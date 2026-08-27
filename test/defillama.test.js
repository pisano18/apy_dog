'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/sources/defillama');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { detectTraps, peerMedians } = require('../src/core/traps');

const POOLS = require('./fixtures/defillama-pools.json');
const PROTOCOLS = require('./fixtures/defillama-protocols.json');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const NOW = Date.parse('2026-08-27T00:00:00Z');

const parse = (payload, opts = {}) => adapter.parsePools(payload, {
  schema, C, protocols: PROTOCOLS, now: NOW, ...opts,
});

const byName = (list, needle) => list.find((o) => o.name.includes(needle));

test('satisfies the source adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'defillama');
  assert.equal(adapter.label, 'DefiLlama Yields');
});

test('parses the fixture, keeping only actionable pools', () => {
  const r = parse(POOLS);
  assert.equal(r.opportunities.length, 11);
  assert.deepEqual(r.dropped, {
    unparseable: 3,   // null pool id, a literal null, a bare string
    noChain: 1,
    noRate: 1,
    lowTvl: 1,
    absurdApy: 1,
  });
  assert.ok(r.notes.some((n) => /under \$10,000 TVL/.test(n)));
  assert.ok(r.notes.some((n) => /APY above 100,000%/.test(n)));
});

test('every parsed opportunity passes schema validation', () => {
  const r = parse(POOLS);
  const bad = r.opportunities.map((o) => [o.id, schema.validate(o)]).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);
  for (const o of r.opportunities) {
    assert.equal(o.source, 'defillama');
    assert.equal(o.yieldKind, C.YIELD_KIND.VARIABLE);
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.ORDINARY);
    assert.equal(o.risk.insurance, C.INSURANCE.NONE);
    assert.equal(o.risk.principalAtRisk, true);
    assert.ok(o.name.includes('('), 'name must carry the chain');
  }
});

test('classifies pairs, staking and lending', () => {
  const r = parse(POOLS);
  assert.equal(byName(r.opportunities, 'USDC-ETH on Uniswap').assetClass, C.ASSET_CLASS.CRYPTO_LP);
  assert.equal(byName(r.opportunities, 'USDC-ETH on Uniswap').subType, 'volatile_lp');
  assert.equal(byName(r.opportunities, 'DAI-USDC-USDT').subType, 'stable_lp');
  assert.equal(byName(r.opportunities, 'STETH on Lido').assetClass, C.ASSET_CLASS.CRYPTO_STAKING);
  assert.equal(byName(r.opportunities, 'JITOSOL').assetClass, C.ASSET_CLASS.CRYPTO_STAKING);
  assert.equal(byName(r.opportunities, 'USDC on AAVE V3').assetClass, C.ASSET_CLASS.CRYPTO_LENDING);
});

test('a hyphenated single-exposure symbol is not a liquidity pool', () => {
  // Pendle PT tokens are hyphenated but hold one asset; treating them as LPs
  // would attach a fictional impermanent-loss warning.
  const pt = byName(parse(POOLS).opportunities, 'PT-SUSDE');
  assert.equal(pt.assetClass, C.ASSET_CLASS.CRYPTO_LENDING);
  assert.equal(pt.ilRisk, 'no');
});

test('liquid staking is NOTICE liquidity, everything else INSTANT', () => {
  const r = parse(POOLS);
  assert.equal(byName(r.opportunities, 'STETH on Lido').liquidity, C.LIQUIDITY.NOTICE);
  assert.equal(byName(r.opportunities, 'USDC on AAVE V3').liquidity, C.LIQUIDITY.INSTANT);
});

test('carries the metadata trap detection depends on', () => {
  const brett = byName(parse(POOLS).opportunities, 'WETH-BRETT');
  assert.equal(brett.apy.total, 78.1);
  assert.equal(brett.apy.base, 6.2);
  assert.equal(brett.apy.reward, 71.9);
  assert.equal(brett.apy.mean30d, 20.8);
  assert.equal(brett.tvl, 418000);
  assert.equal(brett.ilRisk, 'yes');
  const t = detectTraps(brett);
  assert.ok(t.flags.includes(C.TRAP_FLAGS.REWARD_DOMINANT));
  assert.ok(t.flags.includes(C.TRAP_FLAGS.LOW_TVL));
  assert.ok(t.flags.includes(C.TRAP_FLAGS.APY_SPIKE));
  assert.ok(t.flags.includes(C.TRAP_FLAGS.IMPERMANENT_LOSS));
  assert.equal(t.verdict, 'likely_trap');
});

test('joins protocol metadata, and survives a missing protocol', () => {
  const r = parse(POOLS);
  const aave = byName(r.opportunities, 'USDC on AAVE V3');
  assert.equal(aave.risk.auditCount, 3);
  assert.ok(aave.risk.ageDays > 1500);

  // "0" audits is a real signal, not a missing value — traps.js flags it.
  assert.equal(byName(r.opportunities, 'Venus').risk.auditCount, 0);

  // Beefy is deliberately absent from the protocols fixture.
  const orphan = byName(r.opportunities, 'Beefy');
  assert.equal(orphan.risk.auditCount, null);
  assert.equal(orphan.risk.ageDays, null);
});

test('running without protocol enrichment still produces valid rows', () => {
  const r = parse(POOLS, { protocols: null });
  assert.equal(r.opportunities.length, 11);
  assert.equal(r.opportunities.every((o) => o.risk.auditCount === null), true);
  assert.deepEqual(r.opportunities.flatMap((o) => schema.validate(o)), []);
});

test('confidence falls with thin history and low upstream confidence', () => {
  const r = parse(POOLS);
  const aave = byName(r.opportunities, 'USDC on AAVE V3');   // binned 3, 1240 days
  const brett = byName(r.opportunities, 'WETH-BRETT');       // binned 1, 44 days
  const orphan = byName(r.opportunities, 'Beefy');           // binned 1, 11 days
  assert.ok(aave.confidence > brett.confidence);
  assert.ok(brett.confidence > orphan.confidence);
  assert.ok(orphan.confidence > 0);
});

test('url and accessNotes tell the user how to actually buy it', () => {
  const brett = byName(parse(POOLS).opportunities, 'WETH-BRETT');
  assert.equal(brett.url, 'https://defillama.com/yields/pool/747c1d2a-c668-4682-b9f9-000000000004');
  assert.match(brett.accessNotes, /Base/);
  assert.match(brett.accessNotes, /Aerodrome V1/);
  assert.match(brett.accessNotes, /self-custody wallet/);
  assert.match(brett.accessNotes, /ETH for gas/);
  assert.deepEqual(brett.requirements, ['Self-custody wallet', 'ETH for gas on Base']);
});

test('falls back to the poolMeta for a nameless pool and to a protocol page for a non-uuid key', () => {
  const morpho = byName(parse(POOLS).opportunities, 'Steakhouse USDC');
  assert.equal(morpho.symbol, 'Steakhouse USDC');
  const seeded = parse({ data: [{ pool: 'seed-x', chain: 'Base', project: 'aave-v3', symbol: 'USDC', tvlUsd: 5e7, apy: 5 }] });
  assert.equal(seeded.opportunities[0].url, 'https://defillama.com/protocol/aave-v3');
});

test('coerces string numbers and tolerates a malformed predictions block', () => {
  const venus = byName(parse(POOLS).opportunities, 'Venus');
  assert.equal(venus.tvl, 45000000);
  assert.equal(venus.apy.total, 6.5);
  assert.deepEqual(schema.validate(venus), []);
});

test('derives daily volume from the 7d figure when 1d is absent', () => {
  const curve = byName(parse(POOLS).opportunities, 'DAI-USDC-USDT');
  assert.equal(curve.volume, 168000000 / 7);
});

test('the cap is a parameter and is reported', () => {
  const r = parse(POOLS, { limit: 3 });
  assert.equal(r.opportunities.length, 3);
  assert.equal(r.capped, true);
  assert.ok(r.notes.some((n) => /Capped at 3 pools/.test(n)));
  // The blend must keep both ends of the range: the loud farms AND the deep
  // blue chip that gives the user something to compare them against.
  const names = r.opportunities.map((o) => o.name).join(' | ');
  assert.match(names, /BRETT|Beefy/);
  assert.match(names, /Lido/);
  assert.equal(r.reserved, 1);
});

test('never throws on hostile or drifted upstream shapes', () => {
  for (const payload of [null, undefined, {}, [], 'nope', 42, { status: 'error', data: null }, { data: {} }]) {
    const r = parse(payload);
    assert.equal(Array.isArray(r.opportunities), true);
    assert.equal(r.opportunities.length, 0);
  }
  const evil = {
    data: [
      { get pool() { throw new Error('boom'); } },
      { pool: 'p1', chain: 'Base', symbol: 'USDC', apy: 5, tvlUsd: 5e7, predictions: null, underlyingTokens: 'not-an-array' },
    ],
  };
  const r = parse(evil);
  assert.equal(r.opportunities.length, 1);
  assert.equal(r.dropped.unparseable, 1);
  assert.deepEqual(r.opportunities[0].underlying, []);
  assert.deepEqual(schema.validate(r.opportunities[0]), []);
});

test('an absurd reward leg is caught even when upstream leaves apy null', () => {
  // schema.normalize composes total = base + reward when `apy` is null, so the
  // sanity gate must test that composed figure. Gating on `apy ?? apyBase` let a
  // blown-up reward leg through and emitted a row that failed schema.validate().
  const row = (over) => ({ pool: 'p', chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 5e7, ...over });
  const cases = [
    { apy: null, apyBase: 5, apyReward: 500000 },
    { apy: null, apyBase: 5, apyReward: 99999 },
    { apy: null, apyBase: 5, apyReward: -500 },
    { apy: '1e400', apyBase: 4.81, apyReward: 99999 },
  ];
  for (const c of cases) {
    const r = parse({ status: 'success', data: [row(c)] });
    assert.deepEqual(r.opportunities, [], `should have dropped ${JSON.stringify(c)}`);
    assert.equal(r.dropped.absurdApy, 1);
  }
  // A sane reward leg still composes and survives.
  const ok = parse({ status: 'success', data: [row({ apy: null, apyBase: 6, apyReward: 70 })] });
  assert.equal(ok.opportunities.length, 1);
  assert.equal(ok.opportunities[0].apy.total, 76);
  assert.deepEqual(schema.validate(ok.opportunities[0]), []);
});

test('no corruption of the fixture produces a row that fails validation', () => {
  const KEYS = ['pool', 'chain', 'project', 'symbol', 'tvlUsd', 'apyBase', 'apyReward', 'apy',
    'apyMean30d', 'apyBase7d', 'stablecoin', 'ilRisk', 'exposure', 'poolMeta',
    'underlyingTokens', 'count', 'outlier', 'predictions', 'volumeUsd1d', 'volumeUsd7d'];
  const WEIRD = [null, 0, -1, '', 'abc', true, false, [], {}, [[]], { a: 1 }, '1,234',
    1e309, -1e309, 500000, -500, 99999, 0.045];
  const rows = POOLS.data.filter((p) => p && typeof p === 'object');
  const payloads = [];
  for (const k of KEYS) {
    for (const v of WEIRD) payloads.push({ status: 'success', data: rows.map((r) => ({ ...r, [k]: v })) });
    payloads.push({ status: 'success', data: rows.map((r) => { const c = { ...r }; delete c[k]; return c; }) });
  }
  payloads.push({ status: 'success', data: [] });
  payloads.push({ status: 'success', data: [null, undefined, 0, '', false, [], {}] });
  payloads.push({ status: 'success', data: {} });
  payloads.push({ status: 'success', data: 'not-an-array' });
  for (const protocols of [PROTOCOLS, null, [], 'x', {}, [null, 5, {}, { slug: null }]]) {
    for (const payload of payloads) {
      const r = parse(payload, { protocols });
      assert.equal(Array.isArray(r.opportunities), true);
      for (const o of r.opportunities) {
        assert.deepEqual(schema.validate(o), [], `${o.id} must validate`);
        assert.ok(Number.isFinite(o.apy.total), 'headline must be a real number');
        assert.ok(o.name && o.url && o.accessNotes, 'row must stay actionable');
      }
    }
  }
});

test('a renamed rate field degrades the source instead of crashing it', () => {
  const drifted = { status: 'success', data: POOLS.data.filter((p) => p && typeof p === 'object').map((p) => ({ ...p, apy: undefined, apyBase: undefined })) };
  const r = parse(drifted);
  assert.equal(r.opportunities.length, 0);
  assert.ok(r.dropped.noRate > 0);
});

// --- seed -------------------------------------------------------------------

const loadSeed = (dir = SEED_DIR) => adapter.loadSeed({
  seedDir: dir, schema, C, settings: {}, now: NOW, log() {},
});

test('loadSeed returns a valid offline snapshot', () => {
  const r = loadSeed();
  assert.equal(r.status, 'offline');
  assert.ok(r.opportunities.length >= 30, `expected 30+ seed rows, got ${r.opportunities.length}`);
  const bad = r.opportunities.map((o) => [o.id, schema.validate(o)]).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);
  for (const o of r.opportunities) {
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.ok(o.accessNotes && o.url && o.confidence > 0);
  }
});

test('loadSeed never throws, even with a bad seed directory', () => {
  const r = loadSeed('/nonexistent/seed/dir');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.opportunities, []);
  assert.ok(r.warnings.length);
});

test('the seed spans the real range, from blue chip to trap', () => {
  const list = loadSeed().opportunities;
  const medians = peerMedians(list);
  const verdicts = list.map((o) => ({ o, t: detectTraps(o, { peerMedian: medians[o.assetClass] }) }));

  const traps = verdicts.filter((v) => v.t.verdict === 'likely_trap');
  assert.ok(traps.length >= 3, 'seed must contain farms the trap detector catches');
  assert.ok(traps.every((v) => v.o.apy.total > 40));

  const aave = byName(list, 'USDC on Aave V3 (Ethereum)');
  assert.ok(aave.apy.total >= 3 && aave.apy.total <= 10);
  assert.equal(verdicts.find((v) => v.o === aave).t.flags.includes(C.TRAP_FLAGS.REWARD_DOMINANT), false);

  const lido = byName(list, 'STETH on Lido');
  assert.ok(lido.apy.total > 1 && lido.apy.total < 6);
  assert.equal(lido.assetClass, C.ASSET_CLASS.CRYPTO_STAKING);

  // All three DeFi shapes are represented.
  const classes = new Set(list.map((o) => o.assetClass));
  assert.equal(classes.has(C.ASSET_CLASS.CRYPTO_LENDING), true);
  assert.equal(classes.has(C.ASSET_CLASS.CRYPTO_STAKING), true);
  assert.equal(classes.has(C.ASSET_CLASS.CRYPTO_LP), true);
});

// --- live path (stubbed transport; the sandbox cannot reach llama.fi) --------

function stubCtx({ pools = POOLS, protocols = PROTOCOLS, protocolsFail = false } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      schema, C, now: NOW, settings: {}, signal: null, log() {},
      http: {
        async getJSON(url) {
          calls.push(url);
          if (url.includes('yields.llama.fi')) {
            if (pools instanceof Error) throw pools;
            return pools;
          }
          if (protocolsFail) throw Object.assign(new Error('HTTP 403'), { status: 403 });
          return protocols;
        },
      },
    },
  };
}

test('fetch() joins both endpoints and returns normalized rows', async () => {
  const { ctx, calls } = stubCtx();
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.opportunities.length, 11);
  assert.equal(calls.length, 2);
  assert.equal(byName(r.opportunities, 'USDC on AAVE V3').risk.auditCount, 3);
  assert.deepEqual(r.opportunities.flatMap((o) => schema.validate(o)), []);
  assert.equal(r.opportunities.every((o) => o.seed === false && o.live === true), true);
});

test('fetch() degrades to partial when protocol enrichment fails', async () => {
  const { ctx } = stubCtx({ protocolsFail: true });
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'partial');
  assert.equal(r.opportunities.length, 11);
  assert.ok(r.warnings.some((w) => /protocol metadata unavailable/i.test(w)));
  assert.ok(r.notes.some((n) => /Protocol metadata skipped/i.test(n)));
  assert.equal(r.opportunities.every((o) => o.risk.auditCount === null), true);
});

test('fetch() reports a dead pools endpoint as a failed source, not an exception', async () => {
  const { ctx } = stubCtx({ pools: Object.assign(new Error('blocked'), { status: 403 }) });
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.opportunities, []);
  assert.ok(r.warnings[0].includes('403'));
});
