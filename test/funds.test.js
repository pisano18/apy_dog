'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/funds');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const http = require('../src/core/http');
const { scoreRisk } = require('../src/core/risk');
const { detectTraps } = require('../src/core/traps');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');

/**
 * yahoo-chart-jepi.json is the real v8/finance/chart response shape, trimmed to
 * 61 daily bars so the numbers below can be checked by hand. It deliberately
 * contains two null bars (halted sessions) and 13 monthly dividends, the oldest
 * of which falls just outside the 365-day window.
 */
const chartPayload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'yahoo-chart-jepi.json'), 'utf8'));
const stooqCsv = fs.readFileSync(path.join(FIXTURES, 'stooq-jepi.csv'), 'utf8');

const NOW = Date.parse('2026-08-27T00:00:00Z');
const ctx = { schema, C, http, seedDir: SEED_DIR, settings: {}, now: NOW, log() {} };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b} (within ${eps})`);

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'funds');
  assert.equal(adapter.label, 'Income ETFs, REITs, BDCs & CEFs');
  assert.ok(adapter.assetClasses.includes('etf'));
  assert.ok(adapter.assetClasses.includes('cef'));
  for (const a of adapter.assetClasses) assert.ok(Object.values(C.ASSET_CLASS).includes(a), `bad assetClass ${a}`);
});

test('the universe is grouped, real and roughly the intended size', () => {
  const cats = Object.keys(adapter.UNIVERSE);
  assert.deepEqual(cats.sort(), [
    'bdc', 'bond_etf', 'cef', 'covered_call', 'dividend_etf', 'mortgage_reit', 'preferred', 'reit', 'ultrashort',
  ]);
  const all = adapter.resolveUniverse({});
  assert.ok(all.length >= 65 && all.length <= 85, `expected ~70 symbols, got ${all.length}`);
  assert.equal(new Set(all.map((e) => e.symbol)).size, all.length, 'duplicate ticker in the universe');
  for (const e of all) {
    assert.match(e.symbol, /^[A-Z]{1,5}$/, `${e.symbol} does not look like a US ticker`);
    assert.ok(e.name && e.issuer, `${e.symbol} is missing a name or issuer`);
    assert.ok(adapter.CATEGORIES[e.category], `${e.symbol} has unknown category ${e.category}`);
  }
  // Spot check that every category is actually populated.
  for (const [cat, list] of Object.entries(adapter.UNIVERSE)) assert.ok(list.length >= 5, `${cat} is thin`);
});

// ---------------------------------------------------------------------------
// Payout frequency
// ---------------------------------------------------------------------------

test('detects payout frequency from the median gap, not the mean', () => {
  const at = (...dates) => dates.map((d) => Date.parse(`${d}T00:00:00Z`));

  assert.equal(adapter.detectFrequency(at('2026-01-05', '2026-02-05', '2026-03-05', '2026-04-06')).periodsPerYear, 12);
  assert.equal(adapter.detectFrequency(at('2026-01-05', '2026-04-05', '2026-07-05', '2026-10-05')).periodsPerYear, 4);
  assert.equal(adapter.detectFrequency(at('2025-06-15', '2025-12-15', '2026-06-15')).periodsPerYear, 2);
  assert.equal(adapter.detectFrequency(at('2024-12-20', '2025-12-20', '2026-12-20')).periodsPerYear, 1);
  assert.equal(adapter.detectFrequency(at('2026-08-05', '2026-08-12', '2026-08-19')).periodsPerYear, 52);

  // A quarterly payer with a year-end special: the mean gap is ~68 days, which
  // would be read as monthly and annualise the forward yield by 12 instead of 4.
  const special = at('2025-03-20', '2025-06-20', '2025-09-19', '2025-12-19', '2025-12-29', '2026-03-20', '2026-06-19');
  assert.equal(adapter.detectFrequency(special).periodsPerYear, 4);

  assert.equal(adapter.detectFrequency([Date.now()]), null);
  assert.equal(adapter.detectFrequency(null), null);
});

// ---------------------------------------------------------------------------
// Yield
// ---------------------------------------------------------------------------

test('trailing yield sums only the last 365 days, forward annualises the latest payment', () => {
  const series = adapter.parseChart(chartPayload);
  const y = adapter.computeYield({ dividends: series.dividends, price: series.price, nowMs: NOW });

  // Twelve in-window payments: eleven at 0.38 plus a final 0.45 = 4.63 on 58.40.
  assert.equal(y.dividendCount, 12);
  close(y.trailingSum, 4.63, 1e-9);
  close(y.trailingYield, (4.63 / 58.40) * 100);
  // Forward takes only the 0.45 x 12. It is 1.3pp higher, which is exactly the
  // flattery this adapter refuses to lead with.
  close(y.forwardYield, ((0.45 * 12) / 58.40) * 100);
  assert.ok(y.forwardYield > y.trailingYield);
  assert.equal(y.payoutFrequency, 'monthly');
  assert.equal(y.partialHistory, false);
});

test('a monthly payer with almost no history is flagged rather than published as a low yield', () => {
  const divs = [
    { ts: Date.parse('2026-07-01T00:00:00Z'), amount: 0.40 },
    { ts: Date.parse('2026-08-01T00:00:00Z'), amount: 0.40 },
  ];
  const y = adapter.computeYield({ dividends: divs, price: 50, nowMs: NOW });
  assert.equal(y.periodsPerYear, 12);
  assert.equal(y.partialHistory, true);
  assert.match(y.notes.join(' '), /less than a full year/);
  close(y.trailingYield, (0.80 / 50) * 100);          // still reported, honestly
  close(y.forwardYield, ((0.40 * 12) / 50) * 100);
});

test('yield is null, never zero or NaN, when the inputs are unusable', () => {
  assert.equal(adapter.computeYield({ dividends: [], price: 50 }).trailingYield, null);
  assert.equal(adapter.computeYield({ dividends: [{ ts: NOW, amount: 1 }], price: 0 }).trailingYield, null);
  assert.equal(adapter.computeYield({ dividends: [{ ts: NOW, amount: 1 }], price: null }).trailingYield, null);
  // Junk records are dropped, not coerced.
  const y = adapter.computeYield({
    dividends: [{ ts: 'nope', amount: 0.5 }, { ts: NOW - 10 * 86400000, amount: 'n/a' }, { ts: NOW - 5 * 86400000, amount: 0.5 }],
    price: 100,
    nowMs: NOW,
  });
  assert.equal(y.dividendCount, 1);
  close(y.trailingYield, 0.5);
});

test('a fund that stopped paying reads as 0%, and says so', () => {
  const divs = [{ ts: Date.parse('2024-03-01T00:00:00Z'), amount: 0.5 }, { ts: Date.parse('2024-06-01T00:00:00Z'), amount: 0.5 }];
  const y = adapter.computeYield({ dividends: divs, price: 20, nowMs: NOW });
  assert.equal(y.trailingYield, 0);
  assert.match(y.notes.join(' '), /Paid nothing in the last 12 months/);
});

// ---------------------------------------------------------------------------
// Volatility and drawdown
// ---------------------------------------------------------------------------

test('volatility matches the closed form for a series with a known stdev', () => {
  // 41 prices alternating 100/101 give 40 log returns of +-ln(1.01) with a mean
  // of exactly zero, so the sample stdev is ln(1.01) * sqrt(40/39).
  const px = Array.from({ length: 41 }, (_, i) => (i % 2 ? 101 : 100));
  const expected = Math.log(1.01) * Math.sqrt(40 / 39) * Math.sqrt(252) * 100;
  const out = adapter.computeVolatility(px);
  assert.equal(out.returns, 40);
  close(out.volatility, expected, 1e-9);
});

test('volatility drops implausible daily moves and refuses to answer on thin data', () => {
  const px = Array.from({ length: 41 }, (_, i) => (i % 2 ? 101 : 100));
  const withSplit = [...px.slice(0, 20), 1000, ...px.slice(20)];   // an unadjusted 10x
  const out = adapter.computeVolatility(withSplit);
  assert.equal(out.discarded, 2);                                  // the jump up and back down
  assert.ok(out.volatility < 20, `a split should not become 1000% vol, got ${out.volatility}`);

  assert.equal(adapter.computeVolatility([100, 101, 102]), null);  // fewer than 20 returns
  assert.equal(adapter.computeVolatility(null), null);
  assert.equal(adapter.computeVolatility([]), null);
});

test('max drawdown is the worst peak-to-trough, in that order', () => {
  close(adapter.computeMaxDrawdown([100, 120, 90, 110, 60, 80]), 50);   // 120 -> 60
  close(adapter.computeMaxDrawdown([100, 101, 102]), 0);                // monotone rise
  assert.equal(adapter.computeMaxDrawdown([100]), null);
  // A deep trough BEFORE the peak must not count against the later high.
  close(adapter.computeMaxDrawdown([100, 50, 200, 190]), 50);
});

// ---------------------------------------------------------------------------
// Parsing the upstream payloads
// ---------------------------------------------------------------------------

test('parses the chart payload, skipping null bars and keeping dividends', () => {
  const s = adapter.parseChart(chartPayload);
  assert.equal(s.symbol, 'JEPI');
  assert.equal(s.currency, 'USD');
  assert.equal(s.price, 58.40);
  assert.equal(s.priceFromMeta, true);
  assert.equal(s.adjustedForDividends, true);
  assert.equal(s.adj.length, 59, 'the two halted sessions must be dropped, not zero-filled');
  assert.equal(s.dividends.length, 13);
  assert.equal(s.dividends[0].ts, Date.UTC(2025, 7, 1));
  assert.equal(new Date(s.lastTsMs).toISOString().slice(0, 10), '2026-08-26');
});

test('the fixture end to end: measured price, yield, volatility and drawdown', () => {
  const stats = adapter.analyzeSeries(adapter.parseChart(chartPayload), { nowMs: NOW });
  assert.equal(stats.price, 58.40);
  close(stats.trailingYield, (4.63 / 58.40) * 100);
  close(stats.forwardYield, ((0.45 * 12) / 58.40) * 100);
  // The path peaks at 60.10 and troughs at 50.25 by construction.
  close(stats.maxDrawdown, ((60.10 - 50.25) / 60.10) * 100, 1e-9);
  assert.ok(stats.volatility > 8 && stats.volatility < 20, `implausible vol ${stats.volatility}`);
  assert.equal(stats.yieldSource, 'measured');
  assert.equal(stats.dataAsOf.slice(0, 10), '2026-08-26');
});

test('degenerate chart responses degrade, they do not throw', () => {
  assert.equal(adapter.parseChart(null), null);
  assert.equal(adapter.parseChart({}), null);
  assert.equal(adapter.parseChart({ chart: { result: [], error: null } }), null);
  assert.match(
    adapter.parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }).error,
    /Not Found/,
  );

  // A field rename upstream must degrade this source, never crash it.
  const renamed = JSON.parse(JSON.stringify(chartPayload));
  delete renamed.chart.result[0].indicators.adjclose;
  const s = adapter.parseChart(renamed);
  assert.equal(s.adjustedForDividends, false);
  assert.equal(s.adj.length, 59, 'raw close must stand in when adjclose disappears');

  const noMetaPrice = JSON.parse(JSON.stringify(chartPayload));
  delete noMetaPrice.chart.result[0].meta.regularMarketPrice;
  const s2 = adapter.parseChart(noMetaPrice);
  assert.equal(s2.priceFromMeta, false);
  assert.ok(s2.price > 0, 'must fall back to the last close');

  const noEvents = JSON.parse(JSON.stringify(chartPayload));
  delete noEvents.chart.result[0].events;
  assert.deepEqual(adapter.parseChart(noEvents).dividends, []);
});

test('accepts the array form of the dividend events block', () => {
  const arrayForm = JSON.parse(JSON.stringify(chartPayload));
  arrayForm.chart.result[0].events.dividends = [
    { amount: 0.40, date: Date.UTC(2026, 6, 1) / 1000 },
    { amount: 0.41, date: Date.UTC(2026, 7, 1) / 1000 },
    { amount: 'bad', date: Date.UTC(2026, 5, 1) / 1000 },
  ];
  const s = adapter.parseChart(arrayForm);
  assert.equal(s.dividends.length, 2);
  assert.equal(s.dividends[1].amount, 0.41);
});

test('the Stooq fallback gives price and volatility but no yield of its own', () => {
  const s = adapter.parseStooq(stooqCsv, http.parseCSV);
  assert.equal(s.adjustedForDividends, false);
  assert.deepEqual(s.dividends, []);
  assert.ok(s.price > 0);
  assert.equal(new Date(s.lastTsMs).toISOString().slice(0, 10), '2026-08-26');

  const bare = adapter.analyzeSeries(s, { nowMs: NOW });
  assert.equal(bare.trailingYield, null, 'no dividends means no yield may be invented');

  const seeded = adapter.analyzeSeries(s, { nowMs: NOW, fallbackYield: 7.8 });
  assert.equal(seeded.trailingYield, 7.8);
  assert.equal(seeded.yieldSource, 'seed');
  assert.match(seeded.notes.join(' '), /bundled snapshot/);
  assert.match(seeded.notes.join(' '), /not dividend-adjusted/);

  assert.equal(adapter.parseStooq('', http.parseCSV), null);
  assert.equal(adapter.parseStooq('Date,Close\ngarbage,', http.parseCSV), null);
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('maps a covered-call ETF onto the canonical vocabulary', () => {
  const entry = adapter.UNIVERSE.covered_call.find((e) => e.symbol === 'JEPI');
  const stats = adapter.analyzeSeries(adapter.parseChart(chartPayload), { nowMs: NOW });
  const o = adapter.buildOpportunity(entry, stats, { schema, C });

  assert.deepEqual(schema.validate(o), []);
  assert.equal(o.id, 'funds:jepi');
  assert.equal(o.assetClass, C.ASSET_CLASS.ETF);
  assert.equal(o.yieldKind, C.YIELD_KIND.TRAILING);
  assert.equal(o.liquidity, C.LIQUIDITY.DAILY);
  assert.equal(o.taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(o.payoutFrequency, 'monthly');
  assert.equal(o.expenseRatio, 0.35);
  assert.equal(o.term.days, null, 'an open-ended fund has no maturity');
  // The price filter and the "can I afford one share" question both read these.
  assert.equal(o.price, 58.40);
  assert.equal(o.minInvestment, 58.40);
  // Rates are rounded to four decimals in the schema, so compare at that precision.
  close(o.apy.total, (4.63 / 58.40) * 100, 1e-4);
  close(o.apy.forward, ((0.45 * 12) / 58.40) * 100, 1e-4);
  assert.ok(o.risk.volatility > 0 && o.risk.maxDrawdown > 0);
  assert.match(o.accessNotes, /commission free/i);
  assert.equal(o.seed, false);
  assert.equal(o.live, true);
  assert.equal(o.confidence, 0.88);
});

test('tax treatment follows the instrument, not the wrapper', () => {
  const stats = { price: 20, trailingYield: 6, volatility: 12, maxDrawdown: 15 };
  const find = (sym) => adapter.resolveUniverse({}).find((e) => e.symbol === sym);
  const build = (sym) => adapter.buildOpportunity(find(sym), stats, { schema, C });

  assert.equal(build('O').taxTreatment, C.TAX_TREATMENT.SECTION_199A);
  assert.equal(build('ARCC').taxTreatment, C.TAX_TREATMENT.SECTION_199A);
  assert.equal(build('AGNC').taxTreatment, C.TAX_TREATMENT.SECTION_199A);
  assert.equal(build('SCHD').taxTreatment, C.TAX_TREATMENT.QUALIFIED_DIVIDEND);
  assert.equal(build('MUB').taxTreatment, C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT);
  assert.equal(build('MUB').assetClass, C.ASSET_CLASS.MUNI_BOND);
  assert.equal(build('HYG').taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(build('QYLD').taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(build('PDI').taxTreatment, C.TAX_TREATMENT.MIXED);
  // Treasury bill ETFs are state-tax exempt; the AAA CLO ETF next to them is not.
  assert.equal(build('SGOV').taxTreatment, C.TAX_TREATMENT.TREASURY);
  assert.equal(build('SGOV').assetClass, C.ASSET_CLASS.GOVT_BOND);
  assert.equal(build('JAAA').taxTreatment, C.TAX_TREATMENT.ORDINARY);
  assert.equal(build('JAAA').assetClass, C.ASSET_CLASS.CORP_BOND);
});

test('CEF and mortgage-REIT fields we cannot measure stay null', () => {
  const stats = { price: 18, trailingYield: 14, volatility: 16, maxDrawdown: 26 };
  const gof = adapter.buildOpportunity(adapter.UNIVERSE.cef.find((e) => e.symbol === 'GOF'), stats, { schema, C });
  assert.equal(gof.rocShare, null);
  assert.equal(gof.navPremium, null);
  assert.equal(gof.payoutCoverage, null);
  assert.equal(gof.tvl, null);
  assert.match(gof.notes, /left blank rather than guessed/);
  assert.equal(gof.risk.leverage, 1.35);
  assert.match(gof.accessNotes, /limit orders/);
});

test('structural leverage reaches risk.js and traps.js', () => {
  const stats = { price: 10, trailingYield: 14, volatility: 26, maxDrawdown: 35 };
  const agnc = adapter.buildOpportunity(adapter.UNIVERSE.mortgage_reit.find((e) => e.symbol === 'AGNC'), stats, { schema, C });
  assert.equal(agnc.risk.leverage, 8.0);
  const traps = detectTraps(agnc);
  assert.ok(traps.flags.includes(C.TRAP_FLAGS.LEVERAGED), 'an 8x levered mREIT must be flagged as leveraged');
  const risk = scoreRisk(agnc);
  assert.ok(risk.factors.some((f) => /leverage/i.test(f.label)), 'leverage must appear as a named risk factor');
  assert.equal(risk.volatilityAssumed, false, 'measured volatility must be used, not the class default');
});

test('a user-added ticker is accepted, classified conservatively and marked as an assumption', () => {
  const list = adapter.resolveUniverse({ extraSymbols: ['ZZZZ', { symbol: 'pff' }, '   ', 'not a ticker!'] });
  const added = list.find((e) => e.symbol === 'ZZZZ');
  assert.ok(added, 'a plain string ticker should be added');
  assert.equal(added.category, 'user');
  // A bare string must not downgrade a symbol we already classify properly.
  assert.equal(list.find((e) => e.symbol === 'PFF').category, 'preferred');
  assert.equal(list.some((e) => /[^A-Z0-9.\-]/.test(e.symbol)), false, 'junk strings must never become URLs');

  const o = adapter.buildOpportunity(added, { price: 25, trailingYield: 8 }, { schema, C });
  assert.deepEqual(schema.validate(o), []);
  assert.equal(o.assetClass, C.ASSET_CLASS.ETF);
  assert.equal(o.taxTreatment, C.TAX_TREATMENT.MIXED);
  assert.match(o.notes, /assumptions, not lookups/);

  // An explicit category is honoured, and exclusions are honoured.
  const typed = adapter.resolveUniverse({ extraSymbols: [{ symbol: 'RQI', category: 'cef', name: 'Cohen & Steers Quality Income Realty Fund' }] });
  assert.equal(typed.find((e) => e.symbol === 'RQI').category, 'cef');
  const trimmed = adapter.resolveUniverse({ sources: { funds: { exclude: ['JEPI', 'qyld'] } } });
  assert.equal(trimmed.some((e) => e.symbol === 'JEPI' || e.symbol === 'QYLD'), false);
});

test('buildAll drops what it cannot map without taking the batch down', () => {
  const good = { entry: adapter.UNIVERSE.reit.find((e) => e.symbol === 'O'), stats: { price: 58, trailingYield: 5.5 } };
  const noYield = { entry: adapter.UNIVERSE.reit.find((e) => e.symbol === 'SPG'), stats: { price: 180, trailingYield: null } };
  const out = adapter.buildAll([good, noYield, null, { entry: null, stats: null }], { schema, C });
  assert.equal(out.opportunities.length, 1);
  assert.equal(out.skipped.length, 3);
});

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

test('loadSeed returns real, valid, honestly labelled rows', () => {
  const res = adapter.loadSeed(ctx);
  assert.equal(res.status, 'offline');
  assert.ok(res.opportunities.length >= 45, `expected ~50 seed rows, got ${res.opportunities.length}`);
  assert.equal(res.warnings.length, 0);

  const classes = new Set();
  for (const o of res.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.equal(o.source, 'funds');
    assert.ok(o.price > 0 && o.minInvestment === o.price);
    assert.ok(o.apy.total > 0 && o.apy.total < 30, `${o.symbol} seed yield ${o.apy.total} is not plausible`);
    assert.ok(o.confidence < 0.6, 'a bundled snapshot must not read as a live quote');
    classes.add(o.assetClass);
  }
  // Every category the source claims should actually be represented offline.
  for (const cls of ['etf', 'corp_bond', 'govt_bond', 'muni_bond', 'dividend_equity', 'reit', 'bdc', 'preferred', 'cef']) {
    assert.ok(classes.has(cls), `no seed row for ${cls}`);
  }
});

test('loadSeed never throws, whatever it is handed', () => {
  for (const bad of [{}, { seedDir: '/nope/nowhere' }, { seedDir: __dirname }, null, undefined]) {
    const res = adapter.loadSeed(bad);
    assert.ok(['offline', 'failed'].includes(res.status));
    assert.ok(Array.isArray(res.opportunities));
  }
});

test('seed rows survive the risk and trap pipeline with sensible verdicts', () => {
  const rows = adapter.loadSeed(ctx).opportunities;
  const by = (sym) => rows.find((o) => o.symbol === sym);

  // Ultra-short Treasuries should land near the floor; CLO equity should not.
  const sgov = scoreRisk(by('SGOV')).score;
  const ecc = scoreRisk(by('ECC')).score;
  assert.ok(sgov < 20, `SGOV scored ${sgov}`);
  assert.ok(ecc > sgov + 25, `ECC ${ecc} should sit far above SGOV ${sgov}`);

  // No seed row may be flagged stale or as a fabricated ROC/NAV problem: we
  // deliberately publish nulls there rather than invented numbers.
  for (const o of rows) {
    const t = detectTraps(o);
    assert.equal(t.flags.includes(C.TRAP_FLAGS.RETURN_OF_CAPITAL), false);
    assert.equal(t.flags.includes(C.TRAP_FLAGS.NAV_PREMIUM), false);
    assert.equal(t.flags.includes(C.TRAP_FLAGS.LOW_TVL), false, 'fund AUM is unknown and must not read as a thin pool');
  }
});

test('every seed ticker exists in the universe', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'funds.json'), 'utf8'));
  const known = new Set(adapter.resolveUniverse({}).map((e) => e.symbol));
  const orphans = raw.items.map((i) => i.symbol).filter((s) => !known.has(s));
  assert.deepEqual(orphans, [], 'seed rows for symbols the adapter cannot classify would be silently dropped');
  assert.equal(raw.meta.dataAsOf, '2026-08-01');
});

// ---------------------------------------------------------------------------
// Network path, with the network stubbed
// ---------------------------------------------------------------------------

function stubHttp({ fail = () => false, stooqFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    parseCSV: http.parseCSV,
    async getJSON(url) {
      calls.push(url);
      const symbol = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
      if (fail(symbol, url)) {
        const err = new Error(`HTTP 404 for ${url}`);
        err.status = 404;
        throw err;
      }
      const payload = JSON.parse(JSON.stringify(chartPayload));
      payload.chart.result[0].meta.symbol = symbol;
      return payload;
    },
    async getText(url) {
      calls.push(url);
      const symbol = url.match(/s=([a-z0-9.\-]+)\.us/)?.[1]?.toUpperCase();
      if (!stooqFor.has(symbol)) {
        const err = new Error('HTTP 404');
        err.status = 404;
        throw err;
      }
      return stooqCsv;
    },
  };
}

const smallCtx = (over = {}) => ({
  ...ctx,
  settings: { sources: { funds: { exclude: adapter.resolveUniverse({}).map((e) => e.symbol).slice(6) } } },
  ...over,
});

test('fetch builds live rows and asks the chart endpoint for every symbol', async () => {
  const stub = stubHttp();
  const res = await adapter.fetch(smallCtx({ http: stub }));
  assert.equal(res.status, 'ok');
  assert.equal(res.opportunities.length, 6);
  assert.equal(stub.calls.length, 6);
  assert.match(stub.calls[0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/.*range=2y.*interval=1d/);
  for (const o of res.opportunities) {
    assert.deepEqual(schema.validate(o), []);
    assert.equal(o.seed, false);
    assert.equal(o.source, 'funds');
    assert.equal(o.price, 58.40);
    assert.equal(o.dataAsOf.slice(0, 10), '2026-08-26');
  }
});

test('one dead symbol degrades the source to partial instead of killing it', async () => {
  const dead = 'QYLD';
  const stub = stubHttp({ fail: (sym) => sym === dead });
  const res = await adapter.fetch(smallCtx({ http: stub }));
  assert.equal(res.status, 'partial');
  assert.equal(res.opportunities.some((o) => o.symbol === dead), false);
  assert.ok(res.opportunities.length >= 5);
  assert.match(res.notes.join(' '), new RegExp(`${dead} \\(query1[^)]*HTTP 404\\)`));
  // Both Yahoo hosts get a try before we give up on a symbol.
  assert.ok(stub.calls.some((u) => u.includes('query2.finance.yahoo.com') && u.includes(dead)));
});

test('Yahoo down entirely falls back to Stooq prices with seeded yields', async () => {
  const stub = stubHttp({ fail: () => true, stooqFor: new Set(['JEPI']) });
  const res = await adapter.fetch(smallCtx({ http: stub }));
  assert.equal(res.status, 'partial');
  const jepi = res.opportunities.find((o) => o.symbol === 'JEPI');
  assert.ok(jepi, 'the Stooq path should still produce a row');
  assert.equal(jepi.apy.total, 7.8, 'yield comes from the bundled seed on this path');
  assert.ok(jepi.price > 0);
  assert.equal(jepi.confidence, 0.45, 'a remembered yield on a live price is a weaker claim');
  assert.match(res.warnings.join(' '), /price feed is probably blocked or down/);
});

test('a total outage returns failed, not a throw and not an empty ok', async () => {
  const stub = stubHttp({ fail: () => true });
  const res = await adapter.fetch(smallCtx({ http: stub }));
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.opportunities, []);
  assert.ok(res.warnings.length);
});

test('fetch converts an unexpected throw into a failed result', async () => {
  const res = await adapter.fetch({
    ...ctx,
    http: { getJSON() { throw new Error('boom'); }, getText() { throw new Error('boom'); }, parseCSV: http.parseCSV },
    settings: null,
    // resolveUniverse handles null settings; make the crash come from elsewhere.
    get seedDir() { throw new Error('exploding ctx'); },
  });
  assert.equal(res.status, 'failed');
  assert.ok(res.warnings.length);
});
