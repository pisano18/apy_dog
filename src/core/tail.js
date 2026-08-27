'use strict';

const C = require('./constants');

/**
 * Catastrophic (tail) risk.
 *
 * Mean-variance utility has a specific, dangerous blind spot: it measures risk as
 * variance, and variance cannot see a jump to zero. A stablecoin lending pool has
 * roughly 3% annualised price volatility, so a variance-based ranking treats it as
 * nearly as safe as a T-bill — right up until the protocol is exploited or the peg
 * breaks, and the position is worth 40 cents.
 *
 * So catastrophic risk is modelled separately and explicitly: an annual probability
 * of a severe loss event, and how much of your principal such an event takes. That
 * expected loss is subtracted from the return directly, before any variance maths.
 *
 * The probabilities below are order-of-magnitude judgements, not measurements. They
 * are deliberately shown to the user with their reasons rather than buried, because
 * a number this consequential should be arguable.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Annual probability of a severe loss event, by what the thing fundamentally is. */
const BASE_P = {
  cash: 0.0005,             // uninsured bank failure, essentially covered by FDIC
  cd: 0.0005,
  govt_bond: 0.0002,
  muni_bond: 0.002,
  corp_bond: 0.004,
  dividend_equity: 0.006,   // a single company can go to zero
  reit: 0.006,
  bdc: 0.010,               // levered lending to small companies
  cef: 0.004,
  etf: 0.0008,              // diversified; a broad fund does not go to zero
  preferred: 0.008,
  crypto_staking: 0.012,
  crypto_lending: 0.020,
  crypto_lp: 0.035,
  rwa: 0.006,               // issuer and redemption-gate risk
  p2p_lending: 0.020,
  annuity: 0.002,
  speculative: 0.020,
};

/** How much principal a severe event takes, given it happens. */
const BASE_LGE = {
  cash: 0.4, cd: 0.4, govt_bond: 0.3, muni_bond: 0.5, corp_bond: 0.55,
  dividend_equity: 0.75, reit: 0.7, bdc: 0.7, cef: 0.6, etf: 0.5, preferred: 0.7,
  crypto_staking: 0.7, crypto_lending: 0.75, crypto_lp: 0.85,
  rwa: 0.5, p2p_lending: 0.65, annuity: 0.4, speculative: 0.8,
};

function catastrophicRisk(o) {
  const reasons = [];
  let p = BASE_P[o.assetClass] ?? 0.01;
  let lge = BASE_LGE[o.assetClass] ?? 0.7;

  const note = (label) => reasons.push(label);
  note(`${C.ASSET_CLASS_LABELS[o.assetClass] || o.assetClass} baseline`);

  // --- guarantees are the whole point of guarantees -------------------------
  const ins = o.risk?.insurance;
  if (ins === C.INSURANCE.US_GOV) {
    p = 0.00002; lge = 0.2;
    note('US government backing — the tail is essentially closed');
  } else if (ins === C.INSURANCE.FDIC || ins === C.INSURANCE.NCUA) {
    p = 0.00005; lge = 0.15;
    note(`${ins.toUpperCase()} insured — depositors have never lost insured funds`);
    // ...unless the position is larger than the insured limit.
    const limit = o.risk?.insuredLimit;
    if (Number.isFinite(limit) && Number.isFinite(o.__amount) && o.__amount > limit) {
      const uninsuredShare = (o.__amount - limit) / o.__amount;
      p = 0.0006 * uninsuredShare + p;
      note(`${(uninsuredShare * 100).toFixed(0)}% of your amount would sit above the ${(limit / 1000).toFixed(0)}k insured limit`);
    }
  }

  const isDefi = ['crypto_staking', 'crypto_lending', 'crypto_lp'].includes(o.assetClass);
  if (isDefi) {
    // Smart-contract risk falls sharply with age, audits and capital at stake.
    // Something holding a billion dollars for three years has been attacked and held.
    const tvl = Number.isFinite(o.tvl) ? o.tvl : 0;
    const age = Number.isFinite(o.risk?.ageDays) ? o.risk.ageDays : 90;
    const audits = Number.isFinite(o.risk?.auditCount) ? o.risk.auditCount : 0;

    let mult = 1;
    if (tvl >= 1e9) { mult *= 0.35; note('Over $1B at stake — heavily battle-tested'); }
    else if (tvl >= 1e8) { mult *= 0.55; note('Over $100M at stake'); }
    else if (tvl >= 1e7) { mult *= 0.85; }
    else if (tvl >= 1e6) { mult *= 1.6; note('Under $10M at stake'); }
    else { mult *= 3.0; note('Under $1M at stake — a small target is a soft target'); }

    if (age >= 1095) { mult *= 0.45; note('Three or more years live without a fatal incident'); }
    else if (age >= 365) { mult *= 0.7; note('Over a year live'); }
    else if (age >= 90) { mult *= 1.3; }
    else if (age >= 30) { mult *= 2.5; note('Under 3 months live'); }
    else { mult *= 5.0; note('Under 30 days live — highest-risk window there is'); }

    if (audits >= 3) { mult *= 0.7; note(`${audits} audits`); }
    else if (audits >= 1) { mult *= 0.85; }
    else { mult *= 1.6; note('No published audit'); }

    p *= mult;
    note('Smart-contract exploit risk');
  }

  // --- peg risk -------------------------------------------------------------
  // A "stable" asset paying far above the risk-free rate is being paid to hold
  // peg risk. The market is usually right about how much.
  if (o.stablecoin) {
    const rate = o.apy?.total;
    const rf = Number.isFinite(o.__riskFree) ? o.__riskFree : 4;
    let depegP = 0.008;
    if (Number.isFinite(rate) && rate > rf) {
      const excess = rate - rf;
      depegP += clamp(excess * 0.0018, 0, 0.05);
      if (excess > 6) note(`Pays ${excess.toFixed(1)}pp over risk-free on a "stable" asset — that spread is the peg risk`);
    }
    p += depegP;
    lge = Math.max(lge * 0.55, 0.25);   // depegs usually partially recover
    note('Stablecoin peg could break');
  }

  // --- diversification cuts both probability and severity --------------------
  if (['etf', 'cef'].includes(o.assetClass) || o.subType === 'index_proxy') {
    lge *= 0.7;
    note('Holds many positions — one failure is not the whole position');
  }

  // --- leverage turns a drawdown into a wipeout ------------------------------
  const lev = o.risk?.leverage;
  if (Number.isFinite(lev) && lev > 1.1) {
    p *= 1 + (lev - 1) * 1.5;
    lge = clamp(lge * (1 + (lev - 1) * 0.5), 0, 1);
    note(`${lev.toFixed(2)}x leverage amplifies the tail`);
  }

  // --- impermanent loss is a slow bleed, not a jump, but it compounds --------
  if (o.ilRisk === 'yes' || o.subType === 'volatile_lp') {
    p *= 1.25;
    note('Volatile-pair LP — divergence adds to the tail');
  }

  p = clamp(p, 0, 0.85);
  lge = clamp(lge, 0, 1);

  return {
    annualProbability: Math.round(p * 100000) / 100000,
    lossGivenEvent: Math.round(lge * 1000) / 1000,
    expectedAnnualLossPct: Math.round(p * lge * 100 * 1000) / 1000,
    reasons,
  };
}

/**
 * Loss aversion: a cautious investor weights a catastrophic loss far more heavily
 * than its raw expected value, and the curve has to be steep at the cautious end
 * to mean anything. Someone who sets appetite to 10 is not saying "I would like
 * slightly less variance", they are saying "I cannot lose this money" — and a
 * merely linear weight lets a big enough spread argue them out of that.
 *
 * Appetite 0 counts a catastrophic loss six times over; 50 about three times;
 * 100 counts it once, at face expected value.
 */
function lossAversionWeight(appetite = 50) {
  const a = clamp(Number(appetite) || 0, 0, 100);
  return 1 + 5 * Math.pow((100 - a) / 100, 1.6);
}

module.exports = { catastrophicRisk, lossAversionWeight, BASE_P, BASE_LGE };
