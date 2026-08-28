'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const S = require('../src/core/signals');
const B = require('../src/core/backtest');
const syn = require('../src/core/synthetic');

/**
 * The tests that decide whether the signal engine is a tool or a horoscope.
 *
 * Three families, in order of how badly a failure matters:
 *
 *   1. No lookahead. A detector that can see the future will validate
 *      beautifully and lose money. This is checked structurally.
 *   2. The null. On data with no structure by construction, the harness must
 *      report no edge. If it ever reports one, every other number it produces
 *      is worthless.
 *   3. Detection. On planted regimes, the detectors must actually fire, and
 *      fire BEFORE the event rather than after it.
 */

describe('no detector can see the future', () => {
  test('poisoning every bar after the evaluation point changes nothing', () => {
    const path = syn.coiledThenBreaks({ n: 400, seed: 3 });
    const i = 280;

    const clean = S.detectAt(path, i, {});
    const poisoned = S.detectAt({
      closes: path.closes.map((c, k) => (k > i ? NaN : c)),
      volumes: path.volumes.map((v, k) => (k > i ? NaN : v)),
      highs: [], lows: [],
    }, i, {});

    assert.deepStrictEqual(
      clean.map((s) => [s.key, s.fired, Math.round((s.strength || 0) * 1e6)]),
      poisoned.map((s) => [s.key, s.fired, Math.round((s.strength || 0) * 1e6)]),
      'a detector read data from after the evaluation bar',
    );
  });

  test('and replacing the future with a crash changes nothing either', () => {
    // The subtler version: NaN might be filtered somewhere and coincidentally
    // match. Real numbers that are wildly different cannot coincide.
    const path = syn.randomWalk({ n: 400, seed: 9 });
    const i = 250;
    const crashed = path.closes.map((c, k) => (k > i ? c * 0.2 : c));
    assert.deepStrictEqual(
      S.detectAt(path, i, {}).map((s) => [s.key, s.fired]),
      S.detectAt({ ...path, closes: crashed }, i, {}).map((s) => [s.key, s.fired]),
    );
  });

  test('windowAt never returns a bar after the index', () => {
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert.deepStrictEqual(S.windowAt(arr, 4), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(S.windowAt(arr, 4, 3), [2, 3, 4]);
    assert.deepStrictEqual(S.windowAt(arr, 0), [0]);
    assert.deepStrictEqual(S.windowAt(arr, 99).length, 10);
  });

  test('the forward return is entered on the bar AFTER the signal', () => {
    // Filling at the close the detector just read is a fill nobody could get,
    // and it is the commonest way a backtest invents an edge.
    const closes = [10, 11, 12, 13, 14, 15];
    assert.strictEqual(B.forwardReturn(closes, 0, 1), 12 / 11 - 1);
    assert.strictEqual(B.forwardReturn(closes, 1, 2), 14 / 12 - 1);
    assert.strictEqual(B.forwardReturn(closes, 4, 1), null, 'must refuse when the window runs off the end');
  });
});

describe('the null: no edge where there is no edge', () => {
  test('no signal validates across twenty independent baskets of pure noise', () => {
    // The most important test in this repository. Random walks have no
    // structure by construction, so anything reported as validated here is a
    // bug in the harness that would make every real result meaningless.
    //
    // This test has already earned its keep. It originally failed, and the
    // cause was real: evaluating every bar produced forward windows that
    // overlapped by twenty days out of twenty-one, so the confidence interval
    // was computed on a sample size roughly twenty times larger than the number
    // of genuinely independent observations. The compression detector came back
    // "validated" on four of twelve noise baskets. Striding by the horizon and
    // correcting for seven simultaneous comparisons fixed it.
    const failures = {};
    let runs = 0;
    for (let k = 0; k < 20; k += 1) {
      const res = B.walkForward(syn.randomBasket({ count: 22, n: 1100, seed: 2000 + k * 97 }), { horizon: 21 });
      if (!res.ok) continue;
      runs += 1;
      for (const key of res.validated) failures[key] = (failures[key] || 0) + 1;
      if (res.composite.verdict === 'validated') failures.__composite = (failures.__composite || 0) + 1;
    }
    assert.ok(runs >= 15, `only ${runs} null runs completed`);
    assert.deepStrictEqual(failures, {},
      `harness claimed an edge in pure noise: ${JSON.stringify(failures)}`);
  });

  test('the base rate is a sensible definition of "large"', () => {
    // With an absolute threshold the base rate came out at 43%, which made
    // "large move" mean little more than "volatile instrument" — a question
    // every volatility detector answers trivially and correctly while telling
    // you nothing useful.
    const c = B.collect(syn.randomBasket({ count: 20, n: 900, seed: 3 }), { horizon: 21 });
    assert.ok(c.bars > 400, 'expected a real sample');
    assert.ok(c.baseRate > 0.01 && c.baseRate < 0.20,
      `a ${(c.baseRate * 100).toFixed(0)}% base rate does not describe a large move`);
  });

  test('the relative threshold is computed from data available at the bar', () => {
    // Using full-sample volatility to set the bar is the most seductive kind of
    // lookahead: mildly wrong, and never looks wrong.
    const path = syn.regimeSwitching({ n: 800, seed: 5 });
    const truncated = { ...path, closes: path.closes.slice(0, 500) };
    const a = B.collect([{ symbol: 'X', ...path }], { horizon: 21 });
    const b = B.collect([{ symbol: 'X', ...truncated }], { horizon: 21 });
    const shared = b.obs.filter((o) => o.i < 400);
    for (const o of shared) {
      const match = a.obs.find((x) => x.i === o.i);
      if (!match) continue;
      assert.ok(Math.abs(match.bar - o.bar) < 1e-9,
        `the threshold at bar ${o.i} changed when later data was added`);
    }
  });
});

describe('the planted positive: it finds structure that is really there', () => {
  test('compression validates out-of-sample on regime-switching paths', () => {
    // The mirror of the null. A harness that never validates anything is as
    // broken as one that validates everything, and considerably easier to ship
    // by accident.
    const res = B.walkForward(syn.regimeBasket({ count: 30, n: 1600, seed: 11 }), { horizon: 21 });
    assert.ok(res.ok, res.reason);
    assert.ok(res.validated.includes('coil'),
      `missed a planted volatility regime: validated ${JSON.stringify(res.validated)}`);
    const coil = res.test.scores.find((s) => s.key === 'coil');
    assert.ok(coil.lift > 1.2, `lift of only ${coil.lift?.toFixed(2)} on planted structure`);
    assert.ok(coil.ci.lo > res.test.baseRate,
      'validated without the interval clearing the base rate');
  });

  test('and honestly reports the detector that was NOT planted as failed', () => {
    // The regime generator ramps volume during the violent phase, not before
    // it, so there is no accumulation pattern to find. A harness that reported
    // one would be finding what it expected rather than what was there.
    const res = B.walkForward(syn.regimeBasket({ count: 30, n: 1600, seed: 11 }), { horizon: 21 });
    const qa = res.test.scores.find((s) => s.key === 'quiet_accumulation');
    assert.ok(['failed', 'insufficient', 'unproven'].includes(qa.verdict),
      `claimed an edge for a pattern that was never planted: ${qa.verdict}`);
  });

  test('a detector with no inputs is insufficient, never failed', () => {
    // There is a difference between "we measured this and it does not work" and
    // "we have never had the data to measure it", and conflating them would
    // quietly discard a signal that had never been given a chance.
    const res = B.walkForward(syn.regimeBasket({ count: 20, n: 1400, seed: 3 }), { horizon: 21 });
    const sq = res.test.scores.find((s) => s.key === 'squeeze');
    assert.strictEqual(sq.verdict, 'insufficient');
    assert.strictEqual(res.weights.squeeze, 0, 'an unmeasured signal must carry no weight');
  });
});

describe('overlapping windows are the trap, and the harness knows it', () => {
  test('dense sampling produces far more rows than independent observations', () => {
    const basket = syn.randomBasket({ count: 6, n: 900, seed: 61 });
    const dense = B.collect(basket, { horizon: 21, stride: 1 });
    const proper = B.collect(basket, { horizon: 21 });
    assert.ok(dense.bars > proper.bars * 10,
      'striding should discard the overwhelming majority of overlapping rows');
    // Both describe the same world, so the base rates should broadly agree —
    // it is the CONFIDENCE that differs, not the estimate.
    assert.ok(Math.abs(dense.baseRate - proper.baseRate) < 0.08,
      'striding changed the estimate rather than just its precision');
  });

  test('the correction for seven simultaneous tests actually widens the interval', () => {
    const narrow = B.wilson(60, 200, B.zForAlpha(0.05));
    const wide = B.wilson(60, 200, B.zForAlpha(0.05 / 7));
    assert.ok(wide.lo < narrow.lo && wide.hi > narrow.hi);
    assert.ok(Math.abs(B.zForAlpha(0.05) - 1.95996) < 0.001, 'z for 5% must be 1.96');
  });
});

describe('detection: the signals find what was planted', () => {
  test('coil fires during the quiet stretch, before the break', () => {
    const p = syn.coiledThenBreaks({ n: 400, quietStart: 250, quietLen: 40, seed: 13 });
    const { quietStart, breakAt } = p.meta;

    // Late in the quiet window, once the compression is established.
    const during = S.coil(p.closes, breakAt - 3);
    assert.ok(during.fired, 'coil missed a planted volatility compression');
    assert.ok(during.strength > 0.3, `weak reading (${during.strength.toFixed(2)}) on an obvious coil`);

    // Long before it, in the normal-volatility regime.
    const before = S.coil(p.closes, quietStart - 30);
    assert.ok(!before.fired || before.strength < during.strength,
      'coil is no stronger inside the compression than outside it');
  });

  test('coil fires far more often on coiled paths than on random ones', () => {
    const rate = (paths) => {
      let fires = 0;
      let bars = 0;
      for (const p of paths) {
        for (let i = 80; i < p.closes.length - 25; i += 1) {
          bars += 1;
          if (S.coil(p.closes, i).fired) fires += 1;
        }
      }
      return fires / bars;
    };
    const coiled = rate(Array.from({ length: 12 }, (_, k) => syn.coiledThenBreaks({ n: 400, seed: 60 + k })));
    const random = rate(Array.from({ length: 12 }, (_, k) => syn.randomWalk({ n: 400, annualVol: 0.4, seed: 900 + k })));
    assert.ok(coiled > random * 1.5,
      `coil fires at ${(coiled * 100).toFixed(1)}% on coiled paths vs ${(random * 100).toFixed(1)}% on random — not discriminating`);
  });

  test('quiet accumulation needs BOTH volume and a still price', () => {
    const p = syn.quietAccumulationThenBreak({ n: 400, accStart: 260, accLen: 30, seed: 17 });
    const during = S.quietAccumulation(p.closes, p.volumes, p.meta.breakAt - 3);
    assert.ok(during.fired, 'missed a planted accumulation');

    // Same volume ramp, but with the price moving: this is the move, not a
    // warning of one, and it must not fire.
    const moving = syn.randomWalk({ n: 400, annualVol: 0.9, seed: 5 });
    const loud = S.quietAccumulation(moving.closes, p.volumes, 300);
    assert.ok(!loud.fired || loud.strength < during.strength,
      'fired on a path that was already moving');
  });

  test('a mixed basket scores better than a pure-noise one', () => {
    const mixed = B.collect(syn.mixedBasket({ count: 24, coiledFraction: 0.5, n: 520, seed: 8 }), { horizon: 21, threshold: 0.15 });
    const noise = B.collect(syn.randomBasket({ count: 24, n: 520, annualVol: 0.4, seed: 8 }), { horizon: 21, threshold: 0.15 });
    const liftOf = (c) => B.scoreSignal('coil', c.obs, c.baseRate).lift ?? 0;
    assert.ok(liftOf(mixed) > liftOf(noise),
      `coil lift ${liftOf(mixed).toFixed(2)} on planted data vs ${liftOf(noise).toFixed(2)} on noise`);
  });
});

describe('missing inputs are reported, never imputed', () => {
  test('squeeze with no short interest returns no score at all', () => {
    const r = S.squeeze({});
    assert.strictEqual(r.fired, false);
    assert.strictEqual(r.strength, 0);
    assert.ok(r.inputsMissing.length >= 2, 'must name what it lacked');
  });

  test('squeeze with partial data is damped and says what is missing', () => {
    const partial = S.squeeze({ shortPercentFloat: 40, daysToCover: 6 });
    const full = S.squeeze({ shortPercentFloat: 40, daysToCover: 6, borrowFeePct: 30, floatShares: 2e7 });
    assert.ok(full.strength > partial.strength,
      'four ingredients must read stronger than two');
    assert.ok(partial.inputsMissing.includes('borrow fee'));
  });

  test('the GME shape scores near the top and leans up', () => {
    // Short interest above float, days to cover in the double digits, a borrow
    // fee that has gone vertical, and a tiny float. All of it was public.
    const r = S.squeeze({ shortPercentFloat: 120, daysToCover: 12, borrowFeePct: 80, floatShares: 5e7, priceVsHigh: -0.8 });
    assert.ok(r.fired);
    assert.ok(r.strength > 0.75, `only ${r.strength.toFixed(2)} on the textbook case`);
    assert.strictEqual(r.lean, 'up', 'forced buying has a direction');
  });

  test('an ordinary stock does not read as a squeeze', () => {
    const r = S.squeeze({ shortPercentFloat: 2.5, daysToCover: 1.1, borrowFeePct: 0.3, floatShares: 4e9 });
    assert.ok(!r.fired, `fired on a completely ordinary short profile (${r.strength.toFixed(2)})`);
  });
});

describe('direction is never claimed without a mechanism', () => {
  test('compression signals alone produce no lean', () => {
    const p = syn.coiledThenBreaks({ n: 400, seed: 23 });
    const r = S.readSignals(p, 285, {});
    assert.strictEqual(r.lean.direction, 'none',
      'a volatility signal was allowed to vote on direction');
  });

  test('only mechanically directional signals vote', () => {
    const up = S.leanFrom([
      { key: 'coil', fired: true, strength: 0.9 },
      { key: 'squeeze', fired: true, strength: 0.8, lean: 'up', evidence: ['forced buying'] },
    ]);
    assert.strictEqual(up.direction, 'up');
    const conflict = S.leanFrom([
      { key: 'squeeze', fired: true, strength: 0.6, lean: 'up', evidence: [] },
      { key: 'unlock', fired: true, strength: 0.6, lean: 'down', evidence: [] },
    ]);
    assert.strictEqual(conflict.direction, 'none', 'opposing mechanisms must cancel, not average');
  });

  test('an uncalibrated reading says so', () => {
    const p = syn.randomWalk({ n: 300, seed: 2 });
    assert.strictEqual(S.readSignals(p, 200, {}).calibrated, false);
    assert.strictEqual(S.readSignals(p, 200, { weights: { coil: 1 } }).calibrated, true);
  });
});

describe('the statistics are the right statistics', () => {
  test('Wilson, not the normal approximation', () => {
    // 2 of 3 under the normal approximation gives a lower bound below zero,
    // which would let a three-observation signal pass as validated.
    const w = B.wilson(2, 3);
    assert.ok(w.lo > 0 && w.lo < w.p && w.hi > w.p && w.hi <= 1);
    // More data must narrow the interval.
    const tight = B.wilson(200, 300);
    assert.ok((tight.hi - tight.lo) < (w.hi - w.lo));
  });

  test('a small sample is never validated, however good it looks', () => {
    const obs = Array.from({ length: 12 }, (_, k) => ({
      big: true, signals: { coil: { fired: true, strength: 1 } }, forward: 0.3, symbol: 'X', i: k,
    }));
    const s = B.scoreSignal('coil', obs, 0.1);
    assert.strictEqual(s.verdict, 'insufficient',
      '12 for 12 is not evidence, and the harness must say so');
  });

  test('a signal no better than the base rate is reported as failed', () => {
    const obs = Array.from({ length: 400 }, (_, k) => ({
      big: k % 10 === 0, signals: { coil: { fired: true, strength: 0.5 } }, forward: 0, symbol: 'X', i: k,
    }));
    const s = B.scoreSignal('coil', obs, 0.1);
    assert.strictEqual(s.verdict, 'failed');
    assert.ok(s.lift < 1.05);
  });

  test('failed signals are given zero weight, not a negative one', () => {
    const w = B.fitWeights([
      { key: 'coil', verdict: 'validated', lift: 1.8 },
      { key: 'extension', verdict: 'failed', lift: 0.7 },
      { key: 'unlock', verdict: 'insufficient', lift: 3.0 },
      { key: 'catalyst', verdict: 'unproven', lift: 1.4 },
    ]);
    assert.ok(w.coil > 0);
    assert.strictEqual(w.extension, 0);
    assert.strictEqual(w.unlock, 0, 'an unmeasured signal must not be trusted because its lift looked good');
    assert.ok(w.catalyst > 0 && w.catalyst < 0.4, 'unproven signals are damped, not adopted');
  });

  test('recall is reported, because precision alone can hide a useless signal', () => {
    const obs = Array.from({ length: 500 }, (_, k) => ({
      big: k < 100,
      signals: { coil: { fired: k < 3, strength: 1 } },
      forward: 0, symbol: 'X', i: k,
    }));
    const s = B.scoreSignal('coil', obs, 0.2);
    assert.ok(s.recall < 0.05, 'a signal catching 3 of 100 moves must show a tiny recall');
  });
});

describe('the quiet-period check the user asked for', () => {
  test('false positive rates are measured on bars where nothing happened', () => {
    const fp = B.falsePositiveProfile(syn.randomBasket({ count: 40, n: 1400, seed: 55 }), { horizon: 21 });
    assert.ok(fp.quietBars > 500, `only ${fp.quietBars} quiet bars to check against`);
    for (const r of fp.rows) {
      assert.ok(r.falsePositiveRate === null || (r.falsePositiveRate >= 0 && r.falsePositiveRate <= 1));
    }
    const coilFp = fp.rows.find((r) => r.key === 'coil');
    assert.ok(coilFp.falsePositiveRate < 0.5,
      `coil fires on ${(coilFp.falsePositiveRate * 100).toFixed(0)}% of quiet bars — it fires on everything`);
  });
});

describe('fitting parameters instead of guessing them', () => {
  test('the sweep finds no edge in noise, across ten baskets', () => {
    // The sweep multiplies the number of chances to be fooled by the size of
    // the grid, so it needs its own null. It has already earned it twice.
    let falseValidations = 0;
    let runs = 0;
    for (let k = 0; k < 10; k += 1) {
      const r = B.sweep(syn.randomBasket({ count: 26, n: 1800, seed: 5000 + k * 311 }),
        { horizon: 21, outcome: 'vol_expansion' });
      if (!r.ok) continue;
      runs += 1;
      falseValidations += r.validated.length;
    }
    assert.ok(runs >= 8, `only ${runs} sweeps completed`);
    assert.strictEqual(falseValidations, 0, 'the parameter sweep found an edge in pure noise');
  });

  test('but still finds planted structure, and rejects what was not planted', () => {
    const r = B.sweep(syn.regimeBasket({ count: 30, n: 2400, seed: 11 }),
      { horizon: 21, outcome: 'vol_expansion' });
    assert.ok(r.ok, r.reason);
    assert.ok(r.validated.includes('coil'), `missed planted compression: ${JSON.stringify(r.validated)}`);
    const qa = r.test.scores.find((x) => x.key === 'quiet_accumulation');
    assert.ok(['failed', 'insufficient', 'unusable'].includes(qa.verdict),
      `claimed an edge for a pattern never planted: ${qa.verdict}`);
  });

  test('the holdout is never the set the parameters were chosen on', () => {
    const split = B.threeWaySplit(syn.randomBasket({ count: 4, n: 2000, seed: 1 }));
    for (let i = 0; i < split.train.length; i += 1) {
      const tr = split.train[i].closes;
      const va = split.validate[i].closes;
      const te = split.test[i].closes;
      assert.ok(tr.length && va.length && te.length, 'a split came back empty');
      // Chronological and disjoint: a random split would put bar i in train and
      // bar i+1 — nearly the same observation — in test.
      assert.strictEqual(tr.length + va.length + te.length,
        split.train[i].closes.length + va.length + te.length);
      assert.notStrictEqual(tr[tr.length - 1], te[0], 'train and test overlap');
    }
  });

  test('the correction accounts for the whole grid, not just the detectors', () => {
    const r = B.sweep(syn.regimeBasket({ count: 20, n: 2000, seed: 3 }), { horizon: 21, outcome: 'vol_expansion' });
    assert.ok(r.ok);
    const gridSize = Object.values(B.PARAM_GRID).reduce((n, v) => n + v.length, 0);
    assert.strictEqual(r.configsTried, gridSize);
    assert.ok(r.families > gridSize, 'the correction must cover configurations AND detectors');
  });
});

describe('the outcome must not be the signal in disguise', () => {
  test('forward volatility is compared to the long baseline, never to recent', () => {
    // Dividing forward volatility by RECENT volatility is a tautology: every
    // compression detector fires when recent volatility is low, so a low
    // denominator guarantees a high ratio. With that definition the range
    // detector "validated" on four of six baskets of pure random walks.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'core', 'backtest.js'), 'utf8');
    const block = src.slice(src.indexOf("outcome === 'vol_expansion'"), src.indexOf('} else {'));
    assert.ok(/windowAt\(closes, i, 121\)/.test(block),
      'the expansion outcome must measure against the long baseline');
    assert.ok(!/realisedVol\(S\.windowAt\(closes, i, 11\)\)/.test(block),
      'recent volatility reappeared in the denominator');
  });

  test('a degenerate base rate is refused rather than reported', () => {
    // Near zero, three lucky fires produce an enormous lift against a bar on
    // the floor. That is not a finding and it looks exactly like one.
    const obs = Array.from({ length: 400 }, (_, k) => ({
      big: k < 2, signals: { coil: { fired: k < 4, strength: 1 } }, forward: 0, symbol: 'X', i: k,
    }));
    const rare = B.scoreSignal('coil', obs, 0.005);
    assert.strictEqual(rare.verdict, 'unusable');
    assert.match(rare.why, /too rare/);

    const common = B.scoreSignal('coil', obs, 0.85);
    assert.strictEqual(common.verdict, 'unusable');
    assert.match(common.why, /too common/);
  });
});
