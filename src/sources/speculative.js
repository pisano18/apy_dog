'use strict';

const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * HIGH-UPSIDE / UNCERTAIN — modelled expected returns, not yields.
 *
 * Everything else in this app answers "what does this pay?". This source answers
 * a different and much weaker question: "what might this be worth in a year?".
 * The two must never be shown as the same kind of number, so every row here
 * leaves apy.total NULL, sets yieldKind EXPECTED, and carries an `expected`
 * block with a full distribution instead of a point rate. risk.js charges these
 * rows 10 points for being a modelled expectation and score.js haircuts them by
 * confidence, which is deliberately capped low. That is the intended treatment.
 *
 * THE MODEL, AND WHY IT IS THIS SMALL
 * -----------------------------------
 * Free daily price data supports exactly three signals worth anything, and all
 * three are weak:
 *
 *   - 12-1 momentum. Twelve-month return excluding the most recent month (the
 *     last month is skipped because of short-term reversal — that is the classic
 *     Jegadeesh-Titman formulation). Real but small, and it decays. So it is
 *     shrunk to a fifth of its raw size and capped at +/-12pp.
 *   - Distance below the 52-week high. Only counted past -25%, only weakly, and
 *     only as mild mean reversion. Falling knives exist.
 *   - Realised volatility. Not a return signal at all. It sets the WIDTH of the
 *     distribution, which is the honest place for it, plus a small haircut for
 *     the low-volatility anomaly — very high volatility assets have historically
 *     not been paid for it.
 *
 * Everything else is a prior: a ~5.5% equity risk premium as the anchor, so the
 * estimate is tethered to something defensible rather than to a weak signal.
 * With the default priors the whole model can only produce roughly -12% to +26%,
 * which is the point. A model built from two moving averages that confidently
 * prints +80% is not finding opportunity, it is broken.
 *
 * A single point estimate would be a lie, so the output is a lognormal band:
 * p10 / p50 / p90 and a probabilityOfLoss COMPUTED from that distribution rather
 * than asserted. basis[] lists every input that moved the number, in plain
 * English, because a number this soft has to be arguable.
 *
 * DATA: the same Yahoo v8 chart endpoint funds.js uses (range=2y&interval=1d),
 * with the same query2 and Stooq fallbacks. Its parsers are reused where the
 * module is loadable; the fetch loop below is the one genuine duplicate.
 */

const ID = 'speculative';
const LABEL = 'High-Upside / Uncertain';

const TRADING_DAYS = 252;
const MONTH_BARS = 21;          // one month of sessions, the bit 12-1 momentum skips
const MIN_VOL_RETURNS = 60;     // under a quarter of history, an annualised stdev is noise
const HORIZON_DAYS = 365;
const Z90 = 1.2815515655446004; // standard normal 90th percentile

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Negative zero is a real hazard here: a model output of -1e-18 renders as
// "-0.0%", which reads as a deliberate statement about a tiny loss.
const round = (v, dp) => {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  const out = Math.round(v * f) / f;
  return out === 0 ? 0 : out;
};
const r1 = (v) => round(v, 1);
const r3 = (v) => round(v, 3);
/** Percentages in basis[] always carry their sign; "+0%" for a loss reads as a lie. */
const signed = (v, dp = 0) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;

// ---------------------------------------------------------------------------
// Price access — reuse funds.js where it is present
// ---------------------------------------------------------------------------

// funds.js already speaks this endpoint fluently and its parsers are exported,
// so the shape-handling lives in exactly one place. It is loaded defensively:
// this source degrades to its own minimal parser rather than failing to load if
// funds.js is absent or its exports move.
let funds = null;
try { funds = require('./funds'); } catch { funds = null; }

const CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const chartUrl = funds?.chartUrl || ((host, symbol) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div%7Csplit`);

const stooqUrl = funds?.stooqUrl || ((symbol) =>
  `https://stooq.com/q/d/l/?s=${encodeURIComponent(String(symbol).toLowerCase())}.us&i=d`);

const quotePage = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

/**
 * Yahoo chart payload -> { price, adj[], lastTsMs }. Never throws.
 * Only used when funds.parseChart is unavailable; it needs less than funds does
 * (no dividend stream), so the fallback is genuinely small.
 */
function parseChartLocal(payload) {
  const chart = payload?.chart;
  if (!chart) return null;
  if (chart.error) return { error: `${chart.error?.code || 'error'}: ${chart.error?.description || 'chart error'}` };
  const res = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!res) return null;

  const quote = Array.isArray(res.indicators?.quote) ? res.indicators.quote[0] : null;
  const adjBlock = Array.isArray(res.indicators?.adjclose) ? res.indicators.adjclose[0] : null;
  const close = Array.isArray(quote?.close) ? quote.close.map(num) : [];
  const adjRaw = Array.isArray(adjBlock?.adjclose) ? adjBlock.adjclose.map(num) : [];
  const adj = (adjRaw.length ? adjRaw : close).filter((v) => v !== null && v > 0);
  const timestamps = Array.isArray(res.timestamp) ? res.timestamp.map(num) : [];
  const lastTs = [...timestamps].reverse().find((v) => v !== null) ?? null;

  return {
    symbol: res.meta?.symbol ? String(res.meta.symbol) : null,
    currency: res.meta?.currency ? String(res.meta.currency).toUpperCase() : 'USD',
    price: num(res.meta?.regularMarketPrice) ?? (adj.length ? adj[adj.length - 1] : null),
    lastTsMs: lastTs === null ? null : lastTs * 1000,
    adj,
    adjustedForDividends: adjRaw.length > 0,
  };
}

/** Stooq daily CSV -> the same shape. Only used when funds.parseStooq is missing. */
function parseStooqLocal(csvText, parseCSV = baseHttp.parseCSV) {
  let rows;
  try { rows = parseCSV(String(csvText || '')); } catch { return null; }
  if (!Array.isArray(rows) || !rows.length) return null;

  const series = [];
  for (const row of rows) {
    const close = num(row?.Close ?? row?.close);
    const ts = Date.parse(`${String(row?.Date ?? row?.date ?? '').trim()}T00:00:00Z`);
    if (close === null || close <= 0 || !Number.isFinite(ts)) continue;
    series.push({ ts, close });
  }
  if (series.length < 2) return null;
  series.sort((a, b) => a.ts - b.ts);
  const last = series[series.length - 1];
  return {
    symbol: null,
    currency: 'USD',
    price: last.close,
    lastTsMs: last.ts,
    adj: series.map((s) => s.close),
    adjustedForDividends: false,
  };
}

const parseChart = funds?.parseChart || parseChartLocal;
const parseStooq = funds?.parseStooq || parseStooqLocal;

// ---------------------------------------------------------------------------
// The model — pure, exported, unit-tested
// ---------------------------------------------------------------------------

/** Usable closes only. Zero and negative prices are bad data, not cheap stock. */
function cleanCloses(closes) {
  return (Array.isArray(closes) ? closes : []).map(num).filter((v) => v !== null && v > 0);
}

/**
 * Annualised volatility: sample stdev of daily log returns, scaled by sqrt(252),
 * in percent. Log returns rather than simple ones because they are additive over
 * time, which is what the sqrt-of-time scaling assumes.
 *
 * Returns null rather than a number when there is too little history — an
 * annualised figure from six weeks of data is a guess wearing a decimal point.
 */
function annualisedVol(closes, { periodsPerYear = TRADING_DAYS, minReturns = MIN_VOL_RETURNS } = {}) {
  const px = cleanCloses(closes);
  if (px.length < minReturns + 1) return null;

  const rets = [];
  for (let i = 1; i < px.length; i += 1) {
    const ret = Math.log(px[i] / px[i - 1]);
    // A +/-100% log move is an unadjusted split in the feed, not a market day.
    if (Math.abs(ret) > 1) continue;
    rets.push(ret);
  }
  if (rets.length < minReturns) return null;

  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
  return Number.isFinite(vol) ? vol : null;
}

/**
 * 12-1 momentum: the twelve-month return EXCLUDING the most recent month, in
 * percent. The last month is dropped because of short-term reversal — recent
 * winners tend to give a little back over the following weeks, and leaving that
 * month in reliably weakens the signal. This is the standard formulation.
 */
function momentum12_1(closes, { lookback = TRADING_DAYS, skip = MONTH_BARS } = {}) {
  const px = cleanCloses(closes);
  if (px.length < lookback + 1) return null;
  const end = px[px.length - 1 - skip];
  const start = px[px.length - 1 - lookback];
  if (!Number.isFinite(end) || !Number.isFinite(start) || start <= 0) return null;
  return (end / start - 1) * 100;
}

/**
 * How far below its trailing 52-week high the last price sits, in percent
 * (always <= 0). Uses everything supplied when there is less than a year of it,
 * so callers that care about the "52-week" part must gate on history length.
 */
function drawdownFromHigh(closes, { window = TRADING_DAYS } = {}) {
  const px = cleanCloses(closes);
  if (px.length < 2) return null;
  const tail = px.slice(-window);
  const high = Math.max(...tail);
  const last = tail[tail.length - 1];
  if (!(high > 0)) return null;
  return (last / high - 1) * 100;
}

/**
 * Standard normal CDF, Zelen & Severo (Abramowitz & Stegun 26.2.17).
 * Absolute error under 7.5e-8, which is far finer than this model deserves, and
 * it avoids a dependency for one function.
 */
function normalCdf(z) {
  if (!Number.isFinite(z)) return null;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Turn an annual expectation and a volatility into an honest distribution of
 * one-horizon outcomes.
 *
 * Prices are modelled as lognormal, so the RETURN over the horizon is
 * exp(N(m, s^2)) - 1. `mu` is the arithmetic annual expectation, so m is set to
 * make E[1+R] = (1+mu)^T exactly — that is the -s^2/2 term, and skipping it is
 * the classic way to accidentally overstate every percentile at once.
 *
 * probabilityOfLoss falls straight out of the same distribution as
 * P(exp(X) < 1) = Phi(-m/s). It is never asserted, because a chance-of-loss
 * number that does not agree with the band beside it is worse than none.
 *
 * @returns {{p10:number,p50:number,p90:number,probabilityOfLoss:number,sigmaHorizon:number}|null}
 */
function lognormalBands(mu, sigma, days = HORIZON_DAYS) {
  const muPct = num(mu);
  const sigmaPct = num(sigma);
  const d = num(days);
  if (muPct === null || sigmaPct === null || d === null || d <= 0) return null;

  // You cannot lose more than everything, and nothing compounds at 100x. A mu
  // outside that is a caller bug, and silently clamping it would hide the bug
  // behind a plausible-looking band.
  if (muPct <= -99 || muPct > 10000) return null;
  const t = d / 365;
  const growth = 1 + muPct / 100;

  const s = Math.max(0, sigmaPct / 100) * Math.sqrt(t);
  const m = Math.log(growth) * t - (s * s) / 2;
  const q = (z) => (Math.exp(m + s * z) - 1) * 100;

  const pLoss = s <= 0 ? (m < 0 ? 1 : 0) : normalCdf(-m / s);
  if (!Number.isFinite(pLoss)) return null;

  return {
    p10: r1(q(-Z90)),
    p50: r1(q(0)),
    p90: r1(q(Z90)),
    probabilityOfLoss: r3(clamp(pLoss, 0, 1)),
    sigmaHorizon: r1(s * 100),
  };
}

/**
 * Calibration. Every one of these is a deliberate act of humility; loosen them
 * and the model starts producing numbers it cannot support.
 */
const PRIORS = {
  equityRiskPremium: 5.5,     // the anchor: what a diversified equity claim is worth being in
  momentumShrink: 0.20,       // raw 12-1 momentum is weak, so keep a fifth of it
  momentumCapPp: 12,          // ...and never let it be the whole story
  reversionWeight: 0.12,      // mean reversion is weaker still
  reversionThresholdPct: -25, // and only from a genuinely deep hole
  reversionCapPp: 8,
  volPivotPct: 40,            // above here, extra volatility has not historically been paid for
  volDragPerPp: 0.05,
  volDragCapPp: 6,
  muFloorPct: -30,            // outside this range the model is broken, not prescient
  muCeilPct: 45,
};

/**
 * Combine the three signals into one annual expectation.
 *
 * Returns the number plus its decomposition, because basis[] has to be able to
 * show the user every input that moved it. `mu` is the figure the rest of the
 * pipeline uses.
 */
function blendedExpectedReturn({ momentum = null, drawdown = null, vol = null, priors = {} } = {}) {
  const p = { ...PRIORS, ...(priors || {}) };
  const basis = [];

  const base = num(p.equityRiskPremium) ?? 0;
  basis.push(`Equity risk premium prior ${base.toFixed(1)}% as the anchor`);

  // --- momentum -------------------------------------------------------------
  const mom = num(momentum);
  let momentumPart = 0;
  if (mom === null) {
    basis.push('No 12-month price history, so momentum contributed nothing');
  } else {
    const raw = mom * p.momentumShrink;
    momentumPart = clamp(raw, -p.momentumCapPp, p.momentumCapPp);
    const capped = Math.abs(raw - momentumPart) > 1e-9 ? `, capped at ${p.momentumCapPp}pp` : '';
    basis.push(`12-1 momentum ${mom >= 0 ? '+' : ''}${mom.toFixed(1)}% shrunk ${p.momentumShrink}x to `
      + `${momentumPart >= 0 ? '+' : ''}${momentumPart.toFixed(1)}pp${capped}`);
  }

  // --- mean reversion -------------------------------------------------------
  // Only past the threshold: something 8% off its high is not "beaten down",
  // it is a normal week, and paying it a reversion bonus would be noise.
  const dd = num(drawdown);
  let reversionPart = 0;
  if (dd !== null && dd < p.reversionThresholdPct) {
    const excess = p.reversionThresholdPct - dd;
    reversionPart = clamp(excess * p.reversionWeight, 0, p.reversionCapPp);
    basis.push(`${Math.abs(dd).toFixed(0)}% below its 52-week high adds +${reversionPart.toFixed(1)}pp of mean reversion`);
  } else if (dd !== null) {
    basis.push(`${Math.abs(dd).toFixed(0)}% below its 52-week high — inside the ${Math.abs(p.reversionThresholdPct)}% `
      + 'threshold, so no mean-reversion credit');
  }

  // --- volatility -----------------------------------------------------------
  const v = num(vol);
  let volDrag = 0;
  if (v !== null) {
    volDrag = clamp((v - p.volPivotPct) * p.volDragPerPp, 0, p.volDragCapPp);
    basis.push(volDrag > 0
      ? `${v.toFixed(0)}% annualised volatility — high-volatility assets have not historically been paid for it, `
        + `so -${volDrag.toFixed(1)}pp`
      : `${v.toFixed(0)}% annualised volatility, which sets the width of the band rather than the middle`);
  }

  const rawMu = base + momentumPart + reversionPart - volDrag;
  const mu = clamp(rawMu, p.muFloorPct, p.muCeilPct);
  // With the default priors the component caps already hold the result inside
  // this range; the outer clamp is the backstop for overridden priors and for
  // the day a signal arrives as garbage.
  if (Math.abs(rawMu - mu) > 1e-9) basis.push(`Capped at ${mu.toFixed(1)}% — the raw blend left the model's supported range`);

  return {
    mu: r1(mu),
    base: r1(base),
    momentumPart: r1(momentumPart),
    reversionPart: r1(reversionPart),
    volDrag: r1(volDrag),
    basis,
  };
}

/**
 * Confidence is LOW by construction, 0.15 to 0.40. These are estimates from a
 * simple model on noisy data; anything higher would let score.js treat them as
 * comparable to a measured yield, which they are not.
 */
function modelConfidence({ vol = null, momentum = null, drawdown = null, seed = false } = {}) {
  let c = 0.40;
  c -= Number.isFinite(vol) ? clamp((vol - 25) / 300, 0, 0.12) : 0.12;
  if (!Number.isFinite(momentum)) c -= 0.08;
  if (!Number.isFinite(drawdown)) c -= 0.03;
  if (seed) c -= 0.06;                       // a remembered input is weaker than a measured one
  return clamp(r3(c), 0.15, 0.40);
}

/**
 * PURE: a price series -> everything a row needs. Never throws.
 * Both the live path and the seed path end up here, so the model cannot drift
 * between what the app ships with and what it computes after a refresh.
 */
function modelFromCloses(closes, opts = {}) {
  const priors = opts.priors || {};
  const horizonDays = num(opts.horizonDays) || HORIZON_DAYS;
  const px = cleanCloses(closes);

  const vol = annualisedVol(px);
  const momentum = momentum12_1(px);
  const drawdown = drawdownFromHigh(px);
  return modelFromSignals({ vol, momentum, drawdown, priors, horizonDays, bars: px.length });
}

/** PURE: precomputed signals -> the expected block. The seed path enters here. */
function modelFromSignals({ vol = null, momentum = null, drawdown = null, priors = {}, horizonDays = HORIZON_DAYS, bars = null, seed = false } = {}) {
  const v = num(vol);
  // Without a volatility there is no width, and a band with no width is the
  // point estimate this whole source exists to avoid. A zero, negative or
  // absurd volatility is bad data, and it would print as a suspiciously
  // confident row, so those are dropped rather than rendered.
  if (v === null || v <= 0 || v > 400) return null;

  const blend = blendedExpectedReturn({ momentum: num(momentum), drawdown: num(drawdown), vol: v, priors });
  const bands = lognormalBands(blend.mu, v, horizonDays);
  if (!bands) return null;
  // A band with a hole in it is not a band; drop the row rather than render a
  // dash where the downside figure should be.
  if (![bands.p10, bands.p50, bands.p90, bands.probabilityOfLoss].every(Number.isFinite)) return null;

  const horizonLabel = horizonDays === 365 ? 'One-year' : `${Math.round(horizonDays)}-day`;
  const basis = [...blend.basis];
  basis.push(`${horizonLabel} lognormal band from ${v.toFixed(0)}% volatility: `
    + `p10 ${signed(bands.p10)}, p50 ${signed(bands.p50)}, p90 ${signed(bands.p90)}`);
  basis.push(`Chance of ending below where you started: ${Math.round(bands.probabilityOfLoss * 100)}%, `
    + 'computed from that band rather than asserted');
  if (Number.isFinite(bars) && bars < TRADING_DAYS + 1) {
    basis.push(`Only ${bars} sessions of history — less than the model wants`);
  }

  return {
    vol: r1(v),
    momentum: r1(num(momentum)),
    drawdown: r1(num(drawdown)),
    mu: blend.mu,
    bands,
    basis,
    confidence: modelConfidence({ vol: v, momentum: num(momentum), drawdown: num(drawdown), seed }),
    bars: Number.isFinite(bars) ? bars : null,
  };
}

// ---------------------------------------------------------------------------
// Universe — real, liquid, editable
// ---------------------------------------------------------------------------

/**
 * Groups exist so the thesis can be honest without being written 46 times, and
 * so a user who wants none of, say, the crypto proxies can drop the whole group.
 */
const GROUPS = {
  beaten_down_quality: {
    label: 'Beaten-down quality',
    thesis: (n) => `For this to work, ${n} has to fix whatever the market marked it down for and be re-rated back `
      + 'toward its own long-run multiple; if the decline is structural rather than cyclical, it will not.',
  },
  high_growth: {
    label: 'High growth',
    thesis: (n) => `For this to work, ${n} has to keep growing fast enough for long enough to justify a valuation `
      + 'that already assumes it will; a single missed quarter re-rates these hard.',
  },
  small_cap_value: {
    label: 'Small-cap value',
    thesis: () => 'For this to work, small-cap value has to close some of the valuation gap to large-cap growth — '
      + 'a gap that has widened for more than a decade and may keep widening.',
  },
  sector_thematic: {
    label: 'Sector & thematic',
    thesis: (n) => `For this to work, the theme ${n} tracks has to turn expectation into earnings, and the fund's `
      + 'holdings have to be the companies that capture it rather than the ones competed away.',
  },
  commodity: {
    label: 'Commodity & miners',
    thesis: (n) => `For this to work, the commodity behind ${n} has to rise in price; it pays nothing while you wait, `
      + 'so the entire return is the price move and a flat year is a loss after inflation.',
  },
  crypto_proxy: {
    label: 'Crypto proxies',
    thesis: (n) => `For this to work, crypto prices have to be materially higher in a year, and ${n} has to track `
      + 'that without financing, custody or regulatory problems of its own.',
  },
};

/**
 * About 45 real, liquid US-listed names. No penny stocks, nothing that cannot be
 * sold in a normal session, and no framing of any of it as a sure thing.
 * `kind: 'etf'` marks a diversified basket, which materially changes the tail.
 */
const UNIVERSE = {
  beaten_down_quality: [
    { symbol: 'NKE', name: 'Nike, Inc.', kind: 'stock' },
    { symbol: 'PFE', name: 'Pfizer Inc.', kind: 'stock' },
    { symbol: 'INTC', name: 'Intel Corporation', kind: 'stock' },
    { symbol: 'DIS', name: 'The Walt Disney Company', kind: 'stock' },
    { symbol: 'PYPL', name: 'PayPal Holdings, Inc.', kind: 'stock' },
    { symbol: 'SBUX', name: 'Starbucks Corporation', kind: 'stock' },
    { symbol: 'LULU', name: 'Lululemon Athletica Inc.', kind: 'stock' },
    { symbol: 'CVS', name: 'CVS Health Corporation', kind: 'stock' },
    { symbol: 'EL', name: 'The Estee Lauder Companies Inc.', kind: 'stock' },
    { symbol: 'FDX', name: 'FedEx Corporation', kind: 'stock' },
  ],
  high_growth: [
    { symbol: 'NVDA', name: 'NVIDIA Corporation', kind: 'stock' },
    { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.', kind: 'stock' },
    { symbol: 'PLTR', name: 'Palantir Technologies Inc.', kind: 'stock' },
    { symbol: 'CRWD', name: 'CrowdStrike Holdings, Inc.', kind: 'stock' },
    { symbol: 'SNOW', name: 'Snowflake Inc.', kind: 'stock' },
    { symbol: 'DDOG', name: 'Datadog, Inc.', kind: 'stock' },
    { symbol: 'SHOP', name: 'Shopify Inc.', kind: 'stock' },
    { symbol: 'NET', name: 'Cloudflare, Inc.', kind: 'stock' },
    { symbol: 'MELI', name: 'MercadoLibre, Inc.', kind: 'stock' },
  ],
  small_cap_value: [
    { symbol: 'AVUV', name: 'Avantis U.S. Small Cap Value ETF', kind: 'etf' },
    { symbol: 'VBR', name: 'Vanguard Small-Cap Value ETF', kind: 'etf' },
    { symbol: 'IJS', name: 'iShares S&P Small-Cap 600 Value ETF', kind: 'etf' },
    { symbol: 'DFSV', name: 'Dimensional US Small Cap Value ETF', kind: 'etf' },
  ],
  sector_thematic: [
    { symbol: 'SMH', name: 'VanEck Semiconductor ETF', kind: 'etf' },
    { symbol: 'XBI', name: 'SPDR S&P Biotech ETF', kind: 'etf' },
    { symbol: 'ARKK', name: 'ARK Innovation ETF', kind: 'etf' },
    { symbol: 'ICLN', name: 'iShares Global Clean Energy ETF', kind: 'etf' },
    { symbol: 'TAN', name: 'Invesco Solar ETF', kind: 'etf' },
    { symbol: 'URA', name: 'Global X Uranium ETF', kind: 'etf' },
    { symbol: 'KWEB', name: 'KraneShares CSI China Internet ETF', kind: 'etf' },
    { symbol: 'XME', name: 'SPDR S&P Metals & Mining ETF', kind: 'etf' },
    { symbol: 'ITB', name: 'iShares U.S. Home Construction ETF', kind: 'etf' },
    { symbol: 'IGV', name: 'iShares Expanded Tech-Software Sector ETF', kind: 'etf' },
  ],
  commodity: [
    { symbol: 'GLD', name: 'SPDR Gold Shares', kind: 'etf' },
    { symbol: 'SLV', name: 'iShares Silver Trust', kind: 'etf' },
    { symbol: 'GDX', name: 'VanEck Gold Miners ETF', kind: 'etf' },
    { symbol: 'GDXJ', name: 'VanEck Junior Gold Miners ETF', kind: 'etf' },
    { symbol: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', kind: 'etf' },
    { symbol: 'PDBC', name: 'Invesco Optimum Yield Diversified Commodity Strategy No K-1 ETF', kind: 'etf' },
    { symbol: 'COPX', name: 'Global X Copper Miners ETF', kind: 'etf' },
  ],
  crypto_proxy: [
    { symbol: 'IBIT', name: 'iShares Bitcoin Trust ETF', kind: 'etf' },
    { symbol: 'FBTC', name: 'Fidelity Wise Origin Bitcoin Fund', kind: 'etf' },
    { symbol: 'COIN', name: 'Coinbase Global, Inc.', kind: 'stock' },
    // Holds bitcoin bought with convertible notes and preferred stock, so it
    // moves further than bitcoin in both directions. The figure is approximate
    // and exists so traps.js and risk.js can see the leverage at all.
    { symbol: 'MSTR', name: 'Strategy Inc. (formerly MicroStrategy)', kind: 'stock', leverage: 1.5 },
    { symbol: 'MARA', name: 'MARA Holdings, Inc.', kind: 'stock' },
    { symbol: 'RIOT', name: 'Riot Platforms, Inc.', kind: 'stock' },
  ],
};

/** Settings can add symbols, drop symbols, or drop whole groups. */
function resolveUniverse(settings = {}) {
  const cfg = settings?.sources?.speculative || settings?.speculative || {};
  const out = new Map();

  const dropGroups = new Set((Array.isArray(cfg.excludeGroups) ? cfg.excludeGroups : []).map((g) => String(g).trim()));
  for (const [group, list] of Object.entries(UNIVERSE)) {
    if (dropGroups.has(group)) continue;
    for (const e of list) out.set(e.symbol, { ...e, group });
  }

  for (const raw of Array.isArray(cfg.symbols) ? cfg.symbols : []) {
    const e = typeof raw === 'string' ? { symbol: raw } : (raw && typeof raw === 'object' ? raw : null);
    const symbol = String(e?.symbol || '').trim().toUpperCase();
    // Ticker-shaped only; a junk string is a URL we then wait 20 seconds to fail on.
    if (!symbol || !/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(symbol)) continue;
    const known = out.get(symbol);
    const group = GROUPS[e.group] ? e.group : (known?.group || 'sector_thematic');
    out.set(symbol, { kind: 'stock', ...(known || {}), ...e, symbol, group, userAdded: true });
  }

  const exclude = new Set((Array.isArray(cfg.exclude) ? cfg.exclude : []).map((s) => String(s).trim().toUpperCase()));
  return [...out.values()].filter((e) => !exclude.has(e.symbol));
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

const ACCESS_NOTES = 'Any US brokerage, commission free. Trades like a stock and settles T+1; one share is the '
  + 'practical minimum, or less wherever fractional shares are supported. Nothing here pays you to wait — the '
  + 'return, if there is one, is the price change.';

/**
 * PURE: universe entry + model output -> a normalized Opportunity, or null.
 *
 * apy.total is deliberately left null. A row in this source that carried a
 * headline APY would be ranked, filtered and read as a yield, and it is not one.
 */
function buildOpportunity(entry, model, opts = {}) {
  const schema = opts.schema || baseSchema;
  const C = opts.C || baseC;
  const symbol = String(entry?.symbol || '').trim().toUpperCase();
  if (!symbol || !model || !Number.isFinite(model.mu) || !model.bands) return null;
  if (!Number.isFinite(model.bands.p10) || !Number.isFinite(model.bands.probabilityOfLoss)) return null;

  const group = GROUPS[entry?.group] ? entry.group : 'sector_thematic';
  const name = entry?.name || symbol;
  const b = model.bands;
  const seed = !!opts.seed;

  // Every row says the same thing, on purpose: this is a model estimate with
  // wide error bars, and here is the tenth-percentile year in plain numbers.
  const notes = 'A model estimate, not a yield. The error bars are wide: one year in ten looks like '
    + `${signed(b.p10)} or worse, and the model puts the chance of simply losing money at `
    + `${Math.round(b.probabilityOfLoss * 100)}%. Nothing here is contracted to pay you anything.`;

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: symbol,
    symbol,
    name,
    provider: entry?.issuer || null,
    assetClass: C.ASSET_CLASS.SPECULATIVE,
    // 'index_proxy' is the token tail.js reads to mean "one holding failing is
    // not the whole position", which is the single most important structural
    // difference between GLD and a levered bitcoin miner. Single names keep
    // their group so the UI can still say what kind of bet this is.
    subType: entry?.kind === 'etf' ? 'index_proxy' : group,
    region: 'US',
    currency: opts.currency || 'USD',

    // No apy block at all: there is no yield here to report.
    yieldKind: C.YIELD_KIND.EXPECTED,
    term: { days: null },
    liquidity: C.LIQUIDITY.DAILY,

    price: num(opts.price),
    minInvestment: num(opts.price),          // one share

    risk: {
      insurance: C.INSURANCE.NONE,           // brokerage custody is not protection from loss
      principalAtRisk: true,
      volatility: model.vol,
      maxDrawdown: num(opts.maxDrawdown),
      leverage: num(entry?.leverage),
    },

    expected: {
      annualReturn: model.mu,
      p10: b.p10,
      p50: b.p50,
      p90: b.p90,
      probabilityOfLoss: b.probabilityOfLoss,
      horizonDays: num(opts.horizonDays) || HORIZON_DAYS,
      basis: model.basis,
      thesis: GROUPS[group].thesis(name),
    },

    // Held for the modelled one-year horizon, so the gain is long-term.
    taxTreatment: C.TAX_TREATMENT.CAPITAL_GAIN_LONG,
    url: quotePage(symbol),
    notes,
    accessNotes: ACCESS_NOTES,
    requirements: ['Brokerage account'],
    confidence: model.confidence,
    dataAsOf: opts.dataAsOf || null,
    seed,
  };

  return schema.normalize(row, { source: ID, seed });
}

/** PURE: rows -> opportunities. One unparseable symbol never takes the source down. */
function buildAll(rows, opts = {}) {
  const opportunities = [];
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const o = buildOpportunity(row?.entry, row?.model, { ...opts, ...(row?.opts || {}) });
      if (o) opportunities.push(o);
      else skipped.push(String(row?.entry?.symbol || '?'));
    } catch {
      skipped.push(String(row?.entry?.symbol || '?'));
    }
  }
  return { opportunities, skipped };
}

const HONESTY_WARNING = 'These are modelled expectations, not yields. Nothing in this source is contracted to pay '
  + 'anything; the numbers come from a deliberately simple model run on price history alone, it can be badly wrong '
  + 'about any single name, and the p10 column is there because that is a real outcome, not a footnote.';

// ---------------------------------------------------------------------------
// Network path
// ---------------------------------------------------------------------------

/** Run `worker` over `items` with at most `limit` in flight. Never rejects. */
async function mapLimited(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); } catch (err) { out[i] = { error: err?.message || String(err) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

const errText = (err) => (err?.status ? `HTTP ${err.status}` : err?.message || String(err));

/**
 * One symbol: Yahoo query1, then query2, then Stooq.
 *
 * TODO(dedupe): funds.js#fetchSymbol is this same loop against the same hosts.
 * When a third price-driven source appears, lift it into core/prices.js and have
 * both require that instead; two copies did not justify the indirection yet.
 */
async function fetchSymbol(ctx, entry) {
  const http = ctx.http || baseHttp;
  const attempts = [];

  for (const host of CHART_HOSTS) {
    if (ctx.signal?.aborted) return { entry, series: null, attempts, aborted: true };
    try {
      const payload = await http.getJSON(chartUrl(host, entry.symbol), {
        signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 3,
      });
      const series = parseChart(payload);
      if (series && !series.error && Array.isArray(series.adj) && series.adj.length) {
        return { entry, series, via: 'yahoo', attempts };
      }
      attempts.push(`${new URL(host).host}: ${series?.error || 'unusable response shape'}`);
    } catch (err) {
      attempts.push(`${new URL(host).host}: ${errText(err)}`);
    }
  }

  if (ctx.signal?.aborted) return { entry, series: null, attempts, aborted: true };
  try {
    const csv = await http.getText(stooqUrl(entry.symbol), {
      signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 3,
    });
    const series = parseStooq(csv, http.parseCSV);
    if (series && Array.isArray(series.adj) && series.adj.length) return { entry, series, via: 'stooq', attempts };
    attempts.push('stooq.com: no usable rows');
  } catch (err) {
    attempts.push(`stooq.com: ${errText(err)}`);
  }

  return { entry, series: null, attempts };
}

async function fetchLive(ctx) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const entries = resolveUniverse(ctx.settings || {});
  const notes = [];
  const warnings = [HONESTY_WARNING];

  if (!entries.length) {
    return contract.result({
      status: 'failed',
      warnings: [...warnings, 'The speculative universe is empty — every symbol was excluded in settings.'],
    });
  }

  ctx.log?.(`speculative: pricing ${entries.length} symbols from the Yahoo chart endpoint`);
  const results = await mapLimited(entries, 3, (entry) => fetchSymbol(ctx, entry));

  const rows = [];
  const failed = [];
  const thin = [];
  let viaStooq = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const res = results[i];
    if (!res || !res.series) {
      failed.push(`${entry.symbol} (${res?.attempts?.[0] || res?.error || 'no response'})`);
      continue;
    }
    if (res.via === 'stooq') viaStooq += 1;

    const closes = Array.isArray(res.series.adj) ? res.series.adj : [];
    const model = modelFromCloses(closes);
    if (!model) { thin.push(entry.symbol); continue; }   // not enough history to model honestly

    rows.push({
      entry,
      model,
      opts: {
        price: num(res.series.price),
        currency: res.series.currency || 'USD',
        // Deepest peak-to-trough over the window, which is a different question
        // from "how far below the high is it now" — risk.js wants the former.
        maxDrawdown: typeof funds?.computeMaxDrawdown === 'function' ? num(funds.computeMaxDrawdown(closes)) : null,
        dataAsOf: Number.isFinite(res.series.lastTsMs) ? new Date(res.series.lastTsMs).toISOString() : null,
      },
    });
  }

  const built = buildAll(rows, { schema, C, seed: false });

  notes.push(`${built.opportunities.length} of ${entries.length} symbols modelled from two years of daily closes.`);
  notes.push('Expected returns are anchored to a 5.5% equity risk premium; 12-1 momentum is shrunk to a fifth of its '
    + 'raw size and capped at 12pp, so no single signal can drive a row on its own.');
  if (viaStooq) notes.push(`${viaStooq} symbol(s) fell back to Stooq for prices.`);
  if (thin.length) notes.push(`${thin.length} symbol(s) skipped for too little price history to model: ${thin.slice(0, 10).join(', ')}.`);
  if (built.skipped.length) notes.push(`${built.skipped.length} row(s) dropped while mapping: ${built.skipped.slice(0, 10).join(', ')}.`);
  if (failed.length) notes.push(`${failed.length} symbol(s) unavailable this run: ${failed.slice(0, 15).join('; ')}${failed.length > 15 ? '; …' : ''}.`);

  if (!built.opportunities.length) {
    return contract.result({ status: 'failed', notes, warnings: [...warnings, 'No symbol returned usable price history.'] });
  }
  if (failed.length > entries.length / 2) {
    warnings.push(`Over half the universe failed to price (${failed.length}/${entries.length}) — the price feed is probably blocked or down.`);
  }

  return contract.result({
    opportunities: built.opportunities,
    status: failed.length || thin.length || viaStooq ? 'partial' : 'ok',
    notes,
    warnings,
    fetchedAt: new Date(ctx.now || Date.now()).toISOString(),
  });
}

async function fetch(ctx) {
  try {
    return await fetchLive(ctx || {});
  } catch (err) {
    const failed = contract.failure(err);
    failed.warnings.unshift(HONESTY_WARNING);
    return failed;
  }
}

// ---------------------------------------------------------------------------
// Seed path
// ---------------------------------------------------------------------------

/**
 * The seed carries the model's INPUTS — volatility, 12-1 momentum, distance
 * below the high — not its outputs, so the bundled rows are produced by exactly
 * the same code that runs after a refresh. A precomputed expected block would
 * quietly diverge from the model the first time the calibration changed.
 */
function loadSeed(ctx) {
  try {
    const schema = ctx?.schema || baseSchema;
    const C = ctx?.C || baseC;
    const { items, meta } = contract.readSeed(ctx?.seedDir, 'speculative.json');
    const dataAsOf = meta?.dataAsOf || '2026-08-01';

    const known = new Map();
    for (const [group, list] of Object.entries(UNIVERSE)) {
      for (const e of list) known.set(e.symbol, { ...e, group });
    }

    const rows = [];
    let unusable = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const symbol = String(item?.symbol || '').trim().toUpperCase();
      const entry = known.get(symbol);
      if (!entry) { unusable += 1; continue; }
      const model = modelFromSignals({
        vol: num(item?.volatility),
        momentum: num(item?.momentum12_1),
        drawdown: num(item?.drawdownFromHigh),
        seed: true,
      });
      if (!model) { unusable += 1; continue; }
      rows.push({
        entry,
        model,
        opts: { price: num(item?.price), maxDrawdown: num(item?.maxDrawdown), dataAsOf },
      });
    }

    const built = buildAll(rows, { schema, C, dataAsOf, seed: true });
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        warnings: [HONESTY_WARNING, 'The bundled speculative snapshot is missing or unreadable.'],
      });
    }

    const notes = [
      `Bundled snapshot of ${built.opportunities.length} names as of ${dataAsOf}. The tickers are real; the prices, `
      + 'volatilities and momentum figures are approximate round figures for that date, not quotes.',
      'The expected-return blocks below were computed offline by the same model the refresh runs, from those inputs.',
    ];
    if (unusable) notes.push(`${unusable} seed row(s) skipped: not in the universe, or missing a volatility.`);
    if (built.skipped.length) notes.push(`${built.skipped.length} seed row(s) dropped while mapping.`);

    return contract.result({
      opportunities: built.opportunities,
      status: 'offline',
      notes,
      warnings: [HONESTY_WARNING],
    });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [HONESTY_WARNING, err?.message || String(err)] });
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Modelled one-year expected returns for liquid, volatile equities and ETFs — beaten-down quality, '
    + 'growth, small-cap value, sector and commodity funds and crypto proxies. Estimates with wide error bars, '
    + 'never yields.',
  homepage: 'https://finance.yahoo.com',
  assetClasses: [baseC.ASSET_CLASS.SPECULATIVE],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,           // the user asked for this category by name
  ttlMs: 6 * 60 * 60 * 1000,      // a two-year price series barely moves in a day

  fetch,
  loadSeed,

  // Exported for the tests, and for anyone recalibrating the model.
  UNIVERSE,
  GROUPS,
  PRIORS,
  HONESTY_WARNING,
  resolveUniverse,
  annualisedVol,
  momentum12_1,
  drawdownFromHigh,
  lognormalBands,
  normalCdf,
  blendedExpectedReturn,
  modelConfidence,
  modelFromCloses,
  modelFromSignals,
  buildOpportunity,
  buildAll,
  parseChart,
  parseStooq,
  chartUrl,
  stooqUrl,
};
