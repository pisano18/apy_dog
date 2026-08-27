'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/sources/equities');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { analyse, classifySetup, readMovement } = require('../src/core/movement');

const SPARK = require('./fixtures/yahoo-spark-batch.json');
const SPARK_ENVELOPE = require('./fixtures/yahoo-spark-envelope.json');
const CHART = require('./fixtures/yahoo-chart-schd.json');
const SEC_EXCHANGE = require('./fixtures/sec-company-tickers-exchange.json');
const SEC_OBJECT = require('./fixtures/sec-company-tickers.json');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const NOW = Date.parse('2026-08-27T00:00:00Z');

const clone = (v) => JSON.parse(JSON.stringify(v));
const seedResult = () => adapter.loadSeed({ seedDir: SEED_DIR, schema, C, settings: {}, now: NOW, log() {} });

/* -------------------------------------------------------------- contract -- */

test('satisfies the source adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'equities');
  assert.equal(adapter.label, 'Stocks & ETFs');
  assert.equal(typeof adapter.fetchOne, 'function');
  for (const cls of adapter.assetClasses) {
    assert.ok(Object.values(C.ASSET_CLASS).includes(cls), `unknown asset class ${cls}`);
  }
});

/* -------------------------------------------------------------- universe -- */

test('the measured universe is the right size and free of duplicates', () => {
  const entries = adapter.universeEntries();
  assert.ok(entries.length >= 320 && entries.length <= 420, `universe is ${entries.length} symbols`);
  const symbols = entries.map((e) => e.symbol);
  assert.equal(new Set(symbols).size, symbols.length, 'a ticker appears in two groups');
  for (const s of symbols) {
    assert.match(s, /^[A-Z][A-Z0-9.\-]{0,9}$/, `${s} is not a plausible ticker`);
  }
});

test('the universe covers what a normal person actually buys, not just what moves', () => {
  const bySymbol = new Map(adapter.universeEntries().map((e) => [e.symbol, e]));
  // The user asked for retirement and everyday investing explicitly. These are
  // the holdings that answer that, and their absence would be the bug.
  for (const s of ['VTI', 'VOO', 'SPY', 'QQQ', 'VXUS', 'VT', 'ITOT', 'SCHB',
    'VFIFX', 'VTTHX', 'VTINX', 'FXAIX', 'VTSAX',
    'BND', 'AGG', 'BNDX', 'VGIT', 'VGSH', 'TLT',
    'SCHD', 'VIG', 'DGRO', 'NOBL']) {
    assert.ok(bySymbol.has(s), `${s} missing from the measured universe`);
  }
  for (const group of ['core_index', 'target_date', 'bond_core', 'dividend_growth', 'sector', 'factor',
    'international', 'commodity', 'megacap', 'high_growth', 'semis', 'biotech', 'energy',
    'financials', 'consumer', 'industrials', 'small_cap', 'crypto_equity', 'volatility_adjacent']) {
    assert.ok(adapter.MEASURED_UNIVERSE[group]?.length, `group ${group} is empty`);
    assert.ok(adapter.GROUPS[group], `group ${group} has no metadata`);
  }
  // Every group a universe entry claims must have metadata, or the row silently
  // gets the wrong asset class and tax treatment.
  for (const e of adapter.universeEntries()) assert.ok(adapter.GROUPS[e.group], `${e.symbol}: unknown group ${e.group}`);
});

test('settings can narrow, extend and cap the universe', () => {
  const only = adapter.resolveUniverse({ sources: { equities: { groups: ['core_index'] } } });
  assert.ok(only.length > 5 && only.every((e) => e.group === 'core_index'));

  const excluded = adapter.resolveUniverse({ sources: { equities: { excludeSymbols: ['SPY'] } } });
  assert.ok(!excluded.some((e) => e.symbol === 'SPY'));

  const extended = adapter.resolveUniverse({ sources: { equities: { extraSymbols: ['zzqq', 'SPY'] } } });
  assert.equal(extended.filter((e) => e.symbol === 'ZZQQ').length, 1);
  assert.equal(extended.filter((e) => e.symbol === 'SPY').length, 1, 'an extra symbol must not duplicate a known one');

  assert.equal(adapter.resolveUniverse({ sources: { equities: { measuredLimit: 12 } } }).length, 12);
});

/* --------------------------------------------------- SEC index tier parse -- */

test('parses the SEC exchange-shaped ticker file and drops what it cannot use', () => {
  const r = adapter.parseTickerIndex(SEC_EXCHANGE);
  assert.equal(r.records.length, 10);
  assert.deepEqual(r.dropped, { unparseable: 1, noTicker: 2, duplicate: 1, alreadyMeasured: 0 });

  const apple = r.records[0];
  assert.equal(apple.ticker, 'AAPL');
  assert.equal(apple.name, 'Apple Inc.');
  // EDGAR wants ten digits; the JSON file ships bare integers.
  assert.equal(apple.cik, '0000320193');
  assert.equal(r.records.find((x) => x.ticker === 'ZZQQ').cik, null);
});

test('parses the older object-keyed ticker file too', () => {
  const r = adapter.parseTickerIndex(SEC_OBJECT);
  assert.equal(r.records.length, 7);
  assert.ok(r.records.some((x) => x.ticker === 'GOOGL' && x.cik === '0001652044'));
  assert.equal(r.dropped.unparseable, 1);  // the literal null
  assert.equal(r.dropped.noTicker, 1);     // the record with a title and no ticker
});

test('the index tier never re-lists something already measured', () => {
  const r = adapter.parseTickerIndex(SEC_EXCHANGE, { skipSymbols: new Set(['AAPL', 'MSFT']) });
  assert.ok(!r.records.some((x) => x.ticker === 'AAPL' || x.ticker === 'MSFT'));
  assert.equal(r.dropped.alreadyMeasured, 3);   // AAPL twice (the file duplicates it) and MSFT
});

test('a renamed or reshaped SEC payload degrades the source instead of crashing it', () => {
  const renamed = { fields: ['cik_number', 'entity', 'symbol', 'venue'], data: SEC_EXCHANGE.data.slice(0, 5) };
  assert.doesNotThrow(() => adapter.parseTickerIndex(renamed));
  assert.equal(adapter.parseTickerIndex(renamed).records.length, 0, 'unknown field names must yield no rows, not wrong ones');

  for (const junk of [null, undefined, 'a string', 42, [], {}, { fields: 'nope', data: 'nope' }, { data: [null, 7, {}] }]) {
    assert.doesNotThrow(() => adapter.parseTickerIndex(junk), `threw on ${JSON.stringify(junk)}`);
    assert.equal(adapter.parseTickerIndex(junk).records.length, 0);
  }
});

test('the index limit is honoured so a ten-thousand-row file cannot flood the table', () => {
  assert.equal(adapter.parseTickerIndex(SEC_EXCHANGE, { limit: 3 }).records.length, 3);
});

/* ------------------------------------------------------------ spark parse -- */

test('parses the batch spark payload, both published shapes', () => {
  const flat = adapter.parseSpark(SPARK);
  assert.deepEqual([...flat.keys()], ['VOO', 'TLT', 'NVDA', 'SCHD']);
  assert.ok(flat.get('VOO').closes.length > 240);
  // The batch endpoint carries no volume, and pretending otherwise would put a
  // fabricated volume anomaly into every movement read on this path.
  assert.deepEqual(flat.get('VOO').volumes, []);

  const enveloped = adapter.parseSpark(SPARK_ENVELOPE);
  assert.deepEqual([...enveloped.keys()], ['VOO', 'TLT']);
  assert.equal(enveloped.get('VOO').closes.length, flat.get('VOO').closes.length);
});

test('spark records that cannot support a read are skipped, not half-used', () => {
  const parsed = adapter.parseSpark(SPARK);
  assert.ok(!parsed.has('TINY'), 'a five-bar series is not a year of history');
  assert.ok(!parsed.has('BADD'), 'an all-null close array is not a price series');
});

test('a garbled spark payload yields nothing rather than throwing', () => {
  for (const junk of [null, undefined, 'nope', 7, [], { spark: { result: 'no' } }, { AAPL: 'no' }, { AAPL: { close: 'no' } }]) {
    assert.doesNotThrow(() => adapter.parseSpark(junk));
    assert.equal(adapter.parseSpark(junk).size, 0);
  }
});

test('an out-of-range timestamp cannot throw a RangeError', () => {
  // new Date(1e18).toISOString() throws. Two adapters in this codebase have
  // already been taken down by exactly this, so it is pinned here.
  const bent = clone(SPARK);
  bent.VOO.timestamp[bent.VOO.timestamp.length - 1] = 1e18;
  const parsed = adapter.parseSpark(bent);
  assert.ok(parsed.has('VOO'));
  assert.doesNotThrow(() => adapter.buildMeasured({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', group: 'core_index' },
    parsed.get('VOO'), { schema, C, now: NOW }));
  const row = adapter.buildMeasured({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', group: 'core_index' },
    parsed.get('VOO'), { schema, C, now: NOW });
  assert.ok(row, 'the row must survive a corrupt timestamp');
  assert.ok(Number.isFinite(Date.parse(row.dataAsOf)), 'dataAsOf must still be a real instant');
});

/* ------------------------------------------------------------ chart parse -- */

test('parses the per-symbol chart, including its dividend stream', () => {
  const s = adapter.parseChart(CHART);
  assert.equal(s.symbol, 'SCHD');
  assert.equal(s.currency, 'USD');
  assert.ok(s.closes.length > 240);
  assert.equal(s.volumes.length, s.closes.length);
  assert.equal(s.dividends.length, 4);
  assert.ok(s.adjustedForDividends);
});

test('a chart error or an unusable chart payload returns a value, never an exception', () => {
  const err = adapter.parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });
  assert.match(err.error, /Not Found/);
  for (const junk of [null, {}, { chart: {} }, { chart: { result: [] } }, 'nope', { chart: { result: [{ timestamp: [], indicators: {} }] } }]) {
    assert.doesNotThrow(() => adapter.parseChart(junk));
  }
});

test('missing adjusted closes fall back to raw closes rather than losing the symbol', () => {
  const noAdj = clone(CHART);
  delete noAdj.chart.result[0].indicators.adjclose;
  const s = adapter.parseChart(noAdj);
  assert.ok(s.closes.length > 240);
  assert.equal(s.adjustedForDividends, false);
});

/* ------------------------------------------------------------------ yield -- */

test('the trailing yield counts the last twelve months and nothing else', () => {
  const price = 100;
  const day = 86400000;
  const divs = [
    { ts: NOW - 400 * day, amount: 1 },     // outside the window
    { ts: NOW - 200 * day, amount: 1 },
    { ts: NOW - 10 * day, amount: 1.5 },
  ];
  assert.equal(adapter.trailingYield(divs, price, NOW), 2.5);
  // No payments in the window is a measured zero, which is a different fact from
  // no dividend data at all.
  assert.equal(adapter.trailingYield([{ ts: NOW - 400 * day, amount: 1 }], price, NOW), 0);
  assert.equal(adapter.trailingYield([], price, NOW), 0);
  assert.equal(adapter.trailingYield(null, price, NOW), null);
  assert.equal(adapter.trailingYield(divs, 0, NOW), null);
  assert.equal(adapter.trailingYield([{ ts: 'x', amount: 'y' }], price, NOW), 0);
});

test('a dividend too small to be income is reported as no yield, not as 0.02%', () => {
  assert.equal(adapter.tidyYield(0.02), null);
  assert.equal(adapter.tidyYield(0), null);
  assert.equal(adapter.tidyYield(3.6), 3.6);
  assert.equal(adapter.tidyYield(null), null);
});

test('worst drawdown finds the deepest peak-to-trough, not the current one', () => {
  assert.equal(adapter.worstDrawdown([100, 120, 60, 90, 110]), 50);
  assert.equal(adapter.worstDrawdown([1, 2]), null);
  assert.equal(adapter.worstDrawdown(null), null);
});

/* ------------------------------------------------------- measured rows ---- */

test('a measured row carries the movement engine output, not a reimplementation of it', () => {
  const series = adapter.parseSpark(SPARK).get('NVDA');
  const row = adapter.buildMeasured({ symbol: 'NVDA', name: 'NVIDIA Corporation', group: 'megacap' },
    series, { schema, C, now: NOW });

  assert.deepEqual(row.movementStats, analyse(series.closes, series.volumes));
  assert.equal(row.risk.volatility, row.movementStats.vol);
  assert.ok(row.price > 0);
  assert.equal(row.minInvestment, row.price, 'one share is the entry ticket');
  assert.equal(row.liquidity, C.LIQUIDITY.DAILY);
  assert.equal(row.term.days, null, 'a share has no maturity and no lockup');
  assert.equal(row.assetClass, C.ASSET_CLASS.DIVIDEND_EQUITY);
  assert.equal(row.measured, true);
  assert.ok(row.accessNotes && row.url);

  // No dividend stream on the batch path and none remembered: the honest answer
  // is no yield, and the row must not be forced into an income sort.
  assert.equal(row.apy.total, null);
  assert.equal(row.track, 'movement');
  assert.deepEqual(schema.validate(row), []);
});

test('a known yield makes the row an income row as well, and says where the yield came from', () => {
  const series = adapter.parseSpark(SPARK).get('SCHD');
  const remembered = adapter.buildMeasured({ symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', group: 'dividend_growth' },
    series, { schema, C, now: NOW, yieldPct: 3.6, yieldSource: 'remembered' });
  assert.equal(remembered.apy.total, 3.6);
  assert.equal(remembered.yieldKind, C.YIELD_KIND.TRAILING);
  assert.equal(remembered.track, 'both');
  assert.match(remembered.notes, /bundled snapshot figure/);

  const measured = adapter.buildMeasured({ symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', group: 'dividend_growth' },
    adapter.parseChart(CHART), { schema, C, now: Date.parse('2026-08-26T20:00:00Z'), yieldSource: 'measured' });
  assert.ok(measured.apy.total > 3 && measured.apy.total < 5, `measured yield ${measured.apy.total}`);
  // Measuring the yield is a stronger claim than remembering it.
  assert.ok(measured.confidence > remembered.confidence);
});

test('a mutual fund carries its real initial minimum and says it is not an ETF', () => {
  const entry = adapter.universeEntries().find((e) => e.symbol === 'VTSAX');
  const row = adapter.buildMeasured(entry, adapter.parseSpark(SPARK).get('VOO'), { schema, C, now: NOW });
  assert.equal(row.minInvestment, 3000);
  assert.match(row.accessNotes, /mutual fund/i);
});

test('a symbol with no price produces no row at all', () => {
  assert.equal(adapter.buildMeasured({ symbol: 'VOO', group: 'core_index' }, { closes: [], volumes: [] }, { schema, C }), null);
  assert.equal(adapter.buildMeasured({ symbol: '', group: 'core_index' }, { price: 10 }, { schema, C }), null);
});

/* ---------------------------------------------------------- index rows ----- */

test('an index-tier row is visibly unmeasured and claims nothing', () => {
  const [rec] = adapter.parseTickerIndex(SEC_EXCHANGE).records;
  const row = adapter.buildIndexRow(rec, { schema, C, dataAsOf: '2026-08-01' });

  assert.equal(row.measured, false);
  assert.equal(row.apy.total, null);
  assert.equal(row.expected, null);
  assert.equal(row.price, null);
  assert.equal(row.movementStats, null);
  assert.equal(row.track, 'movement');
  assert.equal(row.confidence, 0.2);
  assert.equal(row.subType, 'listed_issuer');
  assert.match(row.notes, /Index entry only/);
  assert.match(row.url, /sec\.gov.*0000320193/);
  assert.deepEqual(schema.validate(row), [], 'an unmeasured row must still be a valid row');

  // And the movement engine must report it as unmeasured rather than inventing
  // a setup for a chart it has never seen.
  const read = readMovement(row, { events: [], now: NOW });
  assert.equal(read.unmeasured, true);
  assert.equal(read.heat, null);
  assert.equal(read.setup, null);
});

test('an index row with no CIK still gets somewhere useful to click', () => {
  const rec = adapter.parseTickerIndex(SEC_EXCHANGE).records.find((x) => x.ticker === 'ZZQQ');
  assert.match(adapter.buildIndexRow(rec, { schema, C }).url, /finance\.yahoo\.com/);
  assert.equal(adapter.buildIndexRow(null, { schema, C }), null);
});

/* ------------------------------------------------------------------ seed --- */

test('the bundled seed loads both tiers and every row is valid', () => {
  const r = seedResult();
  assert.equal(r.status, 'offline');
  assert.ok(r.opportunities.length > 150, `only ${r.opportunities.length} seed rows`);

  const bad = r.opportunities.map((o) => [o.id, schema.validate(o)]).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);

  const measured = r.opportunities.filter((o) => o.measured !== false);
  const indexed = r.opportunities.filter((o) => o.measured === false);
  assert.ok(measured.length >= 110, `${measured.length} measured rows`);
  assert.ok(indexed.length >= 50, `${indexed.length} index rows`);

  for (const o of r.opportunities) {
    assert.equal(o.source, 'equities');
    assert.equal(o.seed, true, `${o.id} is not marked as a snapshot`);
    assert.equal(o.live, false);
    assert.ok(o.accessNotes, `${o.id} does not say how to buy it`);
    assert.ok(o.url, `${o.id} has no link`);
  }
  for (const o of measured) {
    assert.ok(o.movementStats, `${o.symbol} was measured but carries no chart read`);
    assert.ok(o.price > 0, `${o.symbol} has no price`);
    assert.ok(Number.isFinite(o.risk.volatility), `${o.symbol} has no volatility`);
    assert.ok(o.risk.maxDrawdown >= o.movementStats.drawdown - 1e-9,
      `${o.symbol}: worst drawdown ${o.risk.maxDrawdown} is shallower than the current one ${o.movementStats.drawdown}`);
  }
  assert.ok(r.notes.some((n) => /Index entry|index-tier/i.test(n)), 'the two tiers must be described in the notes');
});

test('seed movement stats produce a real mix of setups, not one repeated shape', () => {
  const r = seedResult();
  const setups = new Map();
  for (const o of r.opportunities) {
    const read = readMovement(o, { events: [], now: NOW });
    const key = read.unmeasured ? 'unmeasured' : read.setup;
    setups.set(key, (setups.get(key) || 0) + 1);
  }
  for (const want of ['coiled', 'expanding', 'breaking_out', 'breaking_down', 'deep_drawdown',
    'grinding_up', 'grinding_down', 'range_bound', 'unmeasured']) {
    assert.ok(setups.get(want) > 0, `no seed row classifies as ${want}: ${JSON.stringify([...setups])}`);
  }
});

test('seed rates are percentages and nothing pretends to be a yield it is not', () => {
  for (const o of seedResult().opportunities) {
    const v = o.apy?.total;
    if (v === null) continue;
    assert.ok(v > 0.05 && v < 20, `${o.symbol} claims ${v}% — check the units`);
    assert.equal(o.yieldKind, C.YIELD_KIND.TRAILING);
  }
});

test('seed tracks split sensibly between income and movement', () => {
  const rows = seedResult().opportunities;
  const growth = rows.find((o) => o.symbol === 'NVDA');
  const bond = rows.find((o) => o.symbol === 'BND');
  assert.equal(growth.apy.total, null, 'a non-payer must not carry a manufactured 0% yield');
  assert.equal(growth.track, 'movement');
  assert.ok(bond.apy.total > 3);
  assert.equal(bond.track, 'both', 'a bond fund pays and moves, and both are true');
});

test('loadSeed never throws, whatever is wrong with the seed', () => {
  for (const dir of ['/nonexistent/path', null, undefined, __dirname]) {
    let r;
    assert.doesNotThrow(() => { r = adapter.loadSeed({ seedDir: dir, schema, C, settings: {} }); });
    assert.ok(r && Array.isArray(r.opportunities));
  }
  assert.equal(adapter.loadSeed({ seedDir: '/nonexistent/path', schema, C }).status, 'failed');
});

/* ----------------------------------------------------------------- fetch --- */

/** A stub http that answers from the fixtures and counts what was asked for. */
function stubHttp({ sparkPayload = SPARK, secPayload = SEC_EXCHANGE, failSpark = false } = {}) {
  const calls = [];
  return {
    calls,
    parseCSV: () => [],
    async getJSON(url) {
      calls.push(url);
      if (url.includes('/v7/finance/spark')) {
        if (failSpark) throw Object.assign(new Error('HTTP 429'), { status: 429 });
        const wanted = new URL(url).searchParams.get('symbols').split(',');
        const out = {};
        for (const s of wanted) if (sparkPayload[s]) out[s] = sparkPayload[s];
        // Yahoo answers with what it has; a batch of unknown symbols comes back
        // empty, which must look like "nothing for these", not like a failure.
        return Object.keys(out).length ? out : { VOO: sparkPayload.VOO };
      }
      if (url.includes('/v8/finance/chart/')) return CHART;
      if (url.includes('sec.gov')) return secPayload;
      throw new Error(`unexpected url ${url}`);
    },
  };
}

const fetchCtx = (http, settings = {}) => ({
  http, schema, C, settings, seedDir: SEED_DIR, now: NOW, log() {}, signal: null,
});

test('a live run batches the price feed instead of looping symbol by symbol', async () => {
  const http = stubHttp();
  const settings = { sources: { equities: { groups: ['core_index'], fallbackCap: 0 } } };
  const r = await adapter.fetch(fetchCtx(http, settings));

  const symbolCount = adapter.resolveUniverse(settings).length;
  const sparkCalls = http.calls.filter((u) => u.includes('/spark')).length;
  assert.equal(sparkCalls, Math.ceil(symbolCount / adapter.BATCH_SIZE));
  assert.ok(sparkCalls * 4 < symbolCount, 'the whole point is that this is far fewer calls than symbols');

  // Each batch URL must actually carry many symbols.
  const first = new URL(http.calls.find((u) => u.includes('/spark'))).searchParams.get('symbols').split(',');
  assert.ok(first.length > 1 && first.length <= adapter.BATCH_SIZE);

  // And the run must be able to prove its own efficiency claim.
  assert.ok(r.notes.some((n) => /HTTP request\(s\) this run/.test(n)), r.notes.join(' | '));
});

test('a live run returns both tiers, and the index tier is marked unmeasured', async () => {
  const http = stubHttp();
  const settings = { sources: { equities: { groups: ['core_index'], fallbackCap: 0 } } };
  const r = await adapter.fetch(fetchCtx(http, settings));

  assert.ok(r.opportunities.length > 5);
  const measured = r.opportunities.filter((o) => o.measured !== false);
  const indexed = r.opportunities.filter((o) => o.measured === false);
  assert.ok(measured.length >= 1, 'nothing was measured');
  assert.ok(indexed.length >= 5, 'the index tier is missing');

  // A symbol we measured must not also appear as an unmeasured index row.
  const measuredSymbols = new Set(measured.map((o) => o.symbol));
  assert.ok(!indexed.some((o) => measuredSymbols.has(o.symbol)));

  for (const o of r.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} invalid`);
    assert.equal(o.seed, false);
  }
  assert.ok(r.notes.some((n) => /searchable, not analysed/.test(n)));
  assert.ok(r.notes.some((n) => /volume anomalies are unavailable/.test(n)),
    'the run must disclose that the batch feed carries no volume');
});

test('when the batch endpoint fails the run falls back per symbol and says so', async () => {
  const http = stubHttp({ failSpark: true });
  const settings = { sources: { equities: { groups: ['core_index'] } } };
  const r = await adapter.fetch(fetchCtx(http, settings));

  assert.ok(http.calls.some((u) => u.includes('/v8/finance/chart/')), 'no per-symbol fallback happened');
  assert.equal(r.status, 'partial');
  assert.ok(r.notes.some((n) => /fell back to the per-symbol chart endpoint/.test(n)), r.notes.join(' | '));
});

test('an unrecognised spark shape is a fallback, not a crash', async () => {
  const http = stubHttp({ sparkPayload: {} });
  http.getJSON = async (url) => {
    http.calls.push(url);
    if (url.includes('/spark')) return { unexpected: 'shape' };
    if (url.includes('/v8/finance/chart/')) return CHART;
    return SEC_EXCHANGE;
  };
  const r = await adapter.fetch(fetchCtx(http, { sources: { equities: { groups: ['core_index'], fallbackCap: 2 } } }));
  assert.ok(Array.isArray(r.opportunities));
  assert.ok(http.calls.some((u) => u.includes('/v8/finance/chart/')));
});

test('the SEC index failing costs the search box, not the source', async () => {
  const http = stubHttp();
  const inner = http.getJSON.bind(http);
  http.getJSON = async (url) => {
    if (url.includes('sec.gov')) { http.calls.push(url); throw Object.assign(new Error('forbidden'), { status: 403 }); }
    return inner(url);
  };
  const r = await adapter.fetch(fetchCtx(http, { sources: { equities: { groups: ['core_index'], fallbackCap: 0 } } }));
  assert.ok(r.opportunities.length > 0, 'measured rows must survive an SEC outage');
  assert.ok(r.warnings.some((w) => /SEC ticker index unavailable/.test(w)), r.warnings.join(' | '));
});

test('the SEC request identifies itself, because the SEC requires it', () => {
  assert.match(adapter.SEC_UA, /APY Dog/);
  assert.match(adapter.SEC_UA, /github\.com/, 'the SEC asks for a contact, not just a name');
});

test('fetch never throws, however broken the transport is', async () => {
  const r = await adapter.fetch({
    http: { getJSON: async () => { throw new Error('socket hang up'); } },
    schema, C, settings: { sources: { equities: { groups: ['core_index'], fallbackCap: 0 } } }, seedDir: SEED_DIR, now: NOW,
  });
  assert.equal(r.status, 'failed');
  assert.ok(r.warnings.length);
});

/* --------------------------------------------------------------- fetchOne -- */

test('fetchOne promotes an arbitrary ticker from index-tier to fully measured', async () => {
  const http = stubHttp();
  const r = await adapter.fetchOne('schd', fetchCtx(http, {}));

  assert.equal(r.status, 'ok');
  assert.equal(r.opportunities.length, 1);
  const row = r.opportunities[0];
  assert.equal(row.symbol, 'SCHD');
  assert.equal(row.measured, true);
  assert.ok(row.movementStats?.bars > 200);
  assert.ok(row.apy.total > 0, 'the chart endpoint carries dividends, so the yield is measured here');
  assert.ok(row.movementStats.volumeRatio !== null, 'the chart endpoint does carry volume');
  assert.deepEqual(schema.validate(row), []);
  assert.ok(r.notes.some((n) => /measured on demand/.test(n)));
});

test('fetchOne handles a ticker nobody has ever measured, and one that does not exist', async () => {
  const http = stubHttp();
  const r = await adapter.fetchOne('ZZQQ', fetchCtx(http, {}));
  assert.equal(r.status, 'ok');
  assert.equal(r.opportunities[0].subType, 'user');

  const dead = await adapter.fetchOne('NOPE', {
    http: { getJSON: async () => ({ chart: { error: { code: 'Not Found' } } }) }, schema, C, now: NOW,
  });
  assert.equal(dead.status, 'failed');
  assert.equal((await adapter.fetchOne('', {})).status, 'failed');
});

/* ------------------------------------------------------ downstream sanity -- */

test('measured seed rows survive the movement engine and produce usable reads', () => {
  const rows = seedResult().opportunities.filter((o) => o.measured !== false);
  for (const o of rows) {
    const read = readMovement(o, { events: [], now: NOW, horizonDays: 30 });
    assert.equal(read.unmeasured, false, `${o.symbol} reads as unmeasured`);
    assert.ok(Number.isFinite(read.heat) && read.heat >= 0 && read.heat <= 100, `${o.symbol} heat ${read.heat}`);
    assert.ok(read.move && read.move.typical > 0, `${o.symbol} has no expected-move band`);
    assert.ok(classifySetup(o.movementStats).key, `${o.symbol} has no setup`);
  }
});

/* ------------------------------------------------------------- chart data -- */

test('downsample keeps both ends and never exceeds its budget', () => {
  const long = Array.from({ length: 253 }, (_, i) => 100 + i);
  const out = adapter.downsample(long, 120);
  assert.equal(out.length, 120);
  assert.equal(out[0], long[0], 'the first point is where this started');
  assert.equal(out[out.length - 1], long[long.length - 1], 'the last point is where it is now');
  // Evenly spaced, so the chart is not stretched at one end.
  const gaps = out.slice(1).map((v, i) => v - out[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `uneven spacing: ${Math.min(...gaps)}..${Math.max(...gaps)}`);
  for (const n of [2, 5, 60, 119, 252]) assert.equal(adapter.downsample(long, n).length, n);
});

test('a series already inside the budget comes back unchanged', () => {
  const short = [10, 11, 12, 13];
  assert.deepEqual(adapter.downsample(short, 120), short);
  assert.deepEqual(adapter.downsample(short, 4), short);
  assert.deepEqual(adapter.downsample([7], 120), [7]);
});

test('holes are dropped before the spacing is computed, not after', () => {
  // A feed that returns nulls for holidays must draw the same chart as one that
  // omits them. If the holes were kept and skipped later, every point after a
  // gap would sit in the wrong place on the axis.
  const clean = Array.from({ length: 200 }, (_, i) => 50 + i);
  const holed = [];
  for (const v of clean) { holed.push(v); if (v % 7 === 0) holed.push(null, NaN, Infinity, 'x'); }
  assert.deepEqual(adapter.downsample(holed, 60), adapter.downsample(clean, 60));
  assert.equal(adapter.downsample(holed, 60).length, 60);
});

test('downsample refuses to invent a chart out of junk', () => {
  for (const junk of [null, undefined, 'series', 42, {}, [null, NaN], [], [Infinity]]) {
    assert.doesNotThrow(() => adapter.downsample(junk, 120));
    assert.deepEqual(adapter.downsample(junk, 120), []);
  }
  assert.deepEqual(adapter.downsample([1, 2, 3], 0), []);
  assert.deepEqual(adapter.downsample([1, 2, 3], -5), []);
  assert.deepEqual(adapter.downsample([1, 2, 3], 'lots'), []);
  // One point cannot hold both ends, so it holds the one that matters.
  assert.deepEqual(adapter.downsample([1, 2, 3], 1), [3]);
});

test('a measured row carries a thinned copy of the closes it was measured from', () => {
  const series = adapter.parseSpark(SPARK).get('VOO');
  const row = adapter.buildMeasured({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', group: 'core_index' },
    series, { schema, C, now: NOW });
  assert.ok(series.closes.length > adapter.MAX_SERIES_POINTS, 'the fixture must be long enough to need thinning');
  assert.equal(row.series.length, adapter.MAX_SERIES_POINTS);
  assert.equal(row.series[0], series.closes[0]);
  assert.equal(row.series[row.series.length - 1], series.closes[series.closes.length - 1]);
  // The chart's last point and the row's price are the same measurement.
  assert.equal(row.series[row.series.length - 1], row.movementStats.lastClose);
});

test('a corrupt bundled series costs the chart, not the row', () => {
  const entry = { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', group: 'core_index' };
  for (const junk of ['nope', 42, {}, [], [null, 'x', {}], [0, -3, NaN], null]) {
    const row = adapter.buildMeasured(entry, { price: 640, closes: [], volumes: [] },
      { schema, C, now: NOW, series: junk, movementStats: { vol: 14, lastClose: 640, bars: 250 } });
    assert.ok(row, `series ${JSON.stringify(junk)} killed the row`);
    assert.equal(row.series, null, 'a chart must be absent rather than empty or wrong');
    assert.deepEqual(schema.validate(row), []);
  }
  // A zero or a negative close is a data error, and charting one would draw a
  // crash that never happened.
  const row = adapter.buildMeasured(entry, { price: 640, closes: [], volumes: [] },
    { schema, C, now: NOW, series: [630, 0, 635, -1, 640], movementStats: { vol: 14, lastClose: 640, bars: 250 } });
  assert.deepEqual(row.series, [630, 635, 640]);
});

test('every measured seed row charts what its own statistics say', () => {
  const rows = seedResult().opportunities.filter((o) => o.measured !== false);
  for (const o of rows) {
    const s = o.series;
    assert.ok(Array.isArray(s) && s.length >= 40, `${o.symbol} has no chart`);
    assert.ok(s.every((v) => Number.isFinite(v) && v > 0), `${o.symbol} charts a non-price`);
    assert.ok(Math.abs(s[s.length - 1] - o.price) < 0.02 * Math.max(1, o.price / 100),
      `${o.symbol} chart ends at ${s[s.length - 1]} but the row is priced at ${o.price}`);

    const hi = Math.max(...s);
    const lo = Math.min(...s);
    const st = o.movementStats;
    // The drawdown printed next to the chart is the distance from the peak in
    // the chart. If those disagree the chart is worse than no chart at all.
    assert.ok(Math.abs((hi - s[s.length - 1]) / hi * 100 - st.drawdown) < 0.5,
      `${o.symbol}: chart drawdown ${((hi - s[s.length - 1]) / hi * 100).toFixed(1)}% vs stated ${st.drawdown}%`);
    // Range position: near its highs must LOOK near its highs.
    const pos = hi > lo ? (s[s.length - 1] - lo) / (hi - lo) : 0.5;
    if (st.rangePos >= 0.8) assert.ok(pos >= 0.6, `${o.symbol} says ${st.rangePos} up its range but charts at ${pos.toFixed(2)}`);
    if (st.rangePos <= 0.2) assert.ok(pos <= 0.4, `${o.symbol} says ${st.rangePos} up its range but charts at ${pos.toFixed(2)}`);
    assert.ok(Math.abs(pos - st.rangePos) < 0.2, `${o.symbol} range position ${pos.toFixed(2)} vs stated ${st.rangePos}`);

    // Trend is percent per month over the last quarter, which is the last
    // quarter of a series covering a year.
    const tail = s.slice(Math.round(s.length * 0.75));
    const monthly = ((tail[tail.length - 1] / tail[0]) ** (1 / 3) - 1) * 100;
    if (Math.abs(st.trend) >= 1) {
      assert.equal(Math.sign(monthly), Math.sign(st.trend),
        `${o.symbol} trends ${st.trend}%/mo but the chart's last quarter moves ${monthly.toFixed(2)}%/mo`);
    }
    assert.ok(Math.abs(monthly - st.trend) < 4, `${o.symbol} trend ${st.trend} vs chart ${monthly.toFixed(2)}`);
  }
});

test('index-tier rows have no chart, because nothing was measured to chart', () => {
  const indexed = seedResult().opportunities.filter((o) => o.measured === false);
  assert.ok(indexed.length >= 50);
  for (const o of indexed) {
    assert.equal(o.series, null, `${o.symbol} drew a chart out of nothing`);
    assert.equal(o.price, null);
    assert.equal(o.movementStats, null);
  }
  const [rec] = adapter.parseTickerIndex(SEC_EXCHANGE).records;
  assert.equal(adapter.buildIndexRow(rec, { schema, C }).series, null);
});

/* ------------------------------------------------------------------ reach -- */

test('reach is derived from index membership and the tape, not from a list', () => {
  // A whole-market fund, a 401k default and the largest companies in the country
  // are things people hear about without looking.
  assert.equal(adapter.classifyReach({ group: 'core_index' }), 'everyone');
  assert.equal(adapter.classifyReach({ group: 'target_date' }), 'everyone');
  assert.equal(adapter.classifyReach({ group: 'megacap' }), 'everyone');
  // One slice of the market, a factor tilt, a small-cap screen and a VIX product
  // are known to the people who already follow this and nobody else.
  for (const g of ['sector', 'factor', 'small_cap', 'volatility_adjacent']) {
    assert.equal(adapter.classifyReach({ group: g }), 'niche', g);
  }
  for (const g of ['bond_core', 'dividend_growth', 'energy', 'semis', 'high_growth', 'user']) {
    assert.equal(adapter.classifyReach({ group: g }), 'common', g);
  }
});

test('the tape can only make something less well known, never more', () => {
  // A famous category does not make a thinly traded share class famous...
  assert.equal(adapter.classifyReach({ group: 'core_index', dollarVolume: 3e6 }), 'obscure');
  assert.equal(adapter.classifyReach({ group: 'core_index', dollarVolume: 4e7 }), 'niche');
  // ...and a heavy tape does not make a sector fund a household name.
  assert.equal(adapter.classifyReach({ group: 'sector', dollarVolume: 5e9 }), 'niche');
  assert.equal(adapter.classifyReach({ group: 'core_index', dollarVolume: 5e9 }), 'everyone');
  // No volume is no evidence, so the category stands alone.
  for (const v of [null, undefined, 0, -1, NaN, 'lots']) {
    assert.equal(adapter.classifyReach({ group: 'megacap', dollarVolume: v }), 'everyone');
  }
});

test('unmeasured index rows are placed by the only fact we have about them', () => {
  // Ten thousand issuers cannot all be "obscure" without drowning the filter
  // that exists to surface things few people follow. The main boards carry the
  // companies with an investor-relations department; everything else is where
  // the genuinely unfollowed live.
  assert.equal(adapter.classifyReach({ measured: false, exchange: 'NYSE' }), 'common');
  assert.equal(adapter.classifyReach({ measured: false, exchange: 'Nasdaq' }), 'common');
  assert.equal(adapter.classifyReach({ measured: false, exchange: 'NYSE American' }), 'niche');
  assert.equal(adapter.classifyReach({ measured: false, exchange: 'OTC' }), 'niche');
  assert.equal(adapter.classifyReach({ measured: false, exchange: null }), 'niche');
  assert.equal(adapter.classifyReach({ measured: false }), 'niche');

  const rec = adapter.parseTickerIndex(SEC_EXCHANGE).records.find((x) => x.exchange === 'NYSE');
  assert.equal(adapter.buildIndexRow(rec, { schema, C }).reach, 'common');
});

test('every seed row carries a reach the interface knows how to render', () => {
  const known = new Set(['everyone', 'common', 'niche', 'obscure']);
  const rows = seedResult().opportunities;
  const seen = new Set();
  for (const o of rows) {
    assert.ok(known.has(o.reach), `${o.symbol} has reach "${o.reach}"`);
    seen.add(o.reach);
  }
  assert.ok(seen.has('everyone') && seen.has('common') && seen.has('niche'),
    `the snapshot must span the scale: ${[...seen]}`);
  const bySymbol = new Map(rows.map((o) => [o.symbol, o]));
  assert.equal(bySymbol.get('VTI').reach, 'everyone');
  assert.equal(bySymbol.get('AAPL').reach, 'everyone');
  assert.equal(bySymbol.get('XLE').reach, 'niche');
  assert.equal(bySymbol.get('AVUV').reach, 'niche');
  assert.equal(bySymbol.get('PFE').reach, 'common');
});

test('the chart endpoint yields a dollar volume, and the batch endpoint honestly does not', () => {
  const median = adapter.medianDollarVolume([100, 200, 300, ...new Array(20).fill(250)], 10);
  assert.equal(median, 2500);
  // Median, not mean: one earnings session is ten times a normal one and says
  // nothing about whether an ordinary order gets filled.
  assert.equal(adapter.medianDollarVolume([...new Array(24).fill(100), 1e9], 10), 1000);
  assert.equal(adapter.medianDollarVolume([1, 2, 3], 10), null, 'three sessions is not a normal day');
  assert.equal(adapter.medianDollarVolume(null, 10), null);
  assert.equal(adapter.medianDollarVolume([1, 2, 3], 0), null);
  assert.equal(adapter.medianDollarVolume(new Array(30).fill(0), 10), null);

  const fromChart = adapter.buildMeasured({ symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', group: 'dividend_growth' },
    adapter.parseChart(CHART), { schema, C, now: NOW });
  assert.ok(fromChart.volume > 0, 'the chart endpoint carries volume and it should reach the row');
  const fromBatch = adapter.buildMeasured({ symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', group: 'dividend_growth' },
    adapter.parseSpark(SPARK).get('SCHD'), { schema, C, now: NOW });
  assert.equal(fromBatch.volume, null, 'the batch feed carries no volume and must not claim one');
});

test('a chart states whether it was recorded or drawn', () => {
  // On screen a drawn curve and a recorded price history are the same picture,
  // so the difference has to travel on the row.
  const live = adapter.buildMeasured({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', group: 'core_index' },
    adapter.parseSpark(SPARK).get('VOO'), { schema, C, now: NOW });
  assert.equal(live.seriesBasis, 'measured', 'closes we fetched are closes we fetched');

  for (const o of seedResult().opportunities.filter((x) => x.measured !== false)) {
    assert.equal(o.seriesBasis, 'illustrative', `${o.symbol} presents a bundled shape as recorded prices`);
  }
  // No chart, no claim about one.
  const [rec] = adapter.parseTickerIndex(SEC_EXCHANGE).records;
  assert.equal(adapter.buildIndexRow(rec, { schema, C }).seriesBasis, null);
});
