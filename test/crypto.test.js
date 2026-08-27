'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/sources/crypto');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const T = require('../src/core/tracks');
const movement = require('../src/core/movement');

const MARKETS = require('./fixtures/coingecko-markets.json');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const NOW = Date.parse('2026-08-27T12:00:00Z');

const clone = (v) => JSON.parse(JSON.stringify(v));
const parse = (payload, opts = {}) => adapter.parseMarkets(payload, { schema, C, now: NOW, ...opts });
const bySym = (list, sym) => list.find((o) => o.symbol === sym);

const seed = () => adapter.loadSeed({
  seedDir: SEED_DIR, schema, C, settings: {}, now: NOW, log() {},
});

// ---------------------------------------------------------------- contract --

test('satisfies the source adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'crypto');
  assert.equal(adapter.label, 'Crypto Assets');
  assert.equal(adapter.requiresKey, false);
  // The free tier tolerates a handful of calls a minute; anything under a few
  // minutes of TTL turns a refresh button into a rate-limit.
  assert.ok(adapter.ttlMs >= 5 * 60 * 1000 && adapter.ttlMs <= 10 * 60 * 1000);
});

test('the live URL asks for one bulk page with the sparkline attached', () => {
  const url = adapter.marketsUrl(1, 250);
  assert.ok(url.startsWith('https://api.coingecko.com/api/v3/coins/markets?'));
  assert.ok(url.includes('per_page=250'), 'must pull the maximum page size, not loop per symbol');
  assert.ok(url.includes('sparkline=true'), 'the price series is the whole reason for this endpoint');
  assert.ok(url.includes('vs_currency=usd'));
  assert.ok(/price_change_percentage=1h%2C24h%2C7d%2C30d%2C200d%2C1y/.test(url));
});

// ------------------------------------------------------------------ parser --

test('parses the fixture, keeping only tradeable assets', () => {
  const r = parse(MARKETS);
  assert.equal(r.opportunities.length, 12);
  assert.deepEqual(r.dropped, {
    unparseable: 4,     // a null, a string, an array, an object with no id
    duplicate: 1,       // the same asset arriving twice across pages
    noPrice: 1,
    thinVolume: 1,
    noVolatility: 1,
  });
  assert.ok(r.notes.some((n) => /under \$200,000 of 24h volume/.test(n)));
  assert.ok(r.notes.some((n) => /duplicated across pages/.test(n)));
});

test('every parsed opportunity passes schema validation and stays on the movement track', () => {
  const r = parse(MARKETS);
  const bad = r.opportunities.map((o) => [o.id, schema.validate(o)]).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);
  for (const o of r.opportunities) {
    assert.equal(o.source, 'crypto');
    assert.equal(o.track, T.TRACK.MOVEMENT);
    assert.equal(o.yieldKind, C.YIELD_KIND.EXPECTED);
    assert.equal(o.risk.insurance, C.INSURANCE.NONE);
    assert.equal(o.risk.principalAtRisk, true);
    assert.equal(o.taxTreatment, C.TAX_TREATMENT.CAPITAL_GAIN_LONG);
    assert.ok(o.accessNotes && o.accessNotes.length > 40);
    assert.ok(o.url.startsWith('https://www.coingecko.com/en/coins/'));
  }
});

test('no row claims a yield, because none of these pay one', () => {
  const r = parse(MARKETS);
  for (const o of r.opportunities) {
    assert.equal(o.apy.total, null, `${o.symbol} must not carry an APY`);
    assert.equal(o.apy.base, null);
    assert.equal(o.apy.reward, null);
    // Price appreciation must never leak into the yield column by any route.
    assert.equal(o.apy.forward, null);
    assert.equal(o.apy.mean30d, null);
  }
  assert.ok(r.notes.some((n) => /pays nothing/.test(n)));
});

test('the headline number is a zero-centred band, not a forecast', () => {
  const btc = bySym(parse(MARKETS).opportunities, 'BTC');
  assert.equal(btc.expected.annualReturn, 0);
  assert.equal(btc.expected.p50, 0);
  assert.equal(btc.expected.probabilityOfLoss, 0.5);
  assert.ok(btc.expected.p10 < 0 && btc.expected.p90 > 0);
  // Symmetric in log space: a 40% fall and its mirror rise are the same move.
  const down = Math.log(1 + btc.expected.p10 / 100);
  const up = Math.log(1 + btc.expected.p90 / 100);
  assert.ok(Math.abs(down + up) < 0.02, 'band must be symmetric in log space');
  assert.ok(btc.expected.basis.some((b) => /No drift assumed/.test(b)));
  assert.ok(btc.expected.basis.some((b) => /not a finding that the odds are even/.test(b)));
});

test('a wider asset gets a wider band, and nothing else changes', () => {
  const list = parse(MARKETS).opportunities;
  const btc = bySym(list, 'BTC');
  const ape = bySym(list, 'APE');
  assert.ok(ape.risk.volatility > btc.risk.volatility);
  assert.ok(ape.expected.p10 < btc.expected.p10);
  assert.ok(ape.expected.p90 > btc.expected.p90);
  assert.equal(ape.expected.annualReturn, btc.expected.annualReturn);
});

// -------------------------------------------------------------- volatility --

test('hourly bars are annualised by sqrt(24*365), not sqrt(252)', () => {
  // A flat 1% hourly move, alternating, has a known standard deviation.
  const px = [];
  let p = 100;
  for (let i = 0; i < 200; i += 1) { p *= i % 2 === 0 ? 1.01 : 1 / 1.01; px.push(p); }
  const v = adapter.annualisedVolHourly(px);
  // sd of log returns is ~0.00995; annualised over 8,760 hours that is ~93%.
  assert.ok(v > 85 && v < 100, `expected ~93%, got ${v}`);
  // The equity convention would land near 16%, which is the bug this guards.
  assert.ok(v / Math.sqrt(24 * 365) * Math.sqrt(252) < 20);
});

test('volatility needs enough bars, and rejects junk series', () => {
  assert.equal(adapter.annualisedVolHourly([1, 2, 3]), null);
  assert.equal(adapter.annualisedVolHourly(null), null);
  assert.equal(adapter.annualisedVolHourly('nope'), null);
  assert.equal(adapter.annualisedVolHourly(new Array(200).fill(100)), null, 'a dead flat series has no volatility');
  // Nulls, zeroes and negatives are stripped rather than poisoning the maths.
  const dirty = new Array(200).fill(0).map((_, i) => (i % 7 === 0 ? null : 100 + Math.sin(i) * 3));
  assert.ok(Number.isFinite(adapter.annualisedVolHourly(dirty)));
});

test('the Parkinson fallback estimates from a 24h range and refuses nonsense', () => {
  const v = adapter.parkinsonVol(103, 100);
  assert.ok(v > 30 && v < 45, `expected ~34%, got ${v}`);
  assert.equal(adapter.parkinsonVol(100, 100), null);   // no range, no estimate
  assert.equal(adapter.parkinsonVol(90, 100), null);    // high below low
  assert.equal(adapter.parkinsonVol(100, 0), null);
  assert.equal(adapter.parkinsonVol(null, 100), null);
});

test('an asset with no series still gets a row, marked as range-estimated', () => {
  const ar = bySym(parse(MARKETS).opportunities, 'AR');
  assert.equal(ar.movementStats.volBasis, 'range-24h');
  assert.equal(ar.movementStats.bars, 1, 'one day of range is one day of history');
  assert.equal(ar.movementStats.regime, null, 'one observation cannot describe a regime');
  assert.ok(/one day/.test(ar.notes) || /high-low range/.test(ar.notes));
});

test('a renamed sparkline field degrades the row instead of killing the source', () => {
  const hnt = bySym(parse(MARKETS).opportunities, 'HNT');
  assert.ok(hnt, 'the row must survive');
  assert.equal(hnt.movementStats.volBasis, 'range-24h');
});

test('an asset with neither a series nor a range is dropped, not faked', () => {
  const r = parse(MARKETS);
  assert.equal(bySym(r.opportunities, 'UNM'), undefined);
  assert.equal(r.dropped.noVolatility, 1);
  assert.ok(r.notes.some((n) => /no honest range could be drawn/.test(n)));
});

test('an absurd volatility is capped rather than printed', () => {
  const bonk = bySym(parse(MARKETS).opportunities, 'BONK');
  assert.ok(bonk.risk.volatility > 250, 'the measured figure is reported as measured');
  assert.ok(bonk.expected.basis.some((b) => /the band is drawn at 250%/.test(b)));
  assert.ok(bonk.expected.p10 > -100, 'you cannot lose more than everything');
});

// ------------------------------------------------------- movement plumbing --

test('movementStats land in the exact shape the movement engine reads', () => {
  const btc = bySym(parse(MARKETS).opportunities, 'BTC');
  const s = btc.movementStats;
  assert.ok(Number.isFinite(s.vol));
  assert.ok(Number.isFinite(s.regime.ratio) && s.regime.ratio > 0);
  assert.ok(Number.isFinite(s.drawdown) && s.drawdown >= 0);
  assert.ok(Number.isFinite(s.trend));
  assert.equal(s.lastClose, 118420);
  assert.equal(s.bars, 7, '168 hourly points are seven days of history, not 168');
  // Deliberately absent: the movement engine labels these with claims a
  // seven-day window cannot support.
  assert.equal(s.rangePos, null);
  assert.equal(s.volumeRatio, null);
  const read = movement.readMovement(btc, { events: [], now: NOW });
  assert.ok(Number.isFinite(read.heat));
  assert.ok(read.setup);
  assert.ok(!/12-month/.test(JSON.stringify(read.heatParts)), 'never claim a 12-month range read');
});

test('the setup classifier reads compression and expansion off the 7-day window', () => {
  const list = parse(MARKETS).opportunities;
  assert.equal(movement.classifySetup(bySym(list, 'LINK').movementStats).key, T.SETUP.COILED);
  assert.equal(movement.classifySetup(bySym(list, 'TIA').movementStats).key, T.SETUP.EXPANDING);
  assert.equal(movement.classifySetup(bySym(list, 'APE').movementStats).key, T.SETUP.DEEP_DRAWDOWN);
});

test('a coiled asset outranks a placid one on heat', () => {
  const list = parse(MARKETS).opportunities;
  const link = movement.readMovement(bySym(list, 'LINK'), { now: NOW });
  const btc = movement.readMovement(bySym(list, 'BTC'), { now: NOW });
  assert.ok(link.heat > btc.heat);
  assert.ok(link.heatParts.some((p) => /quieter than its own normal/.test(p.label)));
});

test('drawdown comes off the all-time high and its sign is flipped', () => {
  const link = bySym(parse(MARKETS).opportunities, 'LINK');
  // Fixture: price 21.48 against an ATH of 52.7, so about 59% below.
  assert.ok(Math.abs(link.movementStats.drawdown - 59.2) < 0.5);
  assert.equal(link.risk.maxDrawdown, link.movementStats.drawdown);
  assert.ok(/ALL-TIME high/.test(link.notes));
});

test('a corrupt ath_change_percentage yields no drawdown rather than a wrong one', () => {
  const qnt = bySym(parse(MARKETS).opportunities, 'QNT');
  assert.equal(qnt.movementStats.drawdown, null);
  assert.equal(qnt.risk.maxDrawdown, null);
});

test('no row carries fabricated events', () => {
  const r = parse(MARKETS);
  for (const o of r.opportunities) assert.deepEqual(o.events, []);
  assert.ok(r.notes.some((n) => /No dated events/.test(n)));
});

// ----------------------------------------------------------- classification --

test('known and behaving stablecoins are both flagged and neither is a movement candidate', () => {
  const list = parse(MARKETS).opportunities;
  const usdt = bySym(list, 'USDT');
  const unknown = bySym(list, 'NUSD9');

  assert.equal(usdt.stablecoin, true);
  assert.equal(usdt.denomination, 'stable');
  assert.equal(usdt.subType, 'stablecoin');
  assert.ok(usdt.trapFlags.includes(C.TRAP_FLAGS.DEPEG_EXPOSURE));

  // Never seen this id before; it is recognised by how it behaves.
  assert.equal(unknown.stablecoin, true);
  assert.ok(/Behaving as a pegged asset/.test(unknown.notes));

  for (const o of [usdt, unknown]) {
    // The all-time high of a dollar peg is a thin panic print, not a level.
    assert.equal(o.movementStats.drawdown, null);
    assert.ok(movement.readMovement(o, { now: NOW }).heat < 2, 'a peg must not read as hot');
  }
});

test('reserve-backed pegs are graded on their reserves, market-held pegs are not', () => {
  const r = seed();
  const usdc = bySym(r.opportunities, 'USDC');
  const dai = bySym(r.opportunities, 'DAI');
  assert.equal(usdc.assetClass, C.ASSET_CLASS.RWA);
  assert.equal(dai.assetClass, C.ASSET_CLASS.SPECULATIVE);
  assert.equal(dai.stablecoin, true);
});

test('liquid staking tokens are classed as staking but carry no invented rate', () => {
  const steth = bySym(parse(MARKETS).opportunities, 'STETH');
  assert.equal(steth.assetClass, C.ASSET_CLASS.CRYPTO_STAKING);
  assert.equal(steth.subType, 'liquid_staking');
  assert.equal(steth.apy.total, null, 'the staking rate is not in this feed and must not be guessed');
  assert.equal(steth.track, T.TRACK.MOVEMENT);
  assert.ok(/does not include them/.test(steth.notes));
});

test('spot holdings are spot, and price is not mistaken for a minimum investment', () => {
  const btc = bySym(parse(MARKETS).opportunities, 'BTC');
  assert.equal(btc.assetClass, C.ASSET_CLASS.SPECULATIVE);
  assert.equal(btc.subType, 'spot');
  assert.equal(btc.denomination, 'crypto');
  assert.equal(btc.price, 118420);
  assert.equal(btc.minInvestment, null, 'you can buy a fraction of a bitcoin');
  assert.ok(/[Ff]ractional/.test(btc.accessNotes));
});

test('liquidity tiers track depth, and confidence tracks rank and volume', () => {
  assert.equal(adapter.liquidityFor(4e8, C), C.LIQUIDITY.INSTANT);
  assert.equal(adapter.liquidityFor(2e7, C), C.LIQUIDITY.DAILY);
  assert.equal(adapter.liquidityFor(2e6, C), C.LIQUIDITY.SETTLED);
  assert.equal(adapter.liquidityFor(3e5, C), C.LIQUIDITY.ILLIQUID);

  const big = adapter.assetConfidence({ rank: 1, volume: 4e10, marketCap: 2e12, volBasis: 'sparkline-7d-hourly' });
  const small = adapter.assetConfidence({ rank: 800, volume: 4e5, marketCap: 2e7, volBasis: 'sparkline-7d-hourly' });
  assert.ok(big > small + 0.2, 'a rank-800 token on $400k a day is not the same datapoint as bitcoin');
  assert.ok(big <= 0.72, 'a seven-day volatility window never earns top confidence');
  // Volume many times the market cap is a wash-trading signature.
  const washed = adapter.assetConfidence({ rank: 300, volume: 1e9, marketCap: 1e8, volBasis: 'sparkline-7d-hourly' });
  const normal = adapter.assetConfidence({ rank: 300, volume: 1e9, marketCap: 1e11, volBasis: 'sparkline-7d-hourly' });
  assert.ok(washed < normal);
});

// -------------------------------------------------------------- corruption --

test('a completely wrong payload degrades rather than throws', () => {
  for (const junk of [null, undefined, 42, 'string', {}, { data: 'nope' }, true]) {
    const r = parse(junk);
    assert.deepEqual(r.opportunities, []);
    assert.ok(r.warnings.length, `no warning for ${JSON.stringify(junk)}`);
  }
  // CoinGecko reports rate limits in the body, not only in the status line.
  const limited = parse({ status: { error_code: 429, error_message: 'Throttled' } });
  assert.ok(limited.warnings.some((w) => /Throttled/.test(w)));
});

test('every single field can be renamed or nulled without taking the source down', () => {
  const fields = Object.keys(MARKETS[0]);
  for (const f of fields) {
    const broken = clone(MARKETS).map((rec) => {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
      const copy = { ...rec };
      delete copy[f];
      return copy;
    });
    const r = parse(broken);
    assert.ok(Array.isArray(r.opportunities), `dropping ${f} broke the parser`);
    const bad = r.opportunities.map((o) => schema.validate(o)).filter((p) => p.length);
    assert.deepEqual(bad, [], `dropping ${f} produced an invalid row`);
  }
});

test('poisoned values in every field are survivable', () => {
  const poisons = [null, undefined, NaN, Infinity, -Infinity, 0, -1, 1e308, '', 'abc', {}, [], true];
  const fields = Object.keys(MARKETS[0]);
  for (const f of fields) {
    for (const p of poisons) {
      const broken = clone(MARKETS).map((rec) => (
        rec && typeof rec === 'object' && !Array.isArray(rec) ? { ...rec, [f]: p } : rec
      ));
      let r;
      assert.doesNotThrow(() => { r = parse(broken); }, `${f} = ${String(p)} threw`);
      const bad = r.opportunities.map((o) => schema.validate(o)).filter((x) => x.length);
      assert.deepEqual(bad, [], `${f} = ${String(p)} produced an invalid row`);
    }
  }
});

test('out-of-range timestamps never reach toISOString', () => {
  // A RangeError out of new Date(...).toISOString() has taken down adapters here
  // before; every date on the way in is bounds-checked.
  const stamps = [0, -1, 8.64e15 + 1, -8.64e15 - 1, 1e300, '0000-00-00', 'not a date', {}, [], NaN, Infinity];
  for (const s of stamps) {
    const broken = clone(MARKETS).map((rec) => (
      rec && typeof rec === 'object' && !Array.isArray(rec)
        ? { ...rec, last_updated: s, ath_date: s, atl_date: s }
        : rec
    ));
    let r;
    assert.doesNotThrow(() => { r = parse(broken); }, `last_updated = ${String(s)} threw`);
    for (const o of r.opportunities) {
      assert.ok(Number.isFinite(Date.parse(o.dataAsOf)), `dataAsOf unusable for ${String(s)}`);
    }
  }
});

test('a corrupted sparkline never crashes and never invents a series', () => {
  const shapes = [
    { price: null }, { price: 'nope' }, { price: [] }, { price: [1] },
    { price: [0, 0, 0, 0, 0] }, { price: new Array(168).fill(null) },
    { price: new Array(168).fill(0).map(() => -1) },
    { prices: [1, 2, 3] }, null, 'sparkline', 42,
  ];
  for (const sp of shapes) {
    const broken = clone(MARKETS).map((rec) => (
      rec && typeof rec === 'object' && !Array.isArray(rec) ? { ...rec, sparkline_in_7d: sp } : rec
    ));
    let r;
    assert.doesNotThrow(() => { r = parse(broken); }, `sparkline ${JSON.stringify(sp)} threw`);
    for (const o of r.opportunities) {
      // With no usable series the row must fall back honestly, never claim one.
      if (o.movementStats.volBasis !== 'sparkline-7d-hourly') {
        assert.equal(o.movementStats.regime, null);
        assert.ok(o.movementStats.bars <= 1);
      }
    }
  }
});

test('one poisonous record costs one row, not the source', () => {
  const withBomb = clone(MARKETS);
  const bomb = { ...clone(MARKETS[0]), id: 'bomb', symbol: 'bomb', name: 'Bomb' };
  Object.defineProperty(bomb, 'current_price', { get() { throw new Error('boom'); }, enumerable: true });
  withBomb.splice(3, 0, bomb);
  const r = parse(withBomb);
  assert.equal(r.opportunities.length, 12);
  assert.ok(r.dropped.unparseable >= 5);
});

// --------------------------------------------------------------------- seed --

test('the bundled seed loads, validates and is honestly labelled', () => {
  const r = seed();
  assert.equal(r.status, 'offline');
  assert.ok(r.opportunities.length >= 90, `expected ~90+ assets, got ${r.opportunities.length}`);
  const bad = r.opportunities.map((o) => [o.id, schema.validate(o)]).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);
  for (const o of r.opportunities) {
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.equal(o.apy.total, null);
    assert.ok(o.confidence < 0.6, 'a snapshot is never a quote');
    assert.ok(/bundled approximation/.test(o.notes));
  }
  assert.ok(r.notes[0].includes('2026-08-01'));
  assert.ok(/not quotes/.test(r.notes[0]) || /not quotes/.test(r.notes.join(' ')) || /approximate/.test(r.notes[0]));
});

test('seed assets are real, uniquely identified and internally consistent', () => {
  const r = seed();
  const ids = new Set();
  for (const o of r.opportunities) {
    assert.ok(!ids.has(o.id), `duplicate id ${o.id}`);
    ids.add(o.id);
    assert.ok(o.price > 0);
    assert.ok(o.tvl > 0, `${o.symbol} needs a market cap`);
    assert.ok(o.volume >= 200000, `${o.symbol} would have been filtered out live`);
    assert.ok(o.risk.volatility > 0 && o.risk.volatility < 200);
  }
  // The names people asked for, spot-checked.
  for (const sym of ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
    'POL', 'LTC', 'SHIB', 'TRX', 'UNI', 'ATOM', 'XLM', 'NEAR', 'APT', 'ARB', 'OP', 'INJ',
    'TIA', 'SUI', 'SEI', 'RENDER', 'FIL', 'IMX', 'GRT', 'AAVE', 'MKR', 'LDO', 'CRV']) {
    assert.ok(bySym(r.opportunities, sym), `seed is missing ${sym}`);
  }
});

test('loadSeed never throws, whatever it is handed', () => {
  for (const ctx of [
    {}, { seedDir: '/nope/nowhere' }, { seedDir: SEED_DIR, schema: null },
    { seedDir: null }, { seedDir: SEED_DIR, C: null }, undefined,
  ]) {
    let r;
    assert.doesNotThrow(() => { r = adapter.loadSeed(ctx); });
    assert.ok(Array.isArray(r.opportunities));
    assert.ok(['offline', 'failed'].includes(r.status));
  }
});

// --------------------------------------------------------------- live path --

test('settings are clamped so a bad value cannot hammer a free endpoint', () => {
  assert.deepEqual(adapter.resolveOptions({}), { pages: 4, perPage: 250, minVolumeUsd: 200000 });
  assert.equal(adapter.resolveOptions({ pages: 999 }).pages, 10);
  assert.equal(adapter.resolveOptions({ pages: 0 }).pages, 1);
  assert.equal(adapter.resolveOptions({ pages: -5 }).pages, 1);
  assert.equal(adapter.resolveOptions({ pages: 'lots' }).pages, 4);
  assert.equal(adapter.resolveOptions({ perPage: 5000 }).perPage, 250, 'upstream page size is the ceiling');
  assert.equal(adapter.resolveOptions({ perPage: 100 }).perPage, 100);
  assert.equal(adapter.resolveOptions({ minVolumeUsd: 0 }).minVolumeUsd, 0);
  assert.equal(adapter.resolveOptions({ minVolumeUsd: -1 }).minVolumeUsd, 200000);
  for (const junk of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(adapter.resolveOptions(junk).pages, 4);
  }
});

test('fetch pulls bulk pages and never loops per symbol', async () => {
  const calls = [];
  const page = (n) => new Array(4).fill(0).map((_, i) => ({
    ...clone(MARKETS[0]),
    id: `coin-${n}-${i}`,
    symbol: `c${n}${i}`,
    name: `Coin ${n}-${i}`,
    market_cap_rank: n * 10 + i,
  }));

  const ctx = {
    http: {
      async getJSON(url) { calls.push(url); return page(calls.length); },
    },
    cache: null,
    schema,
    C,
    // perPage 4 so the mocked pages are "full" and paging continues.
    settings: { sources: { crypto: { pages: 2, perPage: 4 } } },
    now: NOW,
    log() {},
  };
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 2, 'two pages, two calls — never one call per asset');
  assert.equal(r.opportunities.length, 8);
  assert.ok(r.notes[0].includes('2 bulk calls'));
  assert.deepEqual(calls.map((u) => /[?&]page=(\d+)/.exec(u)[1]), ['1', '2']);
});

test('fetch stops early when upstream runs out of assets', async () => {
  let calls = 0;
  const ctx = {
    http: {
      async getJSON() {
        calls += 1;
        // A short page means the ranking ended; asking for more is wasted quota.
        return calls === 1 ? [clone(MARKETS[0])] : [];
      },
    },
    schema, C, settings: { sources: { crypto: { pages: 4, perPage: 250 } } }, now: NOW, log() {},
  };
  await adapter.fetch(ctx);
  assert.equal(calls, 1);
});

test('a rate limit mid-run keeps the pages that answered and says so', async () => {
  let calls = 0;
  const ctx = {
    http: {
      async getJSON() {
        calls += 1;
        if (calls === 1) return clone(MARKETS);
        const err = new Error('Too Many Requests');
        err.status = 429;
        throw err;
      },
    },
    // perPage 20 matches the fixture length, so page 1 reads as a full page and
    // the run genuinely goes on to ask for page 2.
    schema, C, settings: { sources: { crypto: { pages: 4, perPage: 20 } } }, now: NOW, log() {},
  };
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'partial');
  assert.equal(r.opportunities.length, 12);
  assert.ok(r.warnings.some((w) => /Too Many Requests/.test(w)));
  assert.equal(calls, 2, 'a 429 stops the run rather than deepening the penalty');
});

test('a totally failed fetch reports failure instead of throwing', async () => {
  const ctx = {
    http: {
      async getJSON() { const e = new Error('blocked'); e.status = 403; throw e; },
    },
    schema, C, settings: {}, now: NOW, log() {},
  };
  const r = await adapter.fetch(ctx);
  assert.equal(r.status, 'failed');
  assert.ok(r.warnings.length);
  assert.deepEqual(r.opportunities, []);
});

test('cached pages cost neither a call nor a pacing delay', async () => {
  const store = new Map();
  let calls = 0;
  const cache = {
    async wrap(key, ttl, producer) {
      if (store.has(key)) return { value: store.get(key), fromCache: true, stale: false, age: 1000 };
      const value = await producer();
      store.set(key, value);
      return { value, fromCache: false, stale: false, age: 0 };
    },
  };
  const ctx = {
    http: { async getJSON() { calls += 1; return [clone(MARKETS[0])]; } },
    cache,
    schema,
    C,
    settings: { sources: { crypto: { pages: 1 } } },
    now: NOW,
    log() {},
  };
  await adapter.fetch(ctx);
  assert.equal(calls, 1);
  const started = Date.now();
  const second = await adapter.fetch(ctx);
  assert.equal(calls, 1, 'the second refresh inside the TTL must hit cache');
  assert.ok(Date.now() - started < 500, 'a cache hit must not pay the pacing delay');
  assert.ok(second.notes[0].includes('served from cache'));
});

test('a live run produces rows the aggregator will actually keep', async () => {
  const ctx = {
    http: { async getJSON() { return clone(MARKETS); } },
    schema, C, settings: { sources: { crypto: { pages: 1 } } }, now: NOW, log() {},
  };
  const r = await adapter.fetch(ctx);
  assert.equal(r.opportunities.length, 12);
  for (const o of r.opportunities) {
    assert.deepEqual(schema.validate(o), []);
    assert.equal(o.seed, false);
    assert.equal(o.live, true);
    assert.ok(Number.isFinite(Date.parse(o.dataAsOf)));
  }
  // Live rows are as-of upstream's own last_updated, not the wall clock...
  assert.equal(bySym(r.opportunities, 'BTC').dataAsOf, '2026-08-27T09:41:12.548Z');
  // ...unless upstream's stamp is unusable, in which case the run clock stands
  // in rather than a RangeError escaping.
  assert.equal(bySym(r.opportunities, 'QNT').dataAsOf, '2026-08-27T12:00:00.000Z');
});

// ------------------------------------------------------------- chart data --

const SNAPSHOT_ROWS = require('./fixtures/coingecko-snapshot-rows.json');
const snapshotRows = () => parse(SNAPSHOT_ROWS, { seed: true, dataAsOf: '2026-08-01' }).opportunities;

test('downsample keeps both ends and never exceeds its budget', () => {
  const long = Array.from({ length: 168 }, (_, i) => 100 + i);
  const out = adapter.downsample(long, 120);
  assert.equal(out.length, 120);
  assert.equal(out[0], 100, 'the first point is where the week started');
  assert.equal(out[out.length - 1], 267, 'the last point is the price now');
  const gaps = out.slice(1).map((v, i) => v - out[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'the spacing must be even');
  for (const n of [2, 7, 60, 119, 168]) assert.equal(adapter.downsample(long, n).length, n);
});

test('a series already inside the budget comes back unchanged', () => {
  const week = [1.1, 1.2, 1.15, 1.3];
  assert.deepEqual(adapter.downsample(week, 120), week);
  assert.deepEqual(adapter.downsample(week, 4), week);
  assert.deepEqual(adapter.downsample([9], 120), [9]);
});

test('holes are dropped before the spacing is computed, not after', () => {
  // Sparklines do come back with holes. If a hole were left in and skipped
  // later, every point after it would land in the wrong place on the axis.
  const clean = Array.from({ length: 168 }, (_, i) => 1 + i / 100);
  const holed = [];
  for (const v of clean) { holed.push(v); if (Math.round(v * 100) % 11 === 0) holed.push(null, NaN, -Infinity, '2'); }
  assert.deepEqual(adapter.downsample(holed, 60), adapter.downsample(clean, 60));
});

test('downsample refuses to invent a chart out of junk', () => {
  for (const junk of [null, undefined, 'sparkline', 42, {}, [], [null], [NaN, Infinity]]) {
    assert.doesNotThrow(() => adapter.downsample(junk, 120));
    assert.deepEqual(adapter.downsample(junk, 120), []);
  }
  assert.deepEqual(adapter.downsample([1, 2, 3], 0), []);
  assert.deepEqual(adapter.downsample([1, 2, 3], -1), []);
  assert.deepEqual(adapter.downsample([1, 2, 3], NaN), []);
  assert.deepEqual(adapter.downsample([1, 2, 3], 1), [3], 'one point holds the latest price');
});

test('a live row charts the same seven days its volatility was measured on', () => {
  const btc = bySym(parse(MARKETS).opportunities, 'BTC');
  const raw = MARKETS.find((r) => r?.id === 'bitcoin').sparkline_in_7d.price;
  assert.equal(raw.length, 168, 'the fixture must carry a full week of hourly prices');
  assert.equal(btc.series.length, adapter.MAX_SERIES_POINTS);
  assert.equal(btc.series[0], raw[0]);
  assert.equal(btc.series[btc.series.length - 1], raw[raw.length - 1]);
  assert.equal(btc.movementStats.volBasis, 'sparkline-7d-hourly');
});

test('a row measured from a 24h range gets no chart, because there is no series', () => {
  const ar = bySym(parse(MARKETS).opportunities, 'AR');
  assert.equal(ar.movementStats.volBasis, 'range-24h');
  assert.equal(ar.series, null, 'one high and one low is not a price path');
});

test('the bundled shape draws the chart and is never measured from', () => {
  const rows = snapshotRows();
  const by = (s) => rows.find((o) => o.symbol === s);

  // Inside the budget: kept exactly, ending on the row's price.
  const link = by('LINK');
  assert.equal(link.series.length, 60);
  assert.equal(link.series[link.series.length - 1], link.price);
  // Crucially: a drawn shape must not buy the row any measurement credit.
  assert.equal(link.movementStats.volBasis, 'snapshot-estimate');
  assert.equal(link.movementStats.bars, 0, 'a drawn chart is not days of history');
  assert.equal(link.movementStats.windowHours, null);
  assert.ok(/bundled approximation/.test(link.notes));

  // Over the budget: thinned, both ends intact.
  const hbar = by('HBAR');
  assert.equal(hbar.series.length, adapter.MAX_SERIES_POINTS);
  assert.equal(hbar.series[hbar.series.length - 1], hbar.price);

  // A live series always wins over the bundled one — except when it carries no
  // usable price at all, which must fall back rather than chart a row of zeroes.
  const sol = by('SOL');
  assert.equal(sol.series.length, adapter.MAX_SERIES_POINTS);
  assert.equal(sol.movementStats.volBasis, 'sparkline-7d-hourly');
  const xlm = by('XLM');
  assert.equal(xlm.series.length, 40);
  assert.ok(xlm.series.every((v) => v > 0));
});

test('a corrupt bundled shape costs the chart, not the row', () => {
  const rows = snapshotRows();
  const doge = rows.find((o) => o.symbol === 'DOGE');
  // Nulls, booleans, objects, arrays, a zero and a negative are all removed. A
  // numeric string survives as the number it obviously is, because upstream has
  // shipped prices as strings before.
  assert.deepEqual(doge.series, [0.209, 0.2104, 0.211, 0.2098, 0.2115, 0.2131, 0.2126, 0.2118, 0.212]);
  const ltc = rows.find((o) => o.symbol === 'LTC');
  assert.equal(ltc.series, null, 'a chart must be absent rather than empty or wrong');
  assert.deepEqual(ltc.movementStats.volBasis, 'snapshot-estimate');
  for (const o of rows) assert.deepEqual(schema.validate(o), []);
});

test('a poisoned bundled shape never throws and never charts nonsense', () => {
  const poisons = [null, undefined, 0, -1, 'x', {}, true, [], [null, null], ['a', 'b'],
    [0, 0, 0], [1e308, -1e308], new Array(500).fill(1.5)];
  for (const p of poisons) {
    const broken = clone(SNAPSHOT_ROWS).map((rec) => ({ ...rec, snapshotSeries: p }));
    let r;
    assert.doesNotThrow(() => { r = parse(broken, { seed: true }); }, `snapshotSeries ${String(p)} threw`);
    for (const o of r.opportunities) {
      assert.deepEqual(schema.validate(o), []);
      if (o.series !== null) {
        assert.ok(o.series.length <= adapter.MAX_SERIES_POINTS);
        assert.ok(o.series.every((v) => Number.isFinite(v) && v > 0), `${o.symbol} charted a non-price`);
      }
    }
  }
});

test('every seed row charts the seven days it says it moved', () => {
  const raw = new Map(require('../data/seed/crypto.json').items.map((i) => [i.id, i]));
  for (const o of seed().opportunities) {
    const s = o.series;
    assert.ok(Array.isArray(s) && s.length >= 40, `${o.symbol} has no chart`);
    assert.ok(s.every((v) => Number.isFinite(v) && v > 0), `${o.symbol} charts a non-price`);
    const item = raw.get(o.id.replace(/^crypto:/, ''));
    assert.ok(item, `${o.id} is not in the seed file`);
    assert.equal(s[s.length - 1], item.current_price, `${o.symbol} chart does not end at its price`);
    // The row's notes state the seven-day move in words; the chart must show it.
    const want = item.price_change_percentage_7d_in_currency || 0;
    const got = (s[s.length - 1] / s[0] - 1) * 100;
    assert.ok(Math.abs(got - want) < 0.5, `${o.symbol} says ${want}% over the week and charts ${got.toFixed(2)}%`);
    // One day's high and low happened inside these seven days.
    if (item.high_24h > item.low_24h) {
      assert.ok(Math.max(...s) >= item.high_24h * 0.999, `${o.symbol} chart never reaches its own 24h high`);
      assert.ok(Math.min(...s) <= item.low_24h * 1.001, `${o.symbol} chart never reaches its own 24h low`);
    }
  }
});

// ------------------------------------------------------------------ reach --

test('reach follows the cap ranking, which is how crypto attention is actually ordered', () => {
  const big = { marketCap: 1e12, volume: 1e10 };
  assert.equal(adapter.classifyReach({ rank: 1, ...big }), 'everyone');
  assert.equal(adapter.classifyReach({ rank: 10, ...big }), 'everyone');
  assert.equal(adapter.classifyReach({ rank: 11, ...big }), 'common');
  assert.equal(adapter.classifyReach({ rank: 50, ...big }), 'common');
  assert.equal(adapter.classifyReach({ rank: 51, ...big }), 'niche');
  assert.equal(adapter.classifyReach({ rank: 250, ...big }), 'niche');
  assert.equal(adapter.classifyReach({ rank: 251, ...big }), 'obscure');
  assert.equal(adapter.classifyReach({ rank: 900, ...big }), 'obscure');
});

test('a missing rank falls back to the cap and the tape rather than to a guess', () => {
  assert.equal(adapter.classifyReach({ marketCap: 8e10, volume: 5e9 }), 'everyone');
  assert.equal(adapter.classifyReach({ marketCap: 8e9, volume: 3e8 }), 'common');
  assert.equal(adapter.classifyReach({ marketCap: 8e8, volume: 2e7 }), 'niche');
  assert.equal(adapter.classifyReach({ marketCap: 2e7, volume: 4e5 }), 'obscure');
  // Nothing to place it by is itself an answer.
  assert.equal(adapter.classifyReach({}), 'obscure');
  assert.equal(adapter.classifyReach(), 'obscure');
  for (const junk of [{ rank: 0 }, { rank: -3 }, { rank: 'x' }, { marketCap: null, volume: null }]) {
    assert.equal(adapter.classifyReach(junk), 'obscure');
  }
});

test('a high rank with no volume behind it is a stale cap, not an audience', () => {
  // The reads are combined by taking the most obscure: nothing about a row can
  // make it MORE widely known than its thinnest signal says.
  assert.equal(adapter.classifyReach({ rank: 5, marketCap: 6e10, volume: 3e6 }), 'obscure');
  assert.equal(adapter.classifyReach({ rank: 5, marketCap: 5e8, volume: 5e9 }), 'niche');
  assert.equal(adapter.classifyReach({ rank: 400, marketCap: 9e11, volume: 9e9 }), 'obscure');
});

test('the seed spans the whole reach scale and places the majors correctly', () => {
  const rows = seed().opportunities;
  const known = new Set(['everyone', 'common', 'niche', 'obscure']);
  const seen = new Set();
  for (const o of rows) {
    assert.ok(known.has(o.reach), `${o.symbol} has reach "${o.reach}"`);
    seen.add(o.reach);
  }
  assert.deepEqual([...known].filter((k) => !seen.has(k)), [], `the snapshot must span the scale: ${[...seen]}`);
  assert.equal(bySym(rows, 'BTC').reach, 'everyone');
  assert.equal(bySym(rows, 'ETH').reach, 'everyone');
  // Far enough down the ranking that only the people on that chain follow it.
  assert.ok(['niche', 'obscure'].includes(bySym(rows, 'INJ').reach));
});

test('a chart states whether it was recorded or drawn', () => {
  // On screen a drawn curve and a recorded price history are the same picture,
  // so the difference has to travel on the row.
  assert.equal(bySym(parse(MARKETS).opportunities, 'BTC').seriesBasis, 'measured');
  assert.equal(bySym(parse(MARKETS).opportunities, 'AR').seriesBasis, null, 'no chart, no claim about one');

  const rows = snapshotRows();
  assert.equal(rows.find((o) => o.symbol === 'SOL').seriesBasis, 'measured', 'a real sparkline is a measurement');
  assert.equal(rows.find((o) => o.symbol === 'LINK').seriesBasis, 'illustrative');
  assert.equal(rows.find((o) => o.symbol === 'LTC').seriesBasis, null);
  for (const o of seed().opportunities) {
    assert.equal(o.seriesBasis, 'illustrative', `${o.symbol} presents a bundled shape as recorded prices`);
  }
});
