'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const P = require('../src/core/history-providers');
const eq = require('../src/sources/equities');

/**
 * Fetching price history, and reporting honestly when it cannot.
 *
 * Written after a single-provider fetch returned zero of 105 symbols on a real
 * machine and could say nothing about why, because it swallowed its errors in a
 * bare catch. Both halves of that are tested here: the fallback, and the
 * reporting.
 */

describe('symbol spelling per provider', () => {
  test('US equities take the .us suffix Stooq wants', () => {
    assert.strictEqual(P.stooqSymbol('AAPL'), 'aapl.us');
    assert.strictEqual(P.stooqSymbol('gme'), 'gme.us');
  });
  test('indices and already-suffixed symbols are left alone', () => {
    assert.strictEqual(P.stooqSymbol('^SPX'), '^spx');
    assert.strictEqual(P.stooqSymbol('BRK.B'), 'brk.b');
  });
});

describe('CSV parsing refuses to guess', () => {
  const rows = (n, from = 100) => Array.from({ length: n }, (_, i) =>
    `2024-01-${String((i % 28) + 1).padStart(2, '0')},1,2,0.5,${from + i},1000`).join('\n');

  test('a healthy file parses', () => {
    const p = P.parseStooqCsv(`Date,Open,High,Low,Close,Volume\n${rows(40)}`);
    assert.strictEqual(p.closes.length, 40);
    assert.strictEqual(p.closes[0], 100);
  });

  test('too few rows is not a price history', () => {
    assert.strictEqual(P.parseStooqCsv(`Date,Open,High,Low,Close,Volume\n${rows(5)}`), null);
  });

  test('an HTML error page is not silently read as data', () => {
    // Stooq answers an unknown symbol with a 200 and a page, which is the
    // nastiest failure mode there is: it looks like success.
    assert.strictEqual(P.parseStooqCsv('<html><body>No data</body></html>'), null);
    assert.strictEqual(P.parseStooqCsv(''), null);
    assert.strictEqual(P.parseStooqCsv(null), null);
  });

  test('rows with an unusable close are dropped, not zeroed', () => {
    const csv = `Date,Open,High,Low,Close,Volume\n${rows(40)}\n2024-02-01,1,2,0.5,,1000\n2024-02-02,1,2,0.5,0,1000`;
    const p = P.parseStooqCsv(csv);
    assert.strictEqual(p.closes.length, 40, 'a blank and a zero close must not become bars');
    assert.ok(p.closes.every((c) => c > 0));
  });
});

describe('cleaning never changes the length of a series', () => {
  test('gaps are forward-filled, not removed', () => {
    // Dropping a bar silently shortens the forward window, so a 21-day horizon
    // would mean something different for every instrument — a quiet way to
    // corrupt a backtest.
    assert.deepStrictEqual(P.cleanCloses([1, null, 3, NaN, 5]), [1, 1, 3, 3, 5]);
    assert.strictEqual(P.cleanCloses([1, 2, 3]).length, 3);
    assert.strictEqual(P.cleanCloses([null, null, 4]).length, 3);
  });
});

describe('failures describe themselves', () => {
  test('an HTTP error keeps its status and what the server said', () => {
    const e = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401, body: 'Invalid Cookie' });
    const d = P.describe(e);
    assert.strictEqual(d.status, 401);
    assert.match(d.message, /401/);
    assert.strictEqual(d.sample, 'Invalid Cookie');
  });

  test('a thrown string still produces something usable', () => {
    const d = P.describe(new Error('socket hang up'));
    assert.match(d.message, /socket hang up/);
    assert.strictEqual(d.status, null);
  });

  test('fetchDaily reports every provider it tried', async () => {
    // No network here, so every provider fails — which is exactly the case that
    // produced an unactionable "0 ok, 105 failed" before.
    const r = await P.fetchDaily('AAPL', { years: 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.attempts.length, P.PROVIDERS.length,
      'every provider must be named, not just the last one');
    for (const a of r.attempts) {
      assert.ok(a.provider, 'an attempt with no provider name is not a diagnosis');
      assert.ok(a.message && a.message.length > 3);
    }
  });

  test('a single provider can be selected, for diagnosis', async () => {
    const r = await P.fetchDaily('AAPL', { years: 1, only: 'stooq' });
    assert.strictEqual(r.attempts.length, 1);
    assert.strictEqual(r.attempts[0].provider, 'stooq');
  });
});

describe('projecting the next ex-dividend date', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const every = (days, count, endOffsetDays = -30) =>
    Array.from({ length: count }, (_, i) => ({
      ts: now + endOffsetDays * 86400000 - (count - 1 - i) * days * 86400000,
      amount: 0.5,
    }));

  test('a clean quarterly payer projects forward', () => {
    const r = eq.nextExDividend(every(91, 6), now);
    assert.ok(r, 'a regular quarterly record must project');
    assert.strictEqual(r.cadence, 'quarterly');
    assert.ok(r.daysAway > 0 && r.daysAway < 91);
    assert.strictEqual(r.certainty, 'estimated', 'a projected date is never confirmed');
  });

  test('a monthly payer is recognised as monthly', () => {
    assert.strictEqual(eq.nextExDividend(every(30, 8), now).cadence, 'monthly');
  });

  test('an irregular payer gets nothing rather than a confident wrong date', () => {
    const messy = [
      { ts: now - 700 * 86400000 }, { ts: now - 500 * 86400000 },
      { ts: now - 120 * 86400000 }, { ts: now - 100 * 86400000 },
      { ts: now - 95 * 86400000 }, { ts: now - 40 * 86400000 },
    ];
    assert.strictEqual(eq.nextExDividend(messy, now), null);
  });

  test('too short a record proves nothing', () => {
    assert.strictEqual(eq.nextExDividend(every(91, 3), now), null);
    assert.strictEqual(eq.nextExDividend([], now), null);
    assert.strictEqual(eq.nextExDividend(null, now), null);
  });

  test('a stale record rolls forward instead of reporting a past date', () => {
    // A fund whose last recorded payment is two years old must not be shown as
    // having gone ex-dividend in 2024.
    const r = eq.nextExDividend(every(91, 6, -730), now);
    if (r) assert.ok(r.daysAway >= 0, `projected a date ${r.daysAway} days in the past`);
  });

  test('a record too stale to be meaningful is dropped entirely', () => {
    const ancient = every(91, 6, -3000);
    const r = eq.nextExDividend(ancient, now);
    assert.ok(r === null || r.daysAway <= 200);
  });
});
