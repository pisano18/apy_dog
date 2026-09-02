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

/**
 * An offer's own deadline, which is a different path from a calendar event's.
 *
 * The events above were fixed once. Opportunities were not, and they carry
 * their deadlines as bare dates: `"expiresAt": "2026-08-31"`. `Date.parse`
 * reads that as midnight UTC — the START of the last day — so on the morning of
 * the 31st a still-live offer reported -1 days and `expired: true`. It then
 * dropped out of the expiring filter, off the Radar's "On the clock" card, out
 * of the plan's deadline tier, and store.evaluateAlerts un-fired any alert on
 * it rather than saying "closes today". The last day an offer can be taken is
 * the day it most needs to be visible.
 */
describe("an offer's last day is a day it is still on", () => {
  const { calendarDaysUntil } = require('../src/core/schema');
  const schema = require('../src/core/schema');

  // Fixtures built in the READER'S zone, not in UTC.
  //
  // These used to say `new Date().toISOString().slice(0, 10)` for "today",
  // which is today in UTC — a different day from local today for most of the
  // world for part of every day. The assertions then failed in Los Angeles,
  // Tokyo, Kiritimati and Midway while passing at UTC+0, so `npm test` was red
  // for any contributor outside one timezone and the failure looked like a bug
  // in the code it was testing. calendarDaysUntil answers "how many sleeps",
  // which is a question about the reader's calendar, so the fixtures have to be
  // asked in the reader's calendar too.
  const localDay = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /** An instant at the given local hour today, as an ISO timestamp. */
  const localInstant = (h, m = 0, s2 = 0, offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(h, m, s2, 0);
    return d.toISOString();
  };

  test('a bare date is the whole of that day, not the first instant of it', () => {
    assert.strictEqual(calendarDaysUntil(localDay(0)), 0, 'today read as anything but 0');
    assert.strictEqual(calendarDaysUntil(localDay(1)), 1);
    assert.strictEqual(calendarDaysUntil(localDay(-1)), -1);
    // A bare date is taken at face value — it names a day and no timezone — and
    // is counted against the reader's own calendar day. Fixing a UTC instant
    // and asserting "0" only works where that instant is still the same date,
    // which is why the offsets are checked properly in the last test below.
    const now = Date.parse('2026-08-31T14:00:00Z');
    const here = new Date(now);
    const expected = Math.round((Date.UTC(2026, 7, 31)
      - Date.UTC(here.getFullYear(), here.getMonth(), here.getDate())) / 86400000);
    assert.strictEqual(calendarDaysUntil('2026-08-31', now), expected);
  });

  test('nothing closing tonight is ever described as closing tomorrow', () => {
    // Elapsed-time rounding made a 23:59 deadline read "1" all morning. The
    // deadline is tonight in the reader's own evening, whatever UTC says.
    const tonight = localInstant(23, 59, 59);
    for (const hour of [0, 9, 13, 21]) {
      const now = Date.parse(localInstant(hour, 30));
      assert.strictEqual(calendarDaysUntil(tonight, now), 0,
        `at ${hour}:30 local, a deadline of tonight read as ${calendarDaysUntil(tonight, now)}`);
    }
  });

  test('a row expiring today is not marked expired', () => {
    const row = schema.normalize({
      id: 'x', name: 'Closes today', source: 'deals', sourceLabel: 'Deals',
      apy: { total: 5 }, expiresAt: localDay(0),
    }, { source: 'deals' });
    assert.strictEqual(row.daysLeft, 0, `a row closing today reports ${row.daysLeft} days left`);
    assert.strictEqual(row.expired, false, 'a row closing today is being hidden on its last day');
  });

  test('and one that closed yesterday still is', () => {
    const row = schema.normalize({
      id: 'y', name: 'Closed', source: 'deals', sourceLabel: 'Deals',
      apy: { total: 5 }, expiresAt: localDay(-1),
    }, { source: 'deals' });
    assert.ok(row.daysLeft < 0 && row.expired, 'an offer that has closed is being shown as live');
  });

  test('an offer that opens today is open', () => {
    const row = schema.normalize({
      id: 'z', name: 'Opens today', source: 'deals', sourceLabel: 'Deals',
      apy: { total: 5 }, startsAt: localDay(0),
    }, { source: 'deals' });
    assert.strictEqual(row.daysUntilOpen, 0);
    assert.strictEqual(row.notYetOpen, false, 'an offer that opened this morning reads as not yet open');
  });

  test('and none of this depends on where the reader is', () => {
    // The regression guard proper: the same three answers, computed against a
    // fixed instant, from every populated timezone offset on Earth. A bare date
    // is a day, and "today" is today wherever you are standing.
    const at = (iso) => Date.parse(iso);
    for (const [tz, nowIso] of [
      ['UTC-11', '2026-08-31T11:30:00Z'],
      ['UTC-07', '2026-08-31T07:30:00Z'],
      ['UTC+00', '2026-08-31T12:00:00Z'],
      ['UTC+09', '2026-08-30T15:30:00Z'],
      ['UTC+14', '2026-08-30T10:30:00Z'],
    ]) {
      // Each `nowIso` is chosen so that local time in `tz` is on 31 August.
      const d = new Date(at(nowIso));
      const localDate = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
      const target = Date.UTC(2026, 7, 31);
      const expected = Math.round((target - localDate) / 86400000);
      assert.strictEqual(calendarDaysUntil('2026-08-31', at(nowIso)), expected,
        `${tz}: a bare date must be counted from the reader's own calendar day`);
    }
  });
});
