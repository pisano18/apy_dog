'use strict';

/**
 * Price paths with a known answer.
 *
 * Real market history is the only thing that can tell you a signal's real hit
 * rate, and it cannot tell you whether the detector is CORRECTLY IMPLEMENTED —
 * on real data every bug looks like a finding. So the detectors are validated
 * twice: against planted regimes here, where the right answer is known by
 * construction, and against real history on the user's machine, where the hit
 * rate is measured and no answer is known in advance.
 *
 * The most important generator in this file is the plain random walk. If the
 * backtest reports a validated edge on data that by construction has none, the
 * harness is broken and every other number it produces is worthless. That test
 * runs on every commit.
 *
 * Everything is seeded, because a flaky statistical test is worse than no test:
 * it gets muted, and then it is not a test.
 */

/** Deterministic PRNG (mulberry32). Same seed, same path, on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the returns are actually normal rather than uniform-ish. */
function gaussian(next) {
  let u = 0;
  let v = 0;
  while (u === 0) u = next();
  while (v === 0) v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Geometric Brownian motion. No structure, no regimes, nothing to find.
 *
 * The null hypothesis made executable.
 */
function randomWalk({ n = 500, start = 100, annualVol = 0.35, drift = 0, seed = 1 } = {}) {
  const next = rng(seed);
  const dt = 1 / 252;
  const sigma = annualVol * Math.sqrt(dt);
  const mu = (drift - (annualVol ** 2) / 2) * dt;
  const closes = [start];
  const volumes = [];
  for (let i = 1; i < n; i += 1) {
    closes.push(closes[i - 1] * Math.exp(mu + sigma * gaussian(next)));
  }
  for (let i = 0; i < n; i += 1) volumes.push(1e6 * (0.7 + 0.6 * next()));
  return { closes, volumes, highs: [], lows: [] };
}

/**
 * Quiet, then a break. What a coil is supposed to look like.
 *
 * Volatility drops to `quietVol` for `quietLen` bars and then a move of
 * `breakSize` arrives. The detector must fire DURING the quiet stretch — firing
 * after the break is not prediction, it is reading the news.
 */
function coiledThenBreaks({
  n = 400, start = 100, normalVol = 0.5, quietVol = 0.12,
  quietStart = 250, quietLen = 40, breakSize = 0.35, seed = 7,
} = {}) {
  const next = rng(seed);
  const dt = 1 / 252;
  const closes = [start];
  const volumes = [];
  const breakAt = quietStart + quietLen;
  for (let i = 1; i < n; i += 1) {
    const inQuiet = i >= quietStart && i < breakAt;
    const av = inQuiet ? quietVol : normalVol;
    const sigma = av * Math.sqrt(dt);
    let step = -((av ** 2) / 2) * dt + sigma * gaussian(next);
    // The break itself, spread over a handful of bars so it is a move rather
    // than a single impossible gap.
    if (i >= breakAt && i < breakAt + 5) step += Math.log(1 + breakSize) / 5;
    closes.push(closes[i - 1] * Math.exp(step));
  }
  for (let i = 0; i < n; i += 1) volumes.push(1e6 * (0.7 + 0.6 * next()));
  return { closes, volumes, highs: [], lows: [], meta: { quietStart, breakAt } };
}

/**
 * Volume builds while price does not move, then it moves.
 *
 * The accumulation pattern, planted so the detector can be checked against a
 * case where the right answer is known.
 */
function quietAccumulationThenBreak({
  n = 400, start = 100, vol = 0.3, accStart = 260, accLen = 30,
  volumeRamp = 3.5, breakSize = 0.3, seed = 11,
} = {}) {
  const next = rng(seed);
  const dt = 1 / 252;
  const closes = [start];
  const volumes = [1e6];
  const breakAt = accStart + accLen;
  for (let i = 1; i < n; i += 1) {
    const inAcc = i >= accStart && i < breakAt;
    // Price pinned during accumulation: low vol AND no drift.
    const av = inAcc ? vol * 0.25 : vol;
    const sigma = av * Math.sqrt(dt);
    let step = -((av ** 2) / 2) * dt + sigma * gaussian(next);
    if (i >= breakAt && i < breakAt + 5) step += Math.log(1 + breakSize) / 5;
    closes.push(closes[i - 1] * Math.exp(step));
    const base = 1e6 * (0.85 + 0.3 * next());
    volumes.push(inAcc ? base * volumeRamp : base);
  }
  return { closes, volumes, highs: [], lows: [], meta: { accStart, breakAt } };
}

/**
 * A path that repeatedly compresses and then breaks.
 *
 * The single-event generators above are right for asking "does the detector see
 * this one planted coil", and useless for measuring a hit rate: one 40-bar
 * window inside 1,100 bars survives striding as roughly one observation, so a
 * backtest over it is measuring nothing and will report `failed` no matter how
 * good the detector is.
 *
 * Real instruments cycle between quiet and violent constantly. This generates
 * that, giving a planted-positive dataset with enough events to actually have
 * power — while remaining a thing whose right answer is known by construction.
 */
function regimeSwitching({
  n = 1200, start = 100, calmVol = 0.13, liveVol = 0.55,
  calmLen = 30, liveLen = 25, breakSize = 0.28, seed = 31,
} = {}) {
  const next = rng(seed);
  const dt = 1 / 252;
  const closes = [start];
  const volumes = [1e6];
  const breaks = [];
  let i = 1;
  let calm = true;
  while (i < n) {
    // Jitter each stretch so the detector cannot lock onto a fixed period.
    const len = Math.max(8, Math.round((calm ? calmLen : liveLen) * (0.6 + 0.8 * next())));
    for (let k = 0; k < len && i < n; k += 1, i += 1) {
      const av = calm ? calmVol : liveVol;
      const sigma = av * Math.sqrt(dt);
      let step = -((av ** 2) / 2) * dt + sigma * gaussian(next);
      // The break: a directional impulse over the first few bars after a calm
      // stretch ends, sign chosen at random so nothing here is predictable in
      // direction — only in magnitude, which is the entire claim.
      if (!calm && k < 4) {
        const dir = next() < 0.5 ? -1 : 1;
        step += (dir * Math.log(1 + breakSize)) / 4;
        if (k === 0) breaks.push(i);
      }
      closes.push(closes[i - 1] * Math.exp(step));
      volumes.push(1e6 * (0.8 + 0.4 * next()) * (calm ? 1 : 2.2));
    }
    calm = !calm;
  }
  return { closes: closes.slice(0, n), volumes: volumes.slice(0, n), highs: [], lows: [], meta: { breaks } };
}

/** A basket of regime-switching paths: planted magnitude structure, no direction. */
function regimeBasket({ count = 25, n = 1200, seed = 400 } = {}) {
  return Array.from({ length: count }, (_, k) => ({
    symbol: `REG${k}`,
    ...regimeSwitching({ n, seed: seed + k * 523, calmLen: 24 + (k % 5) * 6, liveLen: 20 + (k % 4) * 5 }),
  }));
}

/** A clean trend with constant volatility. Nothing is compressing here. */
function steadyTrend({ n = 400, start = 100, annualVol = 0.3, drift = 0.4, seed = 21 } = {}) {
  return randomWalk({ n, start, annualVol, drift, seed });
}

/** A basket of independent random walks, for base-rate and null testing. */
function randomBasket({ count = 30, n = 500, annualVol = 0.4, seed = 100 } = {}) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    out.push({ symbol: `RND${k}`, ...randomWalk({ n, annualVol, seed: seed + k * 977 }) });
  }
  return out;
}

/** A basket where a known fraction genuinely coil before breaking. */
function mixedBasket({ count = 30, coiledFraction = 0.5, n = 500, seed = 200 } = {}) {
  const out = [];
  const coiledCount = Math.round(count * coiledFraction);
  for (let k = 0; k < count; k += 1) {
    if (k < coiledCount) {
      out.push({ symbol: `COIL${k}`, ...coiledThenBreaks({ n, seed: seed + k * 641, quietStart: 200 + (k % 7) * 20 }) });
    } else {
      out.push({ symbol: `RND${k}`, ...randomWalk({ n, annualVol: 0.4, seed: seed + k * 733 }) });
    }
  }
  return out;
}

module.exports = {
  rng,
  regimeSwitching,
  regimeBasket,
  gaussian,
  randomWalk,
  coiledThenBreaks,
  quietAccumulationThenBreak,
  steadyTrend,
  randomBasket,
  mixedBasket,
};
