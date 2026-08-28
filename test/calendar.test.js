'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/calendar');
const contract = require('../src/sources/_contract');
const catalyst = require('../src/core/catalyst');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');

const FIX = path.join(__dirname, 'fixtures');
const TREASURY = require('./fixtures/calendar-treasury-upcoming.json');
const NASDAQ = require('./fixtures/calendar-nasdaq-earnings.json');
const FED_RSS = fs.readFileSync(path.join(FIX, 'calendar-fed-press.xml'), 'utf8');
const BLS_ICS = fs.readFileSync(path.join(FIX, 'calendar-bls.ics'), 'utf8');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const NOW = Date.parse('2026-09-01T12:00:00Z');
const SEED_NOW = Date.parse('2026-08-01T12:00:00Z');

const KINDS = new Set(Object.values(catalyst.EVENT_KIND));
const day = (e) => new Date(e.dateMs).toISOString().slice(0, 10);

/* ────────────────────────────────────────────────────────────────── contract */

test('satisfies the source adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'calendar');
  assert.equal(adapter.label, 'Upcoming Events');
  // The Sources panel renders these, and pipeline.test.js rejects unknown ones.
  for (const cls of adapter.assetClasses) {
    assert.ok(Object.values(C.ASSET_CLASS).includes(cls), `unknown asset class ${cls}`);
  }
});

/* ─────────────────────────────────────────────────── pure calendar arithmetic */

test('thirdFriday matches known expiries', () => {
  const d = (y, m) => adapter.thirdFriday(y, m).toISOString().slice(0, 10);
  assert.equal(d(2026, 3), '2026-03-20');    // triple witching
  assert.equal(d(2026, 6), '2026-06-19');
  assert.equal(d(2026, 9), '2026-09-18');
  assert.equal(d(2026, 12), '2026-12-18');
  assert.equal(d(2027, 1), '2027-01-15');
  assert.equal(d(2024, 1), '2024-01-19');
  assert.equal(d(2023, 12), '2023-12-15');
  assert.equal(d(2020, 2), '2020-02-21');    // leap February
  // A month that begins on a Friday is the case a naive "first Friday + 14"
  // implementation gets wrong by a week.
  assert.equal(d(2025, 8), '2025-08-15');
  assert.equal(d(2026, 5), '2026-05-15');
});

test('thirdFriday refuses nonsense rather than inventing a date', () => {
  for (const args of [[2026, 0], [2026, 13], [2026, -1], ['2026', 3], [2026, null], [NaN, 3]]) {
    assert.equal(adapter.thirdFriday(...args), null, `thirdFriday(${args}) should be null`);
  }
});

test('nthWeekday never rolls over into the next month', () => {
  // February 2026 opens on a Sunday and has exactly four of them.
  assert.equal(adapter.nthWeekday(2026, 2, 0, 4) !== null, true);
  assert.equal(adapter.nthWeekday(2026, 2, 0, 5), null);
  const fifth = adapter.nthWeekday(2026, 1, 5, 5);      // January 2026 has five Fridays
  assert.equal(new Date(fifth).toISOString().slice(0, 10), '2026-01-30');
});

test('Eastern time conversion tracks daylight saving', () => {
  // 8:30am ET is 12:30 UTC in summer and 13:30 UTC in winter. Getting this
  // backwards puts a CPI print on the wrong side of the market open.
  assert.equal(new Date(adapter.etTimestamp(2026, 8, 12, 8, 30)).toISOString(), '2026-08-12T12:30:00.000Z');
  assert.equal(new Date(adapter.etTimestamp(2026, 12, 9, 8, 30)).toISOString(), '2026-12-09T13:30:00.000Z');
  // DST 2026: begins Sunday 8 March, ends Sunday 1 November.
  assert.equal(adapter.isEasternDst(Date.parse('2026-03-09T12:00:00Z')), true);
  assert.equal(adapter.isEasternDst(Date.parse('2026-03-06T12:00:00Z')), false);
  assert.equal(adapter.isEasternDst(Date.parse('2026-10-30T12:00:00Z')), true);
  assert.equal(adapter.isEasternDst(Date.parse('2026-11-03T12:00:00Z')), false);
});

test('etTimestamp returns null rather than an unrepresentable date', () => {
  // Date only spans +/-8.64e15 ms; a year past that used to escape as a
  // RangeError out of toISOString and take the whole source down.
  assert.equal(adapter.etTimestamp(300000, 1, 1, 8, 30), null);
  assert.equal(adapter.etTimestamp(NaN, 1, 1), null);
  assert.equal(adapter.etTimestamp(2026, 8, 12, Infinity), null);
});

/* ───────────────────────────────────────────────────────── Treasury auctions */

test('parses the TreasuryDirect upcoming feed', () => {
  const r = adapter.parseTreasuryUpcoming(TREASURY, { now: NOW });
  assert.equal(r.unusable, false);
  assert.equal(r.seen, 11);
  assert.equal(r.events.length, 6);
  assert.equal(r.skipped, 5);

  const bill = r.events.find((e) => e.title === '13-Week Bill auction');
  assert.ok(bill);
  assert.equal(bill.kind, catalyst.EVENT_KIND.TREASURY_AUCTION);
  assert.equal(bill.scope, 'rates');
  assert.equal(bill.certainty, 'confirmed');
  // Bidding closes at 1:00pm ET, which is the deadline that matters to a bidder.
  assert.equal(bill.date, '2026-09-08T17:00:00.000Z');
  assert.match(bill.text, /\$84B on offer/);
  assert.match(bill.text, /Settles 2026-09-10/);
  assert.match(bill.text, /noncompetitive/i);
  assert.equal(bill.magnitude, 84000000000);
});

test('an auction with no announced size keeps its date and says so', () => {
  const r = adapter.parseTreasuryUpcoming(TREASURY, { now: NOW });
  const note = r.events.find((e) => e.title === '10-Year Note auction');
  assert.match(note.text, /Size not yet announced/);
  assert.equal(note.magnitude, null);
});

test('an auction with only a term still parses', () => {
  const r = adapter.parseTreasuryUpcoming(TREASURY, { now: NOW });
  assert.ok(r.events.find((e) => e.title === '42-Day auction'));
});

test('a CUSIP never leaks into the symbol field', () => {
  // Symbol-scoped matching is case-insensitive ticker matching. A CUSIP sitting
  // in `symbol` would hang a rate event off whatever row happened to collide.
  const r = adapter.parseTreasuryUpcoming(TREASURY, { now: NOW });
  for (const e of r.events) assert.equal(e.symbol, null);
});

test('a broken auction feed degrades instead of throwing', () => {
  for (const junk of [null, undefined, {}, 'nope', 42, { data: 'not a list' }]) {
    const r = adapter.parseTreasuryUpcoming(junk, { now: NOW });
    assert.deepEqual(r.events, []);
    assert.equal(r.unusable, true);
  }
  // A renamed field is a degraded source, not a crash: everything is skipped.
  const renamed = TREASURY.filter(Boolean).map((x) => (typeof x === 'object'
    ? { cusip: x.cusip, security_type: x.securityType, security_term: x.securityTerm, auction_date: x.auctionDate }
    : x));
  const r = adapter.parseTreasuryUpcoming(renamed, { now: NOW });
  assert.equal(r.events.length, 0);
  assert.equal(r.skipped, renamed.length);
});

/* ──────────────────────────────────────────────────────────── Fed press feed */

test('picks Fed decisions, minutes and projections out of the press feed', () => {
  const r = adapter.parseFedPressRss(FED_RSS, { now: NOW });
  assert.equal(r.seen, 7);
  assert.equal(r.events.length, 3);
  assert.equal(r.skipped, 4);          // a speech, an enforcement notice, a bad date, a titleless item

  const titles = r.events.map((e) => e.title);
  assert.deepEqual(new Set(titles), new Set(['Fed decision published', 'FOMC minutes released', 'Fed projections released']));
  for (const e of r.events) {
    assert.equal(e.kind, catalyst.EVENT_KIND.FOMC);
    assert.equal(e.scope, 'rates');
    assert.equal(e.certainty, 'confirmed');
    assert.match(e.url, /^https:\/\//);   // a relative link falls back to the calendar page
  }
  const minutes = r.events.find((e) => e.title === 'FOMC minutes released');
  assert.match(minutes.text, /June 16-17, 2026/);   // CDATA unwrapped
});

test('a Fed feed that is not RSS degrades instead of throwing', () => {
  for (const junk of ['', '   ', '<html><body>maintenance</body></html>', null, 42, {}]) {
    const r = adapter.parseFedPressRss(junk, { now: NOW });
    assert.deepEqual(r.events, []);
    assert.equal(r.unusable, true);
  }
});

/* ────────────────────────────────────────────────────────────── BLS calendar */

test('parses a BLS .ics down to the three releases that move rates', () => {
  const r = adapter.parseBlsIcs(BLS_ICS, { now: NOW });
  assert.equal(r.seen, 9);
  assert.equal(r.events.length, 4);
  assert.equal(r.skipped, 5);          // real earnings, county wages, no DTSTART, bad date, month 13

  const kinds = r.events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['cpi', 'cpi', 'jobs', 'ppi']);

  const cpi = r.events.find((e) => e.title.includes('July 2026'));
  // A date-only DTSTART becomes the actual 8:30am ET release, not UTC midnight.
  assert.equal(cpi.date, '2026-08-12T12:30:00.000Z');

  // Folding: SUMMARY continued on the next line must rejoin cleanly.
  const jobs = r.events.find((e) => e.kind === 'jobs');
  assert.equal(jobs.title, 'Employment Situation for July 2026');
  assert.equal(jobs.date, '2026-08-07T12:30:00.000Z');

  // An explicit UTC stamp is honoured as UTC; a floating one is read as Eastern.
  assert.equal(r.events.find((e) => e.kind === 'ppi').date, '2026-08-13T12:30:00.000Z');
  assert.equal(r.events.find((e) => e.title.includes('August 2026')).date, '2026-09-10T12:30:00.000Z');
});

test('parseIcsDate rejects impossible values', () => {
  assert.equal(adapter.parseIcsDate('99991399'), null);      // month 13
  assert.equal(adapter.parseIcsDate('20260812T996100'), null);
  assert.equal(adapter.parseIcsDate('sometime'), null);
  assert.equal(adapter.parseIcsDate(''), null);
  assert.equal(adapter.parseIcsDate(null), null);
});

test('a BLS file that is not iCalendar degrades instead of throwing', () => {
  for (const junk of ['<html>404</html>', '', null, 42, {}]) {
    const r = adapter.parseBlsIcs(junk, { now: NOW });
    assert.deepEqual(r.events, []);
    assert.equal(r.unusable, true);
  }
});

/* ─────────────────────────────────────────────────────────── Nasdaq earnings */

test('parses one day of the Nasdaq earnings calendar', () => {
  const r = adapter.parseNasdaqEarnings(NASDAQ, '2026-10-29', { now: NOW });
  assert.equal(r.seen, 8);
  assert.equal(r.events.length, 5);
  assert.equal(r.skipped, 3);          // empty symbol, junk symbol, a literal null

  const aapl = r.events.find((e) => e.symbol === 'AAPL');
  assert.equal(aapl.kind, catalyst.EVENT_KIND.EARNINGS);
  assert.equal(aapl.scope, 'symbol');
  assert.equal(aapl.certainty, 'confirmed');
  // After the close: 4:15pm ET, a full session away from a pre-market report.
  assert.equal(aapl.date, '2026-10-29T20:15:00.000Z');
  assert.match(aapl.text, /after the close/);
  assert.match(aapl.text, /\$2\.02 a share \(27 estimates\)/);

  const ko = r.events.find((e) => e.symbol === 'KO');
  assert.equal(ko.date, '2026-10-29T11:00:00.000Z');   // 7:00am ET
  assert.match(ko.text, /before the open/);

  const brk = r.events.find((e) => e.symbol === 'BRK-B');
  assert.match(brk.text, /time of day not published/);
  assert.ok(!/Analysts expect/.test(brk.text), 'no forecast means no forecast sentence');
});

test('a day with no earnings is a weekend, not a failure', () => {
  const empty = { data: null, message: 'No data found for the date.', status: { rCode: 200 } };
  const r = adapter.parseNasdaqEarnings(empty, '2026-10-31', { now: NOW });
  assert.deepEqual(r.events, []);
  assert.equal(r.unusable, false);
});

test('a broken earnings payload degrades instead of throwing', () => {
  assert.equal(adapter.parseNasdaqEarnings(NASDAQ, 'not-a-date', { now: NOW }).unusable, true);
  for (const junk of [null, 'nope', 42, { data: { rows: 'nope' } }]) {
    const r = adapter.parseNasdaqEarnings(junk, '2026-10-29', { now: NOW });
    assert.deepEqual(r.events, []);
  }
  const renamed = { data: { rows: NASDAQ.data.rows.map((x) => (x ? { ticker: x.symbol, company: x.name } : x)) } };
  assert.equal(adapter.parseNasdaqEarnings(renamed, '2026-10-29', { now: NOW }).events.length, 0);
});

/* ─────────────────────────────────────────────────── computed expiry / rebal */

test('expiry and rebalance dates are computed, not fetched', () => {
  const events = adapter.calendricalEvents({ now: NOW, months: 13 });
  const opex = events.filter((e) => e.kind === catalyst.EVENT_KIND.OPEX);
  const rebal = events.filter((e) => e.kind === catalyst.EVENT_KIND.INDEX_REBALANCE);
  assert.equal(opex.length, 13);
  // September and December 2026, March, June and September 2027.
  assert.equal(rebal.length, 5);

  assert.deepEqual(opex.slice(0, 4).map(day), ['2026-09-18', '2026-10-16', '2026-11-20', '2026-12-18']);
  assert.deepEqual(rebal.map(day), ['2026-09-18', '2026-12-18', '2027-03-19', '2027-06-18', '2027-09-17']);

  const witching = opex.find((e) => day(e) === '2026-09-18');
  assert.equal(witching.title, 'Triple witching');
  assert.equal(opex.find((e) => day(e) === '2026-10-16').title, 'Monthly options expiry');
  for (const e of opex) assert.equal(e.scope, 'market');
  // A rebalance whose adds and deletes are not public yet belongs on the
  // calendar and on no particular row.
  for (const e of rebal) assert.equal(e.symbol, null);
});

test('calendricalEvents survives a nonsense clock', () => {
  assert.deepEqual(adapter.calendricalEvents({ now: NaN }), []);
  assert.equal(adapter.calendricalEvents({ now: NOW, months: 0 }).length >= 1, true);
  assert.equal(adapter.calendricalEvents({ now: NOW, months: 999 }).length <= 48, true);
});

/* ──────────────────────────────────────────────────────────────── attachment */

const row = (over = {}) => ({
  id: over.id || `x:${over.symbol || Math.random()}`,
  symbol: null, assetClass: 'etf', subType: null, track: 'movement', events: [], ...over,
});

const evt = (kind, dateIso, extra = {}) => catalyst.makeEvent({ kind, date: dateIso, ...extra }, NOW);

test('symbol events land on the matching ticker and nowhere else', () => {
  const events = [evt('earnings', '2026-10-29T20:15:00Z', { symbol: 'AAPL' })];
  const rows = [row({ symbol: 'aapl' }), row({ symbol: 'MSFT' }), row({ symbol: null })];
  const out = adapter.attachEvents(rows, events, { now: NOW });
  assert.equal(out[0].events.length, 1, 'matching is case-insensitive');
  assert.equal(out[1].events.length, 0);
  assert.equal(out[2].events.length, 0);
});

test('rate events land on everything rate-sensitive and on broad funds', () => {
  const events = [evt('fomc', '2026-09-16T18:00:00Z'), evt('cpi', '2026-09-09T12:30:00Z')];
  const rows = [
    row({ assetClass: 'govt_bond', track: 'income' }),
    row({ assetClass: 'cd', track: 'income' }),
    row({ assetClass: 'cash', track: 'income' }),
    row({ assetClass: 'preferred', track: 'both' }),
    row({ assetClass: 'rwa', track: 'income' }),
    row({ assetClass: 'muni_bond', track: 'income' }),
    row({ assetClass: 'corp_bond', track: 'income' }),
    row({ assetClass: 'etf', subType: 'core_index' }),      // VTI-shaped
    row({ assetClass: 'etf', subType: 'bond_etf' }),
    row({ assetClass: 'etf', subType: 'target_date' }),
    row({ assetClass: 'etf', subType: 'sector' }),          // XLE — not "broad"
    row({ assetClass: 'crypto_lp', track: 'income' }),      // a rate cut is not its story
  ];
  const out = adapter.attachEvents(rows, events, { now: NOW });
  const counts = out.map((o) => o.events.filter((e) => e.scope === 'rates').length);
  assert.deepEqual(counts, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0]);
});

test('market events land on every row that is not purely income', () => {
  const events = [evt('opex', '2026-09-18T20:00:00Z')];
  const rows = [
    row({ track: 'movement' }),
    row({ track: 'both' }),
    row({ track: 'income', assetClass: 'cd' }),
  ];
  const out = adapter.attachEvents(rows, events, { now: NOW });
  assert.deepEqual(out.map((o) => o.events.length), [1, 1, 0]);
});

test('an event arriving by two routes is attached once', () => {
  // A stock event can reach a row through its symbol and through a pre-existing
  // events array; the row must not show the same earnings date twice.
  const earnings = evt('earnings', '2026-10-29T20:15:00Z', { symbol: 'AAPL' });
  const rows = [row({ symbol: 'AAPL', events: [earnings] })];
  const out = adapter.attachEvents(rows, [earnings], { now: NOW });
  assert.equal(out[0].events.length, 1);
});

test('attached events come back in date order', () => {
  const events = [
    evt('opex', '2026-12-18T21:00:00Z'),
    evt('opex', '2026-09-18T20:00:00Z'),
    evt('opex', '2026-10-16T20:00:00Z'),
  ];
  const out = adapter.attachEvents([row({ track: 'movement' })], events, { now: NOW });
  assert.deepEqual(out[0].events.map(day), ['2026-09-18', '2026-10-16', '2026-12-18']);
});

test('stale events are not attached to anything', () => {
  // A release from two months ago is history. Leaving it on a row makes a stale
  // calendar look like a live one.
  const old = evt('cpi', '2026-06-10T12:30:00Z');
  const fresh = evt('cpi', '2026-08-26T12:30:00Z');
  const out = adapter.attachEvents([row({ assetClass: 'govt_bond' })], [old, fresh], { now: NOW });
  assert.deepEqual(out[0].events.map(day), ['2026-08-26']);
});

test('attachEvents never mutates the rows it is given', () => {
  const rows = [row({ symbol: 'AAPL' })];
  const before = JSON.stringify(rows);
  const out = adapter.attachEvents(rows, [evt('earnings', '2026-10-29T20:15:00Z', { symbol: 'AAPL' })], { now: NOW });
  assert.equal(JSON.stringify(rows), before, 'input rows were modified in place');
  assert.notEqual(out[0], rows[0]);
  assert.equal(out[0].events.length, 1);
});

test('attachEvents tolerates garbage on either side', () => {
  assert.deepEqual(adapter.attachEvents(null, []), []);
  assert.deepEqual(adapter.attachEvents(undefined, null), []);
  const rows = [row({ symbol: 'AAPL' }), null, 'nope'];
  const out = adapter.attachEvents(rows, [null, undefined, {}, { scope: 'symbol' }, 'x'], { now: NOW });
  assert.deepEqual(out[0].events, []);
  assert.equal(out[1], null);
  assert.equal(out[2], 'nope');
  // Every row still ends up with an events array when there is nothing to attach.
  assert.ok(Array.isArray(adapter.attachEvents([row()], [], { now: NOW })[0].events));
});

/* ─────────────────────────────────────────────────────────────────── merging */

test('a published date displaces the bundled estimate for the same event', () => {
  const guess = catalyst.makeEvent({ kind: 'cpi', date: '2026-09-09T12:30:00Z', certainty: 'estimated', title: 'guess' }, NOW);
  const published = catalyst.makeEvent({ kind: 'cpi', date: '2026-09-09T12:30:00Z', certainty: 'confirmed', title: 'published' }, NOW);
  const merged = adapter.mergeEvents([[guess], [published]], { now: NOW });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].certainty, 'confirmed');
  assert.equal(merged[0].title, 'published');
});

test('two auctions on the same morning are two events', () => {
  const a = catalyst.makeEvent({ kind: 'treasury_auction', date: '2026-09-08T17:00:00Z', title: '13-Week Bill auction' }, NOW);
  const b = catalyst.makeEvent({ kind: 'treasury_auction', date: '2026-09-08T17:00:00Z', title: '26-Week Bill auction' }, NOW);
  assert.equal(adapter.mergeEvents([[a, b]], { now: NOW }).length, 2);
});

test('merging drops events outside the window and anything undated', () => {
  const far = catalyst.makeEvent({ kind: 'opex', date: '2030-01-18T21:00:00Z' }, NOW);
  const ancient = catalyst.makeEvent({ kind: 'cpi', date: '2020-01-14T13:30:00Z' }, NOW);
  const ok = catalyst.makeEvent({ kind: 'opex', date: '2026-09-18T20:00:00Z' }, NOW);
  const merged = adapter.mergeEvents([[far, ancient, ok, null, undefined, {}]], { now: NOW });
  assert.deepEqual(merged.map(day), ['2026-09-18']);
});

/* ────────────────────────────────────────────────────────────────────── seed */

test('loadSeed returns a forward calendar and no opportunities', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  assert.equal(r.status, 'offline');
  assert.deepEqual(r.opportunities, [], 'this source produces events, not rows');
  assert.ok(Array.isArray(r.events));
  assert.ok(r.events.length > 150, `only ${r.events.length} events`);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.notes.some((n) => /2026-08-01/.test(n)));
  assert.ok(r.notes.some((n) => /not buyable rows/.test(n)));
});

test('every seeded event is in the canonical shape with a known kind', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  for (const e of r.events) {
    assert.ok(KINDS.has(e.kind), `unknown kind ${e.kind}`);
    assert.ok(Number.isFinite(e.dateMs));
    assert.equal(new Date(e.dateMs).toISOString(), e.date);
    assert.ok(['symbol', 'rates', 'market'].includes(e.scope), `bad scope ${e.scope}`);
    assert.ok(['confirmed', 'estimated'].includes(e.certainty));
    assert.ok(e.text && e.text.length > 20, `${e.kind} has no explanation`);
    assert.ok(e.title);
    assert.ok(Number.isFinite(e.volMultiple));
  }
});

test('the seed covers every kind the brief asked for, in honest proportions', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  const by = {};
  for (const e of r.events) by[e.kind] = (by[e.kind] || 0) + 1;

  assert.equal(by.fomc, 8);
  assert.equal(by.cpi, 12);
  assert.equal(by.jobs, 12);
  assert.equal(by.ppi, 12);
  assert.ok(by.treasury_auction >= 40, `only ${by.treasury_auction} auctions`);
  assert.ok(by.earnings >= 55 && by.earnings <= 70, `${by.earnings} earnings dates`);
  assert.ok(by.opex >= 12);
  assert.ok(by.index_rebalance >= 4);
});

test('the seed is truthful about which dates are published and which are inferred', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  const certainty = (kind) => new Set(r.events.filter((e) => e.kind === kind).map((e) => e.certainty));

  // Arithmetic cannot be wrong: the third Friday of a month is the third Friday.
  assert.deepEqual(certainty('opex'), new Set(['confirmed']));
  assert.deepEqual(certainty('index_rebalance'), new Set(['confirmed']));
  // Everything derived from a publisher's pattern says so.
  assert.deepEqual(certainty('cpi'), new Set(['estimated']));
  assert.deepEqual(certainty('jobs'), new Set(['estimated']));
  assert.deepEqual(certainty('ppi'), new Set(['estimated']));
  assert.deepEqual(certainty('earnings'), new Set(['estimated']));
  assert.deepEqual(certainty('treasury_auction'), new Set(['estimated']));
  // The Fed's published 2026 meetings are confirmed; the projected 2027 ones are not.
  assert.deepEqual(certainty('fomc'), new Set(['confirmed', 'estimated']));
  for (const e of r.events.filter((x) => x.certainty === 'estimated')) {
    assert.match(e.text, /estimated|inferred|projected|not a published date/i,
      `${e.title} is marked estimated but does not say why`);
  }
});

test('seeded macro releases land at the right wall-clock time', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  const at = (kind, d) => r.events.find((e) => e.kind === kind && day(e) === d);
  // CPI and the jobs report both go out at 8:30am ET, before the open.
  assert.equal(at('cpi', '2026-08-12').date, '2026-08-12T12:30:00.000Z');
  assert.equal(at('jobs', '2026-08-07').date, '2026-08-07T12:30:00.000Z');
  // Winter is an hour later in UTC, and getting that wrong moves a print
  // across the open.
  assert.equal(at('cpi', '2026-12-09').date, '2026-12-09T13:30:00.000Z');
  // The FOMC statement is 2:00pm ET on day two of the meeting.
  assert.equal(at('fomc', '2026-09-16').date, '2026-09-16T18:00:00.000Z');
});

test('seeded earnings carry a ticker so they can attach to a row', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  const earnings = r.events.filter((e) => e.kind === 'earnings');
  for (const e of earnings) {
    assert.ok(e.symbol && /^[A-Z][A-Z0-9.-]{0,9}$/.test(e.symbol), `bad ticker ${e.symbol}`);
  }
  // The tickers the bundled equity universe actually carries, so the calendar
  // is not a list of events about things this app cannot show you.
  const universe = require('../data/seed/equities.json');
  const known = new Set((Array.isArray(universe) ? universe : universe.items).map((x) => String(x.symbol).toUpperCase()));
  const covered = earnings.filter((e) => known.has(e.symbol));
  assert.ok(covered.length >= 50, `only ${covered.length} seeded earnings dates match a bundled ticker`);
});

test('seeded events attach to bundled equity rows end to end', () => {
  const r = adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: SEED_NOW, log() {} });
  const rows = [
    schema.normalize({ source: 'equities', symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'dividend_equity', subType: 'megacap', track: 'movement', measured: false, apy: { total: null } }),
    schema.normalize({ source: 'equities', symbol: 'VTI', name: 'Vanguard Total Stock Market', assetClass: 'etf', subType: 'core_index', apy: { total: 1.2 } }),
    schema.normalize({ source: 'treasury', name: 'US Treasury 10-Year Note', assetClass: 'govt_bond', subType: 'note', track: 'income', apy: { total: 4.2 } }),
  ];
  const out = adapter.attachEvents(rows, r.events, { now: SEED_NOW });

  assert.ok(out[0].events.some((e) => e.kind === 'earnings' && e.symbol === 'AAPL'), 'AAPL earnings did not attach');
  assert.ok(out[0].events.some((e) => e.kind === 'opex'), 'a stock should see the market-wide expiry');
  assert.ok(out[1].events.some((e) => e.kind === 'fomc'), 'a broad index fund should see the Fed');
  assert.ok(out[2].events.some((e) => e.kind === 'treasury_auction'), 'a Treasury row should see the auctions');
  // An income row is not a movement row and does not care about options expiry.
  assert.ok(!out[2].events.some((e) => e.kind === 'opex'));

  // And the whole point: a dated catalyst with a plausible size attached to it.
  const next = catalyst.nextCatalyst(out[0].events, { now: SEED_NOW });
  assert.ok(next, 'no next catalyst for AAPL');
  assert.ok(catalyst.describeCatalyst(next, 28).sentence.length > 10);
});

test('loadSeed never throws, whatever it is handed', () => {
  for (const ctx of [
    { seedDir: '/nonexistent/path', now: SEED_NOW },
    { seedDir: null },
    {},
    { seedDir: SEED_DIR, now: NaN },
    { seedDir: __dirname },                     // a real directory with no calendar.json
  ]) {
    const r = adapter.loadSeed(ctx);
    assert.ok(r && typeof r === 'object');
    assert.deepEqual(r.opportunities, []);
    assert.ok(Array.isArray(r.events));
    assert.ok(['offline', 'failed'].includes(r.status));
  }
  // With no seed file the computed expiries survive on their own — and the
  // source says so rather than passing them off as a bundled calendar.
  const bare = adapter.loadSeed({ seedDir: __dirname, now: SEED_NOW });
  assert.ok(bare.events.every((e) => ['opex', 'index_rebalance', 'money_deadline'].includes(e.kind)));
  assert.ok(bare.warnings.some((w) => /missing or unreadable/.test(w)));
});

test('a corrupted seed entry is skipped, not fatal', () => {
  const corrupt = [
    { kind: 'cpi', date: '2026-09-09T12:30:00Z' },        // fine
    { kind: 'not_a_kind', date: '2026-09-09T12:30:00Z' }, // unknown kind
    { kind: 'cpi', date: 'sometime in September' },
    { kind: 'cpi', date: 1e18 },                          // out of Date's range
    { kind: 'cpi', date: -1e18 },
    { kind: 'cpi' },
    null,
    'nope',
    42,
  ];
  const r = adapter.parseSeedEvents(corrupt, { now: NOW });
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped, 8);
  assert.deepEqual(adapter.parseSeedEvents(null).events, []);
});

/* ─────────────────────────────────────────────────────────── live fetch path */

test('fetch composes every feed and still answers when they all fail', async () => {
  // The sandbox has no egress; this proves the composition, the fallbacks and
  // the honesty of the notes rather than the network.
  const calls = [];
  const ctx = {
    now: SEED_NOW,
    seedDir: SEED_DIR,
    schema,
    C,
    settings: {},
    log() {},
    cache: null,
    http: {
      async getJSON(url) { calls.push(url); throw Object.assign(new Error('blocked'), { status: 403 }); },
      async getText(url) { calls.push(url); throw Object.assign(new Error('blocked'), { status: 403 }); },
    },
  };
  const r = await adapter.fetch(ctx);

  assert.equal(r.status, 'partial');
  assert.deepEqual(r.opportunities, []);
  assert.ok(r.events.length > 150, 'the bundled schedule must survive a total network failure');
  assert.ok(r.warnings.some((w) => /Treasury/i.test(w)));
  assert.ok(r.warnings.some((w) => /Nasdaq/i.test(w)));
  assert.ok(r.notes.some((n) => /computed from the calendar with no request/.test(n)));
  // Efficiency: one call for auctions, one for the Fed, at most three BLS shapes,
  // ten weekday earnings requests. Never one call per instrument.
  assert.ok(calls.length <= 16, `${calls.length} requests for a full calendar refresh`);
  assert.equal(calls.filter((u) => u.includes('treasurydirect')).length, 1);
  const asked = calls.filter((u) => u.includes('nasdaq')).map((u) => u.slice(-10));
  assert.ok(asked.length <= 10, `${asked.length} earnings requests for a fortnight`);
  // No company reports on a Saturday, so asking costs a request and buys nothing.
  for (const d of asked) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `requested the earnings calendar for a weekend (${d})`);
  }
});

test('live dates replace the bundled estimates they duplicate', async () => {
  const ctx = {
    now: SEED_NOW,
    seedDir: SEED_DIR,
    schema,
    C,
    settings: {},
    log() {},
    cache: null,
    http: {
      async getJSON(url) {
        if (url.includes('treasurydirect')) return TREASURY;
        if (url.includes('nasdaq')) {
          // The fixture's rows are dated by the requested day, so only answer
          // for one day and let the rest come back empty.
          return url.endsWith('2026-08-12') ? NASDAQ : { data: null, message: 'No data found' };
        }
        throw new Error('unexpected host');
      },
      async getText(url) {
        if (url.includes('federalreserve')) return FED_RSS;
        if (url.includes('bls.gov')) return BLS_ICS;
        throw new Error('unexpected host');
      },
    },
  };
  const r = await adapter.fetch(ctx);

  assert.equal(r.status, 'ok');
  assert.deepEqual(r.opportunities, []);

  // BLS published the 12 August CPI, so the bundled estimate for that day is gone.
  const cpi = r.events.filter((e) => e.kind === 'cpi' && day(e) === '2026-08-12');
  assert.equal(cpi.length, 1);
  assert.equal(cpi[0].certainty, 'confirmed');
  assert.equal(cpi[0].source, 'bls.gov');

  // Auctions came from TreasuryDirect, so those are confirmed too.
  const auctions = r.events.filter((e) => e.kind === 'treasury_auction' && e.source === 'TreasuryDirect');
  assert.ok(auctions.length >= 6);
  assert.ok(auctions.every((e) => e.certainty === 'confirmed'));

  // The Nasdaq answer for 12 August wins over the bundled AAPL guess.
  const aapl = r.events.filter((e) => e.kind === 'earnings' && e.symbol === 'AAPL');
  assert.ok(aapl.some((e) => e.certainty === 'confirmed' && e.source === 'Nasdaq'));

  // Anything nobody published this run keeps its bundled estimate and its label.
  assert.ok(r.events.some((e) => e.kind === 'jobs' && e.certainty === 'estimated'));
  assert.ok(r.notes[0].includes('events on the calendar'));
});
