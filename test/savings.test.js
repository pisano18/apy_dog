'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/savings');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const http = require('../src/core/http');
const { detectTraps } = require('../src/core/traps');
const { scoreRisk } = require('../src/core/risk');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const USER_RATES = path.join(FIXTURES, 'savings-user-rates.json');
const fdic = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'fdic-institutions.json'), 'utf8'));

const ctx = { schema, C, http, seedDir: SEED_DIR, settings: {}, now: Date.parse('2026-08-27'), log() {} };
const byId = (rows, id) => rows.find((o) => o.id === `savings:${id}`);

// A fetch that never touches the network: the FDIC probe fails, everything else
// is the curated dataset, which is the whole point of this source.
const offlineHttp = { ...http, async getJSON() { throw Object.assign(new Error('blocked'), { status: 403 }); } };

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'savings');
  assert.equal(adapter.label, 'Savings, CDs & Money Market');
  assert.deepEqual(adapter.assetClasses, ['cash', 'cd']);
  assert.equal(adapter.requiresKey, false);
  // The dataset is local; the network only confirms insurance.
  assert.equal(adapter.requiresNetwork, false);
});

test('loadSeed returns the bundled snapshot, honestly labelled, and every row validates', () => {
  const out = adapter.loadSeed(ctx);
  assert.equal(out.status, 'offline');
  assert.equal(out.opportunities.length, 45);
  for (const o of out.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.source, 'savings');
    assert.equal(o.seed, true);
    assert.equal(o.live, false, 'nothing in this source is ever a live quote');
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.ok(o.accessNotes, `${o.id} must say how you actually open it`);
    assert.ok(o.url, `${o.id} must link its rate page`);
    assert.ok(o.confidence > 0 && o.confidence <= adapter.CURATED_CONFIDENCE,
      `${o.id} confidence ${o.confidence} must stay under the curated cap`);
  }
  assert.ok(out.notes.some((n) => /rates file/i.test(n)), 'notes must tell the user how to keep rates current');
});

test('ids are unique, stable and namespaced so a refresh replaces rather than duplicates', () => {
  const seeded = adapter.loadSeed(ctx).opportunities;
  const ids = seeded.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id.startsWith('savings:'), id);
  assert.ok(byId(seeded, 'ally-online-savings'));
  assert.ok(byId(seeded, 'vusxx'));
});

test('covers the real CD term ladder with a penalty on every locked row', () => {
  const rows = adapter.loadSeed(ctx).opportunities.filter((o) => o.assetClass === C.ASSET_CLASS.CD);
  const days = new Set(rows.map((o) => o.term.days));
  for (const d of [91, 182, 274, 365, 548, 730, 1095, 1826]) {
    assert.ok(days.has(d), `no CD at ${d} days`);
  }
  for (const o of rows) {
    assert.equal(o.yieldKind, C.YIELD_KIND.CONTRACTUAL);
    assert.ok(Number.isFinite(o.term.days) && o.term.days > 0, `${o.id} has no term`);
    assert.ok(o.term.earlyExitPenalty, `${o.id} must state what breaking it costs`);
    assert.ok([C.LIQUIDITY.LOCKED, C.LIQUIDITY.NOTICE].includes(o.liquidity));
  }
  // No-penalty CDs are notice accounts, not locked money — that is the product.
  const noPenalty = rows.filter((o) => o.subType === 'no_penalty_cd');
  assert.ok(noPenalty.length >= 2);
  for (const o of noPenalty) {
    assert.equal(o.liquidity, C.LIQUIDITY.NOTICE);
    assert.match(o.term.earlyExitPenalty, /^None after/);
  }
});

test('money market funds are securities, not deposits, and are labelled as such', () => {
  const rows = adapter.loadSeed(ctx).opportunities.filter((o) => o.subType === 'money_market_fund');
  assert.equal(rows.length, 10);
  for (const o of rows) {
    assert.equal(o.assetClass, C.ASSET_CLASS.CASH);
    assert.equal(o.yieldKind, C.YIELD_KIND.MARKET, '7-day SEC yield is a market rate, not an administered one');
    assert.ok(o.symbol, 'a fund row without its ticker is not actionable');
    assert.equal(o.risk.insurance, C.INSURANCE.SIPC);
    assert.equal(o.risk.insuredLimit, null, 'SIPC does not insure against loss, so no limit may be implied');
    assert.equal(o.risk.principalAtRisk, true);
    assert.equal(o.price, 1, 'stable $1.00 NAV');
    assert.ok(Number.isFinite(o.expenseRatio));
  }
  assert.ok(rows.some((o) => o.symbol === 'SPAXX'));
  assert.ok(rows.some((o) => o.symbol === 'VMFXX'));
  assert.ok(rows.some((o) => o.symbol === 'SWVXX'));
});

test('Treasury-only money funds get the state-exempt treatment, with the caveat on the row', () => {
  const rows = adapter.loadSeed(ctx).opportunities.filter((o) => o.subType === 'money_market_fund');
  const treasuryOnly = rows.filter((o) => o.taxTreatment === C.TAX_TREATMENT.TREASURY);
  assert.deepEqual(treasuryOnly.map((o) => o.symbol).sort(), ['FDLXX', 'SNSXX', 'VUSXX']);
  for (const o of treasuryOnly) {
    assert.match(o.notes, /exempt/i);
    assert.match(o.notes, /varies|not guaranteed|published/i, 'the exempt share moves year to year and the row must say so');
  }
  // A government fund full of repo is NOT state-exempt; calling it TREASURY would
  // overstate the after-tax yield in every high-tax state.
  assert.equal(byId(rows, 'spaxx').taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(byId(rows, 'vmfxx').taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(byId(rows, 'vmsxx').taxTreatment, C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
});

test('insured deposits carry the $250k limit and score as insured', () => {
  const rows = adapter.loadSeed(ctx).opportunities;
  const insured = rows.filter((o) => [C.INSURANCE.FDIC, C.INSURANCE.NCUA].includes(o.risk.insurance));
  assert.ok(insured.length >= 30);
  for (const o of insured) {
    assert.equal(o.risk.insuredLimit, 250000);
    assert.equal(o.risk.principalAtRisk, false);
    const r = scoreRisk(o);
    assert.ok(r.score <= 10, `${o.id} scored ${r.score}; insured principal must stay capped`);
    assert.equal(r.principalAtRisk, false);
  }
  assert.ok(rows.some((o) => o.risk.insurance === C.INSURANCE.NCUA), 'credit unions belong here too');
});

test('the rows that should trip trap flags do, and the plain ones do not', () => {
  const rows = adapter.loadSeed(ctx).opportunities;
  const flagsFor = (id) => detectTraps(byId(rows, id)).flags;

  // Promotional wording lives in requirements[] precisely so traps.js can see it.
  assert.ok(flagsFor('openbank-high-yield-savings').includes(C.TRAP_FLAGS.TEASER_RATE));
  assert.ok(flagsFor('varo-savings').includes(C.TRAP_FLAGS.TEASER_RATE));

  // A great rate on $1,000 is a great rate on $1,000.
  assert.ok(flagsFor('varo-savings').includes(C.TRAP_FLAGS.CAPPED_BALANCE));
  assert.ok(flagsFor('dcu-primary-savings').includes(C.TRAP_FLAGS.CAPPED_BALANCE));
  assert.equal(byId(rows, 'dcu-primary-savings').maxInvestment, 1000);

  const teased = rows.filter((o) => detectTraps(o).flags.includes(C.TRAP_FLAGS.TEASER_RATE));
  assert.equal(teased.length, 2, 'no row may trip the teaser regex by accident');
  const capped = rows.filter((o) => detectTraps(o).flags.includes(C.TRAP_FLAGS.CAPPED_BALANCE));
  assert.equal(capped.length, 2);

  const plain = detectTraps(byId(rows, 'ally-online-savings')).flags;
  assert.ok(!plain.includes(C.TRAP_FLAGS.TEASER_RATE));
  assert.ok(!plain.includes(C.TRAP_FLAGS.CAPPED_BALANCE));

  // Promotional rows must not claim curated-level confidence.
  assert.ok(byId(rows, 'openbank-high-yield-savings').confidence < byId(rows, 'ally-online-savings').confidence);
});

test('mergeUserRates replaces by id, appends new rows and keeps bundled order', () => {
  const seed = [
    { id: 'a', kind: 'savings', name: 'A bank', apy: 3 },
    { id: 'b', kind: 'savings', name: 'B bank', apy: 3.1 },
  ];
  const user = [
    { id: 'b', apy: 4.4 },
    { id: 'c', kind: 'savings', name: 'C bank', apy: 5 },
  ];
  const merged = adapter.mergeUserRates(seed, user);
  assert.deepEqual(merged.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(merged[0].origin, 'seed');
  assert.equal(merged[1].origin, 'user');
  assert.equal(merged[2].origin, 'user');
  // Field-level: a user row carrying only {id, apy} keeps the bundled details,
  // because the realistic edit is "this bank pays 4.4% now".
  assert.equal(merged[1].apy, 4.4);
  assert.equal(merged[1].name, 'B bank');
  assert.equal(merged[1].kind, 'savings');
});

test('mergeUserRates survives whatever is actually in the file', () => {
  assert.deepEqual(adapter.mergeUserRates(null, undefined), []);
  assert.deepEqual(adapter.mergeUserRates('nope', 7), []);
  const merged = adapter.mergeUserRates(
    [{ id: 'a', apy: 1 }, null, 'junk', { apy: 2 }],          // no id, no name -> dropped
    [{ id: 'A', apy: 9 }, { name: 'Named only', apy: 3 }],    // id match is case-insensitive
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].apy, 9);
  // Case only differs in the file; schema.makeId lowercases, so both spellings
  // land on the same opportunity id and the row is replaced, not duplicated.
  assert.equal(schema.makeId('savings', merged[0].id), 'savings:a');
  assert.equal(merged[1].name, 'Named only');
});

test('readUserRates: silent when absent, loud when broken', () => {
  const notConfigured = adapter.readUserRates(null);
  assert.deepEqual(notConfigured, { items: [], configured: false, warning: null });

  const missing = adapter.readUserRates('/nonexistent/dir/user-rates.json');
  assert.deepEqual(missing.items, []);
  assert.equal(missing.warning, null, 'no file yet is the normal case, not a problem');

  const real = adapter.readUserRates(USER_RATES);
  assert.equal(real.items.length, 4);
  assert.equal(real.warning, null);

  const bare = (text) => adapter.readUserRates('/whatever.json', () => text);
  assert.deepEqual(bare('[{"id":"x","apy":1}]').items, [{ id: 'x', apy: 1 }]);
  assert.match(bare('{ not json').warning, /not valid JSON/);
  assert.match(bare('{"rows":[]}').warning, /no "items" array/);
  const exploded = adapter.readUserRates('/whatever.json', () => { throw new Error('EACCES'); });
  assert.match(exploded.warning, /Could not read/);
});

test('the user rates file overrides the bundle end to end', async () => {
  const withUser = { ...ctx, settings: { userRatesPath: USER_RATES }, http: offlineHttp };
  const out = await adapter.fetch(withUser);

  // 45 bundled, two of them replaced in place, one new credit union added, one
  // fat-fingered row rejected.
  assert.equal(out.opportunities.length, 46);
  const ally = byId(out.opportunities, 'ally-online-savings');
  assert.equal(ally.apy.total, 4.05);
  assert.equal(ally.dataAsOf, '2026-08-26');
  assert.equal(ally.seed, false, 'a row the user maintains is not the bundled snapshot');
  assert.equal(ally.live, false, 'and it is still not a live quote');
  assert.match(ally.name, /Ally Bank Online Savings/, 'unspecified fields come from the bundled row');
  assert.equal(ally.url, 'https://www.ally.com/bank/online-savings-account/');
  // A freshly-dated row is trusted more than the month-old snapshot, up to the cap.
  assert.equal(ally.confidence, adapter.CURATED_CONFIDENCE);
  assert.ok(byId(out.opportunities, 'ally-online-savings').confidence > byId(out.opportunities, 'marcus-online-savings').confidence);

  const added = byId(out.opportunities, 'my-local-credit-union-13mo');
  assert.equal(added.risk.insurance, C.INSURANCE.NCUA);
  assert.equal(added.term.days, 396);
  assert.deepEqual(schema.validate(added), []);

  assert.ok(!byId(out.opportunities, 'typo-row'), '400% APY is a typo, not a savings account');
  assert.ok(out.notes.some((n) => /skipped/.test(n)));
  // The count must reflect rows that survived, not rows the user typed.
  assert.ok(out.notes.some((n) => /3 from your own rates file, 43 bundled/.test(n)), out.notes[0]);
});

test('buildRows rejects the unusable and never throws', () => {
  const cases = [
    null,
    'a string',
    { id: 'x', apy: 3 },                                             // no kind
    { id: 'x', kind: 'crypto_farm', apy: 3 },                        // unknown kind
    { id: 'x', kind: 'savings' },                                    // no rate
    { id: 'x', kind: 'savings', apy: 'four percent' },
    { id: 'x', kind: 'savings', apy: 400 },                          // percent/basis point mixup
    { id: 'x', kind: 'savings', apy: -1 },
    { id: 'x', kind: 'cd', apy: 4 },                                 // a CD with no term is not a CD
    { id: 'x', kind: 'cd', apy: 4, termDays: 0 },
    { kind: 'savings', apy: 4 },                                     // nothing to key on
  ];
  const out = adapter.buildRows(cases, ctx);
  assert.equal(out.opportunities.length, 0);
  assert.equal(out.skipped, cases.length);

  // A duplicate id is dropped rather than shadowing the first row.
  const dupes = adapter.buildRows([
    { id: 'dup', kind: 'savings', name: 'First', apy: 3 },
    { id: 'dup', kind: 'savings', name: 'Second', apy: 9 },
  ], ctx);
  assert.equal(dupes.opportunities.length, 1);
  assert.equal(dupes.opportunities[0].name, 'First');

  // Percent strings are what users type; accept them.
  const typed = adapter.buildRows([{ id: 'p', kind: 'savings', name: 'Typed', apy: '4.25%' }], ctx);
  assert.equal(typed.opportunities[0].apy.total, 4.25);
});

test('a confidence typed on a row can only lower the curated ceiling', () => {
  const today = new Date().toISOString().slice(0, 10);
  const conf = (confidence) => adapter.buildRows([{
    id: 'u', kind: 'cd', name: 'U', apy: 4, termDays: 365,
    origin: 'user', dataAsOf: today, confidence,
  }], ctx).opportunities[0].confidence;

  // A freshly-dated contractual row from the user's own file is the highest
  // confidence this source can produce, and the cap still binds it.
  assert.equal(conf(undefined), adapter.CURATED_CONFIDENCE);
  // Typing a bigger number must not buy trust a hand-maintained rate has not earned.
  for (const tooHigh of [0.95, 1, 5, '0.99']) {
    assert.equal(conf(tooHigh), adapter.CURATED_CONFIDENCE, `confidence ${tooHigh}`);
  }
  // Lowering still works — that is what the seed's promotional rows rely on.
  assert.equal(conf(0.3), 0.3);
  // And nothing may escape the 0..1 range schema.normalize guarantees.
  for (const negative of [-0.5, -1, -1e9]) assert.equal(conf(negative), 0);
});

test('no row from any input can carry a confidence outside 0..cap', () => {
  const rows = adapter.buildRows([
    { id: 'a', kind: 'savings', name: 'A', apy: 3, confidence: -1 },
    { id: 'b', kind: 'savings', name: 'B', apy: 3, confidence: 99 },
    { id: 'c', kind: 'savings', name: 'C', apy: 3, confidence: 'nonsense' },
    { id: 'd', kind: 'savings', name: 'D', apy: 3, confidence: null },
    { id: 'e', kind: 'savings', name: 'E', apy: 3 },
  ], ctx).opportunities;
  assert.equal(rows.length, 5);
  for (const o of rows) {
    assert.ok(o.confidence >= 0 && o.confidence <= adapter.CURATED_CONFIDENCE,
      `${o.id} confidence ${o.confidence} is outside 0..${adapter.CURATED_CONFIDENCE}`);
  }
});

test('parseFdicInstitution reads the real response shape and shrugs off drift', () => {
  assert.deepEqual(adapter.parseFdicInstitution(fdic.ally), { name: 'Ally Bank', cert: 57803, active: true });
  assert.deepEqual(adapter.parseFdicInstitution(fdic.goldman_string_fields), { name: 'Goldman Sachs Bank USA', cert: 33124, active: true });
  assert.deepEqual(adapter.parseFdicInstitution(fdic.flat_shape), { name: 'Synchrony Bank', cert: 27314, active: true });
  assert.equal(adapter.parseFdicInstitution(fdic.inactive).active, false);

  for (const bad of [fdic.no_match, fdic.renamed_fields, fdic.not_the_api_at_all, null, undefined, {}, [], 'html', { data: 'nope' }]) {
    assert.equal(adapter.parseFdicInstitution(bad), null);
  }
});

test('a corrupted FDIC response is a non-answer, never a half-answer', () => {
  // Null fields, missing keys, wrong types, an empty array, and an object where
  // the array should be. Each must read as "no match", because the alternative
  // is a row that claims to be insured on the strength of garbage.
  for (const key of ['null_fields', 'missing_cert', 'cert_zero', 'wrong_types',
    'data_not_an_array', 'null_row', 'inner_data_is_a_string', 'no_data_key']) {
    assert.equal(adapter.parseFdicInstitution(fdic[key]), null, `${key} must not parse as a match`);
  }
  // CERT:[57803] coerces to 57803 in JavaScript and NAME:{} stringifies to
  // "[object Object]". Neither may reach a note about somebody's deposits.
  assert.equal(adapter.parseFdicInstitution(fdic.wrong_types), null);
});

test('every corrupted FDIC payload still returns the full rate table', async () => {
  for (const key of Object.keys(fdic).filter((k) => !k.startsWith('_'))) {
    const out = await adapter.fetch({ ...ctx, http: { ...http, async getJSON() { return fdic[key]; } } });
    assert.ok(['ok', 'partial'].includes(out.status), `${key} -> ${out.status}`);
    assert.equal(out.opportunities.length, 45, `${key} lost rows`);
    for (const o of out.opportunities) assert.deepEqual(schema.validate(o), [], `${key}: ${o.id} failed validation`);
  }
  // And the same for a transport that misbehaves rather than a payload that does.
  for (const getJSON of [
    () => { throw new Error('sync boom'); },
    async () => { throw new Error('async boom'); },
    async () => undefined,
  ]) {
    const out = await adapter.fetch({ ...ctx, http: { ...http, getJSON } });
    assert.equal(out.opportunities.length, 45);
  }
});

test('a lookup with no certificate number never prints as confirmed insurance', () => {
  // A stale or hand-edited cache entry is the realistic way this arrives.
  for (const junk of ['junk', {}, { cert: null }, { cert: 0 }, { cert: 'abc' }, { name: 'Ally Bank' }]) {
    const rows = adapter.buildRows([{ id: 'a', kind: 'savings', name: 'A', apy: 3, insurance: 'fdic', fdicName: 'Ally Bank' }], ctx);
    const summary = adapter.applyFdicVerification(rows.opportunities, rows.lookups, { 'Ally Bank': junk });
    assert.equal(summary.verified, 0, `${JSON.stringify(junk)} must not count as verified`);
    assert.deepEqual(summary.unmatched, ['Ally Bank']);
    assert.doesNotMatch(rows.opportunities[0].notes, /certificate #(undefined|null|NaN|0\b)/);
    assert.match(rows.opportunities[0].notes, /unverified here/);
  }
  // The insurance claim itself is never stripped on the strength of a bad lookup.
  const rows = adapter.buildRows([{ id: 'a', kind: 'savings', name: 'A', apy: 3, insurance: 'fdic', fdicName: 'Ally Bank' }], ctx);
  adapter.applyFdicVerification(rows.opportunities, rows.lookups, { 'Ally Bank': {} });
  assert.equal(rows.opportunities[0].risk.insurance, C.INSURANCE.FDIC);
});

test('applyFdicVerification tolerates a junk table and junk rows', () => {
  // Not a lookup table means nothing was checked, which is not the same as
  // having checked and found nothing: every row must be left untouched.
  for (const byName of [null, undefined, 0, 'str', [], true]) {
    const rows = adapter.buildRows([{ id: 'a', kind: 'savings', name: 'A', apy: 3, insurance: 'fdic', fdicName: 'Ally Bank' }], ctx);
    const summary = adapter.applyFdicVerification(rows.opportunities, rows.lookups, byName);
    assert.deepEqual(summary, { verified: 0, unmatched: [], inactive: [] });
    assert.equal(rows.opportunities[0].notes, null);
  }
  const rows = adapter.buildRows([{ id: 'a', kind: 'savings', name: 'A', apy: 3, insurance: 'fdic', fdicName: 'Ally Bank' }], ctx);
  const summary = adapter.applyFdicVerification(
    [null, undefined, 7, 'row', ...rows.opportunities],
    rows.lookups,
    { 'Ally Bank': { name: 'Ally Bank', cert: 57803, active: true } },
  );
  assert.equal(summary.verified, 1);
  assert.match(rows.opportunities[0].notes, /certificate #57803/);
});

test('FDIC verification annotates rows without ever inventing or removing insurance', () => {
  const rows = adapter.buildRows([
    { id: 'a', kind: 'savings', name: 'A', apy: 3, insurance: 'fdic', fdicName: 'Ally Bank' },
    { id: 'b', kind: 'savings', name: 'B', apy: 3, insurance: 'fdic', fdicName: 'Nonesuch Bank' },
    { id: 'c', kind: 'savings', name: 'C', apy: 3, insurance: 'fdic', fdicName: 'Silicon Valley Bank' },
    { id: 'd', kind: 'savings', name: 'D', apy: 3, insurance: 'ncua', provider: 'A Credit Union' },
  ], ctx);
  assert.deepEqual([...rows.lookups.values()], ['Ally Bank', 'Nonesuch Bank', 'Silicon Valley Bank']);

  const summary = adapter.applyFdicVerification(rows.opportunities, rows.lookups, {
    'Ally Bank': { name: 'Ally Bank', cert: 57803, active: true },
    'Nonesuch Bank': null,
    'Silicon Valley Bank': { name: 'Silicon Valley Bank', cert: 24735, active: false },
  });

  assert.equal(summary.verified, 1);
  assert.deepEqual(summary.unmatched, ['Nonesuch Bank']);
  assert.deepEqual(summary.inactive, ['Silicon Valley Bank']);
  const [a, b, c, d] = rows.opportunities;
  assert.match(a.notes, /certificate #57803/);
  assert.match(b.notes, /no exact match/);
  // A brand that does not match the register is our string problem, not proof the
  // deposit is uninsured — the claim stays, the caveat is added.
  assert.equal(b.risk.insurance, C.INSURANCE.FDIC);
  assert.match(c.notes, /INACTIVE/);
  assert.equal(d.notes, null, 'credit unions are never looked up against the FDIC register');
});

test('applyFdicVerification leaves unchecked names alone', () => {
  const rows = adapter.buildRows([{ id: 'a', kind: 'savings', name: 'A', apy: 3, fdicName: 'Ally Bank' }], ctx);
  const summary = adapter.applyFdicVerification(rows.opportunities, rows.lookups, {});
  assert.deepEqual(summary, { verified: 0, unmatched: [], inactive: [] });
  assert.equal(rows.opportunities[0].notes, null);
  // and it tolerates being handed nonsense
  assert.doesNotThrow(() => adapter.applyFdicVerification(null, null, null));
});

test('fetch verifies each distinct institution once and reports it', async () => {
  const asked = [];
  const out = await adapter.fetch({
    ...ctx,
    http: {
      ...http,
      async getJSON(url) {
        asked.push(url);
        return url.includes('Ally%20Bank') ? fdic.ally : fdic.flat_shape;
      },
    },
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.opportunities.length, 45);
  assert.deepEqual(out.warnings, []);
  for (const o of out.opportunities) assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);

  // One request per bank, not one per product: Ally alone has five rows.
  assert.equal(new Set(asked).size, asked.length);
  assert.ok(asked.length < 20);
  for (const url of asked) assert.match(url, /^https:\/\/banks\.data\.fdic\.gov\/api\/institutions\?filters=NAME:%22/);
  assert.ok(out.notes.some((n) => /confirmed insured and active/.test(n)));
  assert.match(byId(out.opportunities, 'ally-online-savings').notes, /certificate #57803/);

  // Brokerage sweeps set fdicName to null: they are not banks, so searching the
  // register on their name would burn a request to produce a scary non-finding.
  for (const id of ['wealthfront-cash-account', 'betterment-cash-reserve', 'vanguard-cash-plus']) {
    const notes = byId(out.opportunities, id).notes;
    assert.ok(!/certificate #|no exact match|INACTIVE/.test(notes), `${id} must not be looked up`);
  }
  assert.ok(!asked.some((u) => /Wealthfront|Betterment|Vanguard/i.test(u)));
});

test('an inactive institution downgrades the run and says which one', async () => {
  const out = await adapter.fetch({ ...ctx, http: { ...http, async getJSON() { return fdic.inactive; } } });
  assert.equal(out.status, 'partial');
  assert.equal(out.opportunities.length, 45);
  assert.ok(out.warnings.some((w) => /INACTIVE/.test(w)));
});

test('a blocked FDIC API costs one request and still returns every rate', async () => {
  let calls = 0;
  const out = await adapter.fetch({
    ...ctx,
    http: {
      ...http,
      async getJSON() { calls += 1; throw Object.assign(new Error('blocked by policy'), { status: 403 }); },
    },
  });
  assert.equal(out.status, 'partial');
  assert.equal(out.opportunities.length, 45);
  assert.equal(calls, 1, 'one probe is enough to know the host is unreachable');
  assert.ok(out.warnings.some((w) => /403/.test(w) && /user-maintained/.test(w)));
  for (const o of out.opportunities) assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
});

test('fetch never lets an adapter bug escape as an exception', async () => {
  const out = await adapter.fetch({
    ...ctx,
    get settings() { throw new Error('settings blew up'); },
  });
  assert.equal(out.status, 'failed');
  assert.deepEqual(out.opportunities, []);
  assert.ok(out.warnings.length);
});

test('loadSeed degrades quietly when the bundled dataset is unusable', () => {
  for (const seedDir of [undefined, '/nonexistent/seed/dir']) {
    const out = adapter.loadSeed({ schema, C, seedDir });
    assert.equal(out.status, 'failed');
    assert.deepEqual(out.opportunities, []);
    assert.ok(out.warnings.length);
  }
  assert.doesNotThrow(() => adapter.loadSeed());
});
