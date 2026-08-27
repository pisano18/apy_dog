'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toCSV, toJSON, escapeCell, COLUMNS } = require('../src/core/export');
const schema = require('../src/core/schema');
const { scoreAll } = require('../src/core/score');

const rows = scoreAll([
  { name: 'US Treasury 3 Month Bill', assetClass: 'govt_bond', subType: 'bill', apy: { total: 3.8 }, term: { days: 91 }, liquidity: 'daily', risk: { insurance: 'us_gov' }, yieldKind: 'market', taxTreatment: 'treasury', minInvestment: 100, accessNotes: 'TreasuryDirect.gov or any brokerage', url: 'https://www.treasurydirect.gov/', seed: true },
  { name: 'USDC-ETH on Uniswap V3 (Ethereum)', assetClass: 'crypto_lp', apy: { base: 3, reward: 237, mean30d: 40 }, tvl: 180000, ilRisk: 'yes', liquidity: 'instant', risk: { ageDays: 9, auditCount: 0 }, chain: 'Ethereum', accessNotes: 'Needs a wallet and gas', url: 'https://defillama.com/', seed: false },
].map((r) => schema.normalize({ source: 'test', ...r })), { riskFree: 3.8, appetite: 45, taxProfile: { federalOrdinary: 24, state: 'TX' }, amount: 10000 });

describe('CSV export', () => {
  test('every column has a header and produces a value for every row', () => {
    const csv = toCSV(rows);
    const lines = csv.trim().split('\n');
    assert.strictEqual(lines.length, rows.length + 1);
    const headerCount = lines[0].split(',').length;
    assert.strictEqual(headerCount, COLUMNS.length);
    for (const line of lines.slice(1)) {
      // Naive split is fine here because no test value contains a comma.
      assert.strictEqual(line.split(',').length, COLUMNS.length, `wrong cell count: ${line.slice(0, 80)}`);
    }
  });

  test('carries the caveats, not just the headline number', () => {
    const csv = toCSV(rows);
    for (const h of ['Warning flags', 'Confidence', 'Rate as of', 'Live or snapshot', 'How to buy', 'Risk tier', 'After-tax %']) {
      assert.ok(csv.includes(h), `missing column: ${h}`);
    }
    assert.match(csv, /bundled snapshot/);
    assert.match(csv, /reward_dominant|low_tvl|brand_new/, 'trap flags must travel with the rate');
  });

  test('a meta block explains the file to someone opening it months later', () => {
    const csv = toCSV(rows, { meta: { generatedAt: '2026-08-27T00:00:00Z', total: 2, liveRows: 1, seedRows: 1, riskFree: 3.8, riskFreeSource: 'treasury' } });
    assert.match(csv, /^# APY Dog export/);
    assert.match(csv, /Risk-free rate used: 3\.8%/);
    assert.match(csv, /not quotes/i);
  });

  test('escapes commas, quotes and newlines properly', () => {
    assert.strictEqual(escapeCell('plain'), 'plain');
    assert.strictEqual(escapeCell('a,b'), '"a,b"');
    assert.strictEqual(escapeCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(escapeCell('one\ntwo'), '"one\ntwo"');
    assert.strictEqual(escapeCell(null), '');
    assert.strictEqual(escapeCell(0), '0');
  });

  test('neutralises spreadsheet formula injection from third-party names', () => {
    // Pool and fund names come from public feeds that anyone can write to. A row
    // called =HYPERLINK(...) must land in a cell, not execute in Excel.
    assert.strictEqual(escapeCell('=HYPERLINK("http://evil","click")'), '"\'=HYPERLINK(""http://evil"",""click"")"');
    assert.strictEqual(escapeCell('+1+1'), "'+1+1");
    assert.strictEqual(escapeCell('@SUM(A1)'), "'@SUM(A1)");
    // ...but a genuine negative number is a number, not an attack.
    assert.strictEqual(escapeCell(-4.2), '-4.2');
    assert.strictEqual(escapeCell('-4.2'), '-4.2');
  });

  test('a malicious pool name survives a full round trip as data', () => {
    const nasty = schema.normalize({ source: 'test', name: '=cmd|"/c calc"!A1', assetClass: 'crypto_lp', apy: { total: 9 }, liquidity: 'instant', accessNotes: 'x', url: 'https://x.test/' });
    const csv = toCSV(scoreAll([nasty], { riskFree: 4 }));
    assert.ok(!/(^|\n)=cmd/.test(csv), 'a formula reached the start of a cell');
    assert.match(csv, /'=cmd/);
  });
});

describe('JSON export', () => {
  test('is valid JSON, carries a disclaimer, and keeps the scoring detail', () => {
    const parsed = JSON.parse(toJSON(rows, { meta: { riskFree: 3.8 } }));
    assert.strictEqual(parsed.count, rows.length);
    assert.match(parsed.disclaimer, /not quotes/i);
    assert.match(parsed.disclaimer, /not advice/i);
    assert.strictEqual(parsed.meta.riskFree, 3.8);
    const farm = parsed.opportunities.find((o) => /Uniswap/.test(o.name));
    assert.ok(farm.scores.risk.factors.length, 'risk factors must survive export');
    assert.ok(farm.scores.traps.detail.length, 'trap explanations must survive export');
    assert.ok(farm.tax.parts.length, 'tax breakdown must survive export');
  });
});
