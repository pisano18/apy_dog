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

/**
 * What a capped or one-off offer is ranked against when the reader has not said
 * how much they are working with.
 *
 * Round, ordinary, and large enough that the cap on a typical bonus actually
 * bites — which is the whole point, because it is the cap that turns "122% a
 * year" back into "$300 once". Every row ranked on it says so on its face; the
 * moment a real amount is set, that amount replaces this everywhere.
 */
const REFERENCE_AMOUNT = 10000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtMoney = (v) => `$${Math.round(v).toLocaleString()}`;

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
    // null means the user has not said how much they are working with. In that
    // mode the app shows rates and says nothing about dollars, because a dollar
    // figure computed from a number nobody supplied is a fabrication wearing a
    // currency symbol.
    amount = null,
  } = opts;
  const hasBudget = Number.isFinite(amount) && amount > 0;
  // What to rank a capped or one-off offer against when nobody has said how
  // much they have. Leaving them on the raw annualised rate was the honest-
  // looking choice and the wrong one: a $300 opening bonus annualises to 122%,
  // so the default view became a wall of three-figure promotions sitting above
  // every real investment — exactly the ranking the blending was built to stop,
  // reappearing whenever the budget box was left empty, which is always at
  // first run. So a stated, visible reference is used instead, and every row
  // ranked on it says so. A named assumption beats a hidden one.
  const basisAmount = hasBudget ? amount : REFERENCE_AMOUNT;

  const withRf = { ...o, __riskFree: riskFree, __amount: hasBudget ? amount : null };
  const risk = scoreRisk(withRf);
  const tail = catastrophicRisk(withRf);
  const traps = detectTraps(o, { peerMedian });
  const tax = applyTax(o, taxProfile);

  const gross = tax.grossApy;
  const chosenRaw = basis === BASIS.GROSS ? tax.grossApy
    : basis === BASIS.AFTER_TAX_REAL ? tax.afterTaxRealApy
      : tax.afterTaxApy;

  // --- what this is actually worth on the money you have --------------------
  //
  // Two facts break a naive rate comparison, and both are common:
  //
  //   Caps.     A 6.17% account capped at $1,000 does not pay 6.17% on $10,000.
  //             It pays 6.17% on a tenth of it, and the rest earns whatever else
  //             you can find.
  //   One-offs. An opening bonus of $300 on $1,000 held 120 days annualises to
  //             122%, which is arithmetically true and completely misleading:
  //             you collect it once. Ranked as a rate it buries every real
  //             savings account under a wall of three-figure numbers.
  //
  // So the ranking uses the blended return on the whole budget over the coming
  // year, with anything the cap excludes earning the risk-free rate. The
  // headline APY is still shown, because it is a real fact about the product —
  // it is just not the number that decides which row is better for you.
  const cap = Number.isFinite(o.maxInvestment) && o.maxInvestment > 0 ? o.maxInvestment : basisAmount;
  const deployable = Math.max(0, Math.min(basisAmount, cap));
  const share = basisAmount > 0 ? deployable / basisAmount : 1;
  const holdDays = Number.isFinite(o.term?.days) && o.term.days > 0 ? o.term.days : 365;

  // Can this person actually take the offer? A brokerage bonus tier requiring
  // $250,000 is a real product and completely irrelevant to someone deploying
  // $10,000 — ranking it among their options is worse than not listing it.
  // Without a stated budget there is nothing to compare against, so the question
  // does not arise and the answer is null rather than a guess.
  const affordable = !hasBudget ? null
    : (!Number.isFinite(o.minInvestment) || o.minInvestment <= amount);

  // Two different questions, and they had one answer between them, which was
  // wrong for one of them.
  //
  //   yearsHeld  — how much of the coming *year* this offer occupies. Capped at
  //                one year, because the blend below is a year-one figure and a
  //                five-year lock cannot pay five years of return inside one.
  //   yearsToPay — how long the offer actually takes to pay out, uncapped. This
  //                is the exponent that un-annualises the headline rate back
  //                into the payment the offer is really about.
  //
  // Using the capped one for both understated every one-off that takes longer
  // than a year: Robinhood's $300 five-year IRA match was reported as "$59",
  // because one fifth of the term was all the exponent was allowed to see. The
  // row's own notes said $300 and the line underneath said $59.
  const yearsHeld = Math.min(holdDays, 365) / 365;
  const yearsToPay = holdDays / 365;

  /**
   * One annualised rate, turned into what it is worth over the coming year on
   * the money it can actually be taken on.
   *
   * Applied to every rate the row reports — gross, after tax, after inflation,
   * tax-equivalent — and not just the one the ranking happens to use. Blending
   * only the ranking figure was worse than blending none of them: the yield
   * column read 4.03% and the after-tax column beside it still read 380%, so
   * the table contradicted itself and the sort disagreed with both.
   */
  const blend = (rate, rf = riskFree) => {
    if (!Number.isFinite(rate)) return rate;
    if (hasBudget && affordable === false) return rf;
    if (share >= 0.999 && !o.oneTime) return rate;
    const periodPct = o.oneTime ? (Math.pow(1 + rate / 100, yearsHeld) - 1) * 100 : rate;
    const idleAfter = o.oneTime ? Math.max(0, 1 - yearsHeld) : 0;
    const dollars = deployable * (periodPct / 100)
      + deployable * (rf / 100) * idleAfter
      + (basisAmount - deployable) * (rf / 100);
    return (dollars / basisAmount) * 100;
  };

  /**
   * The remainder is real money and it is taxed like real money.
   *
   * `blend` mixes the row's rate with what the leftover earns in cash, and the
   * leftover used to be credited at the raw nominal rate on EVERY basis. So the
   * "after your tax" column contained untaxed interest and the "after tax and
   * inflation" column contained interest that had been neither taxed nor
   * deflated — and because the cap term is usually the larger of the two, the
   * adjustments were very nearly cancelled out. A capped 6.17% credit-union
   * account read 3.71% after inflation where the honest figure was 0.37%: an
   * order of magnitude, in the column a reader would trust most.
   *
   * The cash is short Treasuries, which is where the risk-free rate comes from,
   * so it is priced as Treasuries: federally taxable, exempt from state. Each
   * basis then blends against the version of cash that has been through the
   * same transformation the basis itself has.
   */
  const rfTax = applyTax(
    { apy: { total: riskFree }, taxTreatment: C.TAX_TREATMENT.TREASURY },
    taxProfile,
  );
  const rfFor = {
    gross: riskFree,
    afterTax: Number.isFinite(rfTax.afterTaxApy) ? rfTax.afterTaxApy : riskFree,
    afterTaxReal: Number.isFinite(rfTax.afterTaxRealApy) ? rfTax.afterTaxRealApy : riskFree,
    // Tax-equivalent yield restates everything in fully-taxable ordinary
    // dollars, so cash has to be restated too rather than passed through raw.
    taxEquivalent: Number.isFinite(rfTax.taxEquivalentYield) ? rfTax.taxEquivalentYield : riskFree,
  };

  // The single payment a one-off actually makes, recovered by un-annualising.
  // This is the number the offer is really about: "$300", not "122% a year".
  const grossPeriodPct = o.oneTime && Number.isFinite(gross)
    ? (Math.pow(1 + gross / 100, yearsToPay) - 1) * 100
    : gross;
  const oneTimeDollars = o.oneTime && !o.dollarsUnknown && Number.isFinite(grossPeriodPct)
    ? deployable * (grossPeriodPct / 100)
    : null;

  // `chosenRaw` is whichever basis the ranking is set to, so it blends against
  // the matching version of cash — otherwise changing the ranking basis quietly
  // changes what the leftover money is assumed to earn.
  const rfForChosen = chosenRaw === tax.afterTaxRealApy ? rfFor.afterTaxReal
    : chosenRaw === tax.afterTaxApy ? rfFor.afterTax
      : chosenRaw === tax.taxEquivalentYield ? rfFor.taxEquivalent
        : rfFor.gross;

  const blended = blend(chosenRaw, rfForChosen);
  const blendedGross = blend(gross, rfFor.gross);
  const blendedAfterTax = blend(tax.afterTaxApy, rfFor.afterTax);
  const blendedAfterTaxReal = blend(tax.afterTaxRealApy, rfFor.afterTaxReal);
  const blendedTaxEquivalent = blend(tax.taxEquivalentYield, rfFor.taxEquivalent);

  let blendNote = null;
  if (hasBudget && affordable === false) {
    blendNote = `Needs ${fmtMoney(o.minInvestment)} to enter, which is more than the ${fmtMoney(amount)} you are deploying.`;
  } else if (Number.isFinite(chosenRaw) && (share < 0.999 || o.oneTime)) {
    const on = hasBudget ? fmtMoney(amount) : `a reference ${fmtMoney(REFERENCE_AMOUNT)}`;
    const tail = hasBudget ? '' : ' Set your own amount in Settings and every figure here is recomputed on it.';
    blendNote = o.dollarsUnknown
      ? 'The rate is exact. The dollars are not — the cap is a share of your pay, which this app has never been '
        + 'told — so no dollar figure is shown for this one. Multiply the rate by your own numbers.'
      : o.oneTime
        ? `A one-off payment of about ${fmtMoney(oneTimeDollars)}, not a rate${
          yearsToPay > 1.05 ? `, and it takes ${holdDays >= 730 ? `${(Math.round(yearsToPay * 2) / 2)} years` : `${Math.round(holdDays)} days`} to be yours` : ''
        }. On ${on}, with the rest at `
          + `${riskFree.toFixed(2)}%, year one works out to ${blended.toFixed(2)}%.${tail}`
        : `Capped at ${fmtMoney(cap)}. On ${on}, with the rest at ${riskFree.toFixed(2)}%, that blends to `
          + `${blended.toFixed(2)}%.${tail}`;
  }

  const chosen = blended;

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
  // Computed on the blended figure so a capped or one-off offer reports what it
  // would really put in your pocket rather than a rate applied to money it will
  // not accept.
  const yearOne = Number.isFinite(blended) && !o.dollarsUnknown ? basisAmount * (blended / 100) : null;
  const fiveYear = o.dollarsUnknown ? null
    : o.oneTime
      ? yearOne   // it does not repeat, so five years is not five times
      : (Number.isFinite(blended) ? basisAmount * (Math.pow(1 + blended / 100, 5) - 1) : null);

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
    headlineYield: Number.isFinite(chosenRaw) ? Math.round(chosenRaw * 1000) / 1000 : null,
    blendedYield: Number.isFinite(blended) ? Math.round(blended * 1000) / 1000 : null,
    // Every reported rate, blended the same way, so no two columns on the same
    // row can tell different stories about the same offer.
    blendedGross: Number.isFinite(blendedGross) ? Math.round(blendedGross * 1000) / 1000 : null,
    blendedAfterTax: Number.isFinite(blendedAfterTax) ? Math.round(blendedAfterTax * 1000) / 1000 : null,
    blendedAfterTaxReal: Number.isFinite(blendedAfterTaxReal) ? Math.round(blendedAfterTaxReal * 1000) / 1000 : null,
    blendedTaxEquivalent: Number.isFinite(blendedTaxEquivalent) ? Math.round(blendedTaxEquivalent * 1000) / 1000 : null,
    // True when the blend actually changed something, so the UI knows to show
    // the raw rate as context rather than pretending it never existed.
    blendApplied: Number.isFinite(blended) && Number.isFinite(chosenRaw)
      && Math.abs(blended - chosenRaw) > 0.005,
    blendNote,
    affordable,
    hasBudget,
    // The amount every dollar figure on this row was computed on, so the UI can
    // label them rather than presenting a reference as though it were the
    // reader's own money.
    basisAmount: o.dollarsUnknown ? null : basisAmount,
    oneTimeDollars: Number.isFinite(oneTimeDollars) ? Math.round(oneTimeDollars) : null,
    dollarsUnknown: !!o.dollarsUnknown,
    deployable: deployable === null ? null : Math.round(deployable),
    oneTime: !!o.oneTime,
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
  // Rate sorts use the blended figures. Sorting by the raw annualised rate put
  // a $300 opening bonus above every real investment in the app, which is the
  // one ordering nobody wants and the reason the blending exists at all.
  apy: (a, b) => (b.scores?.blendedGross ?? b.apy?.total ?? b.expected?.annualReturn ?? -1e9)
    - (a.scores?.blendedGross ?? a.apy?.total ?? a.expected?.annualReturn ?? -1e9),
  afterTax: (a, b) => (b.scores?.blendedAfterTax ?? b.tax?.afterTaxApy ?? -1e9)
    - (a.scores?.blendedAfterTax ?? a.tax?.afterTaxApy ?? -1e9),
  taxEquivalent: (a, b) => (b.scores?.blendedTaxEquivalent ?? b.tax?.taxEquivalentYield ?? -1e9)
    - (a.scores?.blendedTaxEquivalent ?? a.tax?.taxEquivalentYield ?? -1e9),
  afterTaxReal: (a, b) => (b.scores?.blendedAfterTaxReal ?? b.tax?.afterTaxRealApy ?? -1e9)
    - (a.scores?.blendedAfterTaxReal ?? a.tax?.afterTaxRealApy ?? -1e9),
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

module.exports = {
  REFERENCE_AMOUNT, scoreOne, scoreAll, riskAversion, SORTERS, BASIS };
