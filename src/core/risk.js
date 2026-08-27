'use strict';

const C = require('./constants');

/**
 * Risk scoring, 0 (a T-bill) to 100 (you will probably lose this money).
 *
 * The model is deliberately additive and legible rather than clever: every point
 * a thing scores is attributable to a named factor the user can read, so "why is
 * this rated 71?" always has an answer. Opaque risk scores are worse than none,
 * because people trust them.
 *
 * Structure: a STRUCTURAL baseline per asset class (business-model complexity,
 * counterparty, leverage-by-convention) plus separately-measured market risk
 * from volatility. The two are kept apart so we never charge an asset twice for
 * the same danger.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Structural risk only — market risk is added separately from volatility. */
const BASE_BY_CLASS = {
  cash: 4, cd: 5, govt_bond: 3, muni_bond: 10, corp_bond: 18,
  dividend_equity: 16, reit: 22, bdc: 30, cef: 24, etf: 14, preferred: 18,
  crypto_staking: 34, crypto_lending: 38, crypto_lp: 46, rwa: 16,
  p2p_lending: 44, annuity: 14, speculative: 40,
};

/** Typical annualised volatility when a source does not report one. */
const ASSUMED_VOL = {
  cash: 0.1, cd: 0.1, govt_bond: 4, muni_bond: 5, corp_bond: 8,
  dividend_equity: 20, reit: 24, bdc: 30, cef: 22, etf: 16, preferred: 14,
  crypto_staking: 55, crypto_lending: 22, crypto_lp: 70, rwa: 5,
  p2p_lending: 12, annuity: 2, speculative: 55,
};

/** Insurance/guarantee is the biggest discriminator; it both reduces and caps. */
const GUARANTEE_CAP = { us_gov: 8, fdic: 10, ncua: 10, private: 45, sipc: null, none: null };

/**
 * Volatility -> risk points, saturating. 16%/yr (broad equity) ~ 11pts,
 * 30% ~ 18, 60% ~ 28, 100%+ ~ 34. Saturates because past 100% vol the
 * distinction stops being meaningful.
 */
function volPoints(vol) {
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  return clamp(38 * (1 - Math.exp(-vol / 45)), 0, 38);
}

/**
 * Volatility we assume when a source does not report one. Stablecoin-denominated
 * crypto positions are principal-stable, so they must not inherit crypto vol.
 */
function assumedVolatility(o) {
  if (Number.isFinite(o?.risk?.volatility)) return o.risk.volatility;
  const isDefi = ['crypto_staking', 'crypto_lending', 'crypto_lp'].includes(o?.assetClass);
  if (o?.stablecoin && isDefi) return o.ilRisk === 'yes' ? 6 : 3;
  if (o?.stablecoin) return 2;
  return ASSUMED_VOL[o?.assetClass] ?? 25;
}

function scoreRisk(o) {
  const factors = [];
  const add = (points, label) => {
    if (!Number.isFinite(points) || points === 0) return;
    factors.push({ label, points: Math.round(points * 10) / 10 });
  };
  const total = () => factors.reduce((s, f) => s + f.points, 0);

  add(BASE_BY_CLASS[o.assetClass] ?? 40, `${C.ASSET_CLASS_LABELS[o.assetClass] || o.assetClass} baseline`);

  // --- guarantees -----------------------------------------------------------
  const ins = o.risk?.insurance || C.INSURANCE.NONE;
  if (ins === C.INSURANCE.US_GOV) add(-14, 'Backed by the US government');
  else if (ins === C.INSURANCE.FDIC) add(-10, 'FDIC insured');
  else if (ins === C.INSURANCE.NCUA) add(-10, 'NCUA insured');
  else if (ins === C.INSURANCE.PRIVATE) add(-3, 'Private insurance');

  // --- credit ---------------------------------------------------------------
  const rating = (o.risk?.creditRating || '').toUpperCase();
  const RATINGS = { AAA: -8, 'AA+': -7, AA: -6, 'AA-': -5, 'A+': -4, A: -3, 'A-': -2, 'BBB+': 0, BBB: 2, 'BBB-': 4, 'BB+': 10, BB: 13, 'BB-': 16, 'B+': 20, B: 24, 'B-': 28, CCC: 36, CC: 44, C: 50, D: 60 };
  if (RATINGS[rating] !== undefined) add(RATINGS[rating], `Credit rating ${rating}`);

  // --- market risk ----------------------------------------------------------
  const reportedVol = Number.isFinite(o.risk?.volatility) ? o.risk.volatility : null;
  const vol = reportedVol ?? assumedVolatility(o);
  const vp = volPoints(vol);
  if (vp > 0.05) {
    add(vp, reportedVol !== null
      ? `Volatility ${vol.toFixed(0)}%/yr`
      : `Assumed volatility ~${vol.toFixed(0)}%/yr (class typical)`);
  }
  const dd = o.risk?.maxDrawdown;
  if (Number.isFinite(dd) && dd > 25) add(clamp((dd - 25) * 0.16, 0, 12), `Has fallen ${dd.toFixed(0)}% peak-to-trough`);

  // --- duration -------------------------------------------------------------
  if (['govt_bond', 'muni_bond', 'corp_bond'].includes(o.assetClass) && Number.isFinite(o.term?.days)) {
    const years = o.term.days / 365.25;
    if (years > 1) add(clamp((years - 1) * 1.05, 0, 16), `${years.toFixed(1)}yr duration — price falls if rates rise`);
  }

  // --- liquidity ------------------------------------------------------------
  const liqPts = { instant: 0, daily: 0.5, settled: 1.5, notice: 5, locked: 4, illiquid: 15 };
  add(liqPts[o.liquidity] ?? 3, `Liquidity: ${o.liquidity}`);
  if (o.liquidity === C.LIQUIDITY.LOCKED && Number.isFinite(o.term?.days) && o.term.days > 365) {
    add(clamp((o.term.days / 365.25 - 1) * 1.4, 0, 10), 'Long lockup — you cannot react to rate changes');
  }

  // --- DeFi-specific --------------------------------------------------------
  const isDefi = ['crypto_staking', 'crypto_lending', 'crypto_lp'].includes(o.assetClass);
  if (isDefi) {
    const tvl = o.tvl;
    if (Number.isFinite(tvl)) {
      if (tvl < 250e3) add(16, 'TVL under $250k — thin and fragile');
      else if (tvl < 1e6) add(11, 'TVL under $1M');
      else if (tvl < 10e6) add(6, 'TVL under $10M');
      else if (tvl < 100e6) add(2, 'TVL under $100M');
      else add(-5, `Deep TVL ($${(tvl / 1e6).toFixed(0)}M)`);
    } else add(6, 'TVL unknown');

    const age = o.risk?.ageDays;
    if (Number.isFinite(age)) {
      if (age < 30) add(14, 'Live under 30 days');
      else if (age < 90) add(8, 'Live under 3 months');
      else if (age < 365) add(3, 'Live under a year');
      else add(-4, 'Multi-year track record');
    }

    const audits = o.risk?.auditCount;
    if (Number.isFinite(audits)) {
      add(audits > 0 ? -clamp(audits * 2.5, 0, 6) : 9, audits > 0 ? `${audits} audit(s)` : 'No published audit');
    }

    // Emission dependence: yield that is 90% farm tokens is 90% temporary.
    if (Number.isFinite(o.apy?.total) && Number.isFinite(o.apy?.reward) && o.apy.total > 0) {
      const share = clamp(o.apy.reward / o.apy.total, 0, 1);
      if (share > 0.5) add(clamp((share - 0.5) * 26, 0, 14), `${(share * 100).toFixed(0)}% of yield is token emissions`);
    }

    if (o.ilRisk === 'yes' || o.subType === 'volatile_lp') add(12, 'Impermanent loss exposure — divergence can exceed the yield');
    else if (o.assetClass === 'crypto_lp' && o.stablecoin) add(3, 'Stable-pair pool — mild divergence risk');
    if (o.stablecoin) add(5, 'Depends on a stablecoin peg holding');
    add(8, 'Smart-contract risk — code can be exploited');
  }

  // --- leverage -------------------------------------------------------------
  const lev = o.risk?.leverage;
  if (Number.isFinite(lev) && lev > 1) add(clamp((lev - 1) * 12, 0, 22), `${lev.toFixed(1)}x leverage`);

  // --- the rate itself is evidence -----------------------------------------
  // Nothing pays 40% because the market forgot. Above the risk-free rate, extra
  // yield is compensation for risk, so let the number inform its own score.
  const rate = o.apy?.total ?? o.expected?.annualReturn;
  const rf = Number.isFinite(o.__riskFree) ? o.__riskFree : 4.0;
  if (Number.isFinite(rate) && rate > rf) {
    const excess = rate - rf;
    const pts = clamp(9 * Math.log10(1 + excess / 2.2), 0, 30);
    if (pts > 0.5) add(pts, `Pays ${excess.toFixed(1)}pp over risk-free — the market is pricing that risk`);
  }

  // --- quality of the claim -------------------------------------------------
  if (o.yieldKind === C.YIELD_KIND.EXPECTED) add(10, 'Modelled expectation, not a contractual yield');
  else if (o.yieldKind === C.YIELD_KIND.TRAILING) add(4, 'Backward-looking yield — may not repeat');
  else if (o.yieldKind === C.YIELD_KIND.ADMINISTERED) add(2, 'Rate can be changed by the provider at any time');

  let score = total();

  // Guarantee caps apply last: an FDIC-insured 5% CD cannot be "aggressive" no
  // matter how the arithmetic lands, because the principal is insured.
  const cap = GUARANTEE_CAP[ins];
  if (Number.isFinite(cap) && score > cap) {
    factors.push({ label: 'Capped — principal is insured or government-guaranteed', points: Math.round((cap - score) * 10) / 10 });
    score = cap;
  }

  score = clamp(Math.round(score * 10) / 10, 0, 100);
  const tier = C.riskTier(score);
  return {
    score,
    tier: tier.key,
    tierLabel: tier.label,
    tierColor: tier.color,
    volatilityUsed: vol,
    volatilityAssumed: reportedVol === null,
    factors: factors.filter((f) => Math.abs(f.points) >= 0.05).sort((a, b) => b.points - a.points),
    principalAtRisk: ![C.INSURANCE.US_GOV, C.INSURANCE.FDIC, C.INSURANCE.NCUA].includes(ins),
  };
}

module.exports = { scoreRisk, assumedVolatility, volPoints, BASE_BY_CLASS, ASSUMED_VOL };
