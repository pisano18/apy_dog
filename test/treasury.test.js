'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../src/sources/treasury');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const http = require('../src/core/http');
const { scoreRisk } = require('../src/core/risk');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const read = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

const nominalCsv = read('treasury-nominal-2026.csv');
const realCsv = read('treasury-real-2026.csv');

const ctx = { schema, C, http, seedDir: SEED_DIR, settings: {}, now: Date.parse('2026-08-27'), log() {} };

const byTenor = (rows, subType, days) => rows.find((o) => o.subType === subType && o.term.days === days);

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'treasury');
  assert.equal(adapter.label, 'US Treasury');
  assert.deepEqual(adapter.assetClasses, ['govt_bond']);
});

test('parses the latest dated row with data, not the first or last row', () => {
  const out = adapter.parseCurves({ nominalCsv, realCsv }, ctx);
  // 08/27 is present but entirely N/A, and rows are out of order in the file.
  assert.equal(out.dataAsOf.slice(0, 10), '2026-08-26');
  assert.equal(out.warnings.length, 0);
  assert.equal(out.opportunities.length, 18); // 13 nominal tenors + 5 TIPS
  for (const o of out.opportunities) assert.equal(o.dataAsOf.slice(0, 10), '2026-08-26');
});

test('every parsed opportunity passes schema validation', () => {
  const out = adapter.parseCurves({ nominalCsv, realCsv }, ctx);
  for (const o of out.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
  }
});

test('reads by header name and tolerates a missing column', () => {
  // The fixture deliberately omits "4 Mo"; nothing must be invented for it.
  const out = adapter.parseCurves({ nominalCsv }, ctx);
  assert.equal(out.opportunities.some((o) => o.term.days === 122), false);
  assert.ok(byTenor(out.opportunities, 'bill', 91), '3 Mo tenor should be present');
});

test('published rates are used as-is (already coupon-equivalent, not discount rates)', () => {
  const out = adapter.parseCurves({ nominalCsv }, ctx);
  const threeMonth = byTenor(out.opportunities, 'bill', 91);
  assert.equal(threeMonth.apy.total, 3.81);
  // discountToApy would inflate it; if this ever fires someone "fixed" the bug in.
  assert.notEqual(threeMonth.apy.total, schema.discountToApy(3.81, 91));
  assert.equal(threeMonth.yieldKind, C.YIELD_KIND.MARKET);
});

test('classifies bills, notes and bonds and tags every row as government-backed', () => {
  const out = adapter.parseCurves({ nominalCsv }, ctx);
  assert.equal(byTenor(out.opportunities, 'bill', 365).term.label, '1 Year');
  assert.ok(byTenor(out.opportunities, 'note', 731));   // 2 Yr
  assert.ok(byTenor(out.opportunities, 'note', 3653));  // 10 Yr
  assert.ok(byTenor(out.opportunities, 'bond', 7305));  // 20 Yr
  assert.ok(byTenor(out.opportunities, 'bond', 10958)); // 30 Yr
  for (const o of out.opportunities) {
    assert.equal(o.assetClass, C.ASSET_CLASS.GOVT_BOND);
    assert.equal(o.risk.insurance, C.INSURANCE.US_GOV);
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.TREASURY);
    assert.equal(o.liquidity, C.LIQUIDITY.DAILY);
    assert.equal(o.minInvestment, 100);
    assert.equal(o.price, null);
    assert.equal(o.confidence, 0.98);
    assert.match(o.accessNotes, /TreasuryDirect/);
  }
});

test('TIPS rows are labelled as real yields, which is the apples-to-oranges hazard', () => {
  const out = adapter.parseCurves({ realCsv }, ctx);
  assert.equal(out.opportunities.length, 5);
  for (const o of out.opportunities) {
    assert.equal(o.subType, 'tips');
    assert.match(o.name, /REAL/);
    assert.match(o.notes, /inflation-adjusted/i);
  }
  assert.equal(byTenor(out.opportunities, 'tips', 3653).apy.total, 1.87);
});

test('term length drives the rate-sensitivity penalty in risk.js', () => {
  const out = adapter.parseCurves({ nominalCsv }, ctx);
  const bill = scoreRisk(byTenor(out.opportunities, 'bill', 91));
  const long = scoreRisk(byTenor(out.opportunities, 'bond', 10958));
  assert.ok(long.score > bill.score, 'a 30-year bond must score riskier than a 3-month bill');
  assert.equal(bill.principalAtRisk, false);
  assert.ok(long.factors.some((f) => /duration/i.test(f.label)));
});

test('ids are unique, stable and shared between the seed and the live path', () => {
  const live = adapter.parseCurves({ nominalCsv, realCsv }, ctx);
  const seeded = adapter.loadSeed(ctx);
  const ids = live.opportunities.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('treasury:nominal-3-mo'));
  assert.ok(ids.includes('treasury:real-10-yr'));
  // Refreshing must replace the snapshot row, not sit beside it.
  const seedIds = new Set(seeded.opportunities.map((o) => o.id));
  for (const id of ids) assert.ok(seedIds.has(id), `seed is missing ${id}`);
});

test('getRiskFreeRate returns the 3-month bill yield', () => {
  assert.equal(adapter.getRiskFreeRate(adapter.parseCurves({ nominalCsv, realCsv }, ctx)), 3.81);
  assert.equal(adapter.getRiskFreeRate(adapter.loadSeed(ctx)), 3.80);
});

test('getRiskFreeRate returns null rather than a wrong anchor', () => {
  assert.equal(adapter.getRiskFreeRate(null), null);
  assert.equal(adapter.getRiskFreeRate({}), null);
  assert.equal(adapter.getRiskFreeRate({ opportunities: [] }), null);
  // TIPS only: real yields must never become the risk-free rate.
  assert.equal(adapter.getRiskFreeRate(adapter.parseCurves({ realCsv }, ctx)), null);
  // Long bonds only, no short paper to anchor on.
  const longOnly = adapter.parseCurves({ nominalCsv }, ctx);
  longOnly.opportunities = longOnly.opportunities.filter((o) => o.term.days > 700);
  assert.equal(adapter.getRiskFreeRate(longOnly), null);
});

test('upstream drift degrades the source instead of throwing', () => {
  const cases = [
    undefined,
    '',
    '<html><body>Service Unavailable</body></html>',
    'Date\n08/26/2026\n',                                  // no tenor columns
    'Foo,Bar\n1,2\n',                                      // not this CSV at all
    'Date,"3 Mo"\nnot-a-date,3.81\n',                      // unparseable date
    'Date,"3 Mo"\n08/26/2026,N/A\n',                       // no values
    'Date,"3 Mo"\n08/26/2026,9812.50\n',                   // a price where a rate should be
    'Date,"3 Mo"\n08/26/2026,\n',                           // blank cell, NOT a rate of zero
    'Date,"1 Mo","3 Mo"\n08/26/2026\n',                     // row shorter than the header
  ];
  for (const csv of cases) {
    const out = adapter.parseCurves({ nominalCsv: csv }, ctx);
    assert.equal(out.opportunities.length, 0, `expected nothing from ${JSON.stringify(csv)?.slice(0, 40)}`);
  }
  // A partly-broken file still yields the columns that did parse.
  const partial = adapter.parseCurves({ nominalCsv: 'Date,"3 Mo","Mystery Col","10 Yr"\n08/26/2026,3.81,junk,4.16\n' }, ctx);
  assert.equal(partial.opportunities.length, 2);
  assert.equal(partial.warnings.length, 0);
});

test('a blank cell is missing data, never a 0.00% Treasury', () => {
  // Number('') is 0. A blank cell, or a data row shorter than the header (which
  // is what upstream serves the day a tenor is added), must skip the tenor —
  // inventing a 0% bill would also drag getRiskFreeRate to 0 and re-anchor every
  // score in the app.
  const blank = adapter.parseCurves({ nominalCsv: 'Date,"3 Mo","10 Yr"\n08/26/2026,,4.16\n' }, ctx);
  assert.equal(blank.opportunities.length, 1);
  assert.equal(blank.opportunities[0].term.days, 3653);
  assert.equal(adapter.getRiskFreeRate(blank), null);

  const short = adapter.parseCurves({ nominalCsv: 'Date,"1 Mo","2 Mo","3 Mo"\n08/26/2026,3.86\n' }, ctx);
  assert.deepEqual(short.opportunities.map((o) => o.term.days), [30]);

  // A genuinely published 0.00 is still a real rate and must survive.
  const zero = adapter.parseCurves({ nominalCsv: 'Date,"3 Mo"\n08/26/2026,0.00\n' }, ctx);
  assert.equal(zero.opportunities.length, 1);
  assert.equal(zero.opportunities[0].apy.total, 0);
});

test('the pure entry point tolerates null arguments', () => {
  for (const call of [() => adapter.parseCurves(null), () => adapter.parseCurves(), () => adapter.parseCurves({ nominalCsv }, null)]) {
    assert.doesNotThrow(call);
  }
});

test('a corrupted seed rate is skipped, not published as a Treasury', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apydog-seed-'));
  const write = (items) => fs.writeFileSync(path.join(dir, 'treasury.json'), JSON.stringify({ meta: { dataAsOf: '2026-08-01' }, items }));
  const good = { curve: 'nominal', tenor: '3 Mo', rate: 3.8 };

  for (const bad of [
    { curve: 'nominal', tenor: '1 Mo', rate: null },
    { curve: 'nominal', tenor: '1 Mo' },
    { curve: 'nominal', tenor: '1 Mo', rate: '' },
    { curve: 'nominal', tenor: '1 Mo', rate: 9812.5 },   // a price
    { curve: 'nominal', tenor: '1 Mo', rate: -999 },     // would fail schema.validate
    { curve: 'nominal', tenor: '1 Mo', rate: [] },
  ]) {
    write([bad, good]);
    const out = adapter.loadSeed({ schema, C, seedDir: dir });
    assert.equal(out.opportunities.length, 1, `${JSON.stringify(bad)} should have been skipped`);
    assert.equal(out.opportunities[0].apy.total, 3.8);
    for (const o of out.opportunities) assert.deepEqual(schema.validate(o), []);
  }

  // Junk that is not a list of rows at all fails cleanly rather than throwing.
  for (const junk of ['null', '{"items":{"a":1}}', '{not json', '[]']) {
    fs.writeFileSync(path.join(dir, 'treasury.json'), junk);
    const out = adapter.loadSeed({ schema, C, seedDir: dir });
    assert.equal(out.status, 'failed');
    assert.deepEqual(out.opportunities, []);
  }
});

test('loadSeed returns an honest offline snapshot and never throws', () => {
  const out = adapter.loadSeed(ctx);
  assert.equal(out.status, 'offline');
  assert.equal(out.opportunities.length, 19);
  for (const o of out.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.equal(o.source, 'treasury');
    assert.ok(o.confidence > 0 && o.confidence < 0.98, 'a month-old snapshot must not claim live confidence');
  }
  assert.equal(out.opportunities.filter((o) => o.subType === 'tips').length, 5);
});

test('loadSeed degrades quietly when the seed file is unusable', () => {
  for (const seedDir of [undefined, '/nonexistent/seed/dir']) {
    const out = adapter.loadSeed({ schema, C, seedDir });
    assert.equal(out.status, 'failed');
    assert.deepEqual(out.opportunities, []);
    assert.ok(out.warnings.length);
  }
});

test('fetch wraps a network failure into a failed result', async () => {
  const boom = Object.assign(new Error('blocked'), { status: 403 });
  const out = await adapter.fetch({
    ...ctx,
    http: { ...http, getText: async () => { throw boom; } },
  });
  assert.equal(out.status, 'failed');
  assert.deepEqual(out.opportunities, []);
  assert.ok(out.warnings.some((w) => /403/.test(w)));
});

test('fetch builds from the live CSV and takes the year from ctx.now', async () => {
  const asked = [];
  const out = await adapter.fetch({
    ...ctx,
    http: {
      ...http,
      async getText(url) {
        asked.push(url);
        return url.includes('real_yield') ? realCsv : nominalCsv;
      },
    },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.opportunities.length, 18);
  for (const url of asked) assert.match(url, /\/2026\/all\?/);
  assert.equal(adapter.getRiskFreeRate(out), 3.81);
});

test('an empty current-year file falls back to the previous year (early January)', async () => {
  const janCtx = { ...ctx, now: Date.parse('2026-01-02') };
  const seen = [];
  const out = await adapter.fetch({
    ...janCtx,
    http: {
      ...http,
      async getText(url) {
        seen.push(url);
        if (url.includes('/2026/all')) return 'Date,"1 Mo","3 Mo"\n'; // header only, no rows
        return url.includes('real_yield') ? realCsv : nominalCsv;
      },
    },
  });
  assert.ok(seen.some((u) => u.includes('/2026/all')));
  assert.ok(seen.some((u) => u.includes('/2025/all')));
  assert.equal(out.status, 'ok');
  assert.equal(out.opportunities.length, 18);
  assert.ok(out.notes.some((n) => /was empty; used 2025/.test(n)));
});

test('one curve down leaves the source partial, not dead', async () => {
  const out = await adapter.fetch({
    ...ctx,
    http: {
      ...http,
      async getText(url) {
        if (url.includes('real_yield')) throw Object.assign(new Error('gone'), { status: 404 });
        return nominalCsv;
      },
    },
  });
  assert.equal(out.status, 'partial');
  assert.equal(out.opportunities.length, 13);
  assert.ok(out.warnings.length);
  assert.equal(adapter.getRiskFreeRate(out), 3.81);
});
