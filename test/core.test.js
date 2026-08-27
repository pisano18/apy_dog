'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { scoreRisk, assumedVolatility, modifiedDuration } = require('../src/core/risk');
const { catastrophicRisk, lossAversionWeight } = require('../src/core/tail');
const { applyTax, effectiveRate } = require('../src/core/tax');
const { detectTraps, peerMedians } = require('../src/core/traps');
const { scoreOne, scoreAll, riskAversion } = require('../src/core/score');
const { applyQuery, facets, describeQuery } = require('../src/core/filters');
const { dedupe } = require('../src/core/aggregate');

const make = (r) => schema.normalize({ source: 'test', ...r });

const TBILL = { name: '3mo T-bill', assetClass: 'govt_bond', subType: 'bill', apy: { total: 4.3 }, term: { days: 91 }, liquidity: 'daily', risk: { insurance: 'us_gov' }, yieldKind: 'market', taxTreatment: 'treasury', confidence: 0.98, minInvestment: 100 };
const HYSA = { name: 'HYSA', assetClass: 'cash', apy: { total: 4.6 }, liquidity: 'instant', risk: { insurance: 'fdic', insuredLimit: 250000 }, yieldKind: 'administered', confidence: 0.9 };
const FARM = { name: 'Degen farm', assetClass: 'crypto_lp', apy: { base: 3, reward: 237, mean30d: 40 }, tvl: 180000, ilRisk: 'yes', liquidity: 'instant', risk: { ageDays: 9, auditCount: 0 }, yieldKind: 'variable', confidence: 0.4, chain: 'Base' };
const JEPI = { name: 'JEPI', symbol: 'JEPI', assetClass: 'etf', apy: { total: 7.8 }, liquidity: 'daily', price: 57.2, risk: { volatility: 11 }, yieldKind: 'trailing', taxTreatment: 'mixed', confidence: 0.8 };

/* ------------------------------------------------------------------ schema */

describe('schema', () => {
  test('rate maths', () => {
    // 100% APR compounded daily is 171.5% APY; the difference is not cosmetic.
    assert.ok(Math.abs(schema.aprToApy(100, 365) - 171.457) < 0.01);
    assert.ok(Math.abs(schema.apyToApr(schema.aprToApy(7, 12), 12) - 7) < 1e-9, 'apr->apy->apr round trips');
    // A 91-day bill at a 5% discount rate yields more than 5% on a bond-equivalent basis.
    const bey = schema.discountToApy(5, 91);
    assert.ok(bey > 5 && bey < 5.5, `expected ~5.23, got ${bey}`);
    assert.ok(Math.abs(schema.annualize(1, 91) - 4.06) < 0.05, '1% over 91 days annualises to ~4.06%');
  });

  test('derives total from base plus reward, and base from total minus reward', () => {
    assert.strictEqual(make({ name: 'x', apy: { base: 3, reward: 9 } }).apy.total, 12);
    assert.strictEqual(make({ name: 'x', apy: { total: 12, reward: 9 } }).apy.base, 3);
  });

  test('strips currency and percent formatting from upstream strings', () => {
    const o = make({ name: 'x', apy: { total: '4.25%' }, tvl: '$1,200,000', price: '57.20' });
    assert.strictEqual(o.apy.total, 4.25);
    assert.strictEqual(o.tvl, 1200000);
    assert.strictEqual(o.price, 57.2);
  });

  test('validate rejects nonsense and accepts a well-formed row', () => {
    assert.deepStrictEqual(schema.validate(make(TBILL)), []);
    assert.ok(schema.validate(make({ name: 'x', assetClass: 'not_a_class', apy: { total: 5 } })).length);
    assert.ok(schema.validate(make({ name: 'x' })).some((p) => /headline/.test(p)));
    assert.ok(schema.validate(make({ name: 'x', apy: { total: 1e9 } })).some((p) => /implausible/.test(p)));
  });

  test('ids are deterministic across runs so watchlists survive a refresh', () => {
    assert.strictEqual(make({ key: 'a b/c', name: 'n' }).id, make({ key: 'a b/c', name: 'n' }).id);
  });

  test('infers what the yield is actually paid in', () => {
    assert.strictEqual(make({ name: 'x', assetClass: 'govt_bond' }).denomination, 'usd');
    assert.strictEqual(make({ name: 'x', assetClass: 'crypto_lending', stablecoin: true }).denomination, 'stable');
    assert.strictEqual(make({ name: 'x', assetClass: 'crypto_staking' }).denomination, 'crypto');
  });
});

/* -------------------------------------------------------------------- risk */

describe('risk', () => {
  test('a T-bill is riskless and a degen farm is not', () => {
    assert.ok(scoreRisk(make(TBILL)).score <= 5);
    assert.strictEqual(scoreRisk(make(FARM)).score, 100);
  });

  test('insurance caps the score no matter what the arithmetic says', () => {
    // A hypothetically terrible-looking but FDIC-insured product cannot exceed the cap.
    const wild = make({ name: 'x', assetClass: 'cash', apy: { total: 40 }, risk: { insurance: 'fdic' }, liquidity: 'illiquid' });
    assert.ok(scoreRisk(wild).score <= 10, 'FDIC cap is 10');
  });

  test('every point is attributable to a named factor', () => {
    const r = scoreRisk(make(FARM));
    assert.ok(r.factors.length >= 5);
    for (const f of r.factors) {
      assert.ok(typeof f.label === 'string' && f.label.length > 3);
      assert.ok(Number.isFinite(f.points));
    }
  });

  test('modified duration, not maturity — a 30y bond has ~16y of duration', () => {
    assert.ok(Math.abs(modifiedDuration(30, 0.046) - 16.1) < 0.3);
    assert.ok(Math.abs(modifiedDuration(10, 0.046) - 7.87) < 0.2);
    assert.strictEqual(modifiedDuration(0.25, 0.046), 0.25, 'a bill is a zero');
    assert.strictEqual(modifiedDuration(0, 0.046), 0);
  });

  test('assumed volatility scales with duration, and stablecoins do not inherit crypto vol', () => {
    const bill = assumedVolatility(make({ name: 'x', assetClass: 'govt_bond', apy: { total: 4 }, term: { days: 91 } }));
    const long = assumedVolatility(make({ name: 'x', assetClass: 'govt_bond', apy: { total: 4.6 }, term: { days: 10958 } }));
    assert.ok(bill < 1, `3mo bill vol should be tiny, got ${bill}`);
    assert.ok(long > 12 && long < 20, `30y vol should be ~16, got ${long}`);
    assert.ok(assumedVolatility(make({ name: 'x', assetClass: 'crypto_lending', stablecoin: true })) < 8);
    assert.ok(assumedVolatility(make({ name: 'x', assetClass: 'crypto_lp' })) > 40);
  });

  test('a reported volatility always beats an assumed one', () => {
    const r = scoreRisk(make(JEPI));
    assert.strictEqual(r.volatilityUsed, 11);
    assert.strictEqual(r.volatilityAssumed, false);
  });
});

/* -------------------------------------------------------------------- tail */

describe('tail risk', () => {
  test('guaranteed instruments have an essentially closed tail', () => {
    assert.ok(catastrophicRisk(make(TBILL)).annualProbability < 0.001);
    assert.ok(catastrophicRisk(make(HYSA)).annualProbability < 0.001);
  });

  test('a new, unaudited, thin pool is orders of magnitude riskier than a battle-tested one', () => {
    const blue = catastrophicRisk(make({ name: 'x', assetClass: 'crypto_lending', apy: { total: 6 }, tvl: 1.2e9, stablecoin: true, risk: { ageDays: 2000, auditCount: 5 } }));
    const junk = catastrophicRisk(make({ name: 'x', assetClass: 'crypto_lending', apy: { total: 60 }, tvl: 4e5, stablecoin: true, risk: { ageDays: 10, auditCount: 0 } }));
    assert.ok(junk.annualProbability > blue.annualProbability * 8, `${junk.annualProbability} vs ${blue.annualProbability}`);
    assert.ok(blue.reasons.length >= 3);
  });

  test('a stablecoin paying far over risk-free is charged for the peg risk it is being paid for', () => {
    const base = { name: 'x', assetClass: 'crypto_lending', tvl: 1e9, stablecoin: true, risk: { ageDays: 1000, auditCount: 3 } };
    const calm = make({ ...base, apy: { total: 5 } }); calm.__riskFree = 4;
    const hot = make({ ...base, apy: { total: 25 } }); hot.__riskFree = 4;
    assert.ok(catastrophicRisk(hot).annualProbability > catastrophicRisk(calm).annualProbability);
  });

  test('loss aversion is steep at the cautious end', () => {
    assert.ok(Math.abs(lossAversionWeight(0) - 6) < 0.01);
    assert.strictEqual(lossAversionWeight(100), 1);
    assert.ok(lossAversionWeight(10) > 4, 'a cautious user weights catastrophe several times over');
    assert.ok(lossAversionWeight(10) > lossAversionWeight(50));
  });
});

/* --------------------------------------------------------------------- tax */

describe('tax', () => {
  const CA_TOP = { federalOrdinary: 37, federalLtcg: 20, state: 'CA', niitApplies: true, inflation: 2.6 };
  const TX_MID = { federalOrdinary: 24, state: 'TX', inflation: 2.6 };

  test('Treasuries are exempt from state tax and munis from federal', () => {
    const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);
    close(effectiveRate('treasury', CA_TOP).rate, 37 + 3.8);
    close(effectiveRate('muni_federal_exempt', CA_TOP).rate, 13.3);
    close(effectiveRate('ordinary', CA_TOP).rate, 37 + 13.3 + 3.8);
  });

  test('REIT dividends get the 20 percent Section 199A deduction', () => {
    const r = effectiveRate('section_199a', TX_MID);
    assert.ok(Math.abs(r.rate - 24 * 0.8) < 0.01);
  });

  test('sheltered accounts pay nothing on the growth', () => {
    assert.strictEqual(effectiveRate('ordinary', { ...CA_TOP, accountType: 'roth' }).rate, 0);
    assert.ok(effectiveRate('ordinary', { ...CA_TOP, accountType: 'traditional' }).deferred);
  });

  test('a lower muni beats a higher savings rate for a high earner — the whole point', () => {
    const muni = applyTax(make({ name: 'm', apy: { total: 3.7 }, taxTreatment: 'muni_federal_exempt' }), CA_TOP);
    const hysa = applyTax(make({ name: 'h', apy: { total: 4.6 }, taxTreatment: 'ordinary' }), CA_TOP);
    assert.ok(muni.afterTaxApy > hysa.afterTaxApy, `${muni.afterTaxApy} should beat ${hysa.afterTaxApy}`);
    assert.ok(muni.taxEquivalentYield > 6.5);
    // The ordering only reverses well down the brackets: at 24% federal with no
    // state tax the muni still wins (3.70 vs 3.50). It takes the 12% bracket for
    // the higher headline rate to actually be the better deal.
    const lowBracket = { federalOrdinary: 12, state: 'TX', inflation: 2.6 };
    const muniLow = applyTax(make({ name: 'm', apy: { total: 3.7 }, taxTreatment: 'muni_federal_exempt' }), lowBracket);
    const hysaLow = applyTax(make({ name: 'h', apy: { total: 4.6 }, taxTreatment: 'ordinary' }), lowBracket);
    assert.ok(hysaLow.afterTaxApy > muniLow.afterTaxApy, `${hysaLow.afterTaxApy} should beat ${muniLow.afterTaxApy} at 12%`);
    // And at 24% in Texas the muni is still ahead — worth asserting so nobody
    // "simplifies" the engine into a naive headline comparison later.
    const muniTX = applyTax(make({ name: 'm', apy: { total: 3.7 }, taxTreatment: 'muni_federal_exempt' }), TX_MID);
    const hysaTX = applyTax(make({ name: 'h', apy: { total: 4.6 }, taxTreatment: 'ordinary' }), TX_MID);
    assert.ok(muniTX.afterTaxApy > hysaTX.afterTaxApy);
  });

  test('real yield is multiplicative, not subtractive', () => {
    const r = applyTax(make({ name: 'x', apy: { total: 5 }, taxTreatment: 'ordinary' }), { federalOrdinary: 0, state: 'TX', inflation: 3 });
    assert.ok(Math.abs(r.realApy - ((1.05 / 1.03 - 1) * 100)) < 0.001);
    assert.notStrictEqual(r.realApy, 2, 'must not be a naive 5 - 3');
  });
});

/* ------------------------------------------------------------------- traps */

describe('trap detection', () => {
  test('catches the classic emissions farm on every axis', () => {
    const t = detectTraps(make(FARM), { peerMedian: 6 });
    assert.strictEqual(t.verdict, 'likely_trap');
    for (const f of ['reward_dominant', 'low_tvl', 'brand_new', 'apy_spike', 'impermanent_loss', 'unaudited', 'outlier_vs_peers']) {
      assert.ok(t.flags.includes(f), `expected flag ${f}`);
    }
  });

  test('leaves a genuinely clean blue-chip pool alone', () => {
    const clean = make({ name: 'Aave USDC', assetClass: 'crypto_lending', apy: { base: 6.1, reward: 0, mean30d: 5.8 }, tvl: 1.2e9, stablecoin: true, ilRisk: 'no', risk: { ageDays: 2000, auditCount: 5 } });
    assert.strictEqual(detectTraps(clean, { peerMedian: 6 }).score, 0);
  });

  test('catches deposit-account tricks', () => {
    const teaser = make({ name: 'x', assetClass: 'cash', apy: { total: 6 }, maxInvestment: 10000, requirements: ['5.00% intro rate for the first 3 months'] });
    const t = detectTraps(teaser, {});
    assert.ok(t.flags.includes('teaser_rate'));
    assert.ok(t.flags.includes('capped_balance'));
    assert.strictEqual(t.verdict, 'caution');
  });

  test('catches a fund paying you back your own money', () => {
    const cef = make({ name: 'x', assetClass: 'cef', apy: { total: 14.2 }, rocShare: 0.71, navPremium: 12.4, payoutCoverage: 0.62, risk: { leverage: 1.35 } });
    const t = detectTraps(cef, {});
    assert.ok(t.flags.includes('destructive_roc'));
    assert.ok(t.flags.includes('nav_premium'));
    assert.ok(t.flags.includes('unsustainable_payout'));
  });

  test('flags covered-call funds for selling away the upside', () => {
    // The single most misread product in any yield screen: the distribution is
    // option premium, not income the underlying earned.
    const qyld = make({ name: 'x', assetClass: 'etf', subType: 'covered_call', apy: { total: 12 }, expenseRatio: 0.61 });
    const t = detectTraps(qyld, {});
    assert.ok(t.flags.includes('capped_upside'));
    assert.match(t.detail.find((d) => d.flag === 'capped_upside').message, /upside, sold/);
    // A plain dividend ETF is not flagged for this.
    assert.ok(!detectTraps(make({ name: 'y', assetClass: 'etf', subType: 'dividend_etf', apy: { total: 3.7 } }), {}).flags.includes('capped_upside'));
  });

  test('flags fees that eat a meaningful share of the yield', () => {
    const pricey = make({ name: 'x', assetClass: 'cef', apy: { total: 13.5 }, expenseRatio: 1.9 });
    assert.ok(detectTraps(pricey, {}).flags.includes('high_fees'));
    assert.ok(!detectTraps(make({ name: 'y', assetClass: 'etf', apy: { total: 3.7 }, expenseRatio: 0.06 }), {}).flags.includes('high_fees'));
  });

  test('flags leverage on mortgage REITs and BDCs', () => {
    assert.ok(detectTraps(make({ name: 'x', assetClass: 'reit', apy: { total: 14 }, risk: { leverage: 8 } }), {}).flags.includes('leveraged'));
  });

  test('does not double-report age on bundled snapshot rows', () => {
    const old = { name: 'x', assetClass: 'cash', apy: { total: 4 }, dataAsOf: '2020-01-01' };
    assert.ok(detectTraps(make({ ...old, seed: false }), {}).flags.includes('stale_data'));
    assert.ok(!detectTraps(make({ ...old, seed: true }), {}).flags.includes('stale_data'));
  });

  test('peer medians are computed per asset class', () => {
    const m = peerMedians([make({ name: 'a', assetClass: 'cash', apy: { total: 4 } }), make({ name: 'b', assetClass: 'cash', apy: { total: 6 } }), make({ name: 'c', assetClass: 'crypto_lp', apy: { total: 50 } })]);
    assert.strictEqual(m.cash, 5);
    assert.strictEqual(m.crypto_lp, 50);
  });
});

/* ------------------------------------------------------------------- score */

describe('scoring', () => {
  const opts = { riskFree: 4.0, taxProfile: { federalOrdinary: 24, state: 'TX' }, amount: 10000 };

  test('risk appetite genuinely reorders the same data', () => {
    const list = [TBILL, HYSA, FARM, JEPI].map(make);
    const cautious = scoreAll(list, { ...opts, appetite: 10 }).sort((a, b) => b.scores.dogScore - a.scores.dogScore);
    const aggressive = scoreAll(list, { ...opts, appetite: 95 }).sort((a, b) => b.scores.dogScore - a.scores.dogScore);
    assert.notStrictEqual(cautious[0].name, aggressive[0].name, 'appetite must change the answer');
    assert.ok(['HYSA', '3mo T-bill'].includes(cautious[0].name), `cautious top was ${cautious[0].name}`);
    assert.ok(cautious.findIndex((o) => o.name === 'Degen farm') === cautious.length - 1);
  });

  test('a 240 percent farm never wins on certainty equivalent at a cautious setting', () => {
    const s = scoreOne(make(FARM), { ...opts, appetite: 10 });
    assert.ok(s.certaintyEquivalent < 0, `expected negative CE, got ${s.certaintyEquivalent}`);
    assert.ok(s.trapHaircut < 0.4, 'the claim is heavily discounted before it is used');
  });

  test('a guaranteed instrument held to maturity is not charged full price risk', () => {
    const bond = make({ name: '30y', assetClass: 'govt_bond', apy: { total: 4.6 }, term: { days: 10958 }, liquidity: 'daily', risk: { insurance: 'us_gov' }, yieldKind: 'market', taxTreatment: 'treasury' });
    const patient = scoreOne(bond, { ...opts, appetite: 30, horizonDays: null });
    const impatient = scoreOne(bond, { ...opts, appetite: 30, horizonDays: 180 });
    assert.strictEqual(patient.heldToMaturity, true);
    assert.strictEqual(impatient.heldToMaturity, false);
    assert.ok(impatient.variancePenalty > patient.variancePenalty * 3);
  });

  test('a lockup past the horizon is penalised', () => {
    const cd = make({ name: '5y CD', assetClass: 'cd', apy: { total: 4.5 }, term: { days: 1826 }, liquidity: 'locked', risk: { insurance: 'fdic' }, yieldKind: 'contractual' });
    const s = scoreOne(cd, { ...opts, appetite: 45, horizonDays: 90 });
    assert.ok(s.horizonPenalty > 0);
    assert.match(s.horizonNote, /back in 90d/);
  });

  test('risk aversion is monotonic in appetite', () => {
    assert.ok(riskAversion(0) > riskAversion(50));
    assert.ok(riskAversion(50) > riskAversion(100));
  });

  test('income figures scale with the amount deployed', () => {
    const a = scoreOne(make(HYSA), { ...opts, amount: 10000 });
    const b = scoreOne(make(HYSA), { ...opts, amount: 50000 });
    assert.ok(Math.abs(b.scores?.incomeYear1 ?? b.incomeYear1) - (a.incomeYear1 * 5) < 0.01);
    assert.ok(a.income5yr > a.incomeYear1 * 5, 'five-year figure compounds');
  });
});

/* ----------------------------------------------------------------- filters */

describe('filters', () => {
  const list = scoreAll([TBILL, HYSA, FARM, JEPI,
    { name: 'Upside', assetClass: 'speculative', yieldKind: 'expected', expected: { annualReturn: 14, p10: -38, p90: 71, probabilityOfLoss: 0.42 }, liquidity: 'daily', price: 180 },
  ].map(make), { riskFree: 4, appetite: 45, taxProfile: { federalOrdinary: 24, state: 'TX' } });
  const names = (q) => applyQuery(list, q).map((o) => o.name);

  test('speculative rows are opt-in and never leak into a yield search', () => {
    assert.ok(!names({}).includes('Upside'));
    assert.ok(names({ includeSpeculative: true }).includes('Upside'));
    assert.deepStrictEqual(names({ onlySpeculative: true }), ['Upside']);
  });

  test('likely traps are hidden by default and can be shown', () => {
    assert.ok(!names({}).includes('Degen farm'));
    assert.ok(names({ hideTraps: false }).includes('Degen farm'));
  });

  test('insured-only keeps exactly the guaranteed things', () => {
    assert.deepStrictEqual(names({ insuredOnly: true }).sort(), ['3mo T-bill', 'HYSA']);
  });

  test('price filters apply only to things that have a price', () => {
    assert.deepStrictEqual(names({ priceMin: 50, priceMax: 100 }), ['JEPI']);
    assert.ok(!names({ priceMin: 50, priceMax: 100 }).includes('HYSA'), 'a savings account has no share price');
  });

  test('the entry-ticket filter is separate from share price', () => {
    assert.ok(names({ minInvestmentMax: 150 }).includes('3mo T-bill'), '$100 minimum is affordable');
    assert.ok(!names({ minInvestmentMax: 50 }).includes('3mo T-bill'));
  });

  test('term presets translate to day ranges and exclude open-ended when a floor is set', () => {
    assert.ok(names({ termPreset: 'lt3m' }).includes('3mo T-bill'));
    assert.ok(!names({ termPreset: 'lt3m' }).includes('HYSA'), 'open-ended is excluded by a minimum term');
    assert.ok(names({ termPreset: 'liquid' }).includes('HYSA'));
  });

  test('denomination separates dollar yield from crypto yield', () => {
    assert.ok(!names({ denominations: ['usd'], hideTraps: false }).includes('Degen farm'));
    assert.deepStrictEqual(names({ denominations: ['crypto'], hideTraps: false }), ['Degen farm']);
  });

  test('text search matches across name, category and provider', () => {
    assert.deepStrictEqual(names({ text: 'jepi' }), ['JEPI']);
    assert.ok(names({ text: 'government bonds' }).length >= 1, 'category labels are searchable');
    assert.deepStrictEqual(names({ text: 't-bill' }), ['3mo T-bill']);
    assert.deepStrictEqual(names({ text: 'zzzznope' }), []);
  });

  test('facets count what each option would return', () => {
    const f = facets(list, {});
    assert.strictEqual(f.total, 5);
    assert.strictEqual(f.trapsHidden, 1);
    assert.ok(f.byAssetClass.cash >= 1);
    assert.ok(f.byDenomination.usd >= 2);
  });

  test('describeQuery reads like a sentence', () => {
    const d = describeQuery({ minApy: 5, insuredOnly: true, minInvestmentMax: 500 });
    assert.match(d, /at least 5%/);
    assert.match(d, /insured only/);
    assert.strictEqual(describeQuery({}), 'everything');
  });

  test('sorting respects direction', () => {
    const desc = applyQuery(list, { sortBy: 'apy', hideTraps: false, sortDir: 'desc' });
    const asc = applyQuery(list, { sortBy: 'apy', hideTraps: false, sortDir: 'asc' });
    assert.strictEqual(desc[0].name, 'Degen farm');
    assert.strictEqual(asc[asc.length - 1].name, 'Degen farm');
  });
});

/* --------------------------------------------------------------- aggregate */

describe('dedupe', () => {
  test('the same ticker from two sources is merged, keeping the more confident row', () => {
    const a = make({ ...JEPI, source: 'funds', confidence: 0.9, seed: false });
    const b = make({ ...JEPI, source: 'bonds', confidence: 0.5, seed: true });
    const { list, merged } = dedupe([a, b]);
    assert.strictEqual(merged, 1);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].source, 'funds');
    assert.deepStrictEqual(list[0].corroboratedBy, ['bonds']);
    assert.ok(list[0].confidence > 0.9, 'independent agreement raises confidence');
  });

  test('different things are not merged', () => {
    const { list } = dedupe([make(TBILL), make(HYSA), make(FARM)]);
    assert.strictEqual(list.length, 3);
  });
});
