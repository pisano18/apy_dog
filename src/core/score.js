'use strict';

const C = require('./constants');
const { scoreRisk, assumedVolatility } = require('./risk');
const { detectTraps } = require('./traps');
const { applyTax } = require('./tax');
const { catastrophicRisk, lossAversionWeight } = require('./tail');

/**
 * Ranking.
 *
 * The honest way to compare "4.3% guaranteed" against "40%, probably, for now"
 * is a certainty equivalent: the guaranteed return that would make you equally
 * happy. We use mean-variance utility, CE = mu - (A/2)*sigma^2, which is the
 * standard textbook form, with A (risk aversion) driven by the user's own risk
 * appetite slider. A cautious user and an aggressive one genuinely should get
 * different rankings from the same data, and this is the parameter that does it.
 *
 * Three corrections are applied before that, in order, and each one exists
 * because without it the ranking actively misleads:
 *
 *   1. Trap and confidence haircuts, so a 240% emissions farm does not enter the
 *      maths at 240%.
 *   2. Catastrophic risk (see tail.js), subtracted as an expected loss rather
 *      than as variance. Variance cannot see a jump to zero, which is exactly how
 *      DeFi positions actually fail, so without this a 3%-volatility stablecoin
 *      pool outranks a Treasury bill.
 *   3. Loss aversion on that tail term, scaled by risk appetite, so "positive
 *      expected value" cannot by itself argue someone into a coin flip on their
 *      principal.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Risk-aversion coefficient A from a 0..100 appetite slider.
 * 0 = "I cannot lose this money", 50 = balanced, 100 = "swing for the fences".
 */
function riskAversion(appetite = 50) {
  const a = clamp(Number(appetite) || 0, 0, 100);
  // 0 -> 14 (very averse), 50 -> 3, 100 -> 0.35 (nearly risk-neutral)
  return 14 * Math.pow(0.35 / 14, a / 100) * (a === 50 ? 1 : 1);
}

const BASIS = {
  GROSS: 'gross',
  AFTER_TAX: 'afterTax',
  AFTER_TAX_REAL: 'afterTaxReal',
};

/**
 * Score one opportunity. Mutates nothing; returns the score block.
 *
 * @param {object} o        normalized opportunity
 * @param {object} opts
 *   - riskFree        current risk-free rate, percent (drives excess-return logic)
 *   - appetite        0..100 risk appetite
 *   - taxProfile      user's tax settings
 *   - basis           which yield the ranking uses
 *   - horizonDays     when the user wants the money back (null = no constraint)
 *   - peerMedian      median APY of this asset class, for outlier detection
 *   - amount          how much they intend to deploy, for dollar figures
 */
function scoreOne(o, opts = {}) {
  const {
    riskFree = 4.0,
    appetite = 50,
    taxProfile = {},
    basis = BASIS.AFTER_TAX,
    horizonDays = null,
    peerMedian = null,
    amount = 10000,
  } = opts;

  const withRf = { ...o, __riskFree: riskFree, __amount: amount };
  const risk = scoreRisk(withRf);
  const tail = catastrophicRisk(withRf);
  const traps = detectTraps(o, { peerMedian });
  const tax = applyTax(o, taxProfile);

  const gross = tax.grossApy;
  const chosen = basis === BASIS.GROSS ? tax.grossApy
    : basis === BASIS.AFTER_TAX_REAL ? tax.afterTaxRealApy
      : tax.afterTaxApy;

  const vol = risk.volatilityUsed;
  const confidence = clamp(o.confidence ?? 0.5, 0, 1);

  // --- haircut the claim before trusting it in the maths --------------------
  const trapHaircut = 1 - 0.7 * (traps.score / 100);
  const confHaircut = 0.5 + 0.5 * confidence;
  const muRaw = Number.isFinite(chosen) ? chosen : null;
  const mu = muRaw === null ? null : muRaw * trapHaircut * confHaircut;

  // --- certainty equivalent -------------------------------------------------
  // You only collect the yield in the worlds where the thing survives the year,
  // and in the worlds where it does not you lose principal. Both belong in the
  // expected value, weighted by how much the user hates losing money.
  const A = riskAversion(appetite);
  const sigma = (Number.isFinite(vol) ? vol : assumedVolatility(o)) / 100;
  const lossWeight = lossAversionWeight(appetite);
  const tailDrag = tail.annualProbability * tail.lossGivenEvent * 100 * lossWeight;
  const muSurvived = mu === null ? null : mu * (1 - tail.annualProbability);

  // Mark-to-market volatility on a guaranteed instrument you intend to hold to
  // maturity is noise you never realise: a 30-year Treasury returns par whatever
  // its price does in between. Charge that price risk in full only when the user
  // has told us they need the money back before it matures.
  let variancePenalty = (A / 2) * sigma * sigma * 100;
  let heldToMaturity = false;
  const guaranteed = [C.INSURANCE.US_GOV, C.INSURANCE.FDIC, C.INSURANCE.NCUA].includes(o.risk?.insurance);
  const fixedTerm = Number.isFinite(o.term?.days) && o.term.days > 0
    && [C.YIELD_KIND.CONTRACTUAL, C.YIELD_KIND.MARKET].includes(o.yieldKind);
  if (guaranteed && fixedTerm && (!Number.isFinite(horizonDays) || horizonDays >= o.term.days)) {
    variancePenalty *= 0.25;   // residual: you might still change your mind
    heldToMaturity = true;
  }
  let ce = mu === null ? null : muSurvived - tailDrag - variancePenalty;

  // --- horizon / liquidity fit ---------------------------------------------
  // Money you cannot reach when you need it is worth less than money you can.
  let horizonPenalty = 0;
  let horizonNote = null;
  if (ce !== null && Number.isFinite(horizonDays) && horizonDays > 0) {
    const lock = o.liquidity === C.LIQUIDITY.LOCKED ? (o.term?.days ?? 0) : (C.LIQUIDITY_FRICTION_DAYS[o.liquidity] ?? 2);
    if (Number.isFinite(lock) && lock > horizonDays) {
      const overshoot = (lock - horizonDays) / Math.max(horizonDays, 30);
      horizonPenalty = clamp(overshoot * 2.5, 0, 12);
      horizonNote = `Locked ${Math.round(lock)}d but you want it back in ${Math.round(horizonDays)}d`;
      ce -= horizonPenalty;
    }
    // Reinvestment risk: a 1-month bill does not lock in a rate for a 5yr horizon.
    if (o.liquidity !== C.LIQUIDITY.LOCKED && Number.isFinite(o.term?.days) && o.term.days > 0 && o.term.days < horizonDays / 3) {
      ce -= 0.4;
    }
  }

  // --- Sharpe-style excess return per unit of risk --------------------------
  const sharpe = (Number.isFinite(gross) && sigma > 0.0005)
    ? (gross - riskFree) / (sigma * 100)
    : null;

  // --- dollars, because percentages hide magnitude --------------------------
  const yearOne = Number.isFinite(tax.afterTaxApy) ? amount * (tax.afterTaxApy / 100) : null;
  const fiveYear = Number.isFinite(tax.afterTaxApy)
    ? amount * (Math.pow(1 + tax.afterTaxApy / 100, 5) - 1) : null;

  // --- headline 0..100 --------------------------------------------------------
  // Map CE onto a display scale. -5% CE -> 0, riskFree -> 50, +20% CE -> ~95.
  const dogScore = ce === null ? null : clamp(
    50 + 45 * Math.tanh((ce - riskFree) / 9), 0, 100,
  );

  return {
    dogScore: dogScore === null ? null : Math.round(dogScore * 10) / 10,
    certaintyEquivalent: ce === null ? null : Math.round(ce * 1000) / 1000,
    adjustedYield: mu === null ? null : Math.round(mu * 1000) / 1000,
    basisYield: Number.isFinite(chosen) ? Math.round(chosen * 1000) / 1000 : null,
    basis,
    sharpe: sharpe === null ? null : Math.round(sharpe * 100) / 100,
    riskAversionUsed: Math.round(A * 100) / 100,
    trapHaircut: Math.round(trapHaircut * 1000) / 1000,
    confidenceHaircut: Math.round(confHaircut * 1000) / 1000,
    tail,
    tailDrag: Math.round(tailDrag * 1000) / 1000,
    variancePenalty: Math.round(variancePenalty * 1000) / 1000,
    heldToMaturity,
    lossAversionWeight: Math.round(lossWeight * 100) / 100,
    horizonPenalty: Math.round(horizonPenalty * 100) / 100,
    horizonNote,
    incomeYear1: yearOne === null ? null : Math.round(yearOne * 100) / 100,
    income5yr: fiveYear === null ? null : Math.round(fiveYear * 100) / 100,
    risk,
    traps,
    tax,
  };
}

/**
 * Score a whole list. Peer medians are computed across the list first, so the
 * outlier test compares like with like within this actual dataset rather than
 * against a hardcoded guess.
 */
function scoreAll(list, opts = {}) {
  const { peerMedians } = require('./traps');
  const medians = peerMedians(list);
  return list.map((o) => {
    const scored = scoreOne(o, { ...opts, peerMedian: medians[o.assetClass] });
    return {
      ...o,
      scores: scored,
      trapFlags: scored.traps.flags,
      trapScore: scored.traps.score,
      tax: scored.tax,
      risk: { ...o.risk, ...scored.risk },
    };
  });
}

/** Sort comparators the UI exposes. */
const SORTERS = {
  dogScore: (a, b) => (b.scores?.dogScore ?? -1e9) - (a.scores?.dogScore ?? -1e9),
  apy: (a, b) => (b.apy?.total ?? b.expected?.annualReturn ?? -1e9) - (a.apy?.total ?? a.expected?.annualReturn ?? -1e9),
  afterTax: (a, b) => (b.tax?.afterTaxApy ?? -1e9) - (a.tax?.afterTaxApy ?? -1e9),
  taxEquivalent: (a, b) => (b.tax?.taxEquivalentYield ?? -1e9) - (a.tax?.taxEquivalentYield ?? -1e9),
  afterTaxReal: (a, b) => (b.tax?.afterTaxRealApy ?? -1e9) - (a.tax?.afterTaxRealApy ?? -1e9),
  certaintyEquivalent: (a, b) => (b.scores?.certaintyEquivalent ?? -1e9) - (a.scores?.certaintyEquivalent ?? -1e9),
  sharpe: (a, b) => (b.scores?.sharpe ?? -1e9) - (a.scores?.sharpe ?? -1e9),
  risk: (a, b) => (a.risk?.score ?? 1e9) - (b.risk?.score ?? 1e9),
  trap: (a, b) => (a.trapScore ?? 1e9) - (b.trapScore ?? 1e9),
  term: (a, b) => (a.term?.days ?? -1) - (b.term?.days ?? -1),
  tvl: (a, b) => (b.tvl ?? -1) - (a.tvl ?? -1),
  minInvestment: (a, b) => (a.minInvestment ?? 0) - (b.minInvestment ?? 0),
  price: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};

module.exports = { scoreOne, scoreAll, riskAversion, SORTERS, BASIS };
