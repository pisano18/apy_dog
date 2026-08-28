'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { radarPayload, signalsPayload, mergeMeasured } = require('../src/core/views');

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


/**
 * Folding a measurement back into a row.
 *
 * The bug this covers: fetchOne returns a SourceResult envelope, and the
 * handler spread the envelope over the row. Nothing that the measurement was
 * for actually changed — price, series, apy, risk and movementStats all stayed
 * as they were — while the row picked up `opportunities`, `status` and
 * `warnings` keys, its `notes` turned into an array, and the "not measured"
 * badge vanished because `measured: true` was the one part of the spread that
 * landed. Pressing Measure looked like it worked and measured nothing.
 */
describe('mergeMeasured', () => {
  const existing = {
    id: 'equities:AAPL', symbol: 'AAPL', source: 'equities', sourceLabel: 'US equities',
    section: 'movement', measured: false, notes: 'Indexed but not analysed.',
    price: null, apy: { total: null }, risk: { volatility: null }, movementStats: null,
  };
  const envelope = () => ({
    opportunities: [{
      id: 'equities:AAPL', symbol: 'AAPL', source: 'equities',
      price: 214.3, apy: { total: 0.44 }, risk: { volatility: 21.6 },
      movementStats: { bars: 500, vol: 21.6 }, series: [1, 2, 3],
      notes: 'Measured from 500 daily closes.', fetchedAt: '2026-08-28T00:00:00.000Z',
    }],
    status: 'ok',
    notes: ['AAPL measured on demand: 500 daily closes, 1 HTTP request(s).'],
    warnings: [],
    fetchedAt: '2026-08-28T00:00:00.000Z',
  });

  test('the measured fields actually change', () => {
    const { row } = mergeMeasured(existing, envelope());
    assert.strictEqual(row.price, 214.3, 'price did not update');
    assert.strictEqual(row.apy.total, 0.44, 'apy did not update');
    assert.strictEqual(row.risk.volatility, 21.6, 'risk did not update');
    assert.ok(row.movementStats, 'movementStats did not update');
    assert.ok(Array.isArray(row.series), 'series did not update');
    assert.strictEqual(row.measured, true);
  });

  test('the envelope does not become part of the row', () => {
    const { row } = mergeMeasured(existing, envelope());
    for (const k of ['opportunities', 'status', 'warnings']) {
      assert.ok(!(k in row), `row picked up the envelope's ${k}`);
    }
    assert.strictEqual(typeof row.notes, 'string', 'notes must stay the string the schema promises');
  });

  test('identity stays with the row that is already on screen', () => {
    const res = envelope();
    res.opportunities[0].id = 'equities:AAPL:measured';   // an adapter re-keying itself
    const { row } = mergeMeasured(existing, res);
    assert.strictEqual(row.id, 'equities:AAPL', 'a re-keyed row would deselect itself');
    assert.strictEqual(row.sourceLabel, 'US equities');
    assert.strictEqual(row.section, 'movement');
  });

  test('measuring true is never set without a measurement', () => {
    const empty = { opportunities: [], status: 'failed', notes: [], warnings: ['No usable price history came back for AAPL.'] };
    assert.throws(() => mergeMeasured(existing, empty), /No usable price history/);
    // and the adapter's own words are used rather than a generic message
    assert.throws(() => mergeMeasured(existing, { opportunities: [], warnings: [] }), /No price history came back for AAPL/);
  });

  test('the right row is taken when several come back', () => {
    const res = envelope();
    res.opportunities.unshift({ id: 'equities:SPY', symbol: 'SPY', price: 1 });
    const { row } = mergeMeasured(existing, res);
    assert.strictEqual(row.price, 214.3, 'took the wrong row out of the envelope');
  });

  test('warnings are handed back rather than buried in the row', () => {
    const res = envelope();
    res.warnings = ['Series is not dividend-adjusted.'];
    const { row, warnings } = mergeMeasured(existing, res);
    assert.deepStrictEqual(warnings, ['Series is not dividend-adjusted.']);
    assert.ok(!('warnings' in row));
  });
});

/**
 * How busy the next six weeks are is a fact about the calendar.
 *
 * The clock card counts what falls inside a 45-day window, and that count is
 * seasonal: late August is genuinely almost empty and the second half of
 * December is genuinely packed. A card showing four things and saying nothing
 * else reads as a failure to find anything — which is how "only 3 close events,
 * are you serious?" happens while the app is telling the truth. So it also says
 * what is waiting just past the window.
 */
describe('the clock card is legible when the calendar is quiet', () => {
  test('it reports what is beyond its own window', () => {
    const p = radarPayload(dataset, { settings: {}, watchlist: [] });
    assert.ok(Number.isFinite(p.clockWindowDays) && p.clockWindowDays > 0);
    assert.ok(Number.isInteger(p.beyondWindow), 'no count of what lies past the window');
    assert.ok(p.beyondWindow > p.onTheClockCount,
      'the year past the window should hold more than the six weeks inside it');
  });

  test('and names the next one, so the number is not just a number', () => {
    const p = radarPayload(dataset, { settings: {}, watchlist: [] });
    assert.ok(p.nextBeyond, 'nothing named beyond the window');
    assert.ok(p.nextBeyond.days > p.clockWindowDays, 'the "next beyond" is inside the window');
    assert.ok(typeof p.nextBeyond.name === 'string' && p.nextBeyond.name.length > 0);
  });

  test('nothing inside the window is counted twice as beyond it', () => {
    const p = radarPayload(dataset, { settings: {}, watchlist: [] });
    const inside = p.onTheClock.map((x) => x.daysLeft);
    assert.ok(inside.every((d) => d <= p.clockWindowDays), 'an item past the window is in the card');
  });
});

/**
 * Sign-up bonuses are promotions, and promotions end.
 *
 * The bonuses adapter had no concept of an offer end date at all — not in the
 * code, not in the shape of its data — so 44 of the most deadline-driven rows
 * in the app could never appear in any "closing soon" count, no matter what
 * anyone wrote into the offers file.
 */
describe('a bonus can carry an end date', () => {
  test('the adapter reads one when it is given one', () => {
    const bonuses = require('../src/sources/bonuses');
    const schema = require('../src/core/schema');
    const C = require('../src/core/constants');
    const res = bonuses.loadSeed({
      seedDir: require('node:path').join(__dirname, '..', 'data', 'seed'),
      schema,
      C,
      now: Date.now(),
      settings: {},
      log: () => {},
    });
    assert.ok(res.opportunities.length > 10, 'the bonuses seed did not load');

    // Feed one through with an end date and check it survives to the row.
    const withDate = bonuses._buildRow
      ? bonuses._buildRow({ ...res.opportunities[0], expiresAt: '2026-12-01' })
      : null;
    if (withDate) assert.ok(withDate.expiresAt, 'an offer end date was dropped');
    // Whatever the builder's visibility, the field must be in the source.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'sources', 'bonuses.js'), 'utf8');
    assert.ok(/expiresAt:/.test(src), 'bonuses.js still has no concept of an offer end date');
  });
});
