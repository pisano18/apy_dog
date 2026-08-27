'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/speculative');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const http = require('../src/core/http');
const { scoreRisk } = require('../src/core/risk');
const { detectTraps } = require('../src/core/traps');
const { scoreOne } = require('../src/core/score');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');

/**
 * yahoo-chart-nke.json is the real v8/finance/chart response shape carrying 300
 * daily bars of a deterministic synthetic price path: mild drift, a slump around
 * the two-thirds mark, and two halted sessions where the bar is null but the
 * timestamp is not. It is built to land on a beaten-down profile — roughly 31%
 * volatility, deeply negative 12-1 momentum and a >40% fall from its high — so
 * the negative-momentum and mean-reversion branches both get exercised.
 *
 * stooq-nke.csv is the fallback feed for the same name: 89 usable rows, which is
 * enough to annualise a volatility and deliberately NOT enough for 12-1 momentum.
 */
const chartPayload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'yahoo-chart-nke.json'), 'utf8'));
const stooqCsv = fs.readFileSync(path.join(FIXTURES, 'stooq-nke.csv'), 'utf8');

const NOW = Date.parse('2026-08-27T00:00:00Z');
const ctx = { schema, C, http, seedDir: SEED_DIR, settings: {}, now: NOW, log() {} };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b} (within ${eps})`);
const ramp = (n, from = 100) => Array.from({ length: n }, (_, i) => from + i);

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'speculative');
  assert.equal(adapter.label, 'High-Upside / Uncertain');
  assert.deepEqual(adapter.assetClasses, [C.ASSET_CLASS.SPECULATIVE]);
  assert.equal(adapter.defaultEnabled, true, 'the user asked for this category by name');
});

test('the universe is grouped, real and roughly the intended size', () => {
  assert.deepEqual(Object.keys(adapter.UNIVERSE).sort(), [
    'beaten_down_quality', 'commodity', 'crypto_proxy', 'high_growth', 'sector_thematic', 'small_cap_value',
  ]);
  const all = adapter.resolveUniverse({});
  assert.ok(all.length >= 40 && all.length <= 52, `expected ~45 symbols, got ${all.length}`);
  assert.equal(new Set(all.map((e) => e.symbol)).size, all.length, 'duplicate ticker in the universe');
  for (const e of all) {
    assert.match(e.symbol, /^[A-Z]{1,5}$/, `${e.symbol} does not look like a US ticker`);
    assert.ok(e.name && e.name !== e.symbol, `${e.symbol} is missing a real name`);
    assert.ok(adapter.GROUPS[e.group], `${e.symbol} has unknown group ${e.group}`);
    assert.ok(['stock', 'etf'].includes(e.kind), `${e.symbol} has unknown kind ${e.kind}`);
  }
  for (const [group, list] of Object.entries(adapter.UNIVERSE)) {
    assert.ok(list.length >= 3, `${group} is thin`);
    assert.equal(typeof adapter.GROUPS[group].thesis('X'), 'string');
  }
});

test('settings can add, exclude and drop whole groups', () => {
  const dropped = adapter.resolveUniverse({ sources: { speculative: { excludeGroups: ['crypto_proxy'] } } });
  assert.ok(!dropped.some((e) => e.symbol === 'MSTR'));

  const trimmed = adapter.resolveUniverse({ sources: { speculative: { exclude: ['nvda'] } } });
  assert.ok(!trimmed.some((e) => e.symbol === 'NVDA'));

  const added = adapter.resolveUniverse({ sources: { speculative: { symbols: ['RKLB', 'not a ticker!!', ''] } } });
  assert.ok(added.some((e) => e.symbol === 'RKLB' && e.userAdded));
  assert.equal(added.filter((e) => /[^A-Z0-9.\-]/.test(e.symbol)).length, 0, 'junk symbol got through');
});

// ---------------------------------------------------------------------------
// The model, against hand-computed values
// ---------------------------------------------------------------------------

test('annualisedVol is the sample stdev of log returns scaled by sqrt(252)', () => {
  // A perfectly constant compounding rate has zero dispersion, so zero vol.
  const steady = Array.from({ length: 80 }, (_, i) => 100 * 1.001 ** i);
  close(adapter.annualisedVol(steady), 0, 1e-9);

  // Alternating +10% / -10%: mean log return is exactly 0, so the sample
  // variance is sum(r^2)/(n-1) = n*ln(1.1)^2/(n-1).
  const zigzag = Array.from({ length: 121 }, (_, i) => (i % 2 ? 110 : 100));
  const c = Math.log(1.1);
  const expected = c * Math.sqrt(120 / 119) * Math.sqrt(252) * 100;
  close(adapter.annualisedVol(zigzag), expected, 1e-9);

  // Too little history is answered with null, not with a confident number.
  assert.equal(adapter.annualisedVol(ramp(40)), null);
  assert.equal(adapter.annualisedVol([]), null);
  assert.equal(adapter.annualisedVol(null), null);

  // A 10:1 split that the feed did not adjust is dropped as bad data rather
  // than being read as a 900% day.
  const split = Array.from({ length: 121 }, (_, i) => (i % 2 ? 110 : 100));
  split[60] = 1100;
  assert.ok(adapter.annualisedVol(split) < expected * 1.2, 'split artifact leaked into the volatility');
});

test('momentum12_1 measures twelve months and skips the last one', () => {
  // 253 bars of 100,101,...: the window runs from index 0 to index 231.
  close(adapter.momentum12_1(ramp(253)), 231, 1e-12);
  // One more bar shifts both ends by one: 332/101 - 1.
  close(adapter.momentum12_1(ramp(254)), (332 / 101 - 1) * 100, 1e-12);
  // The skipped month genuinely is skipped: moving only the last 21 bars must
  // not change the answer at all.
  const px = ramp(300);
  const spiked = px.slice();
  for (let i = spiked.length - 21; i < spiked.length; i += 1) spiked[i] *= 3;
  close(adapter.momentum12_1(spiked), adapter.momentum12_1(px), 1e-12);
  assert.equal(adapter.momentum12_1(ramp(252)), null, 'should refuse to guess without a full year');
});

test('drawdownFromHigh is the distance below the trailing 52-week high', () => {
  close(adapter.drawdownFromHigh([100, 200, 150]), -25, 1e-12);
  close(adapter.drawdownFromHigh([100, 120, 120]), 0, 1e-12);

  // A high older than 252 sessions has rolled out of the window.
  const long = Array.from({ length: 300 }, (_, i) => (i < 40 ? 500 : 200));
  long[299] = 150;
  close(adapter.drawdownFromHigh(long), -25, 1e-12);

  assert.equal(adapter.drawdownFromHigh([100]), null);
  assert.equal(adapter.drawdownFromHigh('nope'), null);
});

test('normalCdf is accurate enough to price a percentile', () => {
  close(adapter.normalCdf(0), 0.5, 1e-7);
  close(adapter.normalCdf(-1.2815515655446004), 0.1, 1e-7);
  close(adapter.normalCdf(1.2815515655446004), 0.9, 1e-7);
  close(adapter.normalCdf(-1.959963984540054), 0.025, 1e-7);
});

test('lognormalBands puts the mean where it was asked to and computes the loss odds', () => {
  // Pick mu so that ln(1+mu) = sigma^2/2 exactly; the median then sits at 0 and
  // the chance of losing money is exactly a coin flip. This is the whole point
  // of the -s^2/2 term, and getting it wrong shows up here first.
  const mu = (Math.exp(0.02) - 1) * 100;
  const b = adapter.lognormalBands(mu, 20, 365);
  close(b.p50, 0, 1e-9);
  close(b.probabilityOfLoss, 0.5, 1e-3);
  close(b.p10, Math.round((Math.exp(-0.2 * 1.2815515655446004) - 1) * 1000) / 10, 1e-9);
  close(b.p90, Math.round((Math.exp(0.2 * 1.2815515655446004) - 1) * 1000) / 10, 1e-9);
  assert.ok(b.p10 < b.p50 && b.p50 < b.p90, 'percentiles out of order');

  // Zero volatility degenerates to the point estimate, which is the only case
  // where a single number is honest.
  const flat = adapter.lognormalBands(10, 0, 365);
  close(flat.p10, 10, 1e-9);
  close(flat.p90, 10, 1e-9);
  assert.equal(flat.probabilityOfLoss, 0);
  assert.equal(adapter.lognormalBands(-10, 0, 365).probabilityOfLoss, 1);

  // Loss odds must move with the inputs, never be asserted.
  const calm = adapter.lognormalBands(8, 12, 365);
  const wild = adapter.lognormalBands(8, 70, 365);
  assert.ok(wild.probabilityOfLoss > calm.probabilityOfLoss, 'more volatility must mean more chance of loss');
  assert.ok(adapter.lognormalBands(20, 30, 365).probabilityOfLoss
    < adapter.lognormalBands(2, 30, 365).probabilityOfLoss);

  // A shorter horizon narrows the band.
  const short = adapter.lognormalBands(8, 30, 90);
  assert.ok(short.p90 - short.p10 < calm.p90 - calm.p10 + 200 && short.p10 > adapter.lognormalBands(8, 30, 365).p10);

  for (const bad of [[null, 20, 365], [10, null, 365], [10, 20, 0], [10, 20, null], [-200, 20, 365]]) {
    assert.equal(adapter.lognormalBands(...bad), null, `lognormalBands(${bad}) should be null`);
  }
});

test('blendedExpectedReturn shrinks, caps and anchors', () => {
  // 5.5 base + 40 * 0.20 = 8.0 momentum, no reversion (inside -25), no vol drag.
  close(adapter.blendedExpectedReturn({ momentum: 40, drawdown: -10, vol: 30 }).mu, 13.5, 1e-9);

  // Everything binding at once: momentum 200 -> 40 raw -> capped at 12;
  // 55% off the high -> (55-25)*0.12 = 3.6; vol 100 -> (100-40)*0.05 = 3.0.
  const hot = adapter.blendedExpectedReturn({ momentum: 200, drawdown: -55, vol: 100 });
  close(hot.mu, 18.1, 1e-9);
  close(hot.momentumPart, 12, 1e-9);
  close(hot.reversionPart, 3.6, 1e-9);
  close(hot.volDrag, 3, 1e-9);
  assert.ok(hot.basis.some((b) => /capped at 12pp/.test(b)), 'the cap must be visible to the user');

  // Deep negative momentum is shrunk just as hard as positive.
  close(adapter.blendedExpectedReturn({ momentum: -45, drawdown: -10, vol: 20 }).mu, 5.5 - 9, 1e-9);

  // The reversion threshold is a threshold, not a slope from zero.
  close(adapter.blendedExpectedReturn({ momentum: 0, drawdown: -24.9, vol: 20 }).reversionPart, 0, 1e-9);
  close(adapter.blendedExpectedReturn({ momentum: 0, drawdown: -75, vol: 20 }).reversionPart, 6, 1e-9);
  close(adapter.blendedExpectedReturn({ momentum: 0, drawdown: -200, vol: 20 }).reversionPart, 8, 1e-9);

  // Nothing but the prior when nothing is known.
  const bare = adapter.blendedExpectedReturn({});
  close(bare.mu, 5.5, 1e-9);
  assert.ok(bare.basis.some((b) => /momentum contributed nothing/.test(b)));

  // With the default priors the caps hold it well inside the outer clamp; the
  // clamp is the backstop for overridden priors.
  const wild = adapter.blendedExpectedReturn({ momentum: 500, drawdown: -90, vol: 20, priors: { equityRiskPremium: 100 } });
  close(wild.mu, 45, 1e-9);
  assert.ok(wild.basis.some((b) => /supported range/.test(b)));
  const floored = adapter.blendedExpectedReturn({ momentum: -500, drawdown: 0, vol: 20, priors: { equityRiskPremium: -100 } });
  close(floored.mu, -30, 1e-9);

  // Every input that moved the number has to be visible in plain English.
  for (const line of hot.basis) assert.equal(typeof line, 'string');
  assert.ok(hot.basis.some((b) => /Equity risk premium/.test(b)));
  assert.ok(hot.basis.some((b) => /12-1 momentum/.test(b)));
  assert.ok(hot.basis.some((b) => /52-week high/.test(b)));
  assert.ok(hot.basis.some((b) => /volatility/.test(b)));
});

test('confidence stays low by construction', () => {
  const seen = [];
  for (const vol of [5, 25, 60, 120]) {
    for (const momentum of [null, 10]) {
      for (const seed of [false, true]) {
        const c = adapter.modelConfidence({ vol, momentum, drawdown: -10, seed });
        assert.ok(c >= 0.15 && c <= 0.4, `confidence ${c} outside 0.15..0.40`);
        seen.push(c);
      }
    }
  }
  assert.ok(Math.max(...seen) <= 0.4);
  // More volatility and less history must both cost confidence, never add it.
  assert.ok(adapter.modelConfidence({ vol: 100, momentum: 10, drawdown: -5 })
    < adapter.modelConfidence({ vol: 15, momentum: 10, drawdown: -5 }));
  assert.ok(adapter.modelConfidence({ vol: 30, momentum: null, drawdown: -5 })
    < adapter.modelConfidence({ vol: 30, momentum: 10, drawdown: -5 }));
});

test('modelFromSignals refuses to produce a band it cannot support', () => {
  assert.equal(adapter.modelFromSignals({ vol: null, momentum: 10, drawdown: -30 }), null);
  assert.equal(adapter.modelFromSignals({}), null);
  // A zero or nonsense volatility would print as a suspiciously confident row.
  for (const vol of [0, -5, 900, Number.NaN, 'x']) {
    assert.equal(adapter.modelFromSignals({ vol, momentum: 10, drawdown: -30 }), null, `vol ${vol} should be rejected`);
  }
  const m = adapter.modelFromSignals({ vol: 40, momentum: 10, drawdown: -30 });
  assert.ok(Number.isFinite(m.mu) && Number.isFinite(m.bands.p10));
  assert.ok(m.basis.some((b) => /computed from that band/.test(b)));
});

// ---------------------------------------------------------------------------
// Upstream parsing, against the fixtures
// ---------------------------------------------------------------------------

test('parses the Yahoo chart fixture and drops the halted sessions', () => {
  const series = adapter.parseChart(chartPayload);
  assert.ok(series && !series.error);
  assert.equal(series.symbol, 'NKE');
  assert.equal(series.currency, 'USD');
  assert.equal(series.adj.length, 298, '300 bars minus the two null ones');
  assert.equal(series.price, chartPayload.chart.result[0].meta.regularMarketPrice);
  assert.equal(new Date(series.lastTsMs).toISOString().slice(0, 10), '2026-07-31');
  for (const v of series.adj) assert.ok(Number.isFinite(v) && v > 0);
});

test('the model on the fixture matches an independent recomputation', () => {
  const px = adapter.parseChart(chartPayload).adj;

  // Recomputed here with plain loops rather than by calling the adapter, so
  // this is a second derivation and not a restatement of the implementation.
  const rets = [];
  for (let i = 1; i < px.length; i += 1) rets.push(Math.log(px[i] / px[i - 1]));
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  let ss = 0;
  for (const x of rets) ss += (x - mean) ** 2;
  const vol = Math.sqrt(ss / (rets.length - 1)) * Math.sqrt(252) * 100;
  close(adapter.annualisedVol(px), vol, 1e-9);

  const mom = (px[px.length - 22] / px[px.length - 253] - 1) * 100;
  close(adapter.momentum12_1(px), mom, 1e-9);

  let high = 0;
  for (const v of px.slice(-252)) if (v > high) high = v;
  close(adapter.drawdownFromHigh(px), (px[px.length - 1] / high - 1) * 100, 1e-9);

  // And the profile the fixture was built to produce.
  const m = adapter.modelFromCloses(px);
  assert.ok(m.vol > 25 && m.vol < 40, `fixture volatility drifted: ${m.vol}`);
  assert.ok(m.momentum < -20, `fixture momentum drifted: ${m.momentum}`);
  assert.ok(m.drawdown < -25, `fixture drawdown drifted: ${m.drawdown}`);
  assert.ok(m.bands.p10 < m.mu && m.mu < m.bands.p90);
  assert.equal(m.bars, 298);
});

test('the Stooq fallback still models, with momentum honestly missing', () => {
  const series = adapter.parseStooq(stooqCsv, http.parseCSV);
  assert.ok(series && series.adj.length >= 60 && series.adj.length < 253);
  const m = adapter.modelFromCloses(series.adj);
  assert.ok(m, 'a quarter of prices is still enough for a band');
  assert.equal(m.momentum, null);
  assert.ok(m.basis.some((b) => /No 12-month price history/.test(b)));
  assert.ok(m.basis.some((b) => /less than the model wants/.test(b)));
  // Missing a signal has to cost confidence.
  assert.ok(m.confidence < adapter.modelConfidence({ vol: m.vol, momentum: 5, drawdown: m.drawdown }));
});

test('a renamed or broken upstream degrades, never throws', () => {
  const bad = [
    null, undefined, {}, 42, 'nope', [],
    { chart: null },
    { chart: { result: [] } },
    { chart: { result: [{}] } },
    { chart: { result: [{ indicators: {} }] } },
    { chart: { result: [{ indicators: { quote: [{ closes: [1, 2, 3] }] } }] } },   // field renamed
    { chart: { result: [{ indicators: { adjclose: [{ adjclose: [null, 'x', -3] }] } }] } },
    { chart: { error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } },
  ];
  for (const payload of bad) {
    const series = adapter.parseChart(payload);
    assert.ok(series === null || typeof series === 'object', 'parseChart threw or returned junk');
    if (series && !series.error && Array.isArray(series.adj)) {
      assert.equal(adapter.modelFromCloses(series.adj), null, 'a broken payload produced a model anyway');
    }
  }
  assert.ok(adapter.parseChart(bad[bad.length - 1]).error.includes('Not Found'));

  for (const csv of ['', 'Date,Close\n', 'garbage', 'Date,Close\n2026-01-01,notanumber\n']) {
    assert.equal(adapter.parseStooq(csv, http.parseCSV), null);
  }
});

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

test('a built row is an expectation, never a yield', () => {
  const entry = { symbol: 'NKE', name: 'Nike, Inc.', kind: 'stock', group: 'beaten_down_quality' };
  const model = adapter.modelFromCloses(adapter.parseChart(chartPayload).adj);
  const o = adapter.buildOpportunity(entry, model, { schema, C, price: 39.2, maxDrawdown: 48 });

  assert.deepEqual(schema.validate(o), []);
  assert.equal(o.assetClass, C.ASSET_CLASS.SPECULATIVE);
  assert.equal(o.yieldKind, C.YIELD_KIND.EXPECTED);
  assert.equal(o.apy.total, null, 'a speculative row must never carry a headline APY');
  for (const k of Object.keys(o.apy)) assert.equal(o.apy[k], null, `apy.${k} should be null`);
  assert.equal(schema.headlineRate(o), o.expected.annualReturn);
  assert.equal(o.taxTreatment, C.TAX_TREATMENT.CAPITAL_GAIN_LONG);
  assert.equal(o.risk.insurance, C.INSURANCE.NONE);
  assert.equal(o.risk.principalAtRisk, true);
  assert.equal(o.risk.volatility, model.vol);
  assert.equal(o.minInvestment, 39.2);
  assert.ok(o.confidence >= 0.15 && o.confidence <= 0.4);

  const e = o.expected;
  assert.ok(e.p10 < e.p50 && e.p50 < e.p90);
  assert.equal(e.horizonDays, 365);
  assert.ok(e.probabilityOfLoss > 0 && e.probabilityOfLoss < 1);
  assert.ok(e.basis.length >= 5);
  assert.ok(/^For this to work/.test(e.thesis), e.thesis);
  // No hype, anywhere.
  const prose = `${e.thesis} ${o.notes} ${e.basis.join(' ')}`;
  assert.doesNotMatch(prose, /guarantee|surge|moon|explode|can't lose|risk-free|multi-bagger|skyrocket/i);

  // The mandatory honesty sentence, carrying the actual downside figure.
  assert.match(o.notes, /model estimate, not a yield/i);
  assert.ok(o.notes.includes(`${e.p10.toFixed(0)}%`), `notes must quote p10 (${e.p10}): ${o.notes}`);
});

test('ETFs are marked as baskets so the tail model treats them as baskets', () => {
  const model = adapter.modelFromSignals({ vol: 20, momentum: 5, drawdown: -6 });
  const etf = adapter.buildOpportunity({ symbol: 'GLD', name: 'SPDR Gold Shares', kind: 'etf', group: 'commodity' }, model, { schema, C });
  const stock = adapter.buildOpportunity({ symbol: 'NKE', name: 'Nike, Inc.', kind: 'stock', group: 'beaten_down_quality' }, model, { schema, C });
  assert.equal(etf.subType, 'index_proxy');
  assert.equal(stock.subType, 'beaten_down_quality');
});

test('buildAll drops a bad row instead of taking the source down', () => {
  const good = { entry: { symbol: 'NKE', name: 'Nike, Inc.', kind: 'stock', group: 'beaten_down_quality' }, model: adapter.modelFromSignals({ vol: 30, momentum: 5, drawdown: -10 }) };
  const rows = [
    good,
    { entry: null, model: good.model },
    { entry: { symbol: '' }, model: good.model },
    { entry: { symbol: 'XXX', group: 'nope' }, model: null },
    { entry: { symbol: 'YYY', group: 'high_growth' }, model: { mu: Number.NaN, bands: null } },
    null,
  ];
  const built = adapter.buildAll(rows, { schema, C });
  assert.equal(built.opportunities.length, 1);
  assert.equal(built.skipped.length, 5);
});

// ---------------------------------------------------------------------------
// Seed path
// ---------------------------------------------------------------------------

test('loadSeed returns a clean, honestly labelled offline snapshot', () => {
  const res = adapter.loadSeed(ctx);
  assert.equal(res.status, 'offline');
  assert.ok(res.opportunities.length >= 20, `expected ~25 seed rows, got ${res.opportunities.length}`);

  const known = new Set(Object.values(adapter.UNIVERSE).flat().map((e) => e.symbol));
  for (const o of res.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.ok(known.has(o.symbol), `${o.symbol} is not in the universe`);
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.equal(o.source, 'speculative');
    assert.equal(o.apy.total, null);
    assert.equal(o.yieldKind, C.YIELD_KIND.EXPECTED);
    assert.ok(o.confidence >= 0.15 && o.confidence <= 0.4, `${o.symbol} confidence ${o.confidence}`);
    assert.ok(Number.isFinite(o.expected.annualReturn));
    assert.ok(o.expected.annualReturn >= -30 && o.expected.annualReturn <= 45, `${o.symbol} mu out of range`);
    assert.ok(o.expected.p10 < o.expected.p90);
    assert.ok(o.expected.probabilityOfLoss > 0 && o.expected.probabilityOfLoss < 1);
    assert.ok(o.accessNotes && o.url && o.price > 0);
    // The honesty sentence, on every single row, with the real p10 in it.
    assert.match(o.notes, /model estimate, not a yield/i);
    assert.ok(o.notes.includes(`${o.expected.p10.toFixed(0)}%`), `${o.symbol}: ${o.notes}`);
  }

  assert.equal(new Set(res.opportunities.map((o) => o.id)).size, res.opportunities.length, 'duplicate ids');
  assert.ok(res.warnings.some((w) => /modelled expectations, not yields/i.test(w)), 'missing the source-level warning');
  assert.ok(res.notes.some((n) => n.includes('2026-08-01')));
});

test('loadSeed never throws, whatever it is handed', () => {
  for (const bad of [{}, { seedDir: '/nope/nowhere' }, { seedDir: null }, undefined]) {
    const res = adapter.loadSeed(bad);
    assert.ok(['offline', 'failed'].includes(res.status));
    assert.ok(Array.isArray(res.opportunities));
    assert.ok(res.warnings.some((w) => /modelled expectations, not yields/i.test(w)));
  }
});

test('the bundled seed file carries model inputs, not model outputs', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'speculative.json'), 'utf8'));
  assert.equal(raw.meta.dataAsOf, '2026-08-01');
  assert.ok(raw.items.length >= 20);
  for (const item of raw.items) {
    assert.ok(Number.isFinite(item.volatility) && item.volatility > 0, `${item.symbol} needs a volatility`);
    assert.ok(item.drawdownFromHigh <= 0, `${item.symbol} drawdown must be negative or zero`);
    assert.ok(item.price > 0);
    // A precomputed answer in here would drift away from the model.
    assert.equal(item.expected, undefined, `${item.symbol} must not ship a precomputed expected block`);
  }
});

// ---------------------------------------------------------------------------
// Live path — the network is expected to be unavailable here
// ---------------------------------------------------------------------------

test('fetch returns a failed SourceResult rather than throwing when the feed is unreachable', async () => {
  const boom = () => { throw new http.HttpError('HTTP 403 blocked', { status: 403 }); };
  const res = await adapter.fetch({
    ...ctx,
    http: { ...http, getJSON: boom, getText: boom },
    settings: { sources: { speculative: { exclude: [] } } },
  });
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.opportunities, []);
  assert.ok(res.warnings.some((w) => /modelled expectations, not yields/i.test(w)));
  assert.ok(res.notes.some((n) => /unavailable this run/.test(n)));
});

test('fetch models the universe when the chart endpoint answers', async () => {
  const res = await adapter.fetch({
    ...ctx,
    settings: { sources: { speculative: { symbols: [{ symbol: 'NKE', group: 'beaten_down_quality' }], excludeGroups: Object.keys(adapter.UNIVERSE) } } },
    http: {
      ...http,
      getJSON: async () => chartPayload,
      getText: async () => { throw new Error('should not reach Stooq'); },
    },
  });
  assert.ok(['ok', 'partial'].includes(res.status));
  assert.equal(res.opportunities.length, 1);
  const o = res.opportunities[0];
  assert.deepEqual(schema.validate(o), []);
  assert.equal(o.seed, false);
  assert.equal(o.live, true);
  assert.equal(o.apy.total, null);
  assert.equal(o.dataAsOf.slice(0, 10), '2026-07-31');
  assert.ok(res.warnings.some((w) => /modelled expectations, not yields/i.test(w)));
});

test('fetch falls back to Stooq when both Yahoo hosts fail', async () => {
  const res = await adapter.fetch({
    ...ctx,
    settings: { sources: { speculative: { symbols: [{ symbol: 'NKE', group: 'beaten_down_quality' }], excludeGroups: Object.keys(adapter.UNIVERSE) } } },
    http: {
      ...http,
      getJSON: async () => { throw new http.HttpError('HTTP 503', { status: 503 }); },
      getText: async () => stooqCsv,
    },
  });
  assert.equal(res.status, 'partial');
  assert.equal(res.opportunities.length, 1);
  assert.deepEqual(schema.validate(res.opportunities[0]), []);
  assert.ok(res.notes.some((n) => /Stooq/.test(n)));
});

// ---------------------------------------------------------------------------
// Downstream: these rows have to survive the pipeline that ranks them
// ---------------------------------------------------------------------------

test('risk, traps and scoring treat these as the soft claims they are', () => {
  const rows = adapter.loadSeed(ctx).opportunities;
  const mstr = rows.find((o) => o.symbol === 'MSTR');
  const gld = rows.find((o) => o.symbol === 'GLD');

  for (const o of rows) {
    const risk = scoreRisk({ ...o, __riskFree: 4 });
    assert.ok(Number.isFinite(risk.score) && risk.score > 0);
    assert.ok(risk.factors.some((f) => /Modelled expectation/.test(f.label)),
      `${o.symbol} did not get charged for being a model output`);
    assert.equal(risk.principalAtRisk, true);

    // Nothing here should be scored as if it were a bank product.
    assert.ok(risk.score >= 40, `${o.symbol} scored implausibly safe at ${risk.score}`);

    const traps = detectTraps(o, {});
    assert.ok(Array.isArray(traps.flags));

    const scored = scoreOne(o, { riskFree: 4, appetite: 50, amount: 10000 });
    assert.ok(Number.isFinite(scored.dogScore), `${o.symbol} produced no score`);
  }

  // The levered bitcoin proxy has to rank below the gold ETF for a balanced user.
  assert.ok(scoreRisk({ ...mstr, __riskFree: 4 }).score > scoreRisk({ ...gld, __riskFree: 4 }).score);
  assert.ok(detectTraps(mstr, {}).flags.includes(C.TRAP_FLAGS.LEVERAGED));
});
