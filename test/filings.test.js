'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/filings');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { EVENT_KIND, EVENT_INFO, recentEvents } = require('../src/core/catalyst');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const NOW = Date.parse('2026-08-27T18:00:00Z');  // after the newest fixture filing, as a live clock always is

const ATOM_8K = fs.readFileSync(path.join(FIXTURES, 'sec-edgar-current-8k.atom.xml'), 'utf8');
const ATOM_S1_13D = fs.readFileSync(path.join(FIXTURES, 'sec-edgar-current-s1-13d.atom.xml'), 'utf8');
const SUBMISSIONS = require('./fixtures/sec-submissions-ford.json');
const TICKERS = require('./fixtures/sec-company-tickers.json');
const TICKERS_EXCHANGE = require('./fixtures/sec-company-tickers-exchange.json');

const seedCtx = (over = {}) => ({
  seedDir: SEED_DIR, schema, C, settings: {}, log() {}, now: NOW, ...over,
});

/* ═══════════════════════════════════════════════════════════════ contract ══ */

test('satisfies the source adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'filings');
  assert.equal(adapter.label, 'Filings & Disclosures');
  assert.ok(adapter.assetClasses.length);
  for (const cls of adapter.assetClasses) {
    assert.ok(Object.values(C.ASSET_CLASS).includes(cls), `unknown asset class ${cls}`);
  }
});

test('sends SEC the descriptive User-Agent it requires, with contact details', () => {
  assert.match(adapter.SEC_UA, /apy dog/i);
  assert.match(adapter.SEC_UA, /github\.com/);
});

/* ═════════════════════════════════════════════════════════════ item codes ══ */

test('the item map covers every code the app promises to explain', () => {
  const required = ['1.01', '1.02', '2.01', '2.02', '2.03', '2.04', '2.05', '2.06',
    '3.01', '3.02', '4.01', '4.02', '5.01', '5.02', '5.03', '7.01', '8.01', '9.01'];
  for (const code of required) {
    assert.ok(adapter.ITEM_MEANINGS[code], `item ${code} is missing from the map`);
  }
  for (const [code, meaning] of Object.entries(adapter.ITEM_MEANINGS)) {
    assert.match(code, /^\d\.\d{2}$/, `${code} is not an item code`);
    assert.ok(meaning.label && meaning.label.length > 5, `${code} has no readable label`);
    assert.ok(meaning.magnitude >= 0 && meaning.magnitude <= 1, `${code} magnitude out of range`);
  }
});

test('severity ranks a restatement and a delisting notice far above an exhibit', () => {
  const m = (c) => adapter.ITEM_MEANINGS[c].magnitude;
  // The whole point of the map: 9.01 is paperwork, 4.02 is the company saying
  // its own published numbers were wrong. A screen that treats those the same is
  // worse than one with no item codes at all.
  assert.ok(m('4.02') > m('9.01') * 10);
  assert.ok(m('3.01') > m('9.01') * 10);
  assert.ok(m('1.03') >= m('2.02'));
  assert.ok(m('9.01') <= adapter.ROUTINE_MAGNITUDE);
  assert.ok(m('5.07') < m('5.02'), 'a vote result is not a management change');
  assert.ok(m('2.02') > m('7.01'), 'earnings outrank a Reg FD note');
});

test('describeItems reads as a sentence and names every code it was given', () => {
  const s = adapter.describeItems('2.02,9.01');
  assert.match(s, /2\.02/);
  assert.match(s, /9\.01/);
  assert.match(s, /results of operations/i);
  assert.match(s, /exhibits/i);
  assert.ok(s.endsWith('.'), 'should be punctuated');
  assert.match(adapter.describeItems('5.02'), /^8-K item 5\.02 —/);
});

test('the two codes with unambiguous mechanical meaning get a neutral factual note', () => {
  const restatement = adapter.describeItems('4.02,9.01');
  assert.match(restatement, /should no longer be relied upon/i);
  const delisting = adapter.describeItems('3.01');
  assert.match(delisting, /continued-listing rule/i);
  assert.match(delisting, /notice, not a delisting/i);
  // And nothing anywhere calls it good or bad.
  for (const s of [restatement, delisting]) {
    assert.doesNotMatch(s, /\b(bad|good|terrible|disaster|warning sign|avoid)\b/i);
  }
});

test('a routine 9.01-only filing is never dressed up as drama', () => {
  const s = adapter.summariseItems('9.01');
  assert.equal(s.magnitude, adapter.ITEM_MEANINGS['9.01'].magnitude);
  assert.equal(s.routine, true);
  assert.match(s.sentence, /routine/i);
});

test('magnitude takes the most serious item, not an average of them', () => {
  const s = adapter.summariseItems('4.02,9.01');
  // Averaging would report a restatement-with-an-exhibit as half a restatement.
  assert.equal(s.magnitude, 1);
  assert.match(s.headline, /non-reliance/i);
  assert.equal(adapter.summariseItems('9.01,4.02').magnitude, 1, 'order must not matter');
});

test('item codes are read out of every shape upstream ships them in', () => {
  assert.deepEqual(adapter.parseItemCodes('2.02,9.01'), ['2.02', '9.01']);
  assert.deepEqual(adapter.parseItemCodes(['2.02', '9.01']), ['2.02', '9.01']);
  assert.deepEqual(adapter.parseItemCodes('Item 2.02: Results of Operations; Item 9.01'), ['2.02', '9.01']);
  assert.deepEqual(adapter.parseItemCodes('2.02, 2.02, 9.01'), ['2.02', '9.01'], 'deduped');
});

test('unreadable or absent item codes produce nothing, never an exception', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, [], NaN, ['x'], 'no codes here']) {
    assert.deepEqual(adapter.parseItemCodes(bad), [], `${JSON.stringify(bad)} should yield no codes`);
    assert.equal(adapter.describeItems(bad), null);
  }
});

test('an item code the app has never seen degrades instead of vanishing', () => {
  const s = adapter.summariseItems('1.99,2.02');
  assert.deepEqual(s.unknown, ['1.99']);
  assert.match(s.sentence, /1\.99/);
  assert.match(s.sentence, /does not recognise/i);
  assert.equal(s.magnitude, adapter.ITEM_MEANINGS['2.02'].magnitude, 'unknown codes must not set severity');
});

/* ═════════════════════════════════════════════════════════ zipFilings ══════ */

test('zipFilings turns the columnar recent block into records', () => {
  const z = adapter.zipFilings(SUBMISSIONS.filings.recent);
  assert.equal(z.length, 14);
  assert.equal(z.rows.length, 14);
  assert.equal(z.rows[0].accessionNumber, '0000037996-26-000112');
  assert.equal(z.rows[0].form, '8-K');
  assert.equal(z.rows[0].items, '5.02,9.01');
});

test('ragged columns lose no filing, and the short columns are reported', () => {
  const z = adapter.zipFilings(SUBMISSIONS.filings.recent);
  // primaryDocument stops at 5 and items at 13 while form runs to 14. Zipping to
  // the shortest would silently drop nine real filings; zipping to the longest
  // and null-filling keeps every one and says which cells are absent.
  const short = Object.fromEntries(z.ragged.map((r) => [r.column, r.length]));
  assert.equal(short.primaryDocument, 5);
  assert.equal(short.items, 13);
  assert.equal(z.rows.length, 14);
  assert.equal(z.rows[13].items, null);
  assert.equal(z.rows[9].primaryDocument, null);
  assert.equal(z.rows[9].form, '8-K', 'the filing itself survives its missing cells');
});

test('zipFilings ignores scalars sitting among the columns', () => {
  const z = adapter.zipFilings(SUBMISSIONS.filings.recent);
  assert.ok(!z.columns.includes('note'), 'a string is not a column');
  assert.equal(z.rows[0].note, undefined);
});

test('zipFilings drops only records with neither an accession number nor a form', () => {
  const z = adapter.zipFilings({
    accessionNumber: ['0000000001-26-000001', '', ''],
    form: ['8-K', '10-Q', ''],
    filingDate: ['2026-08-01', '2026-08-02', '2026-08-03'],
  });
  assert.equal(z.rows.length, 2);
  assert.equal(z.dropped, 1);
});

test('zipFilings never throws on a shape it has never seen', () => {
  for (const bad of [null, undefined, 42, 'string', [], [1, 2, 3], {}, { a: 1 }, { form: 'not an array' }]) {
    const z = adapter.zipFilings(bad);
    assert.deepEqual(z.rows, [], `${JSON.stringify(bad)} should zip to nothing`);
  }
});

/* ═══════════════════════════════════════════════════════════ atom parsing ══ */

test('parses the live 8-K feed, keeping what is usable', () => {
  const r = adapter.parseAtom(ATOM_8K);
  assert.equal(r.feedTitle, 'Latest Filings - Type 8-K');
  assert.equal(r.entries.length, 9);
  assert.equal(r.dropped.noTitle, 2, 'a title with no separator and an empty one');
  assert.equal(r.dropped.noDate, 2, 'a missing timestamp and an unparseable one');
});

test('decodes escaped company names and keeps hyphenated ones intact', () => {
  const r = adapter.parseAtom(ATOM_8K);
  const names = r.entries.map((e) => e.company);
  assert.ok(names.includes('AT&T INC.'), 'ampersand entity should be decoded');
  assert.ok(names.includes('Freeport-McMoRan Inc.'), 'a hyphen in the name is not the form separator');
  assert.ok(names.includes('NEWMONT Corp /DE/'));
});

test('carries the accession number, the filing link and the acceptance time', () => {
  const r = adapter.parseAtom(ATOM_8K);
  const apple = r.entries.find((e) => e.cik === '0000320193');
  assert.equal(apple.accession, '0000320193-26-000081');
  assert.equal(apple.form, '8-K');
  assert.match(apple.url, /^https:\/\/www\.sec\.gov\/Archives\//);
  // <updated> to the second, not the calendar day from the summary.
  assert.equal(new Date(apple.filedMs).toISOString(), '2026-08-27T13:31:02.000Z');
});

test('reads item codes wherever the feed happens to put them', () => {
  const r = adapter.parseAtom(ATOM_8K);
  const ford = r.entries.find((e) => e.cik === '0000037996');
  assert.equal(ford.items, '5.02,9.01', 'from the summary block');
  const kroger = r.entries.find((e) => e.cik === '0000056873');
  assert.equal(kroger.items, '9.01', 'from a category element');
  const apple = r.entries.find((e) => e.cik === '0000320193');
  assert.equal(apple.items, null, 'absent, and not guessed at');
});

test('an out-of-range timestamp is dropped rather than thrown', () => {
  // new Date(x).toISOString() throws RangeError beyond +/-8.64e15ms. The Micron
  // entry in the fixture carries year 275760, which is exactly that failure.
  const r = adapter.parseAtom(ATOM_8K);
  assert.ok(!r.entries.some((e) => e.cik === '0000723125'));
  for (const e of r.entries) {
    assert.doesNotThrow(() => new Date(e.filedMs).toISOString());
  }
});

test('parseAtom survives every kind of non-feed it may be handed', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, [],
    '<html><body>Your Request Originates from an Undeclared Automated Tool</body></html>',
    '<?xml version="1.0"?><feed><title>Empty</title></feed>']) {
    const r = adapter.parseAtom(bad);
    assert.deepEqual(r.entries, [], `${String(bad).slice(0, 40)} should parse to nothing`);
    assert.equal(r.empty, true);
  }
});

test('a feed truncated mid-entry yields the complete entries and drops the rest', () => {
  const cut = ATOM_8K.slice(0, ATOM_8K.indexOf('Freeport'));
  const r = adapter.parseAtom(cut);
  assert.equal(r.entries.length, 2, 'Apple and AT&T closed their tags; nothing after did');
  assert.equal(r.empty, false);
});

/* ══════════════════════════════════════════════════════════ form mapping ══ */

test('maps the three forms this adapter understands, and only those', () => {
  assert.equal(adapter.eventKindForForm('8-K'), EVENT_KIND.FILING_8K);
  assert.equal(adapter.eventKindForForm('8-K/A'), EVENT_KIND.FILING_8K);
  assert.equal(adapter.eventKindForForm('S-1'), EVENT_KIND.FILING_S1);
  assert.equal(adapter.eventKindForForm('S-1/A'), EVENT_KIND.FILING_S1);
  assert.equal(adapter.eventKindForForm('SC 13D'), EVENT_KIND.FILING_13D);
  assert.equal(adapter.eventKindForForm('SC 13D/A'), EVENT_KIND.FILING_13D);
  for (const other of ['10-Q', '10-K', '4', 'S-8', 'DEF 14A', '', null, undefined, 42, {}]) {
    assert.equal(adapter.eventKindForForm(other), null, `${JSON.stringify(other)} should map to nothing`);
  }
});

test('a 13G is never treated as a 13D', () => {
  // 13G is the PASSIVE version of the same disclosure. Mapping it onto the
  // activist event kind would put a story on the row that its filer explicitly
  // disclaimed.
  assert.equal(adapter.eventKindForForm('SC 13G'), null);
  assert.equal(adapter.eventKindForForm('SC 13G/A'), null);
  const r = adapter.parseAtom(ATOM_S1_13D);
  const built = adapter.buildEvents(r.entries, { now: NOW });
  assert.ok(!built.events.some((e) => e.company && /etsy/i.test(e.company)));
  assert.equal(built.dropped.unknownForm, 1);
});

/* ═══════════════════════════════════════════════════════════════ dedupe ══ */

test('one filing listed under two CIKs becomes one event, filed against the company', () => {
  const r = adapter.parseAtom(ATOM_S1_13D);
  const { entries, merged } = adapter.dedupeEntries(r.entries);
  assert.equal(merged, 1);
  const macys = entries.filter((e) => e.accession === '0001193125-26-200455');
  assert.equal(macys.length, 1);
  // The user holds Macy's, not the investor's partnership, so the subject wins.
  assert.equal(macys[0].role, 'Subject');
  assert.match(macys[0].company, /Macy/);
});

test('8-K duplicates resolve the other way, to the registrant', () => {
  const { entries } = adapter.dedupeEntries([
    { form: '8-K', company: 'Sub Co', cik: '0000000002', role: 'Subject', accession: '0000000001-26-000001', filedMs: NOW },
    { form: '8-K', company: 'Filer Co', cik: '0000000001', role: 'Filer', accession: '0000000001-26-000001', filedMs: NOW },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].company, 'Filer Co');
});

test('entries with no accession number are kept rather than collapsed together', () => {
  const { entries } = adapter.dedupeEntries([
    { form: '8-K', company: 'A', filedMs: NOW, accession: null },
    { form: '8-K', company: 'B', filedMs: NOW, accession: null },
  ]);
  assert.equal(entries.length, 2);
});

/* ══════════════════════════════════════════════════════════════ URLs ══════ */

test('links point at the primary document when we know it', () => {
  assert.equal(
    adapter.archiveUrl('37996', '0000037996-26-000112', 'f-20260826.htm'),
    'https://www.sec.gov/Archives/edgar/data/37996/000003799626000112/f-20260826.htm',
  );
  assert.equal(
    adapter.archiveUrl('37996', '0000037996-26-000112', null),
    'https://www.sec.gov/Archives/edgar/data/37996/000003799626000112/0000037996-26-000112-index.htm',
  );
});

test('a malformed accession number produces no deep link at all', () => {
  // A fabricated Archives path either 404s or resolves to an unrelated filing.
  // Both are worse than the company page, which always works.
  for (const bad of ['', 'nonsense', '123', '0000037996-26-00011', null, undefined]) {
    assert.equal(adapter.archiveUrl('37996', bad, 'x.htm'), null);
  }
  assert.equal(adapter.archiveUrl(null, '0000037996-26-000112', 'x.htm'), null);
});

test('with nothing else to go on, the link is the issuer own EDGAR filing list', () => {
  const url = adapter.filingUrl({ symbol: 'AAPL', form: '8-K/A' });
  assert.match(url, /action=getcompany/);
  assert.match(url, /CIK=AAPL/);
  assert.match(url, /type=8-K(?!%2FA)/, 'the amendment suffix is not a form type EDGAR accepts');
});

test('a link that is not on sec.gov is never trusted', () => {
  const url = adapter.filingUrl({ url: 'https://evil.example/phish', symbol: 'AAPL', form: '8-K' });
  assert.match(url, /^https:\/\/www\.sec\.gov\//);
});

/* ═══════════════════════════════════════════════════════ CIK -> ticker ══ */

test('reads the SEC ticker file in both shapes it ships in', () => {
  const flat = adapter.buildCikIndex(TICKERS);
  assert.equal(flat.get('0000320193').ticker, 'AAPL');
  assert.equal(flat.get('0000037996').ticker, 'F');
  const columnar = adapter.buildCikIndex(TICKERS_EXCHANGE);
  assert.equal(columnar.get('0001318605').ticker, 'TSLA');
  assert.equal(columnar.get('0000732717').ticker, 'T');
});

test('a ticker file that is gibberish costs the symbols, not the source', () => {
  for (const bad of [null, undefined, 42, 'string', { fields: 'no' }, { data: 'no' }]) {
    assert.equal(adapter.buildCikIndex(bad).size, 0);
  }
});

/* ════════════════════════════════════════════════════════════ buildEvents ══ */

const buildFromFixtures = (over = {}) => {
  const a = adapter.parseAtom(ATOM_8K).entries;
  const b = adapter.parseAtom(ATOM_S1_13D).entries;
  const { entries } = adapter.dedupeEntries([...a, ...b]);
  return adapter.buildEvents(entries, {
    now: NOW, tickerByCik: adapter.buildCikIndex(TICKERS), ...over,
  });
};

test('builds catalyst events the rest of the app already knows how to render', () => {
  const { events } = buildFromFixtures();
  assert.ok(events.length >= 10, `only ${events.length} events`);
  for (const e of events) {
    assert.ok(EVENT_INFO[e.kind], `${e.kind} is not a known event kind`);
    assert.equal(e.source, 'filings');
    assert.equal(e.certainty, 'confirmed', 'a filing is a published fact, never an estimate');
    assert.equal(typeof e.dateMs, 'number');
    assert.equal(e.date, new Date(e.dateMs).toISOString());
    assert.ok(e.title && e.text, `${e.kind} event has no readable text`);
    assert.match(e.url, /^https:\/\/(?:www\.)?sec\.gov\//);
    assert.equal(e.past, true, 'a filing has by definition already happened');
  }
});

test('events are sorted newest first, because that is what a feed is for', () => {
  const { events } = buildFromFixtures();
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i - 1].dateMs >= events[i].dateMs, 'out of order at index ' + i);
  }
});

test('a CIK is turned into the ticker the user actually holds', () => {
  const { events } = buildFromFixtures();
  const apple = events.find((e) => e.cik === '0000320193');
  assert.equal(apple.symbol, 'AAPL');
  assert.match(apple.title, /\(AAPL\)/);
  // An issuer with no listed common stock stays symbol-less rather than being
  // guessed at — a wrong ticker attaches the filing to somebody else's holding.
  const muni = events.find((e) => e.cik === '0000902104');
  assert.equal(muni.symbol, null);
  assert.match(muni.title, /MIDWEST MUNICIPAL POWER AGENCY/);
});

test('an 8-K with no published item codes says so rather than implying detail', () => {
  const { events } = buildFromFixtures();
  const apple = events.find((e) => e.cik === '0000320193');
  assert.equal(apple.itemsKnown, false);
  assert.deepEqual(apple.items, []);
  assert.equal(apple.magnitude, null, 'severity we did not measure is null, not zero');
  assert.match(apple.text, /does not publish item codes/i);
});

test('the reason item codes are missing matches where the filing came from', () => {
  // Saying "the live feed does not publish item codes" about a submissions
  // record would be a small lie about our own data: that endpoint does publish
  // them, and this particular filing just left the field empty.
  const feedOnly = buildFromFixtures().events.find((e) => e.cik === '0000320193');
  assert.equal(feedOnly.via, 'feed');
  assert.match(feedOnly.text, /live EDGAR feed does not publish/i);

  const history = adapter.buildEvents(
    [{ via: 'submissions', form: '8-K', company: 'Real Co', cik: '0000000001', items: '', filedMs: NOW - 3600000 }],
    { now: NOW },
  ).events[0];
  assert.equal(history.itemsKnown, false);
  assert.match(history.text, /No item codes were published with this filing/i);
  assert.doesNotMatch(history.text, /live EDGAR feed/i);
});

test('an 8-K with item codes carries them, their severity and their meaning', () => {
  const { events } = buildFromFixtures();
  const ford = events.find((e) => e.cik === '0000037996');
  assert.deepEqual(ford.items, ['5.02', '9.01']);
  assert.equal(ford.itemsKnown, true);
  assert.equal(ford.magnitude, adapter.ITEM_MEANINGS['5.02'].magnitude);
  assert.match(ford.title, /departure or appointment/i);
  assert.equal(ford.routine, false);
});

test('a 9.01-only filing is marked routine and reads as housekeeping', () => {
  const { events } = buildFromFixtures();
  const kroger = events.find((e) => e.cik === '0000056873');
  assert.equal(kroger.routine, true);
  assert.equal(kroger.magnitude, 0.05);
  assert.match(kroger.title, /routine attachment/i);
});

test('an amended filing says it is an amendment', () => {
  const { events } = buildFromFixtures();
  const gm = events.find((e) => e.form === '8-K/A');
  assert.ok(gm);
  assert.match(gm.text, /amends an 8-K this company already filed/i);
  assert.match(gm.title, /8-K\/A/);
});

test('a filing dated a year into the future is a parse error, not news', () => {
  const built = adapter.buildEvents([
    { form: '8-K', company: 'Real Co', cik: '0000000001', filedMs: NOW + 400 * 86400000 },
    { form: '8-K', company: 'Real Co', cik: '0000000001', filedMs: NOW - 86400000 },
  ], { now: NOW });
  assert.equal(built.events.length, 1);
  assert.equal(built.dropped.absurdDate, 1);
});

test('timestamps in the wrong unit or out of range never reach toISOString', () => {
  const built = adapter.buildEvents([
    { form: '8-K', company: 'Seconds Co', filedMs: Math.floor(NOW / 1000) },   // seconds, not ms
    { form: '8-K', company: 'Huge Co', filedMs: 1e18 },
    { form: '8-K', company: 'NaN Co', filedMs: NaN },
    { form: '8-K', company: 'Infinity Co', filedMs: Infinity },
    { form: '8-K', company: 'String Co', filedMs: 'yesterday' },
    { form: '8-K', company: 'Null Co', filedMs: null },
  ], { now: NOW });
  assert.equal(built.events.length, 1, 'only the recoverable seconds timestamp survives');
  assert.equal(built.events[0].company, 'Seconds Co');
  assert.doesNotThrow(() => new Date(built.events[0].dateMs).toISOString());
});

test('one unusable record never costs the others', () => {
  const built = adapter.buildEvents([
    null, undefined, 42, 'string', [],
    { form: '8-K', company: 'Good Co', cik: '0000000001', filedMs: NOW - 3600000 },
    { form: '10-Q', company: 'Wrong Form Co', filedMs: NOW - 3600000 },
  ], { now: NOW });
  assert.equal(built.events.length, 1);
  assert.equal(built.events[0].company, 'Good Co');
  assert.ok(built.dropped.unparseable + built.dropped.unknownForm >= 5);
});

test('buildEvents survives being handed nothing at all', () => {
  for (const bad of [null, undefined, 42, 'string', {}]) {
    assert.deepEqual(adapter.buildEvents(bad, { now: NOW }).events, []);
  }
});

test('the same filing arriving twice produces one event', () => {
  const row = { form: '8-K', company: 'Real Co', cik: '0000000001', accession: '0000000001-26-000001', filedMs: NOW - 3600000, items: '2.02' };
  const built = adapter.buildEvents([row, { ...row }], { now: NOW });
  assert.equal(built.events.length, 1);
});

/* ═════════════════════════════════════════════════════════════ honesty ══ */

const OPINION = /\b(strong|weak|beat|missed|surge[ds]?|plunge[ds]?|soar|crash(?:ed)?|bullish|bearish|buy|sell|should buy|good news|bad news|disappointing|impressive|opportunity|undervalued|overvalued)\b/i;

test('no filing event ever says whether the news is good or bad', () => {
  const live = buildFromFixtures().events;
  const seeded = adapter.loadSeed(seedCtx()).events;
  for (const e of [...live, ...seeded]) {
    assert.doesNotMatch(e.title, OPINION, `title editorialises: ${e.title}`);
    assert.doesNotMatch(e.text, OPINION, `text editorialises: ${e.text}`);
  }
});

test('the text points the user at the document rather than at a summary of it', () => {
  const { events } = buildFromFixtures();
  const eightK = events.filter((e) => e.kind === EVENT_KIND.FILING_8K);
  assert.ok(eightK.length);
  for (const e of eightK) assert.match(e.text, /read the filing/i);
});

/* ═══════════════════════════════════════════════════════════════ seed ══ */

test('the bundled snapshot loads as events, not as rows', () => {
  const r = adapter.loadSeed(seedCtx());
  assert.equal(r.status, 'offline');
  assert.deepEqual(r.opportunities, [], 'a filing is not something you can buy');
  assert.ok(r.events.length >= 70, `only ${r.events.length} filings`);
  assert.deepEqual(r.warnings, []);
});

test('every seeded event is marked as seed and dated on or before the stated as-of', () => {
  const asOf = Date.parse('2026-08-02T00:00:00Z');
  for (const e of adapter.loadSeed(seedCtx()).events) {
    assert.equal(e.seed, true, `${e.title} is not marked seed`);
    assert.ok(e.dateMs <= asOf, `${e.title} is dated after the snapshot's own as-of`);
    assert.equal(e.date, new Date(e.dateMs).toISOString());
  }
});

test('the snapshot says plainly what it is and is not', () => {
  const notes = adapter.loadSeed(seedCtx()).notes.join(' ');
  assert.match(notes, /reconstruction/i);
  assert.match(notes, /not a record of specific documents/i);
  assert.match(notes, /No accession numbers/i);
  assert.match(notes, /2026-08-01/);
});

test('the snapshot attributes nothing alarming to any named company', () => {
  // A reconstruction is not a basis for saying a real business restated its
  // accounts, is being delisted or has defaulted. Those codes stay in the map
  // and arrive with the live feed.
  const forbidden = new Set(['4.02', '3.01', '1.03', '2.04', '6.04']);
  for (const e of adapter.loadSeed(seedCtx()).events) {
    for (const code of e.items || []) {
      assert.ok(!forbidden.has(code), `${e.title} attributes item ${code} to a real company from a reconstruction`);
    }
  }
});

test('every seeded link resolves to the real EDGAR record for that issuer', () => {
  for (const e of adapter.loadSeed(seedCtx()).events) {
    assert.match(e.url, /^https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar\?action=getcompany/);
    assert.match(e.url, /CIK=/);
  }
});

test('the snapshot spans 8-K item types plus S-1s and 13Ds', () => {
  const { events } = adapter.loadSeed(seedCtx());
  const kinds = new Set(events.map((e) => e.kind));
  assert.ok(kinds.has(EVENT_KIND.FILING_8K));
  assert.ok(events.filter((e) => e.kind === EVENT_KIND.FILING_S1).length >= 2);
  assert.ok(events.filter((e) => e.kind === EVENT_KIND.FILING_13D).length >= 2);
  const codes = new Set(events.flatMap((e) => e.items || []));
  assert.ok(codes.size >= 8, `only ${codes.size} distinct item codes`);
  assert.ok(codes.has('2.02'), 'earnings 8-Ks are the bulk of any real fortnight');
  assert.ok(codes.has('9.01'));
});

test('seeded filings name tickers the rest of the app can actually attach them to', () => {
  const equities = require('../data/seed/equities.json');
  const rows = Array.isArray(equities) ? equities : equities.items || [];
  const known = new Set(rows.map((o) => String(o.symbol || '').toUpperCase()));
  const symbols = new Set(adapter.loadSeed(seedCtx()).events.map((e) => e.symbol).filter(Boolean));
  const matched = [...symbols].filter((s) => known.has(s));
  // An event feed whose symbols match nothing in the table is decoration.
  assert.ok(matched.length >= 20, `only ${matched.length} of ${symbols.size} seeded tickers exist in the bundled equity rows`);
});

test('loadSeed never throws, whatever it is pointed at', () => {
  for (const dir of ['/nonexistent/path', '', null, undefined, __dirname]) {
    const r = adapter.loadSeed(seedCtx({ seedDir: dir }));
    assert.ok(r && Array.isArray(r.opportunities) && Array.isArray(r.events));
    assert.equal(r.opportunities.length, 0);
  }
  assert.equal(adapter.loadSeed(seedCtx({ seedDir: '/nonexistent/path' })).status, 'failed');
});

test('a seed file full of junk degrades to nothing rather than crashing', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'filings-seed-'));
  fs.writeFileSync(path.join(dir, 'filings.json'), JSON.stringify({
    meta: { dataAsOf: '2026-08-01' },
    items: [null, 42, 'string', [], { form: '8-K' }, { form: 'NOPE', filed: '2026-08-01' },
      { form: '8-K', company: 'Real Co', symbol: 'X', filed: 'not a date' },
      { form: '8-K', company: 'Real Co', symbol: 'X', items: '2.02', filed: '2026-08-01T12:00:00Z' }],
  }));
  const r = adapter.loadSeed(seedCtx({ seedDir: dir }));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].symbol, 'X');
});

/* ═══════════════════════════════════════════════════════ submissions ══ */

test('per-company history reads the columnar block and filters to what we explain', () => {
  const r = adapter.parseSubmissions(SUBMISSIONS, { now: NOW });
  assert.equal(r.company, 'Ford Motor Company');
  assert.equal(r.symbol, 'F');
  assert.equal(r.cik, '0000037996');
  assert.equal(r.entries.length, 11);
  assert.equal(r.dropped.unknownForm, 2, 'the 10-Q and the Form 4');
  assert.equal(r.dropped.tooOld, 1);
  assert.ok(r.ragged.some((c) => c.column === 'primaryDocument'));
});

test('a broken acceptance timestamp falls back to the filing date', () => {
  const r = adapter.parseSubmissions(SUBMISSIONS, { now: NOW });
  const fallback = r.entries.find((e) => e.accession === '0000037996-26-000080');
  assert.ok(fallback, 'the filing with "not-a-timestamp" should survive on its filingDate');
  assert.equal(new Date(fallback.filedMs).toISOString().slice(0, 10), '2026-06-03');
});

test('history events link straight to the primary document', () => {
  const r = adapter.parseSubmissions(SUBMISSIONS, { now: NOW });
  const { events } = adapter.buildEvents(r.entries, { now: NOW });
  const top = events[0];
  assert.equal(top.url, 'https://www.sec.gov/Archives/edgar/data/37996/000003799626000112/f-20260826.htm');
  const noDoc = events.find((e) => e.items && e.items.includes('3.02'));
  assert.match(noDoc.url, /-index\.htm$/, 'no primary document known, so the filing index');
});

test('parseSubmissions never throws on a payload it does not recognise', () => {
  for (const bad of [null, undefined, 42, 'string', [], {}, { filings: 'no' }, { filings: { recent: 42 } }]) {
    const r = adapter.parseSubmissions(bad, { now: NOW });
    assert.deepEqual(r.entries, []);
  }
});

/* ══════════════════════════════════════════════════════════ live path ══ */

/** A stub http that answers from the fixtures, so the live path is testable. */
function stubHttp(over = {}) {
  const calls = [];
  return {
    calls,
    async getText(url) {
      calls.push(url);
      if (over.fail) throw Object.assign(new Error('blocked'), { status: 403 });
      if (/type=8-K/.test(url)) return ATOM_8K;
      if (/type=S-1/.test(url) || /13D/.test(url)) return ATOM_S1_13D;
      return '';
    },
    async getJSON(url) {
      calls.push(url);
      if (over.fail) throw Object.assign(new Error('blocked'), { status: 403 });
      if (/company_tickers/.test(url)) return TICKERS;
      if (/submissions/.test(url)) {
        if (over.wrongCompany) return SUBMISSIONS;           // every CIK answers as Ford
        if (/CIK0000037996/.test(url)) return SUBMISSIONS;
        // data.sec.gov answers for any valid CIK; most of those companies simply
        // have nothing in the window we asked about.
        const cik = (/CIK(\d{10})/.exec(url) || [])[1] || '0000000000';
        return { cik: String(Number(cik)), name: 'Other Registrant', tickers: [], filings: { recent: {} } };
      }
      return {};
    },
  };
}

const liveCtx = (http, settings = {}) => ({
  http, schema, C, seedDir: SEED_DIR, now: NOW, log() {},
  settings: { sources: { filings: { itemLookupLimit: 2, historySymbolLimit: 1 } }, ...settings },
});

test('the live path produces events, no rows, and states what it cost', async () => {
  const http = stubHttp();
  const r = await adapter.fetch(liveCtx(http));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.opportunities, []);
  assert.ok(r.events.length >= 10, `only ${r.events.length} events`);
  const notes = r.notes.join(' ');
  assert.match(notes, /in \d+ requests?/);
  // One request per feed plus the ticker map, not one per issuer.
  assert.ok(http.calls.filter((u) => /browse-edgar/.test(u)).length === 3);
});

test('the live path is honest about which 8-Ks it actually resolved item codes for', async () => {
  const r = await adapter.fetch(liveCtx(stubHttp()));
  const notes = r.notes.join(' ');
  assert.match(notes, /item codes/i);
  // Never imply an unmeasured row was measured.
  const eightK = r.events.filter((e) => e.kind === EVENT_KIND.FILING_8K);
  const claimed = eightK.filter((e) => e.itemsKnown).length;
  assert.match(notes, new RegExp(`resolved for ${claimed} of ${eightK.length}`));
  for (const e of eightK) {
    if (!e.itemsKnown) assert.equal(e.magnitude, null);
  }
});

test('the live path deepens the tickers the user asked about, and says how many', async () => {
  const http = stubHttp();
  const r = await adapter.fetch(liveCtx(http, { extraSymbols: ['F'] }));
  assert.match(r.notes.join(' '), /filing history pulled for 1/i);
  // The ragged fixture columns must be reported, not silently absorbed.
  assert.match(r.notes.join(' '), /ragged filing columns/i);
  assert.ok(r.events.some((e) => e.items?.includes('2.06')), 'history brings item detail the feed lacks');
});

test('a submissions record for the wrong company is refused, not applied', async () => {
  // The worst thing this adapter could do is stamp one issuer's ticker onto
  // another issuer's filing, which would attach somebody else's news to a
  // holding. A payload whose own CIK disagrees with the one requested is
  // therefore discarded rather than half-trusted.
  const r = await adapter.fetch(liveCtx(stubHttp({ wrongCompany: true })));
  const apple = r.events.find((e) => e.cik === '0000320193');
  assert.equal(apple.symbol, 'AAPL', 'from the ticker map, never from the mismatched payload');
  assert.ok(!r.events.some((e) => e.cik === '0000902104' && e.symbol));
  assert.match(r.warnings.join(' '), /different CIK than was requested/);
  assert.equal(r.status, 'partial');
});

test('a blocked or dead EDGAR degrades to a failed result, never an exception', async () => {
  const r = await adapter.fetch(liveCtx(stubHttp({ fail: true })));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.opportunities, []);
  assert.ok(r.warnings.length);
});

test('an adapter that throws outright still returns a SourceResult', async () => {
  const r = await adapter.fetch({
    http: { getText() { throw new Error('boom'); }, getJSON() { throw new Error('boom'); } },
    schema, C, seedDir: SEED_DIR, now: NOW,
  });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.events, []);
});

test('fetchOne pulls one company history on demand', async () => {
  const r = await adapter.fetchOne(liveCtx(stubHttp()), { symbol: 'F' });
  assert.equal(r.status, 'ok');
  assert.ok(r.events.length);
  for (const e of r.events) assert.equal(e.symbol, 'F');
});

test('fetchOne refuses to guess when it cannot find the company', async () => {
  const r = await adapter.fetchOne(liveCtx(stubHttp()), { symbol: 'NOSUCHTICKER' });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.events, []);
});

/* ════════════════════════════════════════════════ downstream compatibility ══ */

test('events flow through the catalyst helpers the movement engine uses', () => {
  const { events } = adapter.loadSeed(seedCtx({ now: Date.parse('2026-08-05T12:00:00Z') }));
  const recent = recentEvents(events, { now: Date.parse('2026-08-05T12:00:00Z'), lookbackDays: 14 });
  assert.ok(recent.length, 'recent filings should be visible to the movement read');
  for (let i = 1; i < recent.length; i += 1) {
    assert.ok(recent[i - 1].dateMs >= recent[i].dateMs);
  }
});

test('the URL builders escape whatever is handed to them', () => {
  const url = adapter.currentFeedUrl('SC 13D');
  assert.match(url, /type=SC\+13D|type=SC%2013D/);
  assert.match(url, /output=atom/);
  assert.match(url, /count=100/);
  assert.equal(adapter.submissionsUrl(320193), 'https://data.sec.gov/submissions/CIK0000320193.json');
  assert.equal(adapter.submissionsUrl('0000320193'), 'https://data.sec.gov/submissions/CIK0000320193.json');
});

test('toMs is the single guard every timestamp passes through', () => {
  assert.equal(adapter.toMs(NOW), NOW);
  assert.equal(adapter.toMs(Math.floor(NOW / 1000)), NOW - (NOW % 1000));
  assert.equal(adapter.toMs('2026-08-27T18:00:00Z'), NOW);
  for (const bad of [null, undefined, '', NaN, Infinity, -Infinity, 1e18, -1e18, 'not a date', {}, []]) {
    assert.equal(adapter.toMs(bad), null, `${JSON.stringify(bad)} should not survive`);
  }
});
