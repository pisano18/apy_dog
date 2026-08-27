'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { buildPlan, TIERS } = require('../src/core/plan');

/**
 * The plan, which is the only part of this app that expresses an opinion about
 * ORDER rather than about rank.
 *
 * A sorted table can be wrong by a decimal. A plan can be wrong by putting a
 * 5.4% CD above a 100% employer match, which is a different category of wrong.
 */

let rows;
before(async () => {
  const { adapters } = loadAdapters();
  const r = await aggregate(adapters, { offline: true });
  rows = r.opportunities;
});

const idsOf = (p) => p.steps.map((s) => s.id);
const tiersOf = (p) => p.steps.map((s) => s.tier);

describe('the ordering is the advice', () => {
  test('the employer match comes before everything', () => {
    const p = buildPlan(rows, { budget: 25000, facts: { employerMatches: true } });
    assert.strictEqual(p.steps[0].tier, 'match',
      `plan led with ${p.steps[0].tier}: ${p.steps[0].name}`);
  });

  test('expensive debt outranks every yield in the app', () => {
    const p = buildPlan(rows, { budget: 25000, facts: { employerMatches: false, cardBalance: 5000, cardApr: 25 } });
    const t = tiersOf(p);
    assert.strictEqual(t[0], 'debt');
    assert.ok(t.indexOf('core') > 0, 'nothing should sit above clearing a 25% balance');
  });

  test('tiers only ever appear in their declared order', () => {
    const p = buildPlan(rows, {
      budget: 40000,
      facts: { employerMatches: true, cardBalance: 2000, monthlyExpenses: 3000, hoursAvailable: 8 },
    });
    const order = TIERS.map((t) => t.key);
    const seen = tiersOf(p).map((k) => order.indexOf(k));
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i] >= seen[i - 1], `tier ${tiersOf(p)[i]} appeared after ${tiersOf(p)[i - 1]}`);
    }
  });

  test('no step is listed twice', () => {
    const p = buildPlan(rows, {
      budget: 25000,
      facts: { employerMatches: true, cardBalance: 3000, monthlyExpenses: 3500, hoursAvailable: 6 },
    });
    const ids = idsOf(p);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicated: ${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
  });
});

describe('it respects the constraints it was given', () => {
  test('it never allocates more than the budget', () => {
    for (const budget of [500, 1200, 10000, 250000]) {
      const p = buildPlan(rows, { budget, facts: { monthlyExpenses: 2000, hoursAvailable: 10 } });
      const used = p.steps.reduce((n, s) => n + (s.capital || 0), 0);
      assert.ok(used <= budget + 0.5, `allocated ${used} of ${budget}`);
      assert.ok(p.unallocated >= 0);
      assert.ok(Math.abs(used + p.unallocated - budget) < 1, 'allocation and remainder must account for the budget');
    }
  });

  test('it never spends more of your time than you said you had', () => {
    for (const hours of [0, 1, 4, 20]) {
      const p = buildPlan(rows, { budget: 50000, facts: { hoursAvailable: hours } });
      assert.ok(p.minutesUsed <= hours * 60,
        `used ${p.minutesUsed} minutes of a ${hours * 60}-minute budget`);
    }
  });

  test('with no hours to spare, nothing that needs chasing is proposed', () => {
    const p = buildPlan(rows, { budget: 50000, facts: { hoursAvailable: 0 } });
    assert.strictEqual(p.steps.filter((s) => s.tier === 'bounded' || s.tier === 'expiring').length, 0);
    assert.ok(p.skipped.length > 0, 'and it should say what it skipped rather than silently dropping it');
  });

  test('saying there is no match removes the step rather than hiding the question', () => {
    const p = buildPlan(rows, { budget: 10000, facts: { employerMatches: false } });
    assert.strictEqual(p.steps.filter((s) => s.tier === 'match').length, 0);
    assert.ok(p.skipped.some((s) => s.tier === 'match'));
  });

  test('what it has not been told is stated, not guessed', () => {
    const p = buildPlan(rows, { budget: 10000, facts: {} });
    assert.ok(p.notKnown.length >= 2, 'unknowns must be surfaced');
    assert.ok(p.notKnown.some((n) => /balance/i.test(n)));
    assert.ok(p.notKnown.some((n) => /month/i.test(n)));
  });
});

describe('the totals do not mix two different kinds of money', () => {
  test('a small budget cannot claim a large return on capital', () => {
    // The bug this exists to stop: a $1,200 plan reporting $9,201 of first-year
    // money, because a pre-tax commuter election that needs no capital was
    // summed with a yield on a balance.
    const p = buildPlan(rows, { budget: 1200, facts: { hoursAvailable: 4 } });
    assert.ok((p.fromCapital ?? 0) <= 1200 * 1.5,
      `claimed ${p.fromCapital} of capital return on a $1,200 budget`);
  });

  test('capital returns only come from steps that consumed capital', () => {
    const p = buildPlan(rows, { budget: 30000, facts: { monthlyExpenses: 2500, hoursAvailable: 6 } });
    const recomputed = p.steps
      .filter((s) => s.capital > 0 && Number.isFinite(s.dollars))
      .reduce((n, s) => n + s.dollars, 0);
    assert.ok(Math.abs((p.fromCapital ?? 0) - recomputed) < 1);
  });
});

describe('it does not sell you anything without the catch', () => {
  test('a card sign-up step carries its caution', () => {
    const p = buildPlan(rows, { budget: 30000, facts: { hoursAvailable: 12 } });
    const cards = p.steps.filter((s) => /welcome offer|sign-?up/i.test(s.name));
    for (const c of cards) {
      assert.ok(c.caution && /spend you were already|balance/i.test(c.caution),
        `${c.name} proposed with no caution attached`);
    }
  });

  test('a risky core holding says so', () => {
    const p = buildPlan(rows, { budget: 20000, facts: { hoursAvailable: 1 } });
    for (const s of p.steps.filter((x) => x.tier === 'core')) {
      if (['C', 'D', 'E', 'F'].includes(s.grade)) {
        assert.ok(/risk|Grade/i.test(`${s.note || ''} ${s.caution || ''}`),
          `${s.name} is a ${s.grade} and the plan says nothing about it`);
      }
    }
  });

  test('a step whose size is unknowable never states a dollar figure', () => {
    const p = buildPlan(rows, { budget: 20000, facts: { employerMatches: true } });
    for (const s of p.steps.filter((x) => x.dollarsUnknown)) {
      assert.strictEqual(s.dollars, null, `${s.name} quotes dollars it cannot know`);
    }
  });
});
