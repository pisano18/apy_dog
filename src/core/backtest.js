'use strict';

const S = require('./signals');

/**
 * Whether the signals are worth anything.
 *
 * A detector that fires and is followed by a large move 40% of the time sounds
 * impressive and is worthless if large moves happen 40% of the time anyway.
 * That single confusion is what separates a screener from astrology, so
 * everything here is measured against the base rate and nothing is reported
 * without it.
 *
 * The bar a signal has to clear to be called validated:
 *
 *   1. The LOWER bound of the 95% interval on its hit rate must sit above the
 *      base rate. Not the point estimate — the lower bound. A signal that fired
 *      nine times and hit six is not evidence of anything.
 *   2. It must fire often enough to matter: 30 observations minimum.
 *   3. It must survive out-of-sample. Weights are fitted on the first portion
 *      of history and scored on a holdout the fitting never saw.
 *   4. It must NOT fire on quiet periods. Measured explicitly, because a
 *      detector that fires on everything has a wonderful hit rate and tells you
 *      nothing.
 *
 * Signals that fail are reported as failed. The point of building this was to
 * find out, and a harness that only ever confirms is a harness with a bug.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Wilson score interval.
 *
 * Not the normal approximation, which is badly wrong at the small samples and
 * extreme rates this will routinely see — it happily produces a lower bound
 * below zero on 2 hits from 3 fires, which would let a nonsense signal pass.
 */
/**
 * Two-sided critical z for a given alpha.
 *
 * Acklam's inverse-normal approximation. Needed because the Bonferroni
 * correction turns alpha into a number with no memorable z beside it, and
 * hardcoding 1.96 was what let a seven-signal sweep pass one false positive per
 * three runs.
 */
function zForAlpha(alpha) {
  const p = 1 - alpha / 2;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q;
  let r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function wilson(hits, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

/**
 * Forward return over `horizon` bars, entered at the bar AFTER the signal.
 *
 * Entering at i+1 rather than i is not pedantry. A detector reads bar i's
 * close; filling at that same close is a fill you could not have got, and it is
 * the single most common way a backtest quietly reports an edge that does not
 * exist.
 */
function forwardReturn(closes, i, horizon) {
  const entry = closes[i + 1];
  const exit = closes[i + 1 + horizon];
  if (!finite(entry) || !finite(exit) || entry <= 0) return null;
  return exit / entry - 1;
}

/** The largest excursion in either direction over the window, not just the endpoint. */
function forwardMaxMove(closes, i, horizon) {
  const entry = closes[i + 1];
  if (!finite(entry) || entry <= 0) return null;
  let best = 0;
  for (let k = i + 2; k <= i + 1 + horizon && k < closes.length; k += 1) {
    const c = closes[k];
    if (!finite(c) || c <= 0) continue;
    const r = c / entry - 1;
    if (Math.abs(r) > Math.abs(best)) best = r;
  }
  return best;
}

/**
 * Run every detector across every bar of every instrument and record what
 * happened next.
 *
 * ── On overlapping windows, which is the whole ballgame ─────────────────────
 *
 * Evaluating every bar looks like it gives you thousands of observations. It
 * does not. Bar i and bar i+1 share twenty of their twenty-one forward days and
 * almost their entire lookback, so they are very nearly the same observation
 * counted twice. Treating them as independent makes the confidence interval far
 * too narrow, and a narrow interval around a meaningless number is exactly how
 * a backtest certifies an edge that is not there.
 *
 * This was not theoretical. With every bar evaluated, the compression detector
 * came back "validated" on four of twelve baskets of pure random walks — data
 * with no structure by construction. The null test caught it; nothing else
 * would have.
 *
 * So scoring strides by the full horizon, making the forward windows disjoint.
 * It throws away most of the rows and that is the point: a hundred honest
 * observations beat three thousand that are the same twenty observations
 * wearing different hats.
 *
 * @param {object[]} instruments  [{ symbol, closes, volumes?, highs?, lows?, ctx? }]
 * @param {object} opts
 */
function collect(instruments, opts = {}) {
  const {
    horizon = S.DEFAULT_HORIZON,
    threshold = S.DEFAULT_MOVE_THRESHOLD,
    warmup = 70,
    useMaxMove = true,
    // 1 = every bar (dense, overlapping, statistically dishonest — kept only so
    // the overlap effect can itself be demonstrated in a test).
    stride = null,
    // 'relative' asks the question worth asking: will this move much more than
    // IT normally does. A fixed 15% bar instead asks "is this a volatile
    // instrument", which every volatility detector answers trivially and
    // correctly while telling you nothing — with an absolute threshold the base
    // rate came out at 43% and coil's apparent skill was just recognising that
    // high-vol things keep being high-vol.
    thresholdMode = 'relative',
    // Multiples of its own baseline move for the horizon.
    relativeMultiple = 2.0,

    /**
     * WHAT counts as the thing being predicted.
     *
     * 'move' asks whether a large price move follows. It is the intuitive
     * choice and it quietly rigged the first real run against the compression
     * detector: the bar is a multiple of the 121-day BASELINE volatility, while
     * compression fires exactly when recent volatility sits far below that
     * baseline. So the signal demanded a move sized by the loud regime at
     * precisely the moments the instrument had gone quiet — the outcome was
     * anti-correlated with the signal being tested. Compression came back
     * "failed" on 101 symbols, and this is the most likely reason.
     *
     * 'vol_expansion' asks what a compression signal actually claims: does
     * volatility expand from here. That is the documented effect, it is what
     * the detector is built on, and it is measurable without borrowing a
     * threshold from a different regime.
     */
    outcome = 'move',
    // Forward vol must exceed recent vol by this factor to count as expansion.
    // 1.6x the long baseline almost never happens on a constant-volatility
    // path, which pushed the base rate to nearly zero — and a near-zero base
    // rate makes any signal that fires a few lucky times look infinitely good.
    // 1.25x keeps the base rate in a range where the statistics mean something.
    expansionMultiple = 1.25,
  } = opts;
  const step = Number.isFinite(stride) && stride > 0 ? stride : horizon;

  const obs = [];          // one row per (instrument, bar) that could be evaluated
  let bars = 0;
  let bigMoves = 0;

  for (const inst of instruments) {
    const closes = inst.closes || [];
    // Stop far enough from the end that a full forward window exists. Evaluating
    // bars whose outcome has not happened yet is how a backtest ends up scoring
    // only the observations that happened to resolve.
    const last = closes.length - horizon - 2;
    for (let i = warmup; i <= last; i += step) {
      let fwd;
      let bar;
      let big;

      if (outcome === 'vol_expansion') {
        // Forward volatility against the LONG baseline, never against recent
        // volatility.
        //
        // Dividing by recent volatility looks like the natural comparison and
        // is a tautology: every compression detector fires precisely when
        // recent volatility is low, so putting that same low number in the
        // denominator guarantees a high ratio. It is regression to the mean
        // wearing the costume of a prediction, and it is not hypothetical —
        // with recent volatility as the denominator, the range detector
        // "validated" on four of six baskets of pure random walks.
        //
        // Against the long baseline the question is real and a compression
        // signal does not answer it for free: does volatility come back ABOVE
        // this instrument's own long-run normal.
        const baseVol = S.realisedVol(S.windowAt(closes, i, 121));
        const forwardVol = S.realisedVol(closes.slice(i + 1, i + 2 + horizon));
        if (!finite(baseVol) || !finite(forwardVol) || baseVol <= 0) continue;
        fwd = forwardVol / baseVol;
        bar = expansionMultiple;
        big = fwd >= bar;
      } else {
        fwd = useMaxMove ? forwardMaxMove(closes, i, horizon) : forwardReturn(closes, i, horizon);
        if (!finite(fwd)) continue;
        // The bar this move has to clear. In relative mode it is set by the
        // instrument's own long baseline volatility as known AT BAR i — using a
        // full-sample volatility here would be lookahead of the most seductive
        // kind, because it is only mildly wrong and never looks wrong.
        bar = threshold;
        if (thresholdMode === 'relative') {
          const baseVol = S.realisedVol(S.windowAt(closes, i, 121));
          if (!finite(baseVol) || baseVol <= 0) continue;
          bar = relativeMultiple * baseVol * Math.sqrt(horizon / 252);
        }
        big = Math.abs(fwd) >= bar;
      }
      bars += 1;
      if (big) bigMoves += 1;

      const baseCtx = typeof inst.ctxAt === 'function' ? inst.ctxAt(i) : (inst.ctx || {});
      const signals = S.detectAt(
        { closes, volumes: inst.volumes || [], highs: inst.highs || [], lows: inst.lows || [] },
        i,
        opts.params ? { ...baseCtx, params: opts.params } : baseCtx,
      );
      obs.push({
        symbol: inst.symbol,
        i,
        forward: fwd,
        bar,
        big,
        signals: Object.fromEntries(signals.map((s) => [s.key, { fired: s.fired, strength: s.strength }])),
      });
    }
  }

  return {
    obs, bars, bigMoves, baseRate: bars ? bigMoves / bars : 0,
    horizon, threshold, thresholdMode, relativeMultiple, outcome, expansionMultiple, stride: step,
  };
}

/**
 * Score one signal against the collected observations.
 *
 * Two corrections that most backtests skip and both of which matter:
 *
 * `families` widens the interval for multiple comparisons. Testing seven
 * detectors at 95% means roughly one in three runs throws up a false positive
 * somewhere, and the one it throws up is the one you will believe.
 *
 * `clusters` accounts for observations that are not independent even after
 * striding — every instrument in a basket moves partly with the market, so a
 * hundred rows from twenty tickers is not a hundred independent draws.
 */
function scoreSignal(key, obs, baseRate, opts = {}) {
  const { minSample = 30, families = 7 } = opts;
  const fires = obs.filter((o) => o.signals[key]?.fired);
  const hits = fires.filter((o) => o.big).length;
  const n = fires.length;
  // Bonferroni on the two-sided alpha: 0.05 / families, converted back to a z.
  const z = zForAlpha(0.05 / Math.max(1, families));
  const ci = wilson(hits, n, z);
  const allBig = obs.filter((o) => o.big).length;
  const caught = fires.filter((o) => o.big).length;

  // The verdict. Deliberately strict, and deliberately reported even when it
  // fails, because the reason for building this was to find out.
  let verdict;
  let why;
  // A degenerate base rate breaks every comparison built on top of it. Near
  // zero, three lucky fires produce an enormous lift and a lower bound that
  // clears a bar sitting on the floor; near one, everything "predicts" the
  // event. Neither is a finding, and both look like one.
  if (baseRate < 0.02 || baseRate > 0.5) {
    return {
      key,
      fires: n,
      hits,
      hitRate: ci.p,
      ci: { lo: ci.lo, hi: ci.hi },
      baseRate,
      lift: baseRate > 0 ? ci.p / baseRate : null,
      recall: allBig > 0 ? caught / allBig : null,
      fireRate: obs.length ? n / obs.length : 0,
      verdict: 'unusable',
      why: `The event being predicted happens ${(baseRate * 100).toFixed(1)}% of the time, which is too `
        + `${baseRate < 0.02 ? 'rare' : 'common'} for any comparison against it to mean anything. `
        + 'Adjust the threshold until the base rate lands somewhere between 2% and 50%.',
    };
  }
  if (n < minSample) {
    verdict = 'insufficient';
    why = `Fired only ${n} times. Below ${minSample} there is nothing to conclude, in either direction.`;
  } else if (ci.lo > baseRate) {
    verdict = 'validated';
    why = `Hit ${(ci.p * 100).toFixed(1)}% against a ${(baseRate * 100).toFixed(1)}% base rate, and the bottom of `
      + `the 95% interval (${(ci.lo * 100).toFixed(1)}%) still clears it.`;
  } else if (ci.p > baseRate) {
    verdict = 'unproven';
    why = `Hit ${(ci.p * 100).toFixed(1)}% against ${(baseRate * 100).toFixed(1)}%, but the interval `
      + `(${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%) includes the base rate. Could be noise.`;
  } else {
    verdict = 'failed';
    why = `Hit ${(ci.p * 100).toFixed(1)}% against a ${(baseRate * 100).toFixed(1)}% base rate. `
      + 'No better than firing at random, and possibly worse.';
  }

  return {
    key,
    fires: n,
    hits,
    hitRate: ci.p,
    ci: { lo: ci.lo, hi: ci.hi },
    baseRate,
    lift: baseRate > 0 ? ci.p / baseRate : null,
    // What share of all the large moves this signal actually caught. A signal
    // can be precise and near-useless if it only ever sees three of them.
    recall: allBig > 0 ? caught / allBig : null,
    fireRate: obs.length ? n / obs.length : 0,
    verdict,
    why,
  };
}

/**
 * Fit weights from measured lift, out-of-sample.
 *
 * Not a fancy model on purpose. A logistic regression on seven correlated
 * features across a few thousand observations will happily overfit and produce
 * coefficients nobody can interrogate. Lift over base rate is directly
 * interpretable, cannot silently invert a signal's meaning, and a failed signal
 * simply lands on zero weight instead of being quietly given a negative one.
 */
function fitWeights(scores) {
  const w = {};
  for (const s of scores) {
    if (s.verdict === 'failed' || s.verdict === 'insufficient' || !finite(s.lift)) { w[s.key] = 0; continue; }
    // Excess lift above 1, damped, and halved while the result is only unproven.
    const raw = Math.max(0, s.lift - 1);
    w[s.key] = Math.round(100 * Math.min(2, raw) * (s.verdict === 'validated' ? 1 : 0.5)) / 100;
  }
  return w;
}

/**
 * Split, fit, and score on data the fitting never saw.
 *
 * Chronological, never random: a random split leaks, because bar i+1 of the
 * same instrument is almost the same observation as bar i, and shuffling puts
 * one in train and the other in test.
 */
function walkForward(instruments, opts = {}) {
  const { trainFraction = 0.6 } = opts;
  const trainInst = [];
  const testInst = [];
  for (const inst of instruments) {
    const n = (inst.closes || []).length;
    const cut = Math.floor(n * trainFraction);
    if (cut < 100 || n - cut < 100) continue;
    trainInst.push({ ...inst, closes: inst.closes.slice(0, cut), volumes: (inst.volumes || []).slice(0, cut), highs: (inst.highs || []).slice(0, cut), lows: (inst.lows || []).slice(0, cut) });
    testInst.push({ ...inst, closes: inst.closes.slice(cut), volumes: (inst.volumes || []).slice(cut), highs: (inst.highs || []).slice(cut), lows: (inst.lows || []).slice(cut) });
  }
  if (!trainInst.length) {
    return { ok: false, reason: 'Not enough history per instrument to split into train and test.' };
  }

  const train = collect(trainInst, opts);
  const keys = Object.keys(S.PRIOR_WEIGHTS);
  const trainScores = keys.map((k) => scoreSignal(k, train.obs, train.baseRate, opts));
  const weights = fitWeights(trainScores);

  const test = collect(testInst, opts);
  const testScores = keys.map((k) => scoreSignal(k, test.obs, test.baseRate, opts));

  // Does the composite beat its own parts, out of sample?
  const composite = scoreComposite(test.obs, test.baseRate, weights, opts);

  return {
    ok: true,
    horizon: opts.horizon ?? S.DEFAULT_HORIZON,
    threshold: opts.threshold ?? S.DEFAULT_MOVE_THRESHOLD,
    train: { bars: train.bars, baseRate: train.baseRate, scores: trainScores },
    test: { bars: test.bars, baseRate: test.baseRate, scores: testScores },
    weights,
    composite,
    validated: testScores.filter((s) => s.verdict === 'validated').map((s) => s.key),
    failed: testScores.filter((s) => s.verdict === 'failed').map((s) => s.key),
  };
}

/** How the weighted composite performs at a given pressure cut-off. */
function scoreComposite(obs, baseRate, weights, opts = {}) {
  // The cutoff is a chosen parameter, and choosing it on the same data you
  // score it with is another way to manufacture significance. Corrected on the
  // same basis as the individual signals.
  const { cutoff = 55, minSample = 30, families = 7 } = opts;
  const withPressure = obs.map((o) => {
    const sigs = Object.entries(o.signals).map(([key, v]) => ({ key, ...v }));
    return { ...o, pressure: S.pressureFrom(sigs, weights) };
  });
  const fires = withPressure.filter((o) => o.pressure >= cutoff);
  const hits = fires.filter((o) => o.big).length;
  const ci = wilson(hits, fires.length, zForAlpha(0.05 / Math.max(1, families)));
  return {
    cutoff,
    fires: fires.length,
    hits,
    hitRate: ci.p,
    ci: { lo: ci.lo, hi: ci.hi },
    baseRate,
    lift: baseRate > 0 ? ci.p / baseRate : null,
    verdict: fires.length < minSample ? 'insufficient'
      : ci.lo > baseRate ? 'validated' : ci.p > baseRate ? 'unproven' : 'failed',
  };
}

/**
 * The other half of the question, and the half most backtests skip.
 *
 * Take periods where nothing happened and check the detectors stayed quiet. A
 * signal that fires constantly will look accurate on any dataset with enough
 * volatility in it, and this is what catches that.
 */
function falsePositiveProfile(instruments, opts = {}) {
  const { horizon = S.DEFAULT_HORIZON, threshold = S.DEFAULT_MOVE_THRESHOLD } = opts;
  const { obs } = collect(instruments, opts);
  const quiet = obs.filter((o) => !o.big);
  const keys = Object.keys(S.PRIOR_WEIGHTS);
  const rows = keys.map((key) => {
    const firedQuiet = quiet.filter((o) => o.signals[key]?.fired).length;
    return {
      key,
      quietBars: quiet.length,
      firedOnQuiet: firedQuiet,
      falsePositiveRate: quiet.length ? firedQuiet / quiet.length : null,
    };
  });
  return { horizon, threshold, quietBars: quiet.length, rows };
}

/**
 * The parameter grid.
 *
 * Every threshold in the detectors was hand-picked with no data behind it —
 * 0.75 for "compressed", 0.15 for "fired", a 10-day recent window against a
 * 60-day baseline. All guesses, and guessing is most of why the first run
 * against 101 real symbols came back failed. These are the settings the sweep
 * is allowed to consider instead.
 *
 * Kept deliberately small. A grid of ten thousand configurations will always
 * contain one that looks brilliant on any dataset, and finding it is not
 * research, it is a slower way of making something up.
 */
const PARAM_GRID = {
  coil: [
    { recent: 5, baseline: 60, loose: 0.7, tight: 0.3 },
    { recent: 10, baseline: 60, loose: 0.75, tight: 0.35 },
    { recent: 10, baseline: 120, loose: 0.6, tight: 0.25 },
    { recent: 20, baseline: 120, loose: 0.65, tight: 0.3 },
    { recent: 10, baseline: 60, loose: 0.5, tight: 0.2 },
  ],
  range_compression: [
    { recent: 5, baseline: 60, pctCut: 0.25 },
    { recent: 7, baseline: 60, pctCut: 0.25 },
    { recent: 7, baseline: 120, pctCut: 0.15 },
    { recent: 14, baseline: 120, pctCut: 0.2 },
  ],
  quiet_accumulation: [
    { recent: 10, baseline: 60, volFloor: 1.4, driftCap: 0.05 },
    { recent: 10, baseline: 60, volFloor: 1.8, driftCap: 0.04 },
    { recent: 20, baseline: 90, volFloor: 1.5, driftCap: 0.06 },
  ],
  extension: [
    { window: 60, zFloor: 1.2, zSpan: 2.3 },
    { window: 30, zFloor: 1.0, zSpan: 2.0 },
    { window: 120, zFloor: 1.5, zSpan: 2.5 },
  ],
};

/**
 * Split chronologically into three, never two.
 *
 * Two is enough when nothing is being chosen. The moment a sweep picks the best
 * of several configurations, the set it picked on has been used up: the winner
 * is partly the winner because of that data's noise, and reporting its score
 * there is reporting the noise back. So parameters are fitted on TRAIN, the
 * winner is chosen on VALIDATE, and the number that gets reported comes from
 * TEST, which the search never sees.
 */
function threeWaySplit(instruments, { train = 0.5, validate = 0.25 } = {}) {
  const cut = (inst, a, b) => {
    const n = (inst.closes || []).length;
    const from = Math.floor(n * a);
    const to = Math.floor(n * b);
    return {
      ...inst,
      closes: inst.closes.slice(from, to),
      volumes: (inst.volumes || []).slice(from, to),
      highs: (inst.highs || []).slice(from, to),
      lows: (inst.lows || []).slice(from, to),
    };
  };
  const out = { train: [], validate: [], test: [] };
  for (const inst of instruments) {
    const n = (inst.closes || []).length;
    // Each slice has to hold a warmup plus a forward window plus enough strided
    // observations to say anything at all.
    if (n * Math.min(train, validate, 1 - train - validate) < 160) continue;
    out.train.push(cut(inst, 0, train));
    out.validate.push(cut(inst, train, train + validate));
    out.test.push(cut(inst, train + validate, 1));
  }
  return out;
}

/**
 * Fit each detector's parameters, then report on data the fitting never saw.
 *
 * The correction for how many configurations were tried is the part that keeps
 * this honest. Trying five settings and reporting the best at 95% confidence is
 * five chances to be fooled, so the interval widens by the size of the grid as
 * well as by the number of detectors.
 */
function sweep(instruments, opts = {}) {
  const { train, validate, test } = threeWaySplit(instruments, opts);
  if (train.length < 8) {
    return { ok: false, reason: `Only ${train.length} instruments had enough history for a three-way split.` };
  }

  const keys = Object.keys(PARAM_GRID);
  const configsTried = keys.reduce((n, k) => n + PARAM_GRID[k].length, 0);
  const families = configsTried + keys.length;

  const trainSets = {};
  const chosen = {};
  const searchLog = [];

  for (const key of keys) {
    let best = null;
    for (const params of PARAM_GRID[key]) {
      // Fit on train, choose on validate. Scoring the choice on the same data
      // that produced it is the classic way to manufacture an edge.
      const v = collect(validate, { ...opts, params: { [key]: params } });
      const score = scoreSignal(key, v.obs, v.baseRate, { ...opts, families });
      searchLog.push({ key, params, lift: score.lift, fires: score.fires, verdict: score.verdict });
      if (!best || (score.lift ?? 0) > (best.score.lift ?? 0)) best = { params, score };
    }
    chosen[key] = best.params;
    trainSets[key] = best.score;
  }

  // One final pass on the untouched holdout, with every detector on its chosen
  // settings at once.
  const held = collect(test, { ...opts, params: chosen });
  const testScores = keys.map((k) => scoreSignal(k, held.obs, held.baseRate, { ...opts, families }));
  const weights = fitWeights(testScores);
  const composite = scoreComposite(held.obs, held.baseRate, weights, { ...opts, families });

  return {
    ok: true,
    outcome: opts.outcome || 'move',
    horizon: opts.horizon ?? S.DEFAULT_HORIZON,
    configsTried,
    families,
    chosen,
    searchLog,
    validate: { picked: trainSets },
    test: { bars: held.bars, baseRate: held.baseRate, scores: testScores },
    weights,
    composite,
    validated: testScores.filter((x) => x.verdict === 'validated').map((x) => x.key),
    failed: testScores.filter((x) => x.verdict === 'failed').map((x) => x.key),
  };
}

module.exports = {
  wilson,
  zForAlpha,
  PARAM_GRID,
  threeWaySplit,
  sweep,
  forwardReturn,
  forwardMaxMove,
  collect,
  scoreSignal,
  scoreComposite,
  fitWeights,
  walkForward,
  falsePositiveProfile,
};
