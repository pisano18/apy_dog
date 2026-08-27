'use strict';

const T = require('./tracks');
const { expectedMove, nextCatalyst, recentEvents, describeCatalyst } = require('./catalyst');

/**
 * The movement track.
 *
 * This does not predict returns. It answers a narrower and far more answerable
 * question: how likely is this thing to do something notable soon, how big would
 * that be, and is there a dated reason to expect it?
 *
 * The output is a Heat score for ranking, a plain-language setup, an expected-move
 * band, and a direction lean that is usually — correctly — "none". Timing the
 * market is not possible; knowing that a coiled stock reports earnings on Tuesday
 * is just a calendar, and that is what this surfaces.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------ series stats */

/** Annualised volatility of daily log returns, in percent. */
function annualisedVol(closes, { window = null } = {}) {
  if (!Array.isArray(closes)) return null;
  const src = window ? closes.slice(-Math.min(window + 1, closes.length)) : closes;
  const rets = [];
  for (let i = 1; i < src.length; i += 1) {
    const a = src[i - 1]; const b = src[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252) * 100;
}

/**
 * Volatility regime: recent volatility against its own longer baseline.
 *
 * Below ~0.7 the asset is quieter than it usually is. Compressed ranges resolve —
 * not on any schedule, and not in any knowable direction, but the eventual move
 * out of compression tends to be larger than average. That is a real, documented
 * asymmetry and it is the single most useful thing on a price chart that does not
 * require predicting anything.
 */
function volRegime(closes) {
  const recent = annualisedVol(closes, { window: 21 });
  const baseline = annualisedVol(closes, { window: 189 });
  if (!Number.isFinite(recent) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return { recent, baseline, ratio: recent / baseline };
}

/** Where the latest price sits inside its own trailing range, 0 (low) to 1 (high). */
function rangePosition(closes, { window = 252 } = {}) {
  if (!Array.isArray(closes) || closes.length < 20) return null;
  const src = closes.slice(-window).filter(Number.isFinite);
  if (src.length < 20) return null;
  const last = src[src.length - 1];
  const lo = Math.min(...src); const hi = Math.max(...src);
  if (!(hi > lo)) return null;
  return clamp((last - lo) / (hi - lo), 0, 1);
}

/** Percent below the trailing high. Positive means below. */
function drawdownFromHigh(closes, { window = 252 } = {}) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const src = closes.slice(-window).filter((v) => Number.isFinite(v) && v > 0);
  if (src.length < 2) return null;
  const hi = Math.max(...src);
  const last = src[src.length - 1];
  if (!(hi > 0)) return null;
  return ((hi - last) / hi) * 100;
}

/** Trend as percent per month, from a least-squares fit on log price. */
function trendSlope(closes, { window = 63 } = {}) {
  if (!Array.isArray(closes)) return null;
  const src = closes.slice(-window).filter((v) => Number.isFinite(v) && v > 0);
  const n = src.length;
  if (n < 20) return null;
  const ys = src.map((v) => Math.log(v));
  const xbar = (n - 1) / 2;
  const ybar = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (i - xbar) * (ys[i] - ybar); den += (i - xbar) ** 2; }
  if (den === 0) return null;
  return (Math.exp((num / den) * 21) - 1) * 100;   // ~21 trading days in a month
}

/** Latest volume against its own median. >2 means unusual participation. */
function volumeAnomaly(volumes) {
  if (!Array.isArray(volumes) || volumes.length < 25) return null;
  const src = volumes.slice(-60).filter((v) => Number.isFinite(v) && v > 0);
  if (src.length < 20) return null;
  const recent = src.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, src.length);
  const sorted = [...src].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return null;
  return recent / median;
}

/** Everything the setup classifier needs, from raw series. */
function analyse(closes, volumes) {
  return {
    vol: annualisedVol(closes),
    regime: volRegime(closes),
    rangePos: rangePosition(closes),
    drawdown: drawdownFromHigh(closes),
    trend: trendSlope(closes),
    volumeRatio: volumeAnomaly(volumes),
    lastClose: Array.isArray(closes) ? closes.filter(Number.isFinite).slice(-1)[0] ?? null : null,
    bars: Array.isArray(closes) ? closes.filter(Number.isFinite).length : 0,
  };
}

/* ---------------------------------------------------------------- setups -- */

/**
 * Classify what the chart is doing, in words.
 *
 * Order matters: the checks run from most specific and most actionable to least,
 * so an asset that is both coiled and range-bound reports as coiled, which is the
 * more useful observation.
 */
function classifySetup(stats, catalystNear = false) {
  // No price history means no read. Reporting "range-bound" here would be a
  // fabrication dressed as an observation — the honest answer is that we have
  // not looked, and the UI says exactly that.
  if (!stats || !Number.isFinite(stats.vol)) {
    return { key: null, confidence: 0, unmeasured: true };
  }

  const { regime, rangePos, drawdown, trend, volumeRatio } = stats;
  const ratio = regime?.ratio ?? null;

  if (catalystNear) return { key: T.SETUP.EVENT_PENDING, confidence: 0.6 };

  if (Number.isFinite(ratio)) {
    if (ratio < 0.62) return { key: T.SETUP.COILED, confidence: clamp(0.75 - ratio, 0.2, 0.6) };
    if (ratio > 1.55) return { key: T.SETUP.EXPANDING, confidence: clamp((ratio - 1.2) / 2, 0.2, 0.6) };
  }

  if (Number.isFinite(rangePos) && Number.isFinite(volumeRatio)) {
    if (rangePos > 0.96 && volumeRatio > 1.3) return { key: T.SETUP.BREAKING_OUT, confidence: 0.45 };
    if (rangePos < 0.05 && volumeRatio > 1.3) return { key: T.SETUP.BREAKING_DOWN, confidence: 0.45 };
  }

  if (Number.isFinite(drawdown) && drawdown > 32) {
    return { key: T.SETUP.DEEP_DRAWDOWN, confidence: clamp(drawdown / 150, 0.2, 0.5) };
  }

  if (Number.isFinite(trend) && Number.isFinite(ratio) && ratio < 1.2) {
    if (trend > 2.5) return { key: T.SETUP.GRINDING_UP, confidence: 0.4 };
    if (trend < -2.5) return { key: T.SETUP.GRINDING_DOWN, confidence: 0.4 };
  }

  return { key: T.SETUP.RANGE_BOUND, confidence: 0.25 };
}

/**
 * Directional lean.
 *
 * Kept deliberately weak. Every input here is a documented but feeble edge, and
 * the honest output for most assets most of the time is "no lean". A tool that
 * confidently calls direction on every row is lying on most of them.
 */
function directionalLean(stats, events = []) {
  const votes = [];
  const { trend, drawdown, rangePos, regime } = stats || {};

  if (Number.isFinite(trend)) {
    if (trend > 4) votes.push({ dir: 1, weight: 0.35, why: `Trending up about ${trend.toFixed(1)}% a month` });
    else if (trend < -4) votes.push({ dir: -1, weight: 0.35, why: `Trending down about ${Math.abs(trend).toFixed(1)}% a month` });
  }

  // Deep drawdowns mean-revert weakly, and only once they stop falling.
  if (Number.isFinite(drawdown) && drawdown > 35 && Number.isFinite(trend) && trend > -1) {
    votes.push({ dir: 1, weight: 0.2, why: `Down ${drawdown.toFixed(0)}% from its high and no longer falling` });
  }

  if (Number.isFinite(rangePos)) {
    if (rangePos > 0.97) votes.push({ dir: 1, weight: 0.15, why: 'At the top of its 12-month range' });
    if (rangePos < 0.03) votes.push({ dir: -1, weight: 0.15, why: 'At the bottom of its 12-month range' });
  }

  // Some events are structurally one-directional. An unlock is new supply.
  for (const e of events) {
    if (e.past || e.daysAway > 30) continue;
    if (e.kind === 'token_unlock' || e.kind === 'lockup_expiry') {
      votes.push({ dir: -1, weight: 0.3, why: `${e.label} adds sellable supply` });
    }
    if (e.kind === 'filing_s1') votes.push({ dir: -1, weight: 0.2, why: 'New share registration is usually dilutive' });
  }

  if (!votes.length) return { lean: T.LEAN.NONE, strength: 0, reasons: [] };

  const net = votes.reduce((s, v) => s + v.dir * v.weight, 0);
  const gross = votes.reduce((s, v) => s + v.weight, 0);
  // Agreement alone is not strength: with a single vote it is always 1.0, which
  // renders a lone weak trend reading as maximum conviction. Scale it by how much
  // evidence there actually is, so full strength needs several signals agreeing.
  const agreement = gross > 0 ? Math.abs(net) / gross : 0;
  const evidence = Math.min(1, gross / 0.8);
  const strength = agreement * evidence;

  // Below a real threshold, conflicting weak signals are just noise.
  if (Math.abs(net) < 0.18 || agreement < 0.5) {
    return { lean: T.LEAN.NONE, strength: 0, reasons: votes.map((v) => v.why) };
  }
  return {
    lean: net > 0 ? T.LEAN.UP : T.LEAN.DOWN,
    strength: Math.round(clamp(strength, 0, 1) * 100) / 100,
    reasons: votes.filter((v) => (net > 0 ? v.dir > 0 : v.dir < 0)).map((v) => v.why),
  };
}

/* ------------------------------------------------------------------ heat -- */

/**
 * Heat, 0-100: how much this deserves your attention right now.
 *
 * Explicitly NOT a return forecast and NOT a recommendation. A high-heat row is
 * one where something notable is unusually likely to happen soon — which is just
 * as often a reason to stay away as to buy.
 */
function heatScore({ stats, catalyst, setup, horizonDays = 30 }) {
  const parts = [];
  const add = (points, label) => { if (points > 0.05) parts.push({ label, points: Math.round(points * 10) / 10 }); };

  // 1. A dated event close at hand is the strongest signal available.
  if (catalyst?.event) {
    const e = catalyst.event;
    const proximity = Math.exp(-Math.max(e.daysAway, 0) / 18);
    const impact = clamp((e.volMultiple - 1) / 2.5, 0, 1);
    const certainty = e.certainty === 'confirmed' ? 1 : 0.7;
    add(38 * proximity * impact * certainty, `${e.label} in ${Math.max(0, Math.round(e.daysAway))} days`);
  }

  // 2. Compression. Quiet does not stay quiet.
  const ratio = stats?.regime?.ratio;
  if (Number.isFinite(ratio) && ratio < 0.8) {
    add(clamp((0.8 - ratio) * 55, 0, 22), `Trading ${Math.round((1 - ratio) * 100)}% quieter than its own normal`);
  }

  // 3. Already moving.
  if (Number.isFinite(ratio) && ratio > 1.4) {
    add(clamp((ratio - 1.4) * 22, 0, 18), `Volatility running ${Math.round((ratio - 1) * 100)}% above baseline`);
  }

  // 4. At an extreme of its own range.
  const rp = stats?.rangePos;
  if (Number.isFinite(rp)) {
    if (rp > 0.95) add(12 * (rp - 0.95) * 20, 'Pressing its 12-month high');
    if (rp < 0.05) add(12 * (0.05 - rp) * 20, 'Pressing its 12-month low');
  }

  // 5. Unusual participation.
  if (Number.isFinite(stats?.volumeRatio) && stats.volumeRatio > 1.6) {
    add(clamp((stats.volumeRatio - 1.6) * 9, 0, 14), `Volume running ${stats.volumeRatio.toFixed(1)}x its median`);
  }

  // 6. Size of the plausible move. A quiet asset that cannot move much does not
  //    deserve attention however interesting its chart looks.
  const move = expectedMove(stats?.vol, horizonDays, { volMultiple: catalyst?.event?.volMultiple ?? 1 });
  if (move) add(clamp(move.typical * 0.6, 0, 16), `Could plausibly move ±${move.typical}% over ${horizonDays} days`);

  const raw = parts.reduce((s, p) => s + p.points, 0);
  return {
    heat: Math.round(clamp(raw, 0, 100) * 10) / 10,
    parts: parts.sort((a, b) => b.points - a.points),
    move,
  };
}

/**
 * Full movement read for one opportunity.
 * `stats` comes from analyse(), or from an adapter that precomputed the same fields.
 */
function readMovement(o, { events = [], horizonDays = 30, now = Date.now() } = {}) {
  const stats = o.movementStats || null;
  const own = events.filter((e) => !e.symbol || e.symbol === o.symbol);
  const upcoming = nextCatalyst(own, { now });
  const recent = recentEvents(own, { now });
  const catalyst = upcoming ? describeCatalyst(upcoming, stats?.vol ?? o.risk?.volatility) : null;

  const catalystNear = !!(upcoming && upcoming.daysAway <= 10 && upcoming.volMultiple >= 1.5);
  const setup = classifySetup(stats, catalystNear);
  const unmeasured = !!setup.unmeasured;
  const lean = directionalLean(stats, own);
  const { heat, parts, move } = heatScore({ stats, catalyst, setup, horizonDays });

  const sev = move ? T.severity(move.typical) : null;
  const setupInfo = setup.key ? T.SETUP_INFO[setup.key] : null;

  // How clearly we can see the situation: a legible setup, enough history, and a
  // confirmed rather than guessed date. This says nothing about direction.
  const dataQuality = clamp((stats?.bars ?? 0) / 250, 0, 1);
  const clarityScore = clamp(setup.confidence * 0.6 + dataQuality * 0.25 + (upcoming?.certainty === 'confirmed' ? 0.15 : 0), 0, 0.85);

  return {
    // An unmeasured row has no heat, not zero heat. Zero is a claim that nothing
    // is happening; null is the truth, which is that we have not looked.
    unmeasured,
    heat: unmeasured ? null : heat,
    heatTier: unmeasured ? null : T.heatTier(heat).key,
    heatLabel: unmeasured ? null : T.heatTier(heat).label,
    heatColor: unmeasured ? null : T.heatTier(heat).color,
    heatText: unmeasured ? null : T.heatTier(heat).text,
    heatParts: unmeasured ? [] : parts,
    setup: setup.key,
    setupLabel: setupInfo?.label,
    setupColor: setupInfo?.color,
    setupText: setupInfo?.text,
    move,
    severity: sev?.key ?? null,
    severityLabel: sev?.label ?? null,
    severityColor: sev?.color ?? null,
    lean: lean.lean,
    leanStrength: lean.strength,
    leanReasons: lean.reasons,
    catalyst,
    upcoming: own.filter((e) => !e.past).sort((a, b) => a.dateMs - b.dateMs).slice(0, 6),
    recent: recent.slice(0, 5),
    clarity: Math.round(clarityScore * 100) / 100,
    clarityTier: T.clarity(clarityScore).key,
    clarityText: T.clarity(clarityScore).text,
    stats,
  };
}

module.exports = {
  annualisedVol, volRegime, rangePosition, drawdownFromHigh, trendSlope, volumeAnomaly,
  analyse, classifySetup, directionalLean, heatScore, readMovement,
};
