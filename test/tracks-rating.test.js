'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const schema = require('../src/core/schema');
const T = require('../src/core/tracks');
const { rate } = require('../src/core/rating');
const cat = require('../src/core/catalyst');
const mv = require('../src/core/movement');
const { scoreAll } = require('../src/core/score');
const { applyQuery } = require('../src/core/filters');

const make = (r) => schema.normalize({ source: 'test', ...r });
const scored = (r, opts = {}) => scoreAll([make(r)], { riskFree: 3.8, appetite: 45, taxProfile: { federalOrdinary: 24, state: 'TX' }, ...opts })[0];

/** A deterministic price series, so setup classification is testable. */
function series(n, driftAnnual, volAnnual, seed) {
  let p = 100; const out = []; let x = seed;
  const r = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  for (let i = 0; i < n; i += 1) { p *= Math.exp(driftAnnual / 252 + (volAnnual / Math.sqrt(252)) * r() * 3.46); out.push(p); }
  return out;
}

/* ------------------------------------------------------------------ tracks */

describe('tracks', () => {
  test('return source decides the track, not the label', () => {
    assert.strictEqual(make({ name: 'x', assetClass: 'govt_bond', apy: { total: 3.8 } }).track, 'income');
    assert.strictEqual(make({ name: 'x', assetClass: 'cash', apy: { total: 4.4 } }).track, 'income');
    // A 0.4% growth ETF's return is not its dividend.
    assert.strictEqual(make({ name: 'x', assetClass: 'etf', apy: { total: 0.4 } }).track, 'movement');
    // A 9% covered-call fund genuinely is both.
    assert.strictEqual(make({ name: 'x', assetClass: 'etf', apy: { total: 9 } }).track, 'both');
    assert.strictEqual(make({ name: 'x', assetClass: 'reit', apy: { total: 5 } }).track, 'both');
    assert.strictEqual(make({ name: 'x', assetClass: 'dividend_equity', apy: { total: 0.02 } }).track, 'movement');
  });

  test('a "both" row appears in either view and is hidden by neither', () => {
    const rows = scoreAll([
      make({ name: 'CD', assetClass: 'cd', apy: { total: 4.2 }, term: { days: 365 }, liquidity: 'locked', risk: { insurance: 'fdic' }, yieldKind: 'contractual' }),
      make({ name: 'REIT', assetClass: 'reit', apy: { total: 5 }, liquidity: 'daily', price: 40 }),
      make({ name: 'Growth', assetClass: 'etf', apy: { total: 0.3 }, liquidity: 'daily', price: 500 }),
    ], { riskFree: 3.8 });
    const names = (q) => applyQuery(rows, q).map((o) => o.name).sort();
    assert.deepStrictEqual(names({ track: 'income' }), ['CD', 'REIT']);
    assert.deepStrictEqual(names({ track: 'movement' }), ['Growth', 'REIT']);
    assert.deepStrictEqual(names({ track: 'all' }), ['CD', 'Growth', 'REIT']);
  });

  test('grades run monotonically from guaranteed to total loss', () => {
    const keys = [0, 5, 12, 25, 40, 55, 75, 95].map((s) => T.grade(s).key);
    assert.deepStrictEqual(keys, ['A+', 'A+', 'A', 'B', 'C', 'D', 'E', 'F']);
    // Monotonic: a higher risk score can never earn a better grade.
    const order = T.GRADE.map((g) => g.key);
    let prev = -1;
    for (let s = 0; s <= 100; s += 1) {
      const i = order.indexOf(T.grade(s).key);
      assert.ok(i >= prev, `grade went backwards at risk ${s}`);
      prev = i;
    }
    for (const g of T.GRADE) {
      assert.ok(g.headline && g.detail, `${g.key} needs a plain-language explanation`);
    }
  });
});

/* ------------------------------------------------------------------ rating */

describe('rating', () => {
  test('a guaranteed instrument grades A+ with a full principal axis', () => {
    const o = scored({ name: 'T-bill', assetClass: 'govt_bond', subType: 'bill', apy: { total: 3.8 }, term: { days: 91 }, liquidity: 'daily', risk: { insurance: 'us_gov' }, yieldKind: 'market', taxTreatment: 'treasury' });
    const r = rate(o);
    assert.strictEqual(r.grade, 'A+');
    assert.strictEqual(r.axes.principal.value, 5);
    assert.match(r.axes.principal.why, /government/i);
  });

  test('an equity fund cannot read 5/5 principal just because its tail is thin', () => {
    // The bug this guards: a diversified fund almost never goes to zero, but
    // losing 35% is still losing principal.
    const o = scored({ name: 'SCHD', assetClass: 'etf', apy: { total: 3.7 }, liquidity: 'daily', risk: { volatility: 15, maxDrawdown: 34 }, yieldKind: 'trailing' });
    const r = rate(o);
    assert.ok(r.axes.principal.value <= 3.5, `expected a capped principal axis, got ${r.axes.principal.value}`);
    assert.match(r.axes.principal.why, /bad year/i);
  });

  test('a bad-year estimate uses the lognormal form, not a linear multiple', () => {
    // 52% vol implies about -58%, not -86%.
    const o = scored({ name: 'Vol', assetClass: 'dividend_equity', apy: { total: 0.1 }, liquidity: 'daily', risk: { volatility: 52 }, yieldKind: 'trailing' });
    const why = rate(o).axes.principal.why;
    const m = why.match(/-(\d+)%/);
    assert.ok(m, `expected a bad-year figure in "${why}"`);
    assert.ok(Number(m[1]) >= 50 && Number(m[1]) <= 65, `implausible bad-year figure ${m[1]}%`);
  });

  test('the payout axis does not apply to a pure movement row', () => {
    const o = scored({ name: 'Growth', assetClass: 'etf', apy: { total: 0.2 }, liquidity: 'daily', risk: { volatility: 18 } });
    assert.strictEqual(o.track, 'movement');
    assert.strictEqual(rate(o).axes.payout.value, null);
    assert.strictEqual(rate(o).axes.payout.na, true);
  });

  test('a locked CD scores low on exit and says why, in years', () => {
    const o = scored({ name: 'CD', assetClass: 'cd', apy: { total: 4.2 }, term: { days: 1826, earlyExitPenalty: '180 days interest' }, liquidity: 'locked', risk: { insurance: 'fdic' }, yieldKind: 'contractual' });
    const r = rate(o);
    assert.ok(r.axes.exit.value <= 1.5);
    assert.match(r.axes.exit.why, /Locked for 5 years/);
    assert.match(r.axes.exit.why, /180 days interest/);
  });

  test('emissions-funded yield drops the payout axis and explains itself', () => {
    const o = scored({ name: 'Farm', assetClass: 'crypto_lp', apy: { base: 3, reward: 237, mean30d: 40 }, tvl: 180000, ilRisk: 'yes', liquidity: 'instant', risk: { ageDays: 9, auditCount: 0 } });
    const r = rate(o);
    assert.strictEqual(r.grade, 'F');
    assert.ok(r.axes.payout.value <= 1);
    assert.match(r.axes.payout.why, /emissions/i);
  });

  test('the weakest axis is only surfaced when something is actually weak', () => {
    const safe = rate(scored({ name: 'T-bill', assetClass: 'govt_bond', subType: 'bill', apy: { total: 3.8 }, term: { days: 91 }, liquidity: 'daily', risk: { insurance: 'us_gov' }, yieldKind: 'market' }));
    assert.strictEqual(safe.weakestAxis, null, 'nothing weak means nothing to warn about');
    const risky = rate(scored({ name: 'Farm', assetClass: 'crypto_lp', apy: { base: 1, reward: 90 }, tvl: 2e5, liquidity: 'instant', risk: { ageDays: 5, auditCount: 0 } }));
    assert.ok(risky.weakestAxis, 'a genuinely weak axis must be surfaced');
  });
});

/* ---------------------------------------------------------------- catalyst */

describe('catalyst', () => {
  const now = Date.UTC(2026, 7, 27);

  test('expected move scales with the square root of time', () => {
    const a = cat.expectedMove(30, 30);
    const b = cat.expectedMove(30, 120);
    assert.ok(Math.abs(b.typical / a.typical - 2) < 0.05, 'four times the days is twice the move');
    assert.ok(b.outer > b.typical, 'the outer band must be wider than the typical one');
  });

  test('an event is a one-day jump, not a scaled horizon', () => {
    // The bug this guards: multiplying the whole horizon claimed a 45%-vol stock
    // moves 18% into earnings, when the real figure is nearer 8%.
    const e = cat.makeEvent({ kind: 'earnings', date: new Date(now + 6 * 86400000).toISOString() }, now);
    const d = cat.describeCatalyst(e, 45);
    assert.ok(d.move.typical > 5 && d.move.typical < 11, `implausible earnings move ${d.move.typical}%`);
    assert.ok(d.move.eventJump > 0 && d.move.eventJump < d.move.typical);
    // With no event the same window is smaller.
    assert.ok(cat.expectedMove(45, 6).typical < d.move.typical);
  });

  test('the biggest impact wins over mere proximity', () => {
    const evs = [
      cat.makeEvent({ kind: 'ex_dividend', date: new Date(now + 1 * 86400000).toISOString() }, now),
      cat.makeEvent({ kind: 'earnings', date: new Date(now + 9 * 86400000).toISOString() }, now),
    ];
    assert.strictEqual(cat.nextCatalyst(evs, { now }).kind, 'earnings');
  });

  test('an estimated date is weighted below a confirmed one', () => {
    const conf = cat.makeEvent({ kind: 'earnings', date: new Date(now + 10 * 86400000).toISOString(), certainty: 'confirmed' }, now);
    const est = cat.makeEvent({ kind: 'earnings', date: new Date(now + 9 * 86400000).toISOString(), certainty: 'estimated' }, now);
    assert.strictEqual(cat.nextCatalyst([conf, est], { now }).certainty, 'confirmed');
  });

  test('rubbish in gives null out, never a throw', () => {
    for (const bad of [null, undefined, {}, { kind: 'nope', date: '2026-01-01' }, { kind: 'earnings', date: 'not a date' }, { kind: 'earnings', date: 8.7e15 }]) {
      assert.doesNotThrow(() => cat.makeEvent(bad, now));
    }
    assert.strictEqual(cat.makeEvent({ kind: 'earnings', date: 'nonsense' }, now), null);
    assert.strictEqual(cat.expectedMove(null, 30), null);
    assert.strictEqual(cat.expectedMove(30, null), null);
  });

  test('past and future are separated correctly', () => {
    const past = cat.makeEvent({ kind: 'filing_8k', date: new Date(now - 3 * 86400000).toISOString() }, now);
    const future = cat.makeEvent({ kind: 'fomc', date: new Date(now + 12 * 86400000).toISOString() }, now);
    assert.strictEqual(past.past, true);
    assert.strictEqual(future.past, false);
    assert.deepStrictEqual(cat.recentEvents([past, future], { now }).map((e) => e.kind), ['filing_8k']);
    assert.strictEqual(cat.nextCatalyst([past, future], { now }).kind, 'fomc');
  });
});

/* ---------------------------------------------------------------- movement */

describe('movement', () => {
  test('series statistics are computed correctly', () => {
    const flat = new Array(250).fill(100);
    assert.ok(mv.annualisedVol(flat) < 0.001, 'a flat series has no volatility');
    const up = series(250, 0.5, 0.2, 3);
    assert.ok(mv.trendSlope(up) > 0, 'an uptrend must slope up');
    assert.ok(mv.rangePosition(up) > 0.5);
    const dd = mv.drawdownFromHigh([100, 120, 150, 90]);
    assert.ok(Math.abs(dd - 40) < 0.01, `expected 40% drawdown, got ${dd}`);
  });

  test('a compressed series is read as coiled', () => {
    const coiled = [...series(200, 0.05, 0.35, 7), ...series(30, 0, 0.08, 11)];
    const stats = mv.analyse(coiled, coiled.map(() => 1e6));
    assert.ok(stats.regime.ratio < 0.7, 'the regime ratio should show compression');
    assert.strictEqual(mv.classifySetup(stats).key, 'coiled');
  });

  test('a quiet bond-like series is not called coiled or breaking out', () => {
    const quiet = series(250, 0.04, 0.06, 5);
    const setup = mv.classifySetup(mv.analyse(quiet, quiet.map(() => 1e6)));
    assert.ok(['range_bound', 'grinding_up', 'grinding_down'].includes(setup.key), `got ${setup.key}`);
  });

  test('no price history means no read, not a read of "nothing happening"', () => {
    const bare = make({ name: 'Bond ETF', symbol: 'IGSB', assetClass: 'corp_bond', apy: { total: 4.3 }, liquidity: 'daily' });
    const r = mv.readMovement(bare, { events: [] });
    assert.strictEqual(r.unmeasured, true);
    assert.strictEqual(r.heat, null, 'heat must be null, not 0 — zero is a claim');
    assert.strictEqual(r.setup, null);
    assert.deepStrictEqual(r.heatParts, []);
  });

  test('direction lean defaults to none and stays weak', () => {
    const flat = series(250, 0.0, 0.2, 13);
    const lean = mv.directionalLean(mv.analyse(flat, flat.map(() => 1e6)), []);
    assert.strictEqual(lean.lean, 'none');
    // Even a strong uptrend must not produce near-certainty.
    const up = series(250, 0.9, 0.25, 17);
    const strong = mv.directionalLean(mv.analyse(up, up.map(() => 1e6)), []);
    assert.ok(strong.strength <= 1);
    if (strong.lean !== 'none') assert.ok(strong.reasons.length, 'a lean must explain itself');
  });

  test('a token unlock leans down, because it is new supply', () => {
    const flat = series(250, 0, 0.5, 19);
    const stats = mv.analyse(flat, flat.map(() => 1e6));
    const unlock = cat.makeEvent({ kind: 'token_unlock', date: new Date(Date.now() + 5 * 86400000).toISOString() });
    const lean = mv.directionalLean(stats, [unlock]);
    if (lean.lean !== 'none') assert.strictEqual(lean.lean, 'down');
  });

  test('a near catalyst raises heat and explains every point of it', () => {
    const cl = series(250, 0.1, 0.4, 23);
    const o = make({ name: 'X', symbol: 'X', assetClass: 'dividend_equity', apy: { total: 0.5 }, liquidity: 'daily', movementStats: mv.analyse(cl, cl.map(() => 2e6)) });
    const quiet = mv.readMovement(o, { events: [] });
    const hot = mv.readMovement(o, { events: [cat.makeEvent({ kind: 'earnings', date: new Date(Date.now() + 4 * 86400000).toISOString(), symbol: 'X' })] });
    assert.ok(hot.heat > quiet.heat, 'an imminent catalyst must raise heat');
    assert.ok(hot.heatParts.length, 'heat must be attributable');
    for (const p of hot.heatParts) assert.ok(p.label && Number.isFinite(p.points));
    assert.ok(hot.heat <= 100);
  });

  test('clarity never claims certainty and never describes direction', () => {
    const cl = series(250, 0.1, 0.4, 29);
    const o = make({ name: 'X', symbol: 'X', assetClass: 'dividend_equity', liquidity: 'daily', apy: { total: 0.4 }, movementStats: mv.analyse(cl, cl.map(() => 2e6)) });
    const r = mv.readMovement(o, { events: [cat.makeEvent({ kind: 'earnings', date: new Date(Date.now() + 3 * 86400000).toISOString(), symbol: 'X' })] });
    assert.ok(r.clarity <= 0.85, 'clarity is capped below certainty');
    assert.ok(['murky', 'faint', 'clear', 'sharp'].includes(r.clarityTier));
    assert.ok(!/conviction|certain|confident/i.test(r.clarityText || ''), 'clarity must not imply a directional call');
  });

  test('degenerate series degrade instead of throwing', () => {
    for (const bad of [null, undefined, [], [1], [NaN, NaN], [0, 0, 0], ['a', 'b'], [1, -1, 2]]) {
      assert.doesNotThrow(() => mv.analyse(bad, bad), `analyse(${JSON.stringify(bad)}) threw`);
      assert.doesNotThrow(() => mv.classifySetup(mv.analyse(bad, bad)));
    }
  });
});
