'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const calendar = require('../src/sources/calendar');

/**
 * Statutory money deadlines.
 *
 * These are dates people actually miss, and being one day wrong about a filing
 * deadline is the one kind of wrong that costs real money. They are computed
 * rather than fetched, so the arithmetic is the whole product and it gets
 * tested properly.
 */

const at = (iso) => Date.parse(iso);
const gen = (iso) => calendar._moneyDeadlineEvents({ now: at(iso) });

describe('the weekend shift follows the IRS convention', () => {
  const shift = calendar._shiftForWeekend;
  test('a Saturday deadline moves to Monday', () => {
    // 15 April 2028 is a Saturday.
    const d = shift(2028, 4, 15);
    assert.strictEqual(d.getUTCDay(), 1, 'must land on a Monday');
    assert.strictEqual(d.getUTCDate(), 17);
  });
  test('a Sunday deadline moves to Monday', () => {
    // 15 April 2029 is a Sunday.
    const d = shift(2029, 4, 15);
    assert.strictEqual(d.getUTCDay(), 1);
    assert.strictEqual(d.getUTCDate(), 16);
  });
  test('a weekday deadline does not move', () => {
    // 15 April 2027 is a Thursday.
    const d = shift(2027, 4, 15);
    assert.strictEqual(d.getUTCDate(), 15);
  });
});

describe('the deadlines that exist are the ones that matter', () => {
  test('every entry has a date, a title, an explanation and a source', () => {
    for (const d of calendar._MONEY_DEADLINES) {
      assert.ok(d.month >= 1 && d.month <= 12, `bad month on ${d.title}`);
      assert.ok(d.day >= 1 && d.day <= 31, `bad day on ${d.title}`);
      assert.ok(d.title && d.title.length > 8);
      assert.ok(d.text && d.text.length > 40, `${d.title} has no real explanation`);
      assert.ok(/^https:\/\//.test(d.url), `${d.title} has no citable source`);
    }
  });

  test('the December 31 deadlines never shift, because they cannot', () => {
    // A tax year ends when it ends; the IRS does not extend it for a Sunday.
    const nye = calendar._MONEY_DEADLINES.filter((d) => d.month === 12 && d.day === 31);
    assert.ok(nye.length >= 2, 'expected harvesting and FSA deadlines');
    for (const d of nye) assert.strictEqual(d.noShift, true, `${d.title} must not shift off 31 December`);
  });

  test('it covers the four estimated payments and the filing deadline', () => {
    const months = calendar._MONEY_DEADLINES.map((d) => d.month);
    for (const m of [1, 4, 6, 9]) {
      assert.ok(months.includes(m), `no deadline generated for month ${m}`);
    }
  });
});

describe('generation is anchored to now and never invents the past', () => {
  test('it produces a rolling forward set', () => {
    const e = gen('2026-08-28T12:00:00Z');
    assert.ok(e.length >= 6, `only ${e.length} deadlines generated`);
    for (const x of e) {
      assert.ok(x.daysAway >= -3.5, `${x.title} is ${x.daysAway} days in the past`);
      assert.ok(x.daysAway < 500, `${x.title} is too far out to be useful`);
    }
  });

  test('the same deadline is not emitted twice for the same year', () => {
    const e = gen('2026-08-28T12:00:00Z');
    const keys = e.map((x) => `${x.title}|${new Date(x.dateMs).toISOString().slice(0, 10)}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate deadline emitted');
  });

  test('running it on 30 December still surfaces the 31st', () => {
    // The edge case that matters most: the day before the biggest deadline of
    // the year, when an off-by-one would hide it entirely.
    const e = gen('2026-12-30T12:00:00Z');
    // The generator rolls three years forward, so select this year's instance
    // rather than every instance that shares a title.
    const nye = e.filter((x) => (x.title.includes('harvest losses') || x.title.includes('FSA'))
      && x.daysAway < 30);
    assert.ok(nye.length >= 2, 'the 31 December deadlines vanished on 30 December');
    for (const x of nye) assert.ok(x.daysAway >= 0 && x.daysAway <= 2, `${x.title} is ${x.daysAway} days away`);
  });

  test('a deadline renders on its own date in every plausible timezone', () => {
    // This caught a real one: a timestamp at 23:59 Eastern is already the next
    // day in UTC, so "31 December" was reaching the screen as 1 January for
    // anyone east of New York. For a deadline that is the worst possible bug.
    const e = gen('2026-11-01T12:00:00Z');
    const nye = e.filter((x) => x.title.includes('harvest losses'))
      .sort((a, b) => a.daysAway - b.daysAway)[0];
    assert.ok(nye, 'no year-end deadline generated');
    for (const offsetHours of [-11, -10, -8, -5, 0, 1, 5.5, 8, 11]) {
      const shifted = new Date(nye.dateMs + offsetHours * 3600000);
      assert.strictEqual(shifted.getUTCMonth(), 11,
        `at UTC${offsetHours >= 0 ? '+' : ''}${offsetHours} it renders in month ${shifted.getUTCMonth() + 1}`);
      assert.strictEqual(shifted.getUTCDate(), 31,
        `at UTC${offsetHours >= 0 ? '+' : ''}${offsetHours} it renders on the ${shifted.getUTCDate()}`);
    }
  });

  test('it rolls into the next year rather than running dry in December', () => {
    const e = gen('2026-12-30T12:00:00Z');
    const nextYear = e.filter((x) => new Date(x.dateMs).getUTCFullYear() === 2027);
    assert.ok(nextYear.length >= 3, 'nothing generated for the following year');
  });

  test('a nonsense clock produces nothing rather than nonsense', () => {
    assert.deepStrictEqual(calendar._moneyDeadlineEvents({ now: NaN }), []);
    assert.deepStrictEqual(calendar._moneyDeadlineEvents({ now: null }), []);
  });
});

describe('they reach the app', () => {
  test('the offline calendar includes them', async () => {
    const res = await calendar.loadSeed({
      seedDir: require('node:path').join(__dirname, '..', 'data', 'seed'),
      now: at('2026-08-28T12:00:00Z'),
    });
    const money = (res.events || []).filter((e) => e.kind === 'money_deadline');
    assert.ok(money.length >= 5, `only ${money.length} money deadlines reached the dataset`);
    for (const m of money) {
      assert.ok(m.title && m.text && m.url, 'a deadline arrived without its explanation');
    }
  });
});
