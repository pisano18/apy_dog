'use strict';

const C = require('./constants');

/**
 * After-tax and inflation-adjusted yield.
 *
 * This is the part most yield screeners get wrong, and it flips rankings all the
 * time: for a Californian in the top bracket, a 4.30% Treasury beats a 4.60%
 * savings account, because the Treasury is exempt from state tax. Ranking by
 * headline APY without this is ranking by an illusion.
 *
 * All rates are percent. Brackets are user settings, not scraped, because tax
 * situations are personal and a wrong guess here is worse than asking.
 */

/** 2025/2026-era federal ordinary brackets (single / married-joint), for the picker. */
const FEDERAL_ORDINARY_BRACKETS = [10, 12, 22, 24, 32, 35, 37];
const FEDERAL_LTCG_BRACKETS = [0, 15, 20];

/** Top marginal state income tax rates, for the state picker default. */
const STATE_TOP_RATES = {
  AL: 5.0, AK: 0, AZ: 2.5, AR: 3.9, CA: 13.3, CO: 4.4, CT: 6.99, DE: 6.6, DC: 10.75,
  FL: 0, GA: 5.39, HI: 11.0, ID: 5.695, IL: 4.95, IN: 3.05, IA: 3.8, KS: 5.7,
  KY: 4.0, LA: 3.0, ME: 7.15, MD: 5.75, MA: 9.0, MI: 4.25, MN: 9.85, MS: 4.7,
  MO: 4.7, MT: 5.9, NE: 5.2, NV: 0, NH: 0, NJ: 10.75, NM: 5.9, NY: 10.9,
  NC: 4.25, ND: 2.5, OH: 3.5, OK: 4.75, OR: 9.9, PA: 3.07, RI: 5.99, SC: 6.2,
  SD: 0, TN: 0, TX: 0, UT: 4.55, VT: 8.75, VA: 5.75, WA: 0, WV: 4.82,
  WI: 7.65, WY: 0,
};

const DEFAULT_PROFILE = {
  federalOrdinary: 24,
  federalLtcg: 15,
  state: 'TX',
  stateRate: null,        // null => look up STATE_TOP_RATES[state]
  niitApplies: false,     // 3.8% net investment income tax over the MAGI threshold
  accountType: 'taxable', // 'taxable' | 'traditional' | 'roth'
  inflation: 2.6,         // assumed forward CPI, for real-yield display
};

function resolveProfile(p = {}) {
  const profile = { ...DEFAULT_PROFILE, ...p };
  if (profile.stateRate === null || profile.stateRate === undefined) {
    profile.stateRate = STATE_TOP_RATES[profile.state] ?? 0;
  }
  return profile;
}

/**
 * Effective marginal rate applied to this income stream.
 * Returns { rate, parts[] } where parts explain the arithmetic.
 */
function effectiveRate(treatment, profile) {
  const p = resolveProfile(profile);
  const parts = [];
  const niit = p.niitApplies ? 3.8 : 0;

  // Tax-advantaged accounts short-circuit everything.
  if (p.accountType === 'roth') {
    return { rate: 0, parts: [{ label: 'Roth account — no tax on growth or withdrawal', rate: 0 }], sheltered: true };
  }
  if (p.accountType === 'traditional') {
    return {
      rate: 0,
      parts: [{ label: 'Tax-deferred account — no tax until withdrawal', rate: 0 }],
      sheltered: true,
      deferred: true,
    };
  }

  let fed = 0, state = 0;
  switch (treatment) {
    case C.TAX_TREATMENT.TREASURY:
      fed = p.federalOrdinary; state = 0;
      parts.push({ label: `Federal ordinary ${fed}%`, rate: fed });
      parts.push({ label: `State exempt (Treasury interest)`, rate: 0 });
      break;
    case C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT:
      fed = 0; state = p.stateRate;
      parts.push({ label: 'Federal exempt (municipal)', rate: 0 });
      parts.push({ label: `State ${p.state} ${state}%`, rate: state });
      break;
    case C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT:
      parts.push({ label: 'Federal, state and local exempt', rate: 0 });
      break;
    case C.TAX_TREATMENT.QUALIFIED_DIVIDEND:
    case C.TAX_TREATMENT.CAPITAL_GAIN_LONG:
      fed = p.federalLtcg; state = p.stateRate;
      parts.push({ label: `Federal long-term capital gains ${fed}%`, rate: fed });
      parts.push({ label: `State ${p.state} ${state}%`, rate: state });
      break;
    case C.TAX_TREATMENT.SECTION_199A: {
      // REIT/BDC ordinary dividends get a 20% deduction under §199A.
      const eff = p.federalOrdinary * 0.8;
      fed = eff; state = p.stateRate;
      parts.push({ label: `Federal ${p.federalOrdinary}% less 20% §199A deduction = ${eff.toFixed(1)}%`, rate: eff });
      parts.push({ label: `State ${p.state} ${state}%`, rate: state });
      break;
    }
    case C.TAX_TREATMENT.ROC:
      // Return of capital is not taxed now; it lowers basis and is taxed on sale.
      fed = 0; state = 0;
      parts.push({ label: 'Return of capital — deferred, reduces your cost basis', rate: 0 });
      break;
    case C.TAX_TREATMENT.TAX_DEFERRED:
      parts.push({ label: 'Tax-deferred until withdrawal', rate: 0 });
      break;
    case C.TAX_TREATMENT.MIXED:
      fed = p.federalOrdinary * 0.7 + p.federalLtcg * 0.3;
      state = p.stateRate;
      parts.push({ label: `Blended federal ~${fed.toFixed(1)}% (mixed distribution)`, rate: fed });
      parts.push({ label: `State ${p.state} ${state}%`, rate: state });
      break;
    case C.TAX_TREATMENT.ORDINARY:
    default:
      fed = p.federalOrdinary; state = p.stateRate;
      parts.push({ label: `Federal ordinary ${fed}%`, rate: fed });
      parts.push({ label: `State ${p.state} ${state}%`, rate: state });
      break;
  }

  const taxableAtNiit = ![C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT, C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT, C.TAX_TREATMENT.ROC].includes(treatment);
  if (niit && taxableAtNiit) parts.push({ label: 'Net investment income tax 3.8%', rate: niit });

  const rate = Math.max(0, Math.min(99, fed + state + (taxableAtNiit ? niit : 0)));
  return { rate: Math.round(rate * 100) / 100, parts, sheltered: false };
}

/**
 * Full tax view of one opportunity.
 * `taxEquivalentYield` answers: what would a fully-taxable thing have to pay to
 * match this after tax? That is the number to rank a muni against a CD with.
 */
function applyTax(o, profile) {
  const p = resolveProfile(profile);
  const gross = Number.isFinite(o.apy?.total) ? o.apy.total : o.expected?.annualReturn;
  const { rate, parts, sheltered, deferred } = effectiveRate(o.taxTreatment, p);

  if (!Number.isFinite(gross)) {
    return { grossApy: null, afterTaxApy: null, taxEquivalentYield: null, effectiveTaxRate: rate, parts, sheltered: !!sheltered, deferred: !!deferred, realApy: null, afterTaxRealApy: null };
  }

  // Tax takes a share of a gain. It does not refund a share of a loss — not on
  // a credit card annual fee, not on a promotional cost, not on anything an
  // ordinary person holds outside a brokerage account. Applying the haircut to
  // a negative return shrinks it, which quietly reports a losing row as less
  // bad after tax than before it. Rows whose whole point IS a deduction carry
  // that deduction as a positive benefit already.
  const afterTax = gross >= 0 ? gross * (1 - rate / 100) : gross;

  // Tax-equivalent yield uses the FULLY taxable ordinary rate as the benchmark,
  // so every row is expressed in "ordinary income dollars".
  const benchmark = effectiveRate(C.TAX_TREATMENT.ORDINARY, p).rate;
  // Grossing up only makes sense for money you keep. On a losing row there is
  // nothing to gross up, and dividing by (1 - rate) makes the loss look larger
  // than it is: a cost you cannot deduct is exactly that cost in ordinary-income
  // terms, no more.
  const tey = benchmark >= 100 ? null
    : afterTax < 0 ? afterTax
      : afterTax / (1 - benchmark / 100);

  const infl = Number.isFinite(p.inflation) ? p.inflation : 0;
  // Real return is multiplicative, not subtractive: (1+r)/(1+i) - 1.
  const real = ((1 + gross / 100) / (1 + infl / 100) - 1) * 100;
  const afterTaxReal = ((1 + afterTax / 100) / (1 + infl / 100) - 1) * 100;

  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  return {
    grossApy: r2(gross),
    afterTaxApy: r2(afterTax),
    taxEquivalentYield: r2(tey),
    effectiveTaxRate: rate,
    benchmarkRate: benchmark,
    parts,
    sheltered: !!sheltered,
    deferred: !!deferred,
    realApy: r2(real),
    afterTaxRealApy: r2(afterTaxReal),
    inflationUsed: infl,
  };
}

module.exports = {
  applyTax, effectiveRate, resolveProfile,
  DEFAULT_PROFILE, STATE_TOP_RATES, FEDERAL_ORDINARY_BRACKETS, FEDERAL_LTCG_BRACKETS,
};
