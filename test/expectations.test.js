'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { expectationsFor, incomeOutcomes, movementOutcomes, volatilityOf } = require('../src/core/expectations');

/**
 * The expectations band.
 *
 * The property that matters is not that the numbers are right — nobody can know
 * that — but that they are ORDERED and HONEST: the bad case is worse than the
 * typical one, a guaranteed deposit never shows a loss, and something that can
 * go to zero is not described with a tidy percentile.
 */

let rows;
before(async () => {
  const { adapters } = loadAdapters();
  const r = await aggregate(adapters, { offline: true });
  rows = r.opportunities;
});

const pick = (fn) => rows.find(fn);

describe('the band is ordered and the tail is the worst of it', () => {
  test('good >= typical >= bad >= tail, on every row that produces a band', () => {
    let checked = 0;
    for (const o of rows) {
      const e = incomeOutcomes(o, { amount: 10000 });
      if (!e) continue;
      checked += 1;
      const p = e.pct;
      assert.ok(p.good >= p.typical - 1e-9, `${o.name}: good ${p.good} < typical ${p.typical}`);
      assert.ok(p.typical >= p.bad - 1e-9, `${o.name}: typical ${p.typical} < bad ${p.bad}`);
      assert.ok(p.bad >= p.tail - 1e-9, `${o.name}: bad ${p.bad} < tail ${p.tail}`);
    }
    assert.ok(checked > 200, `only ${checked} rows produced a band`);
  });

  test('dollars follow the percentages, on the amount given', () => {
    const o = pick((x) => x.section === 'income' && Number.isFinite(x.apy?.total));
    const e = incomeOutcomes(o, { amount: 25000 });
    for (const k of ['good', 'typical', 'bad', 'tail']) {
      assert.ok(Math.abs(e.dollars[k] - 25000 * e.pct[k]) < 0.01, `${k} dollars do not follow its percentage`);
    }
  });

  test('with no amount there are no dollars, rather than dollars on a guess', () => {
    const o = pick((x) => x.section === 'income');
    assert.strictEqual(incomeOutcomes(o, {}).dollars, null);
  });
});

describe('the two kinds of uncertainty are never conflated', () => {
  test('a guaranteed deposit never shows a loss of principal', () => {
    const guaranteed = rows.filter((o) => o.rating?.grade === 'A+' && !o.risk?.principalAtRisk);
    assert.ok(guaranteed.length > 5, 'expected insured deposits in the dataset');
    for (const o of guaranteed) {
      const e = incomeOutcomes(o, { amount: 10000 });
      assert.strictEqual(e.kind, 'rate', `${o.name} described as principal risk`);
      assert.ok(e.pct.bad >= 0, `${o.name} shows a loss on guaranteed principal`);
      assert.ok(/principal is not at risk/i.test(e.headline));
    }
  });

  test('anything whose principal can move says so in the headline', () => {
    const risky = rows.filter((o) => o.risk?.principalAtRisk && o.section !== 'movement').slice(0, 40);
    assert.ok(risky.length > 10);
    for (const o of risky) {
      const e = incomeOutcomes(o, { amount: 10000 });
      assert.strictEqual(e.kind, 'principal');
      assert.ok(/PRINCIPAL/.test(e.headline), `${o.name} does not warn that principal can move`);
    }
  });

  test('a worse grade has a worse tail', () => {
    const tailFor = (grade) => {
      const o = pick((x) => x.rating?.grade === grade && x.risk?.principalAtRisk);
      return o ? incomeOutcomes(o, { amount: 10000 }).pct.tail : null;
    };
    const c = tailFor('C');
    const f = tailFor('F');
    if (c !== null && f !== null) {
      assert.ok(f < c, `an F row (${f.toFixed(2)}) must have a worse tail than a C row (${c.toFixed(2)})`);
    }
  });
});

describe('the unbounded cases are not given a tidy percentile', () => {
  test('an F row says the tail is not a distribution', () => {
    const o = pick((x) => x.rating?.grade === 'F');
    assert.ok(o, 'expected an F row');
    const e = incomeOutcomes(o, { amount: 10000 });
    assert.ok(e.unbounded, 'an F row must refuse to bound its worst case');
    assert.ok(/zero/.test(e.unbounded));
  });

  test('an insured row does not', () => {
    const o = pick((x) => x.rating?.grade === 'A+' && !x.risk?.principalAtRisk);
    assert.strictEqual(incomeOutcomes(o, { amount: 10000 }).unbounded, null);
  });
});

describe('movement bands describe a distribution, not a forecast', () => {
  test('the bands widen with the number of standard deviations', () => {
    const o = pick((x) => volatilityOf(x) > 0);
    const m = movementOutcomes(o, { horizonDays: 30 });
    assert.ok(m.bands[0].pct < m.bands[1].pct && m.bands[1].pct < m.bands[2].pct);
    assert.ok(m.bands.every((b) => /month/.test(b.odds)), 'each band must state how often, not just how big');
  });

  test('a longer horizon means a wider ordinary move', () => {
    const o = pick((x) => volatilityOf(x) > 0);
    const short = movementOutcomes(o, { horizonDays: 7 });
    const long = movementOutcomes(o, { horizonDays: 90 });
    assert.ok(long.bands[0].pct > short.bands[0].pct);
  });

  test('it admits the model understates the extremes', () => {
    const o = pick((x) => volatilityOf(x) > 0);
    const m = movementOutcomes(o, { horizonDays: 30 });
    assert.ok(m.assumptions.some((a) => /fatter tails|understates/i.test(a)),
      'a normal-distribution band that does not admit fat tails is overconfident');
    assert.ok(/which way/i.test(m.direction), 'must restate that this is not directional');
  });

  test('no volatility means no band, rather than a made-up one', () => {
    assert.strictEqual(movementOutcomes({}, {}), null);
    assert.strictEqual(movementOutcomes({ volatility: 0 }, {}), null);
    assert.strictEqual(movementOutcomes(null, {}), null);
    assert.strictEqual(volatilityOf(undefined), null);
  });
});

describe('every row either gets an expectation or honestly gets none', () => {
  test('expectationsFor never throws across the whole dataset', () => {
    let got = 0;
    for (const o of rows) {
      const e = expectationsFor(o, { amount: 10000, horizonDays: 30 });
      if (e) got += 1;
    }
    assert.ok(got > rows.length * 0.5, `only ${got} of ${rows.length} rows produced expectations`);
  });
});
