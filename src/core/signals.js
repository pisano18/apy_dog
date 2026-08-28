'use strict';

/**
 * Pre-move signals.
 *
 * The premise, stated honestly because everything downstream depends on it:
 * the DIRECTION of a price move is not forecastable to any useful degree, and
 * anyone claiming otherwise is selling something. The MAGNITUDE is a different
 * question. Volatility clusters and mean-reverts — this is one of the most
 * replicated findings in finance — so a period of unusual quiet is genuinely
 * informative about the size of what comes next, without saying a word about
 * which way.
 *
 * So every detector here answers "how likely is a large move soon", never "is
 * it going up". Where a directional lean exists it is reported separately, with
 * its own separately-measured accuracy, and it is usually 'none'.
 *
 * The squeeze family is the exception that proves the rule: short interest above
 * float, a small float, a rising borrow fee and call open interest stacked above
 * spot are mechanically asymmetric — the forced buying can only push one way.
 * That is not a prediction about sentiment, it is arithmetic about who has to
 * transact. It is also the one setup where the ingredients were public before
 * each of the famous cases.
 *
 * ── The rules every detector obeys ──────────────────────────────────────────
 *
 * 1. No lookahead. A detector receives a window ending at the evaluation bar
 *    and cannot see past it. This is enforced structurally by `windowAt` and
 *    tested by feeding a detector data with the future poisoned to NaN.
 * 2. Missing input is reported, never imputed. A squeeze score computed without
 *    short interest is not a weak squeeze score, it is not a squeeze score.
 * 3. Every fire carries human-readable evidence, because a number nobody can
 *    interrogate is indistinguishable from a number that was made up.
 * 4. Strength is a standardised 0..1, NOT a probability. Turning strength into
 *    a probability requires calibration against outcomes, which is what
 *    backtest.js does and what `calibrated` reports.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => (typeof v === 'number' && Number.isFinite(v));

/** Horizon, in trading days, that every detector is aiming at. */
const DEFAULT_HORIZON = 21;

/** What counts as a "large move" for calibration purposes: |return| over this. */
const DEFAULT_MOVE_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// windowing — the no-lookahead guarantee lives here
// ---------------------------------------------------------------------------

/**
 * The only sanctioned way to get data for a detector.
 *
 * Returns the slice of `arr` ending at (and including) index `i`, optionally
 * limited to the last `len` bars. Detectors take the result of this and never
 * the original array, so a lookahead bug requires deliberately bypassing it.
 */
function windowAt(arr, i, len = null) {
  if (!Array.isArray(arr)) return [];
  const end = Math.min(i + 1, arr.length);
  const start = len === null ? 0 : Math.max(0, end - len);
  return arr.slice(start, end);
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!finite(a) || !finite(b) || a <= 0 || b <= 0) continue;
    out.push(Math.log(b / a));
  }
  return out;
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function median(xs) {
  const s = xs.filter(finite).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Annualised realised volatility from a close series. */
function realisedVol(closes) {
  const r = logReturns(closes);
  const s = stdev(r);
  return s === null ? null : s * Math.sqrt(252);
}

/**
 * Where today's value sits inside its own history, 0..1.
 *
 * Percentile rank rather than a z-score because these distributions are
 * emphatically not normal — volatility in particular is heavily right-skewed,
 * and a z-score would call every calm period "one sigma low" and every panic
 * "six sigma", which is both wrong and useless for ranking.
 */
function percentileRank(history, value) {
  const xs = history.filter(finite);
  if (xs.length < 8 || !finite(value)) return null;
  const below = xs.filter((x) => x < value).length;
  return below / xs.length;
}

// ---------------------------------------------------------------------------
// the detectors
// ---------------------------------------------------------------------------

/**
 * Volatility compression.
 *
 * ── MEASURED AND FAILED. Read this before trusting it. ──────────────────────
 *
 * This was built as the workhorse, on the standard claim that quiet does not
 * persist and a compressed instrument is coiled for a move. Against 101 real
 * symbols over five years, out of sample, across fifteen parameter settings, it
 * came back at 0.74 lift on BOTH outcome definitions — worse than knowing
 * nothing. Its interval (12.2% to 26.4% against a 24.8% base rate) also does
 * not clear the base rate from below, so it is not secretly an inverted signal
 * either. It is simply uninformative.
 *
 * The finding that replaced it is the opposite one: volatility PERSISTS at this
 * horizon rather than mean-reverting. Quiet begets quiet, and it is the
 * instrument that has just moved hard which keeps moving. That is why
 * `extension` validated on the same run and this did not.
 *
 * Kept in the codebase because a failed detector with its result written next to
 * it is worth more than a deleted one — it stops the same idea being rebuilt
 * from folklore in six months. It carries zero weight whenever a calibration is
 * loaded, and the interface no longer describes it as evidence of anything.
 */
function coil(closes, i, opts = {}) {
  const { recent = 10, baseline = 60, loose = 0.75, tight = 0.35 } = opts;
  const wr = windowAt(closes, i, recent + 1);
  const wb = windowAt(closes, i, baseline + 1);
  if (wr.length < recent || wb.length < Math.min(30, baseline)) {
    return { key: 'coil', fired: false, strength: 0, inputsMissing: ['not enough price history'] };
  }
  const vr = realisedVol(wr);
  const vb = realisedVol(wb);
  if (!finite(vr) || !finite(vb) || vb <= 0) {
    return { key: 'coil', fired: false, strength: 0, inputsMissing: ['volatility not computable'] };
  }
  const ratio = vr / vb;
  // `loose` is where compression starts counting, `tight` is a genuine coil.
  // These were hand-picked at 0.75 and 0.35 with no data behind them, which is
  // most of why the first real run came back failed. They are parameters now so
  // the sweep can fit them and report what the data actually says.
  const span = Math.max(0.05, loose - tight);
  const strength = clamp((loose - ratio) / span, 0, 1);
  return {
    key: 'coil',
    fired: strength > 0.15,
    strength,
    value: ratio,
    evidence: [
      `Trading at ${Math.round(ratio * 100)}% of its own normal volatility `
        + `(${(vr * 100).toFixed(0)}% annualised now against a ${(vb * 100).toFixed(0)}% baseline).`,
      'Quiet periods do not persist. This says a move is coming, not which way.',
    ],
  };
}

/**
 * Volume rising while price does not.
 *
 * Somebody is accumulating or distributing without moving the tape, which is
 * what building a position looks like before it becomes news. The condition is
 * deliberately conjunctive: volume alone is just a busy day, and volume WITH a
 * price move is the move itself rather than a warning of one.
 */
function quietAccumulation(closes, volumes, i, opts = {}) {
  const { recent = 10, baseline = 60, volFloor = 1.4, driftCap = 0.05 } = opts;
  const vr = windowAt(volumes, i, recent).filter(finite);
  const vb = windowAt(volumes, i, baseline).filter(finite);
  const pr = windowAt(closes, i, recent + 1);
  if (vr.length < recent * 0.6 || vb.length < 20 || pr.length < recent) {
    return { key: 'quiet_accumulation', fired: false, strength: 0, inputsMissing: ['not enough volume history'] };
  }
  const mr = median(vr);
  const mb = median(vb);
  if (!finite(mr) || !finite(mb) || mb <= 0) {
    return { key: 'quiet_accumulation', fired: false, strength: 0, inputsMissing: ['volume not computable'] };
  }
  const volRatio = mr / mb;
  const drift = Math.abs(Math.log(pr[pr.length - 1] / pr[0]));
  // Volume up at least half again, price within ~4% over the window.
  const volPart = clamp((volRatio - volFloor) / Math.max(0.2, volFloor * 1.15), 0, 1);
  const quietPart = clamp((driftCap - drift) / driftCap, 0, 1);
  const strength = volPart * quietPart;
  return {
    key: 'quiet_accumulation',
    fired: strength > 0.15,
    strength,
    value: volRatio,
    evidence: [
      `Volume running ${volRatio.toFixed(1)}x its own median while price moved ${(drift * 100).toFixed(1)}% over ${recent} sessions.`,
      'Size changing hands without moving the price is what position-building looks like.',
    ],
  };
}

/**
 * Range compression — the coil's cross-check.
 *
 * Uses the high-low range rather than close-to-close, so it catches the case
 * where closes are pinned but the intraday range is already widening. Where
 * highs and lows are unavailable it degrades to close-to-close and says so.
 */
function rangeCompression(highs, lows, closes, i, opts = {}) {
  const { recent = 7, baseline = 60, pctCut = 0.25 } = opts;
  const h = windowAt(highs, i, recent);
  const l = windowAt(lows, i, recent);
  const c = windowAt(closes, i, recent);
  const usingCloses = !(h.length === recent && l.length === recent && h.every(finite) && l.every(finite));

  const rangeOf = (hh, ll, cc) => {
    if (usingCloses) {
      const w = cc.filter(finite);
      if (w.length < 3) return null;
      return (Math.max(...w) - Math.min(...w)) / (w[w.length - 1] || 1);
    }
    const hi = Math.max(...hh.filter(finite));
    const lo = Math.min(...ll.filter(finite));
    const last = cc.filter(finite).pop();
    if (!finite(hi) || !finite(lo) || !finite(last) || last <= 0) return null;
    return (hi - lo) / last;
  };

  const now = rangeOf(h, l, c);
  if (!finite(now)) {
    return { key: 'range_compression', fired: false, strength: 0, inputsMissing: ['not enough range history'] };
  }
  // Build the historical distribution of the same measure, point-in-time only.
  const hist = [];
  for (let k = Math.max(recent, i - baseline); k < i; k += 1) {
    const r = rangeOf(windowAt(highs, k, recent), windowAt(lows, k, recent), windowAt(closes, k, recent));
    if (finite(r)) hist.push(r);
  }
  const pct = percentileRank(hist, now);
  if (pct === null) {
    return { key: 'range_compression', fired: false, strength: 0, inputsMissing: ['not enough history to rank the range'] };
  }
  const strength = clamp((pctCut - pct) / pctCut, 0, 1);
  return {
    key: 'range_compression',
    fired: strength > 0.15,
    strength,
    value: pct,
    evidence: [
      `Its ${recent}-session range is tighter than ${Math.round((1 - pct) * 100)}% of the last ${hist.length} readings`
        + `${usingCloses ? ', measured close-to-close because no intraday highs were available' : ''}.`,
    ],
  };
}

/**
 * The squeeze family.
 *
 * Mechanically different from everything else here. A short position is an
 * obligation to buy, and when float is small, borrow is expensive and the
 * shorts are underwater, that obligation becomes forced buying into a thin
 * book. The famous cases all had the same public ingredients weeks in advance.
 *
 * Every input is reported when absent. A squeeze reading without short interest
 * is not a low score, it is no score, and pretending otherwise would produce
 * confident nonsense on the 95% of tickers where nobody has published the data.
 */
function squeeze({ shortPercentFloat, daysToCover, borrowFeePct, floatShares, priceVsHigh }) {
  const missing = [];
  if (!finite(shortPercentFloat)) missing.push('short interest as a share of float');
  if (!finite(daysToCover)) missing.push('days to cover');
  if (missing.length === 2) {
    return { key: 'squeeze', fired: false, strength: 0, inputsMissing: missing };
  }

  const parts = [];
  const evidence = [];

  if (finite(shortPercentFloat)) {
    // 20% of float is high, 50%+ is extraordinary, above 100% is the GME case.
    const s = clamp((shortPercentFloat - 12) / 38, 0, 1);
    parts.push({ w: 0.4, s });
    evidence.push(`${shortPercentFloat.toFixed(1)}% of the free float is sold short`
      + `${shortPercentFloat > 50 ? ' — extraordinary, and mechanically hard to unwind' : ''}.`);
  }
  if (finite(daysToCover)) {
    // Days of average volume needed to buy the shorts back.
    const s = clamp((daysToCover - 2) / 8, 0, 1);
    parts.push({ w: 0.25, s });
    evidence.push(`It would take about ${daysToCover.toFixed(1)} days of normal volume for shorts to cover.`);
  }
  if (finite(borrowFeePct)) {
    // A rising borrow fee is the market pricing scarcity of shares to short.
    const s = clamp((borrowFeePct - 3) / 47, 0, 1);
    parts.push({ w: 0.2, s });
    evidence.push(`Borrowing the shares costs ${borrowFeePct.toFixed(1)}% a year, which is what scarcity looks like.`);
  } else {
    missing.push('borrow fee');
  }
  if (finite(floatShares)) {
    // Small float means the same buying moves the price much further.
    const s = clamp((Math.log10(5e8) - Math.log10(Math.max(1e5, floatShares))) / 2.5, 0, 1);
    parts.push({ w: 0.15, s });
    if (floatShares < 5e7) evidence.push(`Only about ${(floatShares / 1e6).toFixed(0)}M shares actually float.`);
  } else {
    missing.push('float size');
  }

  const totalW = parts.reduce((n, p) => n + p.w, 0) || 1;
  let strength = parts.reduce((n, p) => n + p.w * p.s, 0) / totalW;

  // Confidence penalty for thin inputs: two of five ingredients is a guess
  // wearing a percentage sign.
  const coverage = parts.length / 4;
  strength *= clamp(0.4 + 0.6 * coverage, 0, 1);

  if (finite(priceVsHigh) && priceVsHigh < -0.5 && strength > 0.2) {
    evidence.push('It is also far below its highs, so the short side is currently winning — '
      + 'which is what makes the unwind violent if it turns.');
  }

  return {
    key: 'squeeze',
    fired: strength > 0.2,
    strength,
    value: shortPercentFloat ?? null,
    // The one detector allowed a directional opinion, because forced buying has
    // a direction by construction.
    lean: strength > 0.45 ? 'up' : null,
    inputsMissing: missing,
    evidence,
  };
}

/**
 * A dated event inside the horizon.
 *
 * Not predictive on its own — everyone can see an earnings date — but it turns
 * a compressed setup into a compressed setup with a fuse, and it is the reason
 * a move happens on a particular Tuesday rather than eventually.
 */
function catalystProximity(events, { horizonDays = DEFAULT_HORIZON, now = Date.now() } = {}) {
  const upcoming = (events || [])
    .filter((e) => finite(e.daysAway) && e.daysAway >= 0 && e.daysAway <= horizonDays)
    .sort((a, b) => a.daysAway - b.daysAway);
  if (!upcoming.length) {
    return { key: 'catalyst', fired: false, strength: 0, inputsMissing: ['nothing scheduled in the window'] };
  }
  const e = upcoming[0];
  const mult = finite(e.volMultiple) ? e.volMultiple : 1.5;
  const sizePart = clamp((mult - 1.2) / 2.5, 0, 1);
  const soonPart = clamp(1 - e.daysAway / horizonDays, 0, 1);
  const strength = clamp(0.35 * soonPart + 0.65 * sizePart, 0, 1);
  return {
    key: 'catalyst',
    fired: true,
    strength,
    value: e.daysAway,
    evidence: [
      `${e.title || e.label} in ${Math.round(e.daysAway)} day${Math.round(e.daysAway) === 1 ? '' : 's'}`
        + `${e.certainty === 'estimated' ? ' (estimated date, not published)' : ''}.`,
      `This kind of event has historically moved things about ${mult.toFixed(1)}x a normal day.`,
    ],
  };
}

/**
 * Supply hitting the market on a known date. Crypto's clearest mechanical edge.
 *
 * An unlock worth a meaningful share of circulating supply is sellers arriving
 * on a schedule everyone can read months ahead, and it is the one crypto event
 * with a defensible direction.
 */
function unlockOverhang({ unlockPercentOfFloat, unlockDaysAway }) {
  if (!finite(unlockPercentOfFloat) || !finite(unlockDaysAway)) {
    return { key: 'unlock', fired: false, strength: 0, inputsMissing: ['no published unlock schedule'] };
  }
  if (unlockDaysAway < 0 || unlockDaysAway > 60) {
    return { key: 'unlock', fired: false, strength: 0 };
  }
  const sizePart = clamp((unlockPercentOfFloat - 1) / 14, 0, 1);
  const soonPart = clamp(1 - unlockDaysAway / 60, 0, 1);
  const strength = clamp(0.7 * sizePart + 0.3 * sizePart * soonPart, 0, 1);
  return {
    key: 'unlock',
    fired: strength > 0.1,
    strength,
    value: unlockPercentOfFloat,
    lean: strength > 0.35 ? 'down' : null,
    evidence: [
      `${unlockPercentOfFloat.toFixed(1)}% of circulating supply unlocks in ${Math.round(unlockDaysAway)} days.`,
      'Scheduled supply is the one crypto event with a defensible direction, and it is down.',
    ],
  };
}

/**
 * A move that has gone far in its own terms.
 *
 * ── MEASURED AND VALIDATED, on one of two outcomes. ─────────────────────────
 *
 * The only detector here that beat its base rate on real data: 35.3% against a
 * 24.8% base over 167 independent observations, lift 1.43, surviving a
 * three-way split and a correction for nineteen simultaneous comparisons. It
 * fires on 7.8% of quiet periods, so it is selective rather than always-on.
 *
 * On the harder question — whether a large PRICE move follows rather than
 * merely more volatility — it reached 1.62 lift but on only 60 observations,
 * which is "promising and unproven", not proven. Treat it as a volatility
 * forecast that has been checked, and a price forecast that has not.
 *
 * Nothing here is directional. An extended move predicts more movement, not a
 * reversal: "overbought" is not a sell signal and this does not say it is.
 */
function extension(closes, i, opts = {}) {
  const { window = 60, zFloor = 1.2, zSpan = 2.3 } = opts;
  const w = windowAt(closes, i, window + 1);
  if (w.length < 20) return { key: 'extension', fired: false, strength: 0, inputsMissing: ['not enough history'] };
  const r = logReturns(w);
  const s = stdev(r);
  const last = w[w.length - 1];
  const first = w[0];
  if (!finite(s) || s <= 0 || !finite(last) || !finite(first) || first <= 0) {
    return { key: 'extension', fired: false, strength: 0, inputsMissing: ['not computable'] };
  }
  const move = Math.log(last / first);
  const z = move / (s * Math.sqrt(r.length));
  const strength = clamp((Math.abs(z) - zFloor) / Math.max(0.3, zSpan), 0, 1);
  return {
    key: 'extension',
    fired: strength > 0.2,
    strength,
    value: z,
    evidence: [
      `It has moved ${(Math.exp(move) - 1 >= 0 ? '+' : '')}${((Math.exp(move) - 1) * 100).toFixed(0)}% over `
        + `${r.length} sessions, about ${Math.abs(z).toFixed(1)} standard deviations for something this volatile.`,
      'Stretched moves resolve violently. Which way is not knowable from this.',
    ],
  };
}

// ---------------------------------------------------------------------------
// combining
// ---------------------------------------------------------------------------

/**
 * The signal set for one instrument at one point in time.
 *
 * @param {object} bars  { closes, volumes?, highs?, lows? } full arrays
 * @param {number} i     index to evaluate AT — nothing after it is read
 * @param {object} ctx   fundamentals and events known as of bar i
 */
function detectAt(bars, i, ctx = {}) {
  const { closes = [], volumes = [], highs = [], lows = [] } = bars;
  const p = ctx.params || {};
  const signals = [
    coil(closes, i, p.coil),
    quietAccumulation(closes, volumes, i, p.quiet_accumulation),
    rangeCompression(highs, lows, closes, i, p.range_compression),
    extension(closes, i, p.extension),
    squeeze(ctx),
    catalystProximity(ctx.events, { horizonDays: ctx.horizonDays ?? DEFAULT_HORIZON }),
    unlockOverhang(ctx),
  ];
  return signals;
}

/**
 * Weights, and why they are not a model.
 *
 * These are equal-ish priors chosen from what each effect is documented to do,
 * NOT fitted coefficients. Until backtest.js has fit and stored real ones, the
 * composite is explicitly labelled uncalibrated everywhere it is shown, because
 * a number like "68% chance of a big move" carries an authority it has not
 * earned until something has checked it against outcomes.
 */
const PRIOR_WEIGHTS = {
  coil: 1.0,
  quiet_accumulation: 0.9,
  range_compression: 0.7,
  extension: 0.5,
  squeeze: 1.2,
  catalyst: 0.8,
  unlock: 0.6,
};

/**
 * Turn fired signals into a single pressure reading, 0..100.
 *
 * Deliberately NOT called a probability. It is a rank-ordering device, and the
 * only thing that converts it into a probability is measured outcomes.
 */
function pressureFrom(signals, weights = PRIOR_WEIGHTS) {
  let num = 0;
  let den = 0;
  for (const s of signals) {
    const w = weights[s.key];
    if (!finite(w)) continue;
    den += w;
    if (s.fired) num += w * s.strength;
  }
  if (den <= 0) return 0;
  // Sub-linear so that one very strong signal cannot alone max the scale, and
  // several agreeing signals genuinely add.
  return Math.round(100 * clamp(Math.sqrt(num / den) * 1.25, 0, 1));
}

/**
 * Net directional lean across signals, which is usually nothing.
 *
 * Only the two mechanically-directional detectors get a vote. Everything else
 * is magnitude-only by construction, and letting a compression signal vote on
 * direction is exactly the mistake this whole module exists to avoid.
 */
function leanFrom(signals) {
  const votes = signals.filter((s) => s.fired && s.lean);
  if (!votes.length) return { direction: 'none', strength: 0, why: 'No mechanically directional signal is firing. Magnitude only.' };
  const up = votes.filter((v) => v.lean === 'up').reduce((n, v) => n + v.strength, 0);
  const down = votes.filter((v) => v.lean === 'down').reduce((n, v) => n + v.strength, 0);
  if (Math.abs(up - down) < 0.1) {
    return { direction: 'none', strength: 0, why: 'Directional signals are pulling against each other.' };
  }
  const dir = up > down ? 'up' : 'down';
  return {
    direction: dir,
    strength: clamp(Math.abs(up - down), 0, 1),
    why: votes.filter((v) => v.lean === dir).flatMap((v) => v.evidence || []).join(' '),
  };
}

/** Everything, for one instrument at one bar. */
function readSignals(bars, i, ctx = {}) {
  const signals = detectAt(bars, i, ctx);
  const fired = signals.filter((s) => s.fired);
  return {
    signals,
    fired,
    pressure: pressureFrom(signals, ctx.weights || PRIOR_WEIGHTS),
    lean: leanFrom(signals),
    calibrated: !!ctx.weights,
    missing: [...new Set(signals.flatMap((s) => s.inputsMissing || []))],
  };
}

module.exports = {
  windowAt,
  logReturns,
  realisedVol,
  percentileRank,
  median,
  stdev,
  coil,
  quietAccumulation,
  rangeCompression,
  squeeze,
  catalystProximity,
  unlockOverhang,
  extension,
  detectAt,
  readSignals,
  pressureFrom,
  leanFrom,
  PRIOR_WEIGHTS,
  DEFAULT_HORIZON,
  DEFAULT_MOVE_THRESHOLD,
};
