'use strict';

const { result, failure, readSeed } = require('./_contract');

/**
 * Crypto Assets — spot holdings, via CoinGecko /coins/markets.
 *
 * This is the MOVEMENT-track sibling of defillama.js. That source answers "what
 * does depositing this token pay me?"; this one answers the prior question the
 * app was missing entirely — "what is the token itself doing, and how hard could
 * it move?" A person holding SOL and a person farming SOL-USDC own two different
 * risks, and until now only the second had a row.
 *
 * Three things shape everything below.
 *
 * 1. THESE PAY NOTHING. `apy.total` is null on every row and stays null. Price
 *    appreciation is not a yield, and the fastest way to make this app lie would
 *    be to annualise last year's price change into the same column as a CD rate.
 *    What each row carries instead is a band: how far this thing can travel in a
 *    year, centred on zero because we do not claim to know the direction.
 *
 * 2. EFFICIENCY IS THE WHOLE REASON THIS ENDPOINT WAS CHOSEN. One call returns
 *    250 fully-populated assets INCLUDING a 168-point hourly price series. Four
 *    calls gets a thousand assets with real measured volatility on every one of
 *    them. The naive design — a universe list plus a per-symbol chart request —
 *    would be a thousand calls for the same information and would be rate-limited
 *    into uselessness on the free tier within seconds.
 *
 * 3. THE MEASUREMENT WINDOW IS SEVEN DAYS AND EVERY ROW SAYS SO. A week of
 *    hourly bars is a real volatility measurement, and it is also a short one.
 *    Fields that cannot be computed honestly from what this endpoint returns —
 *    12-month range position, volume-versus-its-own-median — are left null
 *    rather than filled with a lookalike, because the movement engine labels
 *    them with specific claims ("pressing its 12-month high") that would then be
 *    false.
 */

const ID = 'crypto';
const LABEL = 'Crypto Assets';
const MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';

const PER_PAGE = 250;               // upstream maximum, and the point of using it
// Eight calls, 2,000 assets. The free endpoint tolerates this comfortably and
// the difference is not cosmetic: ranks 1,000-2,000 is where the things nobody
// has heard of yet actually live, which is the half of the market this app is
// supposed to be for.
const DEFAULT_PAGES = 8;
const MAX_PAGES = 10;               // the free tier will not tolerate more
const PAGE_PACE_MS = 2200;          // ~27 calls/min ceiling; keyless is 10-30/min
const TTL_MS = 8 * 60 * 1000;       // prices move; the free tier does not want more
const MIN_VOLUME_USD = 200000;      // below this you cannot trade it at any size
const HORIZON_DAYS = 365;
const MAX_BAND_VOL = 250;           // past this a lognormal band stops meaning anything

/** Hours in a year. Crypto trades every one of them — see annualisedVolHourly. */
const HOURS_PER_YEAR = 24 * 365;

/**
 * How many points of price history travel on a row.
 *
 * The sparkline arrives as 168 hourly prices and a thousand rows of that is
 * 168,000 floats held to draw charts a couple of hundred pixels wide. A chart
 * needs the shape, so it is thinned to this before being stored.
 */
const MAX_SERIES_POINTS = 120;

/** 90th-percentile z. The band runs p10..p90, i.e. eight years in ten land inside. */
const Z90 = 1.2816;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/**
 * Guarded ISO conversion.
 *
 * `new Date(x).toISOString()` throws RangeError, not returns NaN, when x is out
 * of range — and upstream timestamp fields are exactly where a garbage value
 * shows up (a zero, a seconds-vs-milliseconds mixup, a "0000-00-00"). Two
 * adapters in this codebase have already been taken down by that throw, so no
 * date reaches toISOString() without passing through here first.
 */
const MIN_MS = Date.parse('1990-01-01T00:00:00Z');
const MAX_MS = Date.parse('2200-01-01T00:00:00Z');
function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t) || t < MIN_MS || t > MAX_MS) return null;
  try {
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Curated identity sets
// ---------------------------------------------------------------------------

/**
 * Known pegged assets, by CoinGecko id.
 *
 * A stablecoin belongs in a movement screen the way a chair belongs in a race:
 * it is a real asset, it is not a candidate. These get flagged rather than
 * dropped, because "designed not to move" is useful information and silently
 * removing rows is its own kind of lie. Behavioural detection below catches the
 * ones this list has not heard of yet.
 */
const STABLE_IDS = new Set([
  'tether', 'usd-coin', 'dai', 'first-digital-usd', 'ethena-usde', 'ethena-staked-usde',
  'usds', 'paypal-usd', 'true-usd', 'usdd', 'gho', 'crvusd', 'nusd', 'liquity-usd',
  'binance-usd', 'magic-internet-money', 'frax', 'stasis-eurs', 'euro-coin', 'tether-eurt',
]);

/**
 * Liquid staking tokens. These genuinely ARE staking products — the token
 * accrues consensus rewards — so they get the crypto_staking class and its risk
 * baseline. What they do NOT get is a yield figure: this endpoint reports price,
 * not staking rate, and inventing one from the price drift is exactly the
 * mistake this file exists to avoid. The rate lives in the DefiLlama source.
 */
const STAKING_IDS = new Set([
  'staked-ether', 'wrapped-steth', 'rocket-pool-eth', 'coinbase-wrapped-staked-eth',
  'jito-staked-sol', 'msol', 'binance-staked-sol', 'mantle-staked-ether', 'stakewise-v3-oseth',
]);

/**
 * Pegs whose backing is an off-chain reserve held by a named issuer, and
 * tokenized commodities, which are the same idea with a different asset in the
 * vault. These get the RWA class rather than the speculative one, and it is a
 * factual distinction rather than a favour: the app's speculative baseline
 * assumes "losing half in a bad year is realistic", which is a true sentence
 * about a memecoin and a false one about a token redeemable one-for-one from a
 * custodian holding T-bills. Grading USDC the same way as BONK would be as
 * wrong as grading BONK the same way as USDC.
 *
 * Deliberately NOT on this list: crypto-collateralised and synthetic pegs (DAI,
 * USDe, crvUSD, GHO). Those hold their dollar through market mechanics rather
 * than a redeemable reserve, so they keep the higher baseline — that gap is the
 * real difference between the two designs, not a labelling detail.
 */
const RESERVE_BACKED_IDS = new Set([
  'tether', 'usd-coin', 'first-digital-usd', 'paypal-usd', 'true-usd', 'usds',
  'binance-usd', 'tether-eurt', 'stasis-eurs', 'euro-coin',
]);
const TOKENIZED_COMMODITY_IDS = new Set(['pax-gold', 'tether-gold']);

/**
 * Wrapped or bridged representations. The price tracks the underlying; the risk
 * does not, because a wrapper adds a custodian or a bridge that can fail on its
 * own. Worth naming on the row.
 */
const WRAPPED_IDS = new Set([
  'wrapped-bitcoin', 'wrapped-steth', 'coinbase-wrapped-btc', 'wrapped-eeth',
  'binance-bitcoin', 'tbtc',
]);

// ---------------------------------------------------------------------------
// Volatility — the one number every read on this row depends on
// ---------------------------------------------------------------------------

/** Finite, positive prices only. A zero or a null in a price series is not data. */
function cleanSeries(prices) {
  if (!Array.isArray(prices)) return [];
  const out = [];
  for (const p of prices) {
    const n = num(p);
    if (n !== null && n > 0) out.push(n);
  }
  return out;
}

/**
 * Evenly-spaced thinning of a price series, oldest first, for the chart.
 *
 * The first and last points survive exactly — they are the two the eye reads,
 * where this started and where it is now — and everything between is sampled at
 * even spacing.
 *
 * Non-finite values are dropped BEFORE the spacing is computed. CoinGecko
 * sparklines do come back with holes in them, and a hole left in place and
 * skipped later would shift every point after it sideways against its own axis.
 */
function downsample(values, targetPoints = MAX_SERIES_POINTS) {
  if (!Array.isArray(values)) return [];
  const clean = values.filter((v) => Number.isFinite(v));
  const target = Math.floor(Number(targetPoints));
  if (!Number.isFinite(target) || target < 1) return [];
  if (!clean.length) return [];
  if (clean.length <= target) return clean;
  // One point cannot hold both ends; the latest price is the one worth keeping.
  if (target === 1) return [clean[clean.length - 1]];

  const step = (clean.length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i += 1) out.push(clean[Math.round(i * step)]);
  return out;
}

/**
 * Annualised volatility of HOURLY log returns, in percent.
 *
 * The annualisation factor is sqrt(24 * 365), not the sqrt(252) used everywhere
 * else in this codebase. That is not a detail: 252 is the count of EQUITY
 * TRADING SESSIONS in a year, and these bars are hours, of which crypto has all
 * 8,760 because it never closes. Using sqrt(252) on hourly bars would report
 * bitcoin at about 6% annualised volatility, which would then flow into the risk
 * grade, the steadiness axis and the expected-move band and make the single most
 * volatile asset class in the app look like a bond fund.
 */
function annualisedVolHourly(prices, { minReturns = 24 } = {}) {
  const px = cleanSeries(prices);
  const rets = [];
  for (let i = 1; i < px.length; i += 1) rets.push(Math.log(px[i] / px[i - 1]));
  if (rets.length < minReturns) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  if (!Number.isFinite(varr) || varr < 0) return null;
  const v = Math.sqrt(varr) * Math.sqrt(HOURS_PER_YEAR) * 100;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Parkinson range estimator, from the 24h high and low.
 *
 * The fallback for records that arrive without a sparkline. The high-low range
 * of a period carries about five times the information about volatility that the
 * period's close-to-close return does, which is why one day of range is worth
 * using at all — but it is still ONE observation, so a row measured this way is
 * marked and its confidence is docked. sigma_day = ln(hi/lo) / (2*sqrt(ln 2)).
 */
function parkinsonVol(high, low) {
  const hi = num(high);
  const lo = num(low);
  if (hi === null || lo === null || lo <= 0 || hi <= lo) return null;
  const daily = Math.log(hi / lo) / (2 * Math.sqrt(Math.log(2)));
  const v = daily * Math.sqrt(365) * 100;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Movement stats for one record, in the exact shape movement.js expects.
 *
 * What is deliberately NOT set, and why, because a null here is a decision:
 *
 *   rangePos    — heatScore prints "Pressing its 12-month high" off this field.
 *                 A seven-day series cannot support that sentence, and an
 *                 all-time-high-to-all-time-low position would not either (for
 *                 most tokens the all-time low is near zero, so it would just
 *                 restate the drawdown while claiming to be a range read).
 *   volumeRatio — heatScore prints "Volume running 2.4x its median". This
 *                 endpoint returns one 24-hour volume figure and no history, so
 *                 there is no median to be 2.4x of.
 *
 * `bars` is reported in DAYS, not in raw sparkline points. Downstream it is read
 * as sessions of history and divided by 250 to score how clearly we can see the
 * situation; handing it 168 would claim eight months of daily history when what
 * we actually have is one week.
 */
function movementStatsFromRecord(rec, opts = {}) {
  if (!rec || typeof rec !== 'object') return null;

  const spark = cleanSeries(rec.sparkline_in_7d?.price);
  const snapshot = rec.snapshotStats && typeof rec.snapshotStats === 'object' ? rec.snapshotStats : null;

  let vol = null;
  let recentVol = null;
  let basis = null;
  let hours = 0;

  if (spark.length >= 25) {
    vol = annualisedVolHourly(spark);
    // Regime: the last two days against the full week. movement.js compares 21
    // sessions to 189 for equities; the crypto analogue is not the same calendar
    // window. 168 continuous hours is more market time than 21 equity sessions
    // (about 137 hours), so a week here is the "baseline" leg, and 48 hours is
    // the "recent" leg. Compression on this scale is what a 24/7 market actually
    // offers — and it is a fast, noisy signal, which the row's notes say plainly.
    recentVol = annualisedVolHourly(spark.slice(-49), { minReturns: 24 });
    basis = vol !== null ? 'sparkline-7d-hourly' : null;
    hours = spark.length;
  }

  if (vol === null && snapshot) {
    // Bundled-snapshot path. The live API does not return this field; the seed
    // file carries it because a hand-authored 168-point price path would be a
    // fabricated price history, which is worse than a stated estimate.
    vol = num(snapshot.volAnnualised);
    const ratio = num(snapshot.volRatio);
    if (vol !== null && vol > 0 && ratio !== null && ratio > 0) recentVol = vol * ratio;
    basis = vol !== null && vol > 0 ? 'snapshot-estimate' : null;
  }

  if (vol === null) {
    vol = parkinsonVol(rec.high_24h, rec.low_24h);
    basis = vol !== null ? 'range-24h' : null;
  }

  if (vol === null || vol <= 0) return null;

  // ath_change_percentage is CoinGecko's distance from the all-time high and is
  // reported NEGATIVE (-62.4 means 62.4% below it). Drawdown downstream is a
  // positive "how far below", so the sign flips here. Note this is an ALL-TIME
  // high, not the trailing-year high movement.js normally computes — a stricter
  // and usually much deeper measure, which the row says out loud.
  const athChange = num(rec.ath_change_percentage);
  const drawdown = athChange === null || athChange < -100 || athChange > 100
    ? null
    : Math.max(0, -athChange);

  // Trend is percent per month downstream, and the 30-day change is exactly
  // that — a point-to-point move rather than a fitted slope, but the same
  // quantity in the same units.
  const trend = num(rec.price_change_percentage_30d_in_currency);

  const regime = (Number.isFinite(recentVol) && recentVol > 0 && vol > 0)
    ? { recent: r1(recentVol), baseline: r1(vol), ratio: r3(recentVol / vol) }
    : null;

  return {
    vol: r1(vol),
    regime,
    rangePos: null,
    drawdown: r1(drawdown),
    trend: r1(trend),
    volumeRatio: null,
    lastClose: num(rec.current_price),
    // Days of price history behind this read, which is what "bars" means to the
    // clarity score downstream. A 24h-range row has seen exactly one day; a
    // bundled row has seen no series at all, and claiming otherwise would buy
    // clarity we did not earn.
    bars: hours > 0 ? Math.max(1, Math.round(hours / 24)) : (basis === 'range-24h' ? 1 : 0),
    volBasis: basis,
    windowHours: hours || null,
  };
}

/**
 * The outcome band. This is NOT a forecast and the numbers are built so it
 * cannot be mistaken for one.
 *
 * A spot crypto holding produces no cash flow. There is no coupon, no rent, no
 * earnings stream — nothing to anchor an expected return to, which is precisely
 * why a "expected return 34%" on a coin is a made-up number wearing a decimal
 * point. So the centre is pinned at zero and only the WIDTH is measured, from
 * the asset's own volatility.
 *
 * Pinning the median at zero rather than the mean is deliberate. Setting the
 * arithmetic mean to zero implies a median of exp(-sigma^2/2) - 1, which for a
 * 70%-volatility asset is -22% — a materially bearish claim about every coin in
 * the table, smuggled in as a modelling convention. Setting the median to zero
 * makes the only claim we can defend: we do not know which way, and here is how
 * far. probabilityOfLoss is 0.5 for the same reason, and the basis says so
 * rather than letting a reader mistake it for a finding.
 */
function outcomeBand(volAnnualPct, days = HORIZON_DAYS) {
  const v = num(volAnnualPct);
  const d = num(days);
  if (v === null || v <= 0 || d === null || d <= 0) return null;
  const capped = Math.min(v, MAX_BAND_VOL);
  const s = (capped / 100) * Math.sqrt(d / 365);
  if (!Number.isFinite(s) || s <= 0) return null;
  const q = (z) => (Math.exp(s * z) - 1) * 100;
  const band = {
    p10: r1(q(-Z90)),
    p50: 0,
    p90: r1(q(Z90)),
    probabilityOfLoss: 0.5,
    sigmaHorizon: r1(s * 100),
    volUsed: r1(capped),
    volCapped: capped < v,
  };
  if (![band.p10, band.p90].every(Number.isFinite)) return null;
  return band;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Is this thing pegged?
 *
 * Two routes, and the row reports which one fired. The curated list is exact;
 * the behavioural test catches the peg that launched last month, and requires
 * BOTH a price sitting on the dollar and measured volatility low enough that it
 * is genuinely behaving as a peg rather than coincidentally passing through $1.
 */
function classifyPeg(rec, vol) {
  const id = String(rec?.id || '').toLowerCase();
  if (STABLE_IDS.has(id)) return { stablecoin: true, basis: 'known' };

  const price = num(rec?.current_price);
  const chg30 = num(rec?.price_change_percentage_30d_in_currency);
  const nearDollar = price !== null && price >= 0.96 && price <= 1.04;
  const quiet = Number.isFinite(vol) && vol < 12;
  const flat = chg30 === null || Math.abs(chg30) < 3;
  if (nearDollar && quiet && flat) return { stablecoin: true, basis: 'behaviour' };

  return { stablecoin: false, basis: null };
}

function classifyAsset(rec, C, peg) {
  const id = String(rec?.id || '').toLowerCase();
  if (STAKING_IDS.has(id)) {
    return { assetClass: C.ASSET_CLASS.CRYPTO_STAKING, subType: 'liquid_staking' };
  }
  if (TOKENIZED_COMMODITY_IDS.has(id)) {
    return { assetClass: C.ASSET_CLASS.RWA, subType: 'tokenized_commodity' };
  }
  if (peg?.stablecoin) {
    return RESERVE_BACKED_IDS.has(id)
      ? { assetClass: C.ASSET_CLASS.RWA, subType: 'stablecoin' }
      : { assetClass: C.ASSET_CLASS.SPECULATIVE, subType: 'stablecoin' };
  }
  // Everything else is a spot holding, and the app has no "spot crypto" class —
  // SPECULATIVE is the honest home for it: an asset with no contractual yield
  // whose entire return is a price you cannot forecast. subType carries the real
  // distinction so the UI and the filters can still tell a wrapper from a coin.
  if (WRAPPED_IDS.has(id)) return { assetClass: C.ASSET_CLASS.SPECULATIVE, subType: 'wrapped' };
  return { assetClass: C.ASSET_CLASS.SPECULATIVE, subType: 'spot' };
}

/**
 * Depth, expressed as the liquidity vocabulary. Every crypto market settles in
 * minutes, so the honest question is not "how long does it take" but "will your
 * order find a bid" — which is a depth question, so 24h volume sets the tier.
 */
function liquidityFor(volume, C) {
  const v = num(volume);
  if (v === null) return C.LIQUIDITY.SETTLED;
  if (v >= 1e8) return C.LIQUIDITY.INSTANT;
  if (v >= 5e6) return C.LIQUIDITY.DAILY;
  if (v >= 1e6) return C.LIQUIDITY.SETTLED;
  return C.LIQUIDITY.ILLIQUID;    // a real order moves this market against you
}

/** Ordered from most advertised to least. Mirrors REACH in core/opportunity-kinds. */
const REACH_ORDER = ['everyone', 'common', 'niche', 'obscure'];
const reachRank = (k) => {
  const i = REACH_ORDER.indexOf(k);
  return i < 0 ? 1 : i;
};

/**
 * How widely known an asset is, from the cap ranking, the cap itself and the
 * tape — the three things this endpoint already gives us on every record.
 *
 * The cap ranking is the honest primary signal here in a way it never is for
 * equities: crypto attention really is ordered by market cap, and the tail is
 * enormous. Bitcoin and ether are on the news; the top fifty are on every
 * exchange's front page; past a few hundred you are into things that are known
 * to the people who follow that chain and nobody else.
 *
 * The three reads are combined by taking the most obscure, because a high rank
 * with no volume behind it is a stale cap, not an audience — and obscurity cuts
 * both ways, which is why the interface shows it instead of scoring it.
 */
function classifyReach({ rank, marketCap, volume } = {}) {
  const reads = [];

  const r = num(rank);
  if (r !== null && r > 0) {
    reads.push(r <= 10 ? 'everyone' : r <= 50 ? 'common' : r <= 250 ? 'niche' : 'obscure');
  }
  const cap = num(marketCap);
  if (cap !== null && cap > 0) {
    reads.push(cap >= 5e10 ? 'everyone' : cap >= 3e9 ? 'common' : cap >= 3e8 ? 'niche' : 'obscure');
  }
  const v = num(volume);
  if (v !== null && v > 0) {
    reads.push(v >= 1e9 ? 'everyone' : v >= 1e8 ? 'common' : v >= 5e6 ? 'niche' : 'obscure');
  }

  // Nothing to place it by is itself an answer: an asset with no rank, no cap
  // and no volume is not one anybody has heard of.
  if (!reads.length) return 'obscure';
  return REACH_ORDER[Math.max(...reads.map(reachRank))];
}

/**
 * How much we trust what this row says.
 *
 * Rank and volume are the two things that separate a datapoint from a rumour: a
 * rank-800 token doing $240k a day is priced by a handful of trades, and every
 * derived figure on its row inherits that. The ceiling is 0.72 rather than
 * something near 1 because even bitcoin's row rests on a SEVEN-DAY volatility
 * window — the price is excellent, the thing we compute from it is a short
 * measurement, and no crypto row has earned a "we know this well".
 */
function assetConfidence({ rank, volume, marketCap, volBasis, seed }) {
  const r = num(rank);
  let c = r === null ? 0.42
    : r <= 10 ? 0.72
      : r <= 50 ? 0.67
        : r <= 100 ? 0.62
          : r <= 250 ? 0.55
            : r <= 500 ? 0.48
              : r <= 1000 ? 0.42
                : 0.36;

  const v = num(volume);
  if (v !== null) {
    if (v >= 1e9) c *= 1.0;
    else if (v >= 1e8) c *= 0.98;
    else if (v >= 1e7) c *= 0.93;
    else if (v >= 1e6) c *= 0.85;
    else c *= 0.72;
  }

  const cap = num(marketCap);
  if (cap !== null && cap > 0 && v !== null && v > 0) {
    // Volume many times the market cap is a wash-trading signature, not depth.
    if (v / cap > 3) c *= 0.7;
  }

  if (volBasis === 'range-24h') c *= 0.78;        // one day of range, not a week
  else if (volBasis === 'snapshot-estimate') c *= 0.85;
  if (seed) c *= 0.8;

  return clamp(Number(c.toFixed(3)), 0.05, 0.95);
}

/**
 * How a person actually buys this. Phrased as likelihood, not as fact: this
 * endpoint returns no exchange listings, so asserting "available on Coinbase"
 * would be a claim we have not checked. Saying what is normal for an asset of
 * this size, and telling the reader to check, is the honest version.
 */
function accessFor({ rank, volume, stablecoin, staking, wrapped, commodity, symbol }) {
  const r = num(rank);
  const v = num(volume) ?? 0;
  const sym = symbol || 'this asset';

  let venue;
  if (r !== null && r <= 30 && v >= 1e8) {
    venue = `Assets this size are normally listed on the large US exchanges (Coinbase, Kraken, Gemini) and buyable with dollars from an ordinary account — confirm the listing before assuming it.`;
  } else if (r !== null && r <= 150 && v >= 1e7) {
    venue = `Usually available on at least one large exchange, though not always a US-regulated one; expect to check Coinbase, Kraken and the major global venues before finding it.`;
  } else if (v >= 1e6) {
    venue = `Thin enough that it may only trade on global exchanges or on-chain. Buying it often means a self-custody wallet, a decentralised exchange, and the host chain's gas token.`;
  } else {
    venue = `Very likely on-chain only. You would need a self-custody wallet, a decentralised exchange and the host chain's gas token, and a normal-sized order will move the price against you.`;
  }

  const custody = 'Held at an exchange this is a claim on the exchange, not on the asset; held in your own wallet, losing the keys loses the money. There is no third option and no insurance behind either.';

  const extra = stablecoin
    ? ' Holding this pays nothing on its own — the yield versions of it are in the DefiLlama source, not here.'
    : staking
      ? ` ${sym} accrues staking rewards in the token itself. This row measures the PRICE only; the staking rate is not reported by this endpoint and is not included anywhere on this row.`
      : wrapped
        ? ' This is a wrapped representation: its price tracks the underlying, but you also carry whatever custodian or bridge issues the wrapper.'
        : commodity
          ? ' This is a claim on metal held by an issuer, not the metal in your hand. It pays nothing, storage is priced into the product, and redeeming it for physical bars has its own minimums and paperwork.'
          : '';

  return `${venue} Fractional purchases are standard — you do not need to buy a whole unit. ${custody}${extra}`;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

function buildRow(rec, opts = {}) {
  const schema = opts.schema || require('../core/schema');
  const C = opts.C || require('../core/constants');
  const seed = !!opts.seed;

  const id = str(rec?.id);
  const symbol = str(rec?.symbol);
  const name = str(rec?.name);
  if (!id || !symbol || !name) return null;

  const price = num(rec.current_price);
  if (price === null || price <= 0) return null;

  const stats = movementStatsFromRecord(rec, opts);
  if (!stats || !Number.isFinite(stats.vol)) return null;

  const band = outcomeBand(stats.vol, HORIZON_DAYS);
  if (!band) return null;

  const marketCap = num(rec.market_cap);
  const volume = num(rec.total_volume);
  const rank = num(rec.market_cap_rank);

  // cleanSeries first: a zero or a negative in a price array is a data error,
  // and a chart drawn through one would show a crash that never happened.
  const spark = cleanSeries(rec.sparkline_in_7d?.price);
  const liveSpark = spark.length > 0;
  const chart = downsample(liveSpark ? spark : cleanSeries(rec.snapshotSeries), MAX_SERIES_POINTS);

  const peg = classifyPeg(rec, stats.vol);

  // Distance from the all-time high is meaningless for a peg. Every dollar
  // stablecoin has an "all-time high" of $1.30-odd from one thin print during
  // some past panic, and carrying that through would report USDT as 24% below
  // its highs and TUSD as deep in a drawdown — which the setup classifier would
  // then dutifully label "Deep drawdown" on an asset engineered not to move.
  if (peg.stablecoin) stats.drawdown = null;

  const { assetClass, subType } = classifyAsset(rec, C, peg);
  const staking = assetClass === C.ASSET_CLASS.CRYPTO_STAKING;
  const wrapped = subType === 'wrapped';
  const commodity = subType === 'tokenized_commodity';
  const SYM = symbol.toUpperCase();

  const chg1y = num(rec.price_change_percentage_1y_in_currency);
  const chg7d = num(rec.price_change_percentage_7d_in_currency);

  // Why the band is the width it is, in the reader's language. Every line here
  // is a fact about how the number was produced, not a view about the asset.
  const basis = [
    'No drift assumed. A spot holding produces no coupon, rent or earnings, so there is nothing '
      + 'to anchor a return forecast to; the centre of this band is zero by construction.',
    stats.volBasis === 'sparkline-7d-hourly'
      ? `Width comes from this asset's own measured volatility, ${stats.vol.toFixed(0)}% annualised, from `
        + `${stats.windowHours} hourly prices over the last seven days.`
      : stats.volBasis === 'range-24h'
        ? `Width comes from a 24-hour high-low range estimate, ${stats.vol.toFixed(0)}% annualised. That is one `
          + 'observation, not a week of them, and it can be well off.'
        : `Width comes from a bundled approximate volatility of ${stats.vol.toFixed(0)}% annualised, not a measurement.`,
    `Over a year that puts one outcome in ten at ${band.p10.toFixed(0)}% or worse and one in ten at `
      + `+${band.p90.toFixed(0)}% or better.`,
    'The 50/50 split is a statement that the direction is unknown, not a finding that the odds are even.',
  ];
  if (band.volCapped) {
    basis.push(`Measured volatility above ${MAX_BAND_VOL}% a year; the band is drawn at ${MAX_BAND_VOL}% because `
      + 'beyond that a lognormal range stops describing anything real.');
  }
  if (Number.isFinite(chg1y)) {
    basis.push(`For context and not as a projection: the last twelve months were ${chg1y >= 0 ? '+' : ''}${chg1y.toFixed(0)}%.`);
  }

  const thesis = peg.stablecoin
    ? `${name} is designed to hold one unit of its peg. There is no upside thesis here; the only question a holder `
      + 'faces is whether the peg and its issuer hold, and the answer is usually yes right up until it is not.'
    : `Nothing about ${name} is contracted to pay you anything. Owning it is a bet that someone will want it more `
      + 'later than they do now. What this app can measure is how far it can travel while you wait, not which way it goes.';

  // Row-level caveats. Each of these exists because a downstream reader would
  // otherwise assume a stronger measurement than the one that was made.
  const rowNotes = [];
  rowNotes.push('No yield: holding this pays nothing. The figure shown is a range of outcomes, not a rate.');
  if (stats.volBasis === 'sparkline-7d-hourly') {
    rowNotes.push('Volatility and the volatility regime are measured over seven days of hourly prices — a real '
      + 'measurement and a short one, so the regime read is fast and noisy.');
  } else if (stats.volBasis === 'range-24h') {
    rowNotes.push('No 7-day price series came back for this asset, so volatility is estimated from one day\'s '
      + 'high-low range.');
  } else {
    rowNotes.push('Volatility on this row is a bundled approximation, not a measurement. Refresh to replace it.');
  }
  if (Number.isFinite(stats.drawdown)) {
    rowNotes.push(`Drawdown is measured from the ALL-TIME high, not a trailing year, so it is a deeper figure than `
      + `the same field on a stock row: ${stats.drawdown.toFixed(0)}% below its record.`);
  }
  rowNotes.push('12-month range position and volume-versus-normal are not available from this feed and are left '
    + 'blank rather than approximated.');
  // The realised move over exactly the window the volatility was measured on.
  // Stated as history, next to a band that is explicitly not a projection.
  if (Number.isFinite(chg7d)) {
    rowNotes.push(`Over the same seven days it actually moved ${chg7d >= 0 ? '+' : ''}${chg7d.toFixed(1)}%.`);
  }
  if (peg.stablecoin) {
    rowNotes.push(peg.basis === 'known'
      ? 'Flagged as a stablecoin: it is designed not to move, so it is not a movement candidate.'
      : 'Behaving as a pegged asset — sitting on the dollar with near-zero volatility — so it is treated as one '
        + 'and is not a movement candidate.');
  }
  if (staking) {
    rowNotes.push('Liquid staking token. It accrues staking rewards, and this row does not include them: this feed '
      + 'reports price only, and the rate belongs to the DefiLlama source.');
  }
  if (commodity) {
    rowNotes.push('Tokenized commodity: a redeemable claim on metal held by the issuer, so the price tracks the '
      + 'metal and the risk includes the issuer and the redemption process.');
  }

  const trapFlags = [];
  if (peg.stablecoin) trapFlags.push(C.TRAP_FLAGS.DEPEG_EXPOSURE);

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: id,
    name,
    symbol: SYM,
    provider: null,
    assetClass,
    subType,
    track: 'movement',              // this source answers "what might move", only
    region: 'Global',
    currency: 'USD',

    // Deliberately no apy block. Price appreciation is not a yield and must
    // never appear in the same column as one.
    yieldKind: C.YIELD_KIND.EXPECTED,
    term: { days: null },
    liquidity: liquidityFor(volume, C),

    price,
    // No minimum: every venue sells fractions, so quoting the unit price as a
    // minimum investment would overstate the entry cost of bitcoin by five
    // orders of magnitude.
    minInvestment: null,
    tvl: marketCap,
    volume,

    stablecoin: peg.stablecoin,
    denomination: peg.stablecoin ? 'stable' : 'crypto',
    exposure: 'single',
    underlying: [SYM],

    movementStats: stats,
    // The chart: the same seven days the volatility above was measured on,
    // thinned for storage. Live that is the real hourly sparkline; offline the
    // bundled snapshot supplies a shape instead, which the seed file labels as
    // such and which nothing is measured from.
    series: chart.length ? chart : null,
    // Live rows chart the real 168-point hourly sparkline. Bundled rows chart a
    // shape drawn to agree with the volatility beside it, which is a useful
    // illustration and not a price history — the difference has to reach the
    // screen, because on screen the two are indistinguishable.
    seriesBasis: chart.length ? (liveSpark ? 'measured' : 'illustrative') : null,
    // The live sparkline is seven days of HOURLY prices. Saying so is what stops
    // the signal engine reading it as seven months of daily bars — which it did,
    // annualising 1.4-hour moves with sqrt(252) and reporting volatility about
    // five times too low. There is no daily history here to give it, and a
    // detector calibrated on daily bars has nothing honest to say about hourly
    // ones, so crypto carries no signals rather than invented ones.
    seriesInterval: chart.length && liveSpark ? 'hour' : null,
    reach: classifyReach({ rank, marketCap, volume }),
    // This feed carries prices, not calendars. Token unlocks, upgrade dates and
    // halvings are dated events that genuinely belong on these rows, and they
    // come from a schedule feed this source does not have — so rather than
    // guess at dates, it ships none.
    events: [],

    risk: {
      principalAtRisk: true,
      insurance: C.INSURANCE.NONE,       // no custodial or market-loss cover exists
      volatility: r1(stats.vol),
      maxDrawdown: stats.drawdown,
    },

    expected: {
      annualReturn: 0,
      p10: band.p10,
      p50: band.p50,
      p90: band.p90,
      probabilityOfLoss: band.probabilityOfLoss,
      horizonDays: HORIZON_DAYS,
      basis,
      thesis,
    },

    // Nothing is paid out, so nothing is taxed until it is sold. Held past a
    // year that is a long-term capital gain.
    taxTreatment: C.TAX_TREATMENT.CAPITAL_GAIN_LONG,

    trapFlags,
    url: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    notes: rowNotes.join(' '),
    accessNotes: accessFor({
      rank, volume, stablecoin: peg.stablecoin, staking, wrapped, commodity, symbol: SYM,
    }),
    requirements: ['Exchange account or a self-custody wallet'],

    confidence: assetConfidence({
      rank, volume, marketCap, volBasis: stats.volBasis, seed,
    }),
    // Live rows are as-of whenever upstream last touched them; a bundled row is
    // as-of the snapshot date and must not be able to claim otherwise.
    dataAsOf: seed
      ? (str(opts.dataAsOf) || isoDate(rec.last_updated))
      : (isoDate(rec.last_updated) || str(opts.dataAsOf)),
    seed,
    live: !seed,
  };

  return schema.normalize(row, { source: ID, seed });
}

// ---------------------------------------------------------------------------
// PURE PARSER
// ---------------------------------------------------------------------------

/**
 * Raw /coins/markets payload -> normalized opportunities.
 *
 * No network, no filesystem, no clock beyond opts.now, so the entire mapping is
 * testable against a fixture. Every record is its own blast radius: a renamed
 * upstream field costs us that row and a line in notes, never the source.
 *
 * @param {Array|object} payload  the markets array, or a concatenation of pages
 * @param {object} opts { schema, C, now, seed, dataAsOf, minVolumeUsd }
 */
function parseMarkets(payload, opts = {}) {
  const schema = opts.schema || require('../core/schema');
  const C = opts.C || require('../core/constants');
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const seed = !!opts.seed;
  const dataAsOf = str(opts.dataAsOf) || isoDate(nowMs) || null;
  const minVolume = Number.isFinite(opts.minVolumeUsd) ? opts.minVolumeUsd : MIN_VOLUME_USD;

  const notes = [];
  const warnings = [];

  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.items) ? payload.items
        : null;

  if (!rows) {
    // CoinGecko reports rate limits and errors as an object with a status block
    // rather than an HTTP error body, so read it before giving up.
    const upstreamMsg = str(payload?.status?.error_message) || str(payload?.error);
    return {
      opportunities: [],
      notes,
      warnings: [upstreamMsg
        ? `upstream returned an error instead of market data: ${upstreamMsg}`
        : 'upstream payload was not an array of market records'],
      dropped: {},
    };
  }

  const dropped = {
    unparseable: 0, duplicate: 0, noPrice: 0, thinVolume: 0, noVolatility: 0,
  };
  const seen = new Set();
  const opportunities = [];
  let stablecoins = 0;
  let stakingTokens = 0;
  const volBasisCount = { sparkline: 0, range: 0, snapshot: 0 };

  for (const rec of rows) {
    try {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { dropped.unparseable += 1; continue; }

      const id = str(rec.id);
      if (!id || !str(rec.symbol) || !str(rec.name)) { dropped.unparseable += 1; continue; }

      // Pages are fetched sequentially and ranks shift between calls, so the
      // same asset can legitimately arrive twice. Keeping both would double-count
      // it in every downstream median.
      const key = id.toLowerCase();
      if (seen.has(key)) { dropped.duplicate += 1; continue; }
      seen.add(key);

      const price = num(rec.current_price);
      if (price === null || price <= 0) { dropped.noPrice += 1; continue; }

      const volume = num(rec.total_volume);
      if (volume === null || volume < minVolume) { dropped.thinVolume += 1; continue; }

      const o = buildRow(rec, { schema, C, seed, dataAsOf, now: nowMs });
      if (!o) { dropped.noVolatility += 1; continue; }

      opportunities.push(o);
      if (o.stablecoin) stablecoins += 1;
      if (o.assetClass === C.ASSET_CLASS.CRYPTO_STAKING) stakingTokens += 1;
      const b = o.movementStats?.volBasis;
      if (b === 'sparkline-7d-hourly') volBasisCount.sparkline += 1;
      else if (b === 'range-24h') volBasisCount.range += 1;
      else if (b === 'snapshot-estimate') volBasisCount.snapshot += 1;
    } catch {
      // One malformed record, one lost row. Never the source.
      dropped.unparseable += 1;
    }
  }

  notes.push(`${rows.length.toLocaleString()} assets returned upstream, ${opportunities.length.toLocaleString()} kept.`);

  const dropTxt = [
    dropped.thinVolume ? `${dropped.thinVolume} under $${minVolume.toLocaleString()} of 24h volume (untradeable at any size)` : null,
    dropped.noPrice ? `${dropped.noPrice} with no usable price` : null,
    dropped.noVolatility ? `${dropped.noVolatility} with no way to measure volatility, so no honest range could be drawn` : null,
    dropped.duplicate ? `${dropped.duplicate} duplicated across pages` : null,
    dropped.unparseable ? `${dropped.unparseable} unparseable` : null,
  ].filter(Boolean);
  if (dropTxt.length) notes.push(`Dropped: ${dropTxt.join('; ')}.`);

  if (opportunities.length) {
    const parts = [];
    if (volBasisCount.sparkline) parts.push(`${volBasisCount.sparkline.toLocaleString()} from seven days of hourly prices`);
    if (volBasisCount.range) parts.push(`${volBasisCount.range.toLocaleString()} from a 24-hour high-low range only`);
    if (volBasisCount.snapshot) parts.push(`${volBasisCount.snapshot.toLocaleString()} from a bundled approximation, not a measurement`);
    if (parts.length) notes.push(`Volatility measured on every row: ${parts.join('; ')}.`);
    notes.push('Every row here pays nothing. The percentage shown is a range of price outcomes centred on zero, '
      + 'not a yield, and the direction is explicitly not claimed.');
    notes.push('12-month range position and volume-versus-its-own-median are not derivable from this endpoint and '
      + 'are left blank on every row rather than approximated.');
    if (stablecoins) {
      notes.push(`${stablecoins} stablecoin${stablecoins === 1 ? '' : 's'} flagged: kept for completeness but designed not to move, so they are not movement candidates.`);
    }
    if (stakingTokens) {
      notes.push(`${stakingTokens} liquid staking token${stakingTokens === 1 ? '' : 's'} classed as staking `
        + 'products. The staking RATE is not in this source — this feed reports price only, so see DefiLlama '
        + 'Yields for what they actually pay.');
    }
    notes.push('No dated events on these rows: unlock schedules, upgrade dates and halvings need a calendar feed '
      + 'this source does not have, so it ships none rather than guessing at dates.');
  }

  return { opportunities, notes, warnings, dropped, stablecoins, stakingTokens, volBasisCount };
}

// ---------------------------------------------------------------------------
// Network path
// ---------------------------------------------------------------------------

/**
 * Settings -> what this run will actually ask for.
 *
 * Pulled out and clamped as its own function because the ceiling is not a
 * preference: a stored `pages: 999` would be 999 calls at a free endpoint that
 * tolerates a couple of dozen a minute, and the resulting rate-limit would take
 * the source out for everyone using the app, not just the person who typed it.
 */
function resolveOptions(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const pages = clamp(Math.floor(num(c.pages) ?? DEFAULT_PAGES), 1, MAX_PAGES);
  const perPage = clamp(Math.floor(num(c.perPage) ?? PER_PAGE), 1, PER_PAGE);
  const min = num(c.minVolumeUsd);
  return {
    pages: Number.isFinite(pages) ? pages : DEFAULT_PAGES,
    perPage: Number.isFinite(perPage) ? perPage : PER_PAGE,
    minVolumeUsd: Number.isFinite(min) && min >= 0 ? min : MIN_VOLUME_USD,
  };
}

function marketsUrl(page, perPage) {
  const q = new URLSearchParams({
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: String(perPage),
    page: String(page),
    price_change_percentage: '1h,24h,7d,30d,200d,1y',
    sparkline: 'true',
  });
  return `${MARKETS_URL}?${q.toString()}`;
}

const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });

/**
 * Fetch N pages, paced and cached per page.
 *
 * Per page rather than per run so that a refresh inside the TTL costs nothing at
 * all, and a run where page 3 rate-limits still keeps pages 1, 2 and 4 — losing
 * the tail of the market is a degraded run, losing everything is a failed one.
 */
async function fetchPages(ctx, { pages, perPage }) {
  const out = [];
  const failedPages = [];
  let cachedPages = 0;

  for (let page = 1; page <= pages; page += 1) {
    if (ctx.signal?.aborted) break;
    const url = marketsUrl(page, perPage);
    const load = () => ctx.http.getJSON(url, { signal: ctx.signal, timeout: 25000, retries: 1, concurrency: 1 });
    try {
      let batch;
      if (ctx.cache?.wrap) {
        const hit = await ctx.cache.wrap(`crypto:markets:p${page}:${perPage}`, TTL_MS, load);
        batch = hit?.value;
        if (hit?.fromCache) cachedPages += 1;
        // A cache hit costs no call, so it also costs no pacing delay.
        if (!hit?.fromCache && page < pages) await sleep(PAGE_PACE_MS);
      } else {
        batch = await load();
        if (page < pages) await sleep(PAGE_PACE_MS);
      }
      if (Array.isArray(batch)) {
        out.push(...batch);
        // Upstream ran out of assets before we ran out of pages.
        if (batch.length < perPage) break;
      } else {
        failedPages.push({ page, message: str(batch?.status?.error_message) || 'page was not an array' });
      }
    } catch (err) {
      failedPages.push({ page, message: err?.message || String(err) });
      // A 429 means the free tier has had enough; asking for more pages will
      // only deepen the penalty box.
      if (err?.status === 429) break;
    }
  }

  return { records: out, failedPages, cachedPages };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const adapter = {
  id: ID,
  label: LABEL,
  description: 'Spot crypto assets ranked by how much they could move, not by a yield they do not pay — a thousand '
    + 'assets in four calls, each with a measured seven-day volatility.',
  homepage: 'https://www.coingecko.com',
  assetClasses: ['speculative', 'crypto_staking', 'rwa'],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: TTL_MS,

  // Exported for tests and for reuse; all pure.
  parseMarkets,
  movementStatsFromRecord,
  annualisedVolHourly,
  parkinsonVol,
  outcomeBand,
  classifyPeg,
  classifyReach,
  liquidityFor,
  assetConfidence,
  resolveOptions,
  marketsUrl,
  downsample,
  MAX_SERIES_POINTS,

  async fetch(ctx) {
    const cfg = ctx.settings?.sources?.crypto || ctx.settings?.crypto || {};
    const { pages, perPage, minVolumeUsd } = resolveOptions(cfg);

    ctx.log?.(`fetching ${pages} page(s) of ${perPage} from CoinGecko markets`);

    let fetched;
    try {
      fetched = await fetchPages(ctx, { pages, perPage });
    } catch (err) {
      return failure(err);
    }

    const { records, failedPages, cachedPages } = fetched;
    if (!records.length) {
      const first = failedPages[0];
      return result({
        status: 'failed',
        warnings: [first ? `CoinGecko returned nothing usable: ${first.message}` : 'CoinGecko returned no market records'],
        fetchedAt: isoDate(ctx.now) || new Date().toISOString(),
      });
    }

    const parsed = parseMarkets(records, {
      schema: ctx.schema, C: ctx.C, now: ctx.now, minVolumeUsd,
    });

    const warnings = [...parsed.warnings];
    for (const f of failedPages) warnings.push(`page ${f.page} of the market list failed (${f.message}) — the tail of the ranking is missing this run`);

    const notes = [
      `${pages} bulk call${pages === 1 ? '' : 's'} covering the top ${(pages * perPage).toLocaleString()} assets by market cap`
        + `${cachedPages ? `, ${cachedPages} served from cache` : ''}.`,
      ...parsed.notes,
    ];

    return result({
      opportunities: parsed.opportunities,
      status: warnings.length ? 'partial' : (parsed.opportunities.length ? 'ok' : 'partial'),
      notes,
      warnings,
      fetchedAt: isoDate(ctx.now) || new Date().toISOString(),
    });
  },

  loadSeed(ctx) {
    try {
      const schema = ctx?.schema || require('../core/schema');
      const C = ctx?.C || require('../core/constants');
      const { items, meta } = readSeed(ctx?.seedDir, 'crypto.json');
      if (!items.length) {
        return result({ status: 'failed', warnings: ['seed file data/seed/crypto.json is missing or unreadable'] });
      }

      const dataAsOf = str(meta.dataAsOf) || '2026-08-01';
      const parsed = parseMarkets(items, {
        schema, C, now: ctx?.now, seed: true, dataAsOf,
      });

      return result({
        opportunities: parsed.opportunities,
        status: 'offline',
        notes: [
          `Bundled snapshot of ${parsed.opportunities.length} real crypto assets as of ${dataAsOf}. Every ticker and `
            + 'name is real; the prices, volumes and volatilities are approximate round figures, not quotes. Crypto '
            + 'moves hourly — refresh before acting on any of it.',
          ...parsed.notes.slice(1),
        ],
        warnings: parsed.warnings,
      });
    } catch (err) {
      // loadSeed must never throw: it is the safety net the live path falls into.
      return failure(err, { status: 'failed' });
    }
  },
};

module.exports = adapter;
