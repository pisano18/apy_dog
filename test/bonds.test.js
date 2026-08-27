'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/bonds');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const http = require('../src/core/http');
const { scoreRisk } = require('../src/core/risk');
const { detectTraps } = require('../src/core/traps');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const readText = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const readJson = (f) => JSON.parse(readText(f));

const NOW = Date.parse('2026-08-27T12:00:00Z');
const baseCtx = (settings = {}) => ({ schema, C, http, seedDir: SEED_DIR, settings, now: NOW, log() {} });

const seedResult = () => adapter.loadSeed(baseCtx());
const byId = (rows, id) => rows.find((o) => o.id === id);
const bySymbol = (rows, sym) => rows.find((o) => o.symbol === sym);

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'bonds');
  assert.equal(adapter.label, 'Bonds, TIPS, I-Bonds & Tokenized RWA');
  assert.deepEqual(adapter.assetClasses, ['govt_bond', 'corp_bond', 'muni_bond', 'rwa']);
});

// ---------------------------------------------------------------------------
// the finance
// ---------------------------------------------------------------------------

test('compositeIBondRate reproduces rates Treasury actually published', () => {
  // Nov 2023: 1.30% fixed, 1.97% semiannual inflation -> 5.27% composite.
  assert.equal(adapter.compositeIBondRate(1.30, 1.97), 5.27);
  // May 2022: 0.00% fixed, 4.81% semiannual -> the famous 9.62%.
  assert.equal(adapter.compositeIBondRate(0, 4.81), 9.62);
  // Nov 2021: 0.00% fixed, 3.56% semiannual -> 7.12%.
  assert.equal(adapter.compositeIBondRate(0, 3.56), 7.12);
});

test('compositeIBondRate keeps the cross term, which is not rounding noise', () => {
  const withCross = adapter.compositeIBondRate(1.30, 1.97);
  const withoutCross = Math.round((1.30 + 2 * 1.97) * 100) / 100;
  assert.equal(withoutCross, 5.24);
  assert.equal(withCross, 5.27);           // 3bp of real money the naive formula loses
});

test('the I bond composite floors at zero in deflation', () => {
  // May 2009: 0.10% fixed against a -2.78% semiannual inflation rate.
  assert.equal(adapter.compositeIBondRate(0.10, -2.78), 0);
  // A positive fixed rate survives mild deflation instead of going negative.
  assert.equal(adapter.compositeIBondRate(1.20, -0.50), 0.19);
  assert.equal(adapter.compositeIBondRate(null, 1.30), null);
  assert.equal(adapter.compositeIBondRate(1.2, 'not a rate'), null);
});

test('doublingApy prices the EE guarantee, not the coupon', () => {
  const apy = adapter.doublingApy(20);
  assert.ok(Math.abs(apy - 3.5265) < 0.001, `expected ~3.53%, got ${apy}`);
  // The definition: compounding at that rate for 20 years doubles the money.
  assert.ok(Math.abs(Math.pow(1 + apy / 100, 20) - 2) < 1e-9);
  assert.equal(adapter.doublingApy(0), null);
  assert.equal(adapter.doublingApy('x'), null);
});

test('breakevenInflation uses the exact Fisher relation', () => {
  const be = adapter.breakevenInflation(4.16, 1.87);
  assert.ok(Math.abs(be - 2.2479) < 0.0005, `expected ~2.2479%, got ${be}`);
  // Nominal minus real is the rule of thumb and it runs hot.
  assert.ok(be < 4.16 - 1.87);
  assert.equal(adapter.breakevenInflation(4.16, null), null);
  assert.equal(adapter.breakevenInflation(4.16, -120), null);
});

test('breakevenNotes turns curve pairs into a sentence, skipping unusable ones', () => {
  const notes = adapter.breakevenNotes([
    { tenor: '5-year', nominal: 3.81, real: 1.57 },
    { tenor: '10-year', nominal: null, real: 1.87 },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /5-year inflation 2\.2[0-9]%/);
  assert.match(notes[0], /only beat nominal Treasuries/);
  assert.deepEqual(adapter.breakevenNotes(null), []);
});

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

test('loadSeed returns the whole bundled table and every row validates', () => {
  const res = seedResult();
  assert.equal(res.status, 'offline');
  // Every instrument in the table must have a seed rate: a row that only appears
  // when the network is up is a row the offline app silently lacks.
  assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length);
  assert.ok(adapter.INSTRUMENTS.length >= 50, `the instrument table has thinned out: ${adapter.INSTRUMENTS.length}`);
  assert.equal(res.warnings.length, 0);
  for (const o of res.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.seed, true);
    assert.equal(o.source, 'bonds');
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.ok(o.accessNotes, `${o.id} has no accessNotes`);
  }
  const ids = res.opportunities.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('loadSeed covers all four groups', () => {
  const rows = seedResult().opportunities;
  const count = (fn) => rows.filter(fn).length;
  assert.equal(count((o) => o.subType === 'savings_bond'), 2);
  assert.equal(count((o) => o.assetClass === C.ASSET_CLASS.CORP_BOND), 11);
  assert.equal(count((o) => o.assetClass === C.ASSET_CLASS.MUNI_BOND), 8);
  assert.ok(count((o) => o.assetClass === C.ASSET_CLASS.RWA) >= 12);
  assert.ok(count((o) => o.assetClass === C.ASSET_CLASS.GOVT_BOND) >= 20);
});

test('loadSeed never throws, whatever the seed directory holds', () => {
  const missing = adapter.loadSeed({ ...baseCtx(), seedDir: '/nonexistent/path/for/bonds' });
  assert.equal(missing.status, 'failed');
  assert.deepEqual(missing.opportunities, []);
  assert.ok(missing.warnings.length);
  assert.doesNotThrow(() => adapter.loadSeed());
  assert.doesNotThrow(() => adapter.loadSeed({ seedDir: SEED_DIR }));
});

test('unknown or rate-less seed rows are skipped and counted, not guessed at', () => {
  const { quotes, skipped } = adapter.parseSeedItems([
    { key: 'IGSB', yield: 4.3 },
    { key: 'NOT_A_REAL_KEY', yield: 9.9 },
    { key: 'SUB' },                                   // no rate at all
    { key: 'series-i', semiannualInflation: 1.3 },    // half an I bond is no I bond
    null,
  ]);
  assert.deepEqual([...quotes.keys()], ['IGSB']);
  assert.equal(skipped, 4);
});

// ---------------------------------------------------------------------------
// savings bonds
// ---------------------------------------------------------------------------

test('the I bond encodes its composite rate, purchase cap and lockup', () => {
  const i = byId(seedResult().opportunities, 'bonds:series-i');
  assert.equal(i.apy.total, adapter.compositeIBondRate(1.20, 1.30));
  assert.equal(i.apy.total, 3.82);
  assert.equal(i.assetClass, C.ASSET_CLASS.GOVT_BOND);
  assert.equal(i.yieldKind, C.YIELD_KIND.ADMINISTERED);
  assert.equal(i.liquidity, C.LIQUIDITY.LOCKED);
  assert.equal(i.term.days, 365);
  assert.equal(i.maxInvestment, 10000);
  assert.equal(i.minInvestment, 25);
  assert.equal(i.taxTreatment, C.TAX_TREATMENT.TREASURY);
  assert.equal(i.risk.insurance, C.INSURANCE.US_GOV);
  assert.equal(i.risk.principalAtRisk, false);
  assert.match(i.term.earlyExitPenalty, /3 months of interest/);
  assert.match(i.term.earlyExitPenalty, /12 months/);
  assert.match(i.notes, /1 May and 1 Nov/);
  assert.match(i.notes, /can never print below 0\.00%/);
  assert.match(i.notes, /annual purchase limit per person, not a balance tier/);
  assert.match(i.accessNotes, /TreasuryDirect/);
});

test('the I bond row carries the TIPS comparison the breakeven exists for', () => {
  const i = byId(seedResult().opportunities, 'bonds:series-i');
  // Seed fixed rate 1.20% against the 5-year TIPS real yield of 1.55%.
  assert.match(i.notes, /real return is the 1\.20% fixed rate/);
  assert.match(i.notes, /1\.55% 5-year TIPS real yield/);
  assert.match(i.notes, /0\.35pp more real yield/);

  // And the other way round: when the fixed rate beats the TIPS real yield, the
  // note has to say so rather than printing a negative advantage for TIPS.
  const entry = adapter.INSTRUMENTS.find((e) => e.key === 'series-i');
  const rich = adapter.buildOpportunity(entry, { fixedRate: 2.10, semiannualInflation: 1.30 }, {
    schema, C, dataAsOf: '2026-08-01', breakevens: [{ tenor: '5-year', nominal: 3.80, real: 1.55 }],
  });
  assert.match(rich.notes, /the I bond pays 0\.55pp more real yield than TIPS/);
});

test('the EE bond is priced off the doubling guarantee, not the stated coupon', () => {
  const ee = byId(seedResult().opportunities, 'bonds:series-ee');
  assert.ok(Math.abs(ee.apy.total - 3.5265) < 0.001);
  assert.equal(ee.yieldKind, C.YIELD_KIND.CONTRACTUAL);   // the doubling is guaranteed
  assert.equal(ee.term.days, 7305);                       // 20 years, the horizon it assumes
  assert.equal(ee.liquidity, C.LIQUIDITY.LOCKED);
  assert.match(ee.notes, /double the purchase price at exactly 20 years/);
  assert.match(ee.notes, /announced coupon rate of 2\.60%/);
  assert.match(ee.notes, /misleading/);
  assert.match(ee.term.earlyExitPenalty, /forfeits the doubling/);
});

test('savings bonds land in a low risk tier and are flagged for their purchase cap', () => {
  const rows = seedResult().opportunities;
  for (const id of ['bonds:series-i', 'bonds:series-ee']) {
    const o = byId(rows, id);
    const risk = scoreRisk(o);
    assert.ok(risk.score <= 8, `${id} scored ${risk.score}, expected government-guaranteed cap`);
    assert.equal(risk.principalAtRisk, false);
    // The $10k limit reaches traps.js as a balance cap. That flag is the price of
    // encoding the limit somewhere machine-readable, and the row's notes explain it.
    const traps = detectTraps(o);
    assert.ok(traps.flags.includes(C.TRAP_FLAGS.CAPPED_BALANCE));
    // And nothing else: a government savings bond is not a promotional teaser,
    // so the requirement strings must stay clear of traps.js's promo wording.
    assert.deepEqual(traps.flags, [C.TRAP_FLAGS.CAPPED_BALANCE], `${id}: ${traps.flags.join()}`);
  }
});

// ---------------------------------------------------------------------------
// credit and muni proxies
// ---------------------------------------------------------------------------

test('every fund proxy says it is a proxy and carries duration as term', () => {
  const rows = seedResult().opportunities
    .filter((o) => [C.ASSET_CLASS.CORP_BOND, C.ASSET_CLASS.MUNI_BOND].includes(o.assetClass));
  assert.equal(rows.length, 19);
  for (const o of rows) {
    assert.match(o.notes, /Index proxy, not a bond/);
    assert.match(o.notes, /not a lockup/);
    assert.equal(o.liquidity, C.LIQUIDITY.DAILY);
    assert.ok(Number.isFinite(o.term.days) && o.term.days > 0, `${o.symbol} has no duration`);
    assert.ok(o.risk.creditRating, `${o.symbol} has no credit rating for risk.js`);
    assert.equal(o.yieldKind, C.YIELD_KIND.MARKET);       // seed carries SEC 30-day yields
  }
});

test('term.days is the published effective duration, in days', () => {
  const rows = seedResult().opportunities;
  assert.equal(bySymbol(rows, 'VCLT').term.days, adapter.durationDays(12.9));
  assert.equal(bySymbol(rows, 'VCLT').term.days, 4712);
  assert.equal(bySymbol(rows, 'BKLN').term.days, adapter.durationDays(0.25));
  assert.equal(bySymbol(rows, 'SUB').term.days, adapter.durationDays(1.9));
  assert.match(bySymbol(rows, 'VCLT').term.label, /12\.9yr duration/);
});

test('duration flows through to risk: a long corporate proxy outscores a short one', () => {
  const rows = seedResult().opportunities;
  const long = scoreRisk(bySymbol(rows, 'VCLT')).score;
  const short = scoreRisk(bySymbol(rows, 'IGSB')).score;
  const floating = scoreRisk(bySymbol(rows, 'FLOT')).score;
  assert.ok(long > short, `VCLT ${long} should outscore IGSB ${short}`);
  assert.ok(short > floating, `IGSB ${short} should outscore FLOT ${floating}`);
});

test('credit quality reaches risk.js in the notation it scores', () => {
  const rows = seedResult().opportunities;
  assert.equal(bySymbol(rows, 'SPHY').risk.creditRating, 'B+');
  assert.equal(bySymbol(rows, 'ANGL').risk.creditRating, 'BB');
  const junk = scoreRisk(bySymbol(rows, 'SPHY'));
  assert.ok(junk.factors.some((f) => /Credit rating B\+/.test(f.label)));
});

test('national munis are federal exempt; a single-state fund depends on where you live', () => {
  const national = bySymbol(seedResult().opportunities, 'PZA');
  assert.equal(national.taxTreatment, C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
  assert.equal(national.stateOfIssue, null);

  const californian = adapter.loadSeed(baseCtx({ tax: { state: 'CA' } })).opportunities;
  assert.equal(bySymbol(californian, 'CMF').taxTreatment, C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT);
  assert.equal(bySymbol(californian, 'CMF').stateOfIssue, 'CA');
  assert.match(bySymbol(californian, 'CMF').notes, /CA resident/);
  // Same fund, a Texan holder: the state exemption is not theirs to claim.
  assert.equal(bySymbol(californian, 'NYF').taxTreatment, C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
  assert.match(bySymbol(californian, 'NYF').notes, /only applies to NY residents/);

  const texan = adapter.loadSeed(baseCtx({ tax: { state: 'TX' } })).opportunities;
  assert.equal(bySymbol(texan, 'CMF').taxTreatment, C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
});

test('muniTreatment tolerates a missing or oddly-cased settings block', () => {
  const cmf = adapter.INSTRUMENTS.find((e) => e.key === 'CMF');
  assert.equal(adapter.muniTreatment(cmf, undefined, C), C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
  assert.equal(adapter.muniTreatment(cmf, { tax: { state: ' ca ' } }, C), C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT);
  assert.equal(adapter.muniTreatment({ key: 'PZA' }, { tax: { state: 'CA' } }, C), C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
});

// ---------------------------------------------------------------------------
// tokenized treasuries
// ---------------------------------------------------------------------------

test('the ladder rungs carry a real maturity, not a duration standing in for one', () => {
  const rows = seedResult().opportunities.filter((o) => o.subType === 'ladder');
  assert.ok(rows.length >= 5, 'a five-year ladder needs five rungs');

  const years = rows.map((o) => Number(o.term.maturity.slice(0, 4))).sort();
  // Consecutive years, so "I want a 5-year ladder" is actually answerable.
  for (let i = 1; i < years.length; i += 1) assert.equal(years[i], years[i - 1] + 1, 'the ladder has a gap in it');

  for (const o of rows) {
    assert.equal(o.assetClass, C.ASSET_CLASS.GOVT_BOND);
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.TREASURY);
    // term.kind is the whole point: a maturity is a date you get your money
    // back on, a duration is a rate-sensitivity number wearing a date's clothes.
    assert.equal(o.term.kind, 'maturity');
    assert.match(o.term.maturity, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(o.term.days) && o.term.days > 0, `${o.symbol} has no days to maturity`);
    // Derived from the date, not stored — so it counts down instead of drifting.
    const expected = Math.round((Date.parse(o.term.maturity) - Date.now()) / 86400000);
    assert.ok(Math.abs(o.term.days - expected) <= 1, `${o.symbol}: ${o.term.days} vs ${expected}`);
    assert.match(o.notes, /liquidates and pays out/);
    assert.doesNotMatch(o.notes, /effective duration expressed in days/);
    assert.deepEqual(schema.validate(o), []);
  }
  // Longer rung, later date, more yield: the ladder must slope the right way.
  const sorted = rows.slice().sort((a, b) => a.term.days - b.term.days);
  assert.ok(sorted[sorted.length - 1].apy.total > sorted[0].apy.total, 'the ladder is inverted');
});

test('the Treasury, agency and TIPS funds are distinct instruments, not four names for one', () => {
  const rows = seedResult().opportunities;
  const group = (t) => rows.filter((o) => o.subType === t);

  assert.ok(group('treasury_fund').length >= 6);
  assert.ok(group('agency').length + group('agency_mbs').length >= 5);
  assert.ok(group('tips_fund').length >= 5);

  // The dedupe key for a government bond is subType plus rounded term days, so
  // two rows that collide on both would silently merge and one fund would vanish
  // from the table. Duration is a real published number and they genuinely
  // differ, but the app depends on that, so it is asserted.
  const keys = rows
    .filter((o) => o.assetClass === C.ASSET_CLASS.GOVT_BOND && Number.isFinite(o.term.days))
    .map((o) => `${o.subType}:${Math.round(o.term.days)}`);
  assert.equal(new Set(keys).size, keys.length, 'two government rows share a dedupe key and would merge');

  // Agency mortgage paper is not full faith and credit and must not read as if
  // it were; Treasury and TIPS funds are, and get the state-tax exemption.
  for (const o of group('agency_mbs')) {
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.ORDINARY);
    assert.match(o.notes, /prepayment/i);
  }
  for (const o of [...group('treasury_fund'), ...group('tips_fund')]) {
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.TREASURY);
  }
  assert.match(group('agency')[0].notes, /implicit/i);

  // A TIPS fund's headline is a real yield and the row has to say so, otherwise
  // it reads as paying two points less than a nominal Treasury for no reason.
  for (const o of group('tips_fund')) assert.match(o.notes, /real yield/i);

  // The extreme-duration rows are the ones a reader is most likely to mistake
  // for safe, because they have no credit risk at all.
  const zroz = rows.find((o) => o.symbol === 'ZROZ');
  assert.ok(zroz.term.days > 9000, 'ZROZ should carry the longest duration in the app');
  assert.ok(scoreRisk(zroz).score > scoreRisk(rows.find((o) => o.symbol === 'VGSH')).score + 15);
});

test('tokenized Treasury rows are uninsured and say why', () => {
  const rows = seedResult().opportunities.filter((o) => o.assetClass === C.ASSET_CLASS.RWA);
  assert.ok(rows.length >= 12, `only ${rows.length} tokenized issuers`);
  for (const o of rows) {
    assert.equal(o.risk.insurance, C.INSURANCE.NONE);
    assert.equal(o.risk.principalAtRisk, true);
    assert.equal(o.subType, 'tokenized_treasury');
    assert.match(o.notes, /no FDIC or SIPC coverage/i);
    assert.match(o.notes, /smart|contract/i);
    assert.ok(o.requirements.length, `${o.symbol} should state its eligibility requirements`);
    assert.match(o.accessNotes, /KYC/);
  }
});

test('tokenized rows keep the yield below the bills they hold, and stay off the top of the table', () => {
  const rows = seedResult().opportunities.filter((o) => o.assetClass === C.ASSET_CLASS.RWA);
  for (const o of rows) {
    assert.ok(o.apy.total > 2 && o.apy.total < 5, `${o.symbol} at ${o.apy.total}% is not a T-bill proxy`);
    // Uninsured wrapper: it must not score as safely as an actual Treasury.
    assert.ok(scoreRisk(o).score > 8, `${o.symbol} scored like government paper`);
  }
});

// ---------------------------------------------------------------------------
// the live DefiLlama shape
// ---------------------------------------------------------------------------

test('parseRwaPools matches tokenized products by symbol and project', () => {
  const out = adapter.parseRwaPools(readJson('bonds-llama-rwa.json'));
  assert.equal(out.warnings.length, 0);
  assert.equal(out.matched, 8);                       // everything in the fixture except WTGXX
  assert.equal(out.quotes.get('BENJI').yield, 3.52);
  assert.equal(out.quotes.get('IB01').yield, 3.62);
  assert.equal(out.quotes.has('WTGXX'), false);
  for (const q of out.quotes.values()) assert.equal(q.live, true);
});

test('parseRwaPools takes the deepest listing when a token is on several chains', () => {
  const out = adapter.parseRwaPools(readJson('bonds-llama-rwa.json'));
  assert.equal(out.quotes.get('BUIDL').yield, 3.58);   // Ethereum $2.18B, not Aptos $41M
  assert.equal(out.quotes.get('BUIDL').tvl, 2180000000);
  assert.equal(out.quotes.get('USYC').tvl, 880000000);
});

test('parseRwaPools falls back to apyBase and refuses impossible T-bill yields', () => {
  const out = adapter.parseRwaPools(readJson('bonds-llama-rwa.json'));
  assert.equal(out.quotes.get('USTB').yield, 3.61);    // "apy" was null on that record
  // The fixture carries an 88% print on a real project and a 79% look-alike on a
  // fork. A fund holding Treasury bills does not pay either.
  assert.equal(out.quotes.get('TBILL').yield, 3.49);
  assert.equal(out.absurd, 1);
  assert.ok(out.notes.some((n) => /implausible APY/.test(n)));
});

test('parseRwaPools survives upstream shape drift without throwing', () => {
  assert.equal(adapter.parseRwaPools(null).quotes.size, 0);
  assert.ok(adapter.parseRwaPools({}).warnings.length);
  assert.ok(adapter.parseRwaPools({ chart: 'wrong endpoint' }).warnings.length);
  assert.equal(adapter.parseRwaPools([]).quotes.size, 0);        // bare array form
  const renamed = adapter.parseRwaPools({
    status: 'success',
    data: [{ pool: 'x', chain: 'Ethereum', project: 'ondo-finance', symbol: 'USDY', tvlUsd: 1e8, yieldPct: 3.4 }],
  });
  assert.equal(renamed.matched, 0);                    // renamed rate field -> skipped, not invented
  const degraded = adapter.parseRwaPools({ status: 'error', data: [] });
  assert.ok(degraded.warnings.some((w) => /status "error"/.test(w)));
});

test('a live tokenized quote produces a valid, non-seed opportunity', () => {
  const out = adapter.parseRwaPools(readJson('bonds-llama-rwa.json'), { dataAsOf: '2026-08-27T12:00:00.000Z' });
  const built = adapter.buildAll(out.quotes, { schema, C, dataAsOf: '2026-08-01' });
  assert.equal(built.opportunities.length, 8);
  for (const o of built.opportunities) {
    assert.deepEqual(schema.validate(o), []);
    assert.equal(o.seed, false);
    assert.equal(o.live, true);
    assert.equal(o.dataAsOf, '2026-08-27T12:00:00.000Z');
    assert.equal(o.assetClass, C.ASSET_CLASS.RWA);
  }
});

// ---------------------------------------------------------------------------
// the live path end to end, on stubbed transport
// ---------------------------------------------------------------------------

function stubHttp({ chartSymbols = ['IGSB'], pools = true, curves = true } = {}) {
  const calls = [];
  return {
    calls,
    parseCSV: http.parseCSV,
    async getJSON(url) {
      calls.push(url);
      if (url.startsWith(adapter.POOLS_URL)) {
        if (!pools) throw new http.HttpError('HTTP 403 blocked', { status: 403, url });
        return readJson('bonds-llama-rwa.json');
      }
      const m = /\/v8\/finance\/chart\/([A-Za-z0-9.-]+)\?/.exec(url);
      if (m && chartSymbols.includes(m[1])) return readJson('bonds-yahoo-chart-igsb.json');
      throw new http.HttpError('HTTP 404 Not Found', { status: 404, url });
    },
    async getText(url) {
      calls.push(url);
      if (!curves) throw new http.HttpError('HTTP 403 blocked', { status: 403, url });
      if (url.includes('daily_treasury_real_yield_curve')) return readText('treasury-real-2026.csv');
      if (url.includes('daily_treasury_yield_curve')) return readText('treasury-nominal-2026.csv');
      throw new http.HttpError('HTTP 404 Not Found', { status: 404, url });
    },
  };
}

test('fetch overlays live quotes on the bundled table and keeps every row valid', async () => {
  const res = await adapter.fetch({ ...baseCtx(), http: stubHttp() });
  assert.equal(res.status, 'partial');               // every fund proxy but IGSB had no chart
  assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length);
  for (const o of res.opportunities) assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);

  const live = res.opportunities.filter((o) => !o.seed);
  assert.equal(live.length, 9);                      // 8 tokenized + IGSB
  const igsb = bySymbol(res.opportunities, 'IGSB');
  assert.equal(igsb.seed, false);
  assert.equal(igsb.yieldKind, C.YIELD_KIND.TRAILING);
  assert.equal(igsb.price, 52.59);
  assert.equal(igsb.minInvestment, 52.59);
  assert.ok(Math.abs(igsb.apy.total - 4.33) < 0.05, `trailing yield was ${igsb.apy.total}`);
  assert.ok(Math.abs(igsb.apy.forward - 4.33) < 0.05);
  assert.match(igsb.notes, /trailing twelve months/);
  assert.equal(igsb.term.days, adapter.durationDays(2.6));   // duration is structural, not fetched
});

test('fetch leaves savings bonds on the snapshot and says so', async () => {
  const res = await adapter.fetch({ ...baseCtx(), http: stubHttp() });
  const i = byId(res.opportunities, 'bonds:series-i');
  assert.equal(i.seed, true);
  assert.equal(i.dataAsOf, '2026-08-01');
  assert.equal(i.apy.total, 3.82);
  assert.ok(res.notes.some((n) => /TreasuryDirect publishes them on a web page/.test(n)));
});

test('fetch computes breakevens off the live Treasury curves', async () => {
  const res = await adapter.fetch({ ...baseCtx(), http: stubHttp() });
  // Latest dated rows with data are 08/26: 5y 3.81 vs 1.57, 10y 4.16 vs 1.87.
  assert.ok(res.notes.some((n) => /5-year inflation 2\.21%/.test(n)), res.notes.join(' | '));
  assert.ok(res.notes.some((n) => /10-year inflation 2\.25%/.test(n)));
  assert.ok(res.notes.some((n) => /Breakevens computed from the 2026-08-26/.test(n)));
});

test('fetch falls back to snapshot breakevens when the curve is unreachable', async () => {
  const res = await adapter.fetch({ ...baseCtx(), http: stubHttp({ curves: false }) });
  assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length);
  assert.ok(res.notes.some((n) => /breakevens use the 2026-08-01 snapshot levels/.test(n)));
  assert.ok(res.notes.some((n) => /10-year inflation 2\.2[0-9]%/.test(n)));
});

test('a blocked upstream degrades the source, it does not fail it', async () => {
  const res = await adapter.fetch({ ...baseCtx(), http: stubHttp({ pools: false, chartSymbols: [], curves: false }) });
  assert.equal(res.status, 'partial');
  assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length);
  assert.ok(res.opportunities.every((o) => o.seed));
  assert.ok(res.warnings.some((w) => /403/.test(w)));
  for (const o of res.opportunities) assert.deepEqual(schema.validate(o), []);
});

test('fetch never throws, even on transport that misbehaves', async () => {
  const hostile = {
    parseCSV: http.parseCSV,
    async getJSON() { throw new Error('socket hang up'); },
    async getText() { return 'not,a,curve\n1,2,3'; },
  };
  const res = await adapter.fetch({ ...baseCtx(), http: hostile });
  assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length);
  assert.ok(['ok', 'partial', 'failed'].includes(res.status));

  const noSeed = await adapter.fetch({ ...baseCtx(), seedDir: '/nonexistent', http: hostile });
  assert.equal(noSeed.status, 'failed');
  assert.deepEqual(noSeed.opportunities, []);
});

test('buildAll skips anything it cannot build and reports which', () => {
  const built = adapter.buildAll(new Map([
    ['IGSB', { yield: 4.3, basis: 'sec30day' }],
    ['series-i', { fixedRate: 1.2, semiannualInflation: 1.3 }],
  ]), { schema, C, dataAsOf: '2026-08-01' });
  assert.equal(built.opportunities.length, 2);
  assert.equal(built.skipped.length, adapter.INSTRUMENTS.length - 2);
  assert.ok(built.skipped.includes('BUIDL'));
  // Plain objects work as well as Maps, and a junk quote is skipped not thrown on.
  assert.equal(adapter.buildAll({ IGSB: { yield: null } }, { schema, C }).opportunities.length, 0);
  assert.equal(adapter.buildAll(null, { schema, C }).opportunities.length, 0);
});

test('the instrument table stays consistent with itself', () => {
  const keys = adapter.INSTRUMENTS.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'instrument keys must be unique');
  for (const e of adapter.INSTRUMENTS) {
    assert.ok(['savings_bond', 'fund_proxy', 'rwa'].includes(e.group), `${e.key} has no known group`);
    if (e.group === 'fund_proxy') {
      assert.ok(adapter.CATEGORIES[e.category], `${e.key} has no category`);
      assert.ok(Number.isFinite(e.durationYears) && e.durationYears > 0, `${e.key} needs a duration`);
      assert.ok(e.creditRating, `${e.key} needs a stated credit quality`);
      if (e.maturity) assert.match(e.maturity, /^\d{4}-\d{2}-\d{2}$/, `${e.key} has an unusable maturity`);
    }
  }
});

// ---------------------------------------------------------------------------
// regressions: a sibling parser or a bad clock must degrade this source, never
// zero it out. Both of these used to throw out of fetchLive, and the outer catch
// turned a missing breakeven sentence into a failed source with no rows at all —
// including the savings bonds, which need no network in the first place.
// ---------------------------------------------------------------------------

test('a shape drift in the treasury curve parser costs the breakeven, not the rows', async () => {
  const treasury = require('../src/sources/treasury');
  const original = treasury.parseCurveCSV;
  const drifted = [
    {},                                                   // tenors gone entirely
    { dateISO: '2026-08-26T00:00:00Z', tenors: null },
    { dateISO: '2026-08-26T00:00:00Z', tenors: {} },      // object where an array is expected
    { dateISO: '2026-08-26T00:00:00Z', tenors: [] },
    { dateISO: '2026-08-26T00:00:00Z', tenors: [null, undefined] },
    { tenors: [{ days: 1826, rate: 3.8 }, { days: 3653, rate: 4.15 }] },   // no dateISO
    { dateISO: 20260826, tenors: [{ days: 1826, rate: 3.8 }, { days: 3653, rate: 4.15 }] },
  ];
  try {
    for (const shape of drifted) {
      treasury.parseCurveCSV = () => shape;
      const res = await adapter.fetch({ ...baseCtx(), http: stubHttp() });
      assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length, `shape ${JSON.stringify(shape)} lost rows`);
      assert.notEqual(res.status, 'failed');
      for (const o of res.opportunities) assert.deepEqual(schema.validate(o), []);
    }
  } finally {
    treasury.parseCurveCSV = original;
  }
});

test('an unusable ctx.now falls back to the wall clock instead of killing the source', async () => {
  for (const now of ['yesterday', NaN, {}, [], Infinity, -1, 0, null, undefined]) {
    const res = await adapter.fetch({ ...baseCtx(), now, http: stubHttp() });
    assert.equal(res.opportunities.length, adapter.INSTRUMENTS.length, `now=${String(now)} lost rows`);
    assert.notEqual(res.status, 'failed');
    for (const o of res.opportunities) assert.deepEqual(schema.validate(o), []);
  }
});
