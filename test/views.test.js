'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { radarPayload, signalsPayload } = require('../src/core/views');

/**
 * The payloads the interface runs on.
 *
 * These lived inside the Electron main process, where nothing could reach them:
 * thirty-one IPC handlers, zero tests, and between them every crash the app
 * could show somebody. The same gap put three crashes into the backtest script
 * — logic reachable only by running the whole application, and therefore
 * reached first by whoever is using it.
 *
 * Run against the real bundled dataset, because the merging and capping rules
 * here are exactly the kind that look fine on a fixture and fall over on eight
 * hundred rows.
 */

let dataset;
before(async () => {
  const { adapters } = loadAdapters();
  const r = await aggregate(adapters, { offline: true });
  dataset = { opportunities: r.opportunities, events: r.events, health: r.health, meta: r.meta };
});

const radar = (over = {}) => radarPayload(dataset, { settings: {}, watchlist: [], ...over });

describe('the Radar payload', () => {
  test('every card the interface asks for is present and populated', () => {
    const p = radar();
    for (const key of ['closing', 'thisWeek', 'income', 'movement', 'deals', 'obscure', 'easy', 'watching']) {
      assert.ok(p.groups[key], `group "${key}" is missing — a card would render empty`);
      assert.ok(Array.isArray(p.groups[key].rows), `group "${key}" has no rows array`);
      assert.ok(Number.isFinite(p.groups[key].count), `group "${key}" has no count`);
    }
  });

  test('the clock merges expiring offers with dated deadlines', () => {
    const p = radar();
    assert.ok(p.onTheClock.length > 3,
      `only ${p.onTheClock.length} things on the clock — the merge is not happening`);
    const kinds = new Set(p.onTheClock.map((x) => x.type));
    assert.ok(kinds.has('event'), 'dated deadlines never made it into the clock');
  });

  test('it is ordered by urgency and nothing already gone is in it', () => {
    const p = radar();
    let last = -Infinity;
    for (const x of p.onTheClock) {
      assert.ok(x.daysLeft >= 0, `${x.name} has already closed and is still listed`);
      assert.ok(x.daysLeft >= last - 1e-9, 'the clock is not in order');
      last = x.daysLeft;
      assert.ok(x.name && x.id, 'a clock entry with no name or id cannot be clicked');
    }
  });

  test('recurring events cannot crowd out the scarce ones', () => {
    // Treasury auctions run weekly. Without a per-kind cap they fill the card
    // with the most routine dates on the calendar and bury the offer that
    // genuinely disappears on Friday.
    const p = radar();
    const perKind = {};
    for (const x of p.onTheClock.filter((y) => y.type === 'event')) {
      const kind = String(x.id).split(':')[1];
      perKind[kind] = (perKind[kind] || 0) + 1;
    }
    for (const [kind, n] of Object.entries(perKind)) {
      assert.ok(n <= 2, `${n} "${kind}" events on the clock — the cap is not applied`);
    }
  });

  test('the week card is capped per kind too, and carries real events', () => {
    const p = radar();
    assert.ok(Number.isFinite(p.weekEventCount));
    const perKind = {};
    for (const e of p.weekEvents) perKind[e.kind] = (perKind[e.kind] || 0) + 1;
    for (const [kind, n] of Object.entries(perKind)) {
      assert.ok(n <= 3, `${n} "${kind}" events this week — earnings season would fill the card`);
    }
    for (const e of p.weekEvents) {
      assert.ok(e.daysAway >= 0 && e.daysAway <= 7, `${e.title} is ${e.daysAway} days away, not this week`);
    }
  });

  test('a budget reaches the payload, and its absence is null not zero', () => {
    assert.strictEqual(radar().budget, null, 'no budget must be null, never 0');
    assert.strictEqual(radar({ settings: { budget: 25000 } }).budget, 25000);
    assert.strictEqual(radar({ settings: { budget: 0 } }).budget, null);
    assert.strictEqual(radar({ settings: { budget: -5 } }).budget, null);
  });

  test('an empty dataset produces an empty payload rather than throwing', () => {
    const p = radarPayload({ opportunities: [], events: [], meta: {} }, {});
    assert.strictEqual(p.onTheClock.length, 0);
    assert.strictEqual(p.weekEvents.length, 0);
    assert.ok(p.groups.income);
  });

  test('a malformed dataset does not take the whole view down', () => {
    assert.doesNotThrow(() => radarPayload({}, {}));
    assert.doesNotThrow(() => radarPayload({ opportunities: [], events: null, meta: null }, {}));
  });
});

describe('the Signals payload', () => {
  test('it counts what is readable against what is merely present', () => {
    const p = signalsPayload(dataset, null);
    assert.ok(p.counts.total > 0, 'no rows carry signals at all');
    assert.strictEqual(p.counts.readable + p.counts.unreadable, p.counts.total);
    // Offline, every chart is drawn rather than recorded, so nothing is
    // readable — and that is the correct answer, not a bug.
    assert.strictEqual(p.counts.readable, 0,
      'a signal was read off a drawn chart, which is the number handed back as its own evidence');
  });

  test('an uncalibrated payload says so rather than implying measurement', () => {
    assert.strictEqual(signalsPayload(dataset, null).calibration, null);
  });

  test('a calibration is passed through with the fields the view renders', () => {
    const p = signalsPayload(dataset, {
      generatedAt: new Date().toISOString(),
      universe: ['A', 'B'],
      years: 5,
      horizon: 21,
      definition: 'x',
      testBaseRate: 0.248,
      testBars: 1110,
      scores: [{ key: 'extension', verdict: 'validated', fires: 167, hitRate: 0.353, baseRate: 0.248, lift: 1.43 }],
      composite: { verdict: 'validated', cutoff: 55, hitRate: 0.353, baseRate: 0.248, lift: 1.43, fires: 167 },
      validated: ['extension'],
      failedSignals: ['coil'],
      weights: { extension: 0.43, coil: 0 },
    });
    assert.ok(p.calibration);
    assert.strictEqual(p.calibration.universe, 2, 'the universe should be reported as a count');
    assert.strictEqual(p.calibration.baseRate, 0.248);
    assert.deepStrictEqual(p.calibration.failed, ['coil']);
  });

  test('the diagnosis explains an empty view in terms of what happened', () => {
    // "Hit refresh" is useless advice to somebody who already refreshed.
    const p = signalsPayload(dataset, null);
    assert.ok(p.diagnosis, 'an empty signals view with no diagnosis is a dead end');
    assert.ok(Array.isArray(p.diagnosis.sources));
    assert.ok(p.diagnosis.sources.some((s) => ['equities', 'crypto'].includes(s.id)),
      'the price sources must be named, since they are the ones that matter here');
  });

  test('an empty or broken dataset is survivable', () => {
    assert.doesNotThrow(() => signalsPayload({ opportunities: [], events: [], health: [], meta: {} }, null));
    assert.doesNotThrow(() => signalsPayload({}, null));
  });
});
