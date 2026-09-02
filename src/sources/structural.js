'use strict';

const contract = require('./_contract');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');
const { STATE_TOP_RATES, resolveProfile } = require('../core/tax');

/**
 * STRUCTURAL & TAX PLAYS — the highest-return things an ordinary person can
 * actually do, and the ones no screener lists because they have no ticker.
 *
 * A 50% employer match on the first 6% of pay is a 50% return, in cash, on the
 * day the money lands, with no market risk attached to the match itself. Nothing
 * in the rest of this app comes close, and it is invisible to every yield table
 * ever built because there is nothing to buy. The same is true of the $3,000 of
 * ordinary income a realised capital loss offsets, of the payroll-tax saving on
 * an FSA election, and of a state's 529 deduction, which is worth a flat state
 * income tax rate the moment the money moves.
 *
 * Four things make this source different from every other one here, and each is
 * enforced structurally rather than left to prose:
 *
 *  1. THE RETURN IS ON THE CONTRIBUTION, NOT ON A PORTFOLIO. A 50% match is 50%
 *     of what you defer, capped by the plan's deferral limit. So the limit is
 *     `maxInvestment` on every row where one exists, and score.js blends the
 *     rate down over a larger budget automatically. Nobody's whole net worth
 *     earns 50%.
 *
 *  2. THE GUARANTEE AND THE INVESTMENT ARE DIFFERENT THINGS. The match is
 *     certain; the index fund you then buy inside the 401(k) is not, and it is
 *     someone else's row in this app. Conflating them is the single most common
 *     way this subject is described dishonestly, so every affected row says so
 *     in `notes` explicitly.
 *
 *  3. MOST OF THESE DEPEND ON WHO YOU ARE. A 529 deduction is worth a Texan
 *     exactly nothing and an Illinois resident 4.95% on the spot. A backdoor
 *     Roth is pointless below the income phase-out. So the rate is COMPUTED from
 *     ctx.settings.tax where it depends on the user, the row says what it was
 *     computed from, and eligibility lives in `requirements[]` where it can be
 *     read at a glance rather than buried in a paragraph.
 *
 *  4. MOST OF THESE HAVE A DEADLINE. Harvesting a loss, funding an FSA, taking a
 *     529 deduction and making a QCD all die at midnight on 31 December, which
 *     is precisely when everyone forgets. IRA contributions run to the April
 *     filing deadline. I-bond composite rates reset on 1 May and 1 November.
 *     Every one of those is computed from the clock as the NEXT occurrence, so
 *     the row surfaces under "closing soon" every year rather than expiring once
 *     and going quiet forever.
 *
 * There is no API for any of this. The rules live in the Internal Revenue Code,
 * in plan documents and on TreasuryDirect, and the dollar limits are inflation
 * indexed every year. So the curated dataset IS the payload, exactly as in
 * savings.js and bonuses.js, and the status is never better than 'partial'.
 */

const ID = 'structural';
const LABEL = 'Structural & Tax Plays';
const SEED_FILE = 'structural.json';
const FALLBACK_AS_OF = '2026-08-01';

/**
 * Confidence ceiling.
 *
 * The RULES here are more durable than any rate in this app — the Internal
 * Revenue Code does not reprice on a Tuesday — but the LIMITS are indexed
 * annually and the plan-specific facts (does your employer match, does your plan
 * allow after-tax contributions) are unknowable from here. So the structure is
 * trustworthy and the arithmetic is an estimate, and the ceiling reflects the
 * weaker of the two.
 */
const CURATED_CONFIDENCE = 0.55;
const SEED_CONFIDENCE = 0.45;

/** Combined employee-side payroll tax. Halves above the wage base — see notes. */
const FICA_RATE = 7.65;
const FICA_MEDICARE_ONLY = 1.45;
/** 2026 Social Security wage base, approximately. Indexed every year. */
const SS_WAGE_BASE = 184500;

/** A tax rate outside this band is a data-entry error, not a tax rate. */
const MAX_BENEFIT_RATE = 200;

/** Milliseconds past which new Date(t).toISOString() throws RangeError. */
const MAX_TIME = 8.64e15;

/**
 * What kind of promise is behind the money, which is the only thing that decides
 * how safe it is.
 *
 * A tax rule is as close to a guarantee as this app ever gets: Congress does not
 * retroactively repeal the capital-loss deduction in November. An employer match
 * is a different animal — it is one company's promise, it is subject to a vesting
 * schedule, and an unvested match is not your money. Those two must never carry
 * the same insurance badge, so the distinction is structural rather than a
 * sentence someone might skim.
 *
 * taxTreatment is chosen so the after-tax engine does not tax the benefit twice.
 * A tax saving is not itself taxable income, so a permanent saving is marked
 * exempt; a pre-tax retirement deduction is marked deferred, because that money
 * genuinely is taxed later, on the way out.
 */
const KINDS = {
  // A statutory federal or state tax rule. The benefit is permanent and untaxed.
  tax_rule: {
    subType: 'tax_rule',
    insurance: baseC.INSURANCE.US_GOV,
    taxTreatment: baseC.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT,
    yieldKind: baseC.YIELD_KIND.CONTRACTUAL,
    guarantee: 'This is a tax rule, not an investment. The saving is as certain as the tax code itself for the year you act in, which is why it is marked government-backed — but the code is amended regularly, and a rule that exists this year may be indexed, phased out or repealed next year.',
  },
  // A pre-tax retirement deduction: real money now, ordinary income tax later.
  tax_deferral: {
    subType: 'tax_deferral',
    insurance: baseC.INSURANCE.US_GOV,
    taxTreatment: baseC.TAX_TREATMENT.TAX_DEFERRED,
    yieldKind: baseC.YIELD_KIND.CONTRACTUAL,
    guarantee: 'The deduction is statutory and immediate. It is a DEFERRAL, not a pardon: the money and everything it earns is taxed as ordinary income when you withdraw it, so the real gain is the difference between your rate now and your rate then, plus decades of compounding on money the government has not taken yet.',
  },
  // The benefit is tax NOT paid on future investment growth. Statutory rule,
  // uncertain amount, because it depends on what you actually earn.
  tax_shelter: {
    subType: 'tax_free_growth',
    insurance: baseC.INSURANCE.US_GOV,
    taxTreatment: baseC.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT,
    yieldKind: baseC.YIELD_KIND.MARKET,
    guarantee: 'The shelter is statutory; the size of the benefit is not. It is your tax rate applied to whatever the account actually earns, so the rate shown is an estimate built on an assumed return, and the underlying investment carries its own risk which this row does not describe.',
  },
  // One employer's promise, governed by a plan document and a vesting schedule.
  employer_promise: {
    subType: 'employer_match',
    insurance: baseC.INSURANCE.NONE,
    taxTreatment: baseC.TAX_TREATMENT.TAX_DEFERRED,
    yieldKind: baseC.YIELD_KIND.CONTRACTUAL,
    guarantee: 'This is your employer\'s promise, not the government\'s. It is contractual — the plan document says what it pays — but it is not insured, it stops the day you leave, and an unvested match is not yours yet.',
  },
  // A Treasury retail savings programme: real interest, government-backed.
  treasury_program: {
    subType: 'savings_bond',
    insurance: baseC.INSURANCE.US_GOV,
    taxTreatment: baseC.TAX_TREATMENT.TREASURY,
    yieldKind: baseC.YIELD_KIND.VARIABLE,
    guarantee: 'Backed by the full faith and credit of the United States. Federal income tax applies to the interest and is deferred until you redeem; state and local income tax never applies.',
  },
  // An issuer's own policy: unofficial, unilateral, and changed without notice.
  provider_policy: {
    subType: 'issuer_policy',
    insurance: baseC.INSURANCE.NONE,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    yieldKind: baseC.YIELD_KIND.ADMINISTERED,
    guarantee: 'This is one company\'s policy, not a law and usually not even a published term. It can change tomorrow, it is applied inconsistently, and nothing obliges the issuer to honour it.',
  },
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : 'an unstated amount');
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(Math.abs(n) >= 10 ? 1 : 2)}%` : 'an unknown rate');

/**
 * A tax profile we can do arithmetic on.
 *
 * resolveProfile() merges the user's settings over its defaults, which means an
 * explicitly null bracket in a saved settings file OVERRIDES the default with
 * null rather than falling back to it. Every rate in this file is then computed
 * from that null. Repairing it here keeps one bad settings value from emptying
 * the whole source.
 */
function safeProfile(input) {
  const p = resolveProfile(input && typeof input === 'object' && !Array.isArray(input) ? input : {});
  const fix = (v, d) => {
    const n = toNum(v);
    return n === null || n < 0 || n > 100 ? d : n;
  };
  return {
    ...p,
    federalOrdinary: fix(p.federalOrdinary, 24),
    federalLtcg: fix(p.federalLtcg, 15),
    stateRate: fix(p.stateRate, 0),
    state: typeof p.state === 'string' && /^[A-Za-z]{2}$/.test(p.state) ? p.state.toUpperCase() : 'your state',
    niitApplies: !!p.niitApplies,
  };
}

// ---------------------------------------------------------------------------
// Dates. Every window here is an ANNUAL recurrence, so it is computed as the
// next occurrence from the clock rather than stored.
// ---------------------------------------------------------------------------

/**
 * A date the rest of the app can hold without exploding.
 *
 * new Date(t).toISOString() throws RangeError outside +/-8.64e15 ms, and that
 * exact throw has taken down four adapters in this codebase. Everything that
 * produces a date here goes through this function, and it returns null rather
 * than throwing on anything it cannot represent.
 */
function isoAt(year, month, day, endOfDay = true) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const t = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  if (!Number.isFinite(t) || Math.abs(t) > MAX_TIME) return null;
  try {
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

/** A clock value we are willing to do arithmetic on. */
function safeNow(nowMs) {
  return Number.isFinite(nowMs) && Math.abs(nowMs) <= MAX_TIME ? nowMs : Date.now();
}

/**
 * The next 31 December, the next 15 April, the next 1 November.
 *
 * Strictly future: a deadline that passed an hour ago is next year's deadline,
 * not an expired row. Expired rows are hidden by the default query, which for a
 * recurring statutory deadline would mean the tax-loss harvesting row vanishing
 * on 1 January and never coming back.
 */
function nextAnnual(nowMs, month, day, { endOfDay = true } = {}) {
  const now = safeNow(nowMs);
  const y = new Date(now).getUTCFullYear();
  for (let i = 0; i <= 2; i += 1) {
    const iso = isoAt(y + i, month, day, endOfDay);
    if (iso) {
      const t = Date.parse(iso);
      if (Number.isFinite(t) && t > now) return iso;
    }
  }
  return null;
}

/**
 * The window that is currently open, or the next one that will be.
 *
 * Open enrollment is the case that needs this: in early November the window is
 * open, so its start is in the PAST and its end is days away. Taking the next
 * start and the next end independently would produce a row that both opens next
 * October and closes this November.
 */
function annualWindow(nowMs, startMonth, startDay, endMonth, endDay) {
  const now = safeNow(nowMs);
  const y = new Date(now).getUTCFullYear();
  for (let i = 0; i <= 2; i += 1) {
    const startsAt = isoAt(y + i, startMonth, startDay, false);
    const expiresAt = isoAt(y + i, endMonth, endDay, true);
    const end = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(end) && end > now) return { startsAt, expiresAt };
  }
  return { startsAt: null, expiresAt: null };
}

/** Last instant of the current month, or of the next one if that has passed. */
function nextMonthEnd(nowMs) {
  const now = safeNow(nowMs);
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;                       // 1-based
  for (let i = 0; i <= 2; i += 1) {
    const year = y + Math.floor((m - 1 + i) / 12);
    const month = ((m - 1 + i) % 12) + 1;
    // Day 0 of the following month is the last day of this one, which is the
    // only correct way to get 28/29/30/31 without a leap-year table.
    const probe = Date.UTC(year, month, 0);
    if (!Number.isFinite(probe) || Math.abs(probe) > MAX_TIME) return null;
    const lastDay = new Date(probe).getUTCDate();
    const iso = isoAt(year, month, lastDay, true);
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t) && t > now) return iso;
  }
  return null;
}

/**
 * Series I savings bond rates reset on 1 May and 1 November. Buying before a
 * reset locks the CURRENT composite for a full six months, which is a real and
 * completely free piece of timing when the next rate is expected to be lower.
 * The window closes the day before the reset.
 */
function nextIBondReset(nowMs) {
  const apr = nextAnnual(nowMs, 4, 30);
  const oct = nextAnnual(nowMs, 10, 31);
  const candidates = [apr, oct].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  const expiresAt = candidates[0] || null;
  if (!expiresAt) return { expiresAt: null, resetLabel: null };
  const month = new Date(Date.parse(expiresAt)).getUTCMonth() + 1;
  return { expiresAt, resetLabel: month === 4 ? '1 May' : '1 November' };
}

/** Resolve a seed window spec into {startsAt, expiresAt, sentence}. */
function resolveWindow(spec, nowMs) {
  const none = { startsAt: null, expiresAt: null, sentence: '' };
  if (!spec || typeof spec !== 'object') return none;
  const now = safeNow(nowMs);

  switch (String(spec.type || '')) {
    case 'year_end': {
      const expiresAt = nextAnnual(now, 12, 31);
      return {
        startsAt: null,
        expiresAt,
        sentence: 'Hard deadline of 31 December: this is a calendar-year action, it cannot be done retroactively in the spring, and an unused year is gone for good.',
      };
    }
    case 'filing_deadline': {
      const expiresAt = nextAnnual(now, 4, 15);
      return {
        startsAt: null,
        expiresAt,
        sentence: 'Unusually, this one is NOT a 31 December deadline: you have until the April filing deadline (no extensions) to make a contribution for the prior tax year, so for a few months two years are open at once.',
      };
    }
    case 'extended_filing_deadline': {
      // Distinct from `filing_deadline`, whose sentence says "no extensions" —
      // true for an IRA or HSA contribution and false for a SEP-IRA or the
      // employer side of a solo 401(k), which are expressly due at the business
      // return's due date INCLUDING extensions. Filing those under the wrong
      // type told a sole proprietor who extended that they had missed a window
      // still open to them for another six months, while the same row's own
      // access notes said the opposite.
      const expiresAt = nextAnnual(now, 10, 15);
      return {
        startsAt: null,
        expiresAt,
        sentence: 'Due with the business return, INCLUDING extensions — so 15 October if you extend, and the '
          + 'regular filing deadline if you do not. That makes this one of the very few moves still available '
          + 'after the tax year has closed.',
      };
    }
    case 'month_end': {
      const expiresAt = nextMonthEnd(now);
      return {
        startsAt: null,
        expiresAt,
        sentence: 'Elected month by month, so the deadline is the end of the current month and every month you miss is money left on the table permanently.',
      };
    }
    case 'ibond_reset': {
      const { expiresAt, resetLabel } = nextIBondReset(now);
      return {
        startsAt: null,
        expiresAt,
        sentence: resetLabel
          ? `Rates reset on ${resetLabel}. A bond bought before the reset earns the CURRENT composite for a full six months before it moves to the new one, so the purchase date, not the calendar year, decides what you get.`
          : 'Rates reset on 1 May and 1 November.',
      };
    }
    case 'open_enrollment': {
      const { startsAt, expiresAt } = annualWindow(now, 10, 15, 11, 30);
      return {
        startsAt,
        expiresAt,
        sentence: 'Employer open enrollment typically runs from mid-October to the end of November, and the exact dates are your employer\'s, not a statute\'s. Outside it you cannot start or change most of these elections at all without a qualifying life event — marriage, a birth, a job change or a loss of other coverage.',
      };
    }
    case 'fixed_start': {
      const t = Date.parse(String(spec.date || ''));
      if (!Number.isFinite(t) || Math.abs(t) > MAX_TIME) return none;
      let startsAt = null;
      try {
        startsAt = t > now ? new Date(t).toISOString() : null;
      } catch {
        startsAt = null;
      }
      return {
        startsAt,
        expiresAt: null,
        sentence: startsAt
          ? 'This does not exist yet. It is legislated and dated, which is why it is here — the point of knowing about it now is to be positioned when it opens, not to act today.'
          : 'The start date for this has now passed, so it should be live. Confirm the implementing rules have actually landed before relying on it.',
      };
    }
    default:
      return none;
  }
}

// ---------------------------------------------------------------------------
// The arithmetic. Pure, exported, and unit-tested — this is the product.
// ---------------------------------------------------------------------------

/**
 * What an employer match is actually worth.
 *
 * The canonical shape is "50% of the first 6% of pay". Two separate percentages
 * that people routinely conflate:
 *
 *   matchLimitPercent  how much of YOUR pay you must defer to collect it all
 *   matchPercent       what the employer adds per dollar you defer
 *
 * So on $80,000 with 50% on the first 6%, you defer $4,800 and they add $2,400.
 * The RETURN is 50% — not 3%, which is what the match is worth as a share of
 * salary, and not 30%, which is what you get by dividing by the wrong number.
 * The return is on the money you defer, and only up to the limit: the very next
 * dollar you defer earns nothing extra, which is why the plan's deferral cap is
 * carried as maxInvestment on the row.
 *
 * @returns {{employeeContribution, employerMatch, returnPct, cappedByLimit}|null}
 */
function matchValue(args) {
  // Destructuring a default only guards `undefined`; an explicit null still
  // throws, and null is exactly what a caller reading a half-filled form passes.
  if (args === null || args === undefined || typeof args !== 'object') return null;
  const { salary, matchPercent, matchLimitPercent, deferralLimit = null } = args;
  const s = toNum(salary);
  const m = toNum(matchPercent);
  const lim = toNum(matchLimitPercent);
  const hardCap = toNum(deferralLimit);

  if (s === null || m === null || lim === null) return null;
  if (s <= 0 || m < 0 || lim <= 0) return null;
  if (m > 1000 || lim > 100) return null;         // not a match, a typo

  const wanted = s * (lim / 100);
  // The statutory deferral limit bites before the match limit for high earners
  // with a generous formula, and when it does, part of the match is unreachable.
  const cappedByLimit = hardCap !== null && hardCap > 0 && wanted > hardCap;
  const employeeContribution = cappedByLimit ? hardCap : wanted;
  const employerMatch = employeeContribution * (m / 100);

  if (!Number.isFinite(employeeContribution) || !Number.isFinite(employerMatch)) return null;

  return {
    employeeContribution: Math.round(employeeContribution * 100) / 100,
    employerMatch: Math.round(employerMatch * 100) / 100,
    // Return ON the deferred dollars, which is the only honest denominator.
    returnPct: Math.round(m * 1e4) / 1e4,
    cappedByLimit,
  };
}

/**
 * What realising a capital loss is worth this year.
 *
 * The order is fixed by statute and it matters: losses net against gains of the
 * same character first, then against gains of the other character, and only the
 * remainder — capped at $3,000 a year — comes off ordinary income. Anything
 * still left carries forward indefinitely.
 *
 * The ordinary-income slice is the valuable part, because it is deducted at your
 * ordinary rate rather than the long-term capital gains rate: at 24% federal
 * that $3,000 is $720 in cash, every year, for as long as the carryforward
 * lasts. And the whole thing has a 31 December deadline, because the loss has to
 * be REALISED — an unsold loser is worth nothing at all.
 *
 * @returns {{againstGains, againstOrdinary, carryforward, taxSaved, effectiveRatePct}|null}
 */
function harvestValue(args) {
  if (args === null || args === undefined || typeof args !== 'object') return null;
  const {
    lossRealised, federalRate, stateRate,
    gainsOffset = 0, gainsRate = null, ordinaryCap = 3000,
  } = args;
  const loss = toNum(lossRealised);
  const fed = toNum(federalRate);
  const state = toNum(stateRate);
  const gains = toNum(gainsOffset) ?? 0;
  const cap = toNum(ordinaryCap);

  if (loss === null || fed === null || state === null) return null;
  if (loss < 0 || fed < 0 || state < 0 || gains < 0) return null;
  if (fed > 100 || state > 100) return null;
  if (cap === null || cap < 0) return null;

  const ordinaryRate = fed + state;
  // Gains are relieved at whatever rate they would have been taxed at. Absent a
  // stated rate, assume the loss is offsetting gains taxed like ordinary income,
  // which is the conservative reading for a short-term position.
  const gainRate = gainsRate === null || gainsRate === undefined ? ordinaryRate : toNum(gainsRate);
  if (gainRate === null || gainRate < 0 || gainRate > 100) return null;

  const againstGains = Math.min(loss, gains);
  const remainder = loss - againstGains;
  const againstOrdinary = Math.min(remainder, cap);
  const carryforward = remainder - againstOrdinary;

  const taxSaved = againstGains * (gainRate / 100) + againstOrdinary * (ordinaryRate / 100);
  if (!Number.isFinite(taxSaved)) return null;

  return {
    againstGains: Math.round(againstGains * 100) / 100,
    againstOrdinary: Math.round(againstOrdinary * 100) / 100,
    carryforward: Math.round(carryforward * 100) / 100,
    taxSaved: Math.round(taxSaved * 100) / 100,
    // What the harvest returned on the loss you actually realised this year.
    // Well below the headline rate once the $3,000 cap bites, which is the whole
    // point of computing it rather than quoting a bracket.
    effectiveRatePct: loss > 0 ? Math.round((taxSaved / loss) * 1e6) / 1e4 : 0,
  };
}

/**
 * What a state 529 deduction is worth, in cash, immediately.
 *
 * A deduction is worth the contribution times your STATE rate — not the federal
 * rate, and not the combined rate. It is capped in most states, and the cap is
 * the reason the honest return figure falls the more you put in: $20,000 into a
 * plan with a $10,000 cap returns the state rate on half of it and nothing on
 * the rest.
 *
 * @returns {{deducted, taxSaved, effectiveRatePct, cappedOut}|null}
 */
function stateDeductionValue(args) {
  if (args === null || args === undefined || typeof args !== 'object') return null;
  const { contribution, stateRate, cap = null } = args;
  const c = toNum(contribution);
  const r = toNum(stateRate);
  const limit = toNum(cap);

  if (c === null || r === null) return null;
  if (c < 0 || r < 0 || r > 100) return null;
  if (limit !== null && limit < 0) return null;

  const deducted = limit === null ? c : Math.min(c, limit);
  const taxSaved = deducted * (r / 100);
  if (!Number.isFinite(taxSaved)) return null;

  return {
    deducted: Math.round(deducted * 100) / 100,
    taxSaved: Math.round(taxSaved * 100) / 100,
    effectiveRatePct: c > 0 ? Math.round((taxSaved / c) * 1e6) / 1e4 : 0,
    cappedOut: limit !== null && c > limit,
  };
}

// ---------------------------------------------------------------------------
// 529 state benefits. Approximate, and approximate on purpose.
// ---------------------------------------------------------------------------

/**
 * Whether a state gives you anything for a 529 contribution, and how much.
 *
 * This varies more than any other number in the app: some states deduct the
 * entire contribution, some cap it at $500, seven give a credit instead, nine
 * have no income tax so the question does not arise, and a handful — California
 * and North Carolina among them — tax income and give nothing at all. The caps
 * are per year and most are stated per taxpayer; several are per beneficiary,
 * which quietly multiplies for a family with three children.
 *
 * `parity` means the deduction follows ANY state's plan, so you can take your
 * home-state deduction while holding a better plan elsewhere. In every other
 * state the deduction is the only reason to use the in-state plan, and it has to
 * be weighed against that plan's fees.
 *
 * Caps move every year and several states have changed their rules recently.
 * These are the right order of magnitude and nothing more.
 */
const STATE_529 = {
  AL: { kind: 'deduction', cap: 5000, capMfj: 10000 },
  AK: { kind: 'no_income_tax' },
  AZ: { kind: 'deduction', cap: 2000, capMfj: 4000, parity: true },
  AR: { kind: 'deduction', cap: 5000, capMfj: 10000 },
  CA: { kind: 'none' },
  CO: { kind: 'deduction', cap: null, note: 'the full contribution, subject to a per-beneficiary limit' },
  CT: { kind: 'deduction', cap: 5000, capMfj: 10000, note: 'with a five-year carryforward of anything above the cap' },
  DE: { kind: 'deduction', cap: 1000, capMfj: 2000, note: 'subject to income limits' },
  DC: { kind: 'deduction', cap: 4000, capMfj: 8000 },
  FL: { kind: 'no_income_tax' },
  GA: { kind: 'deduction', cap: 4000, capMfj: 8000 },
  HI: { kind: 'none' },
  ID: { kind: 'deduction', cap: 6000, capMfj: 12000 },
  IL: { kind: 'deduction', cap: 10000, capMfj: 20000 },
  IN: { kind: 'credit', creditRate: 20, cap: 7500, note: 'a 20% credit capped at $1,500 of credit' },
  IA: { kind: 'deduction', cap: 3800, capMfj: 7600, note: 'per beneficiary, indexed annually' },
  KS: { kind: 'deduction', cap: 3000, capMfj: 6000, parity: true },
  KY: { kind: 'none' },
  LA: { kind: 'deduction', cap: 2400, capMfj: 4800, note: 'with an unlimited carryforward' },
  ME: { kind: 'none' },
  MD: { kind: 'deduction', cap: 2500, capMfj: 5000, note: 'per beneficiary, with a ten-year carryforward' },
  MA: { kind: 'deduction', cap: 1000, capMfj: 2000 },
  MI: { kind: 'deduction', cap: 5000, capMfj: 10000 },
  MN: { kind: 'credit', creditRate: 50, cap: 1000, parity: true, note: 'either a credit that phases out with income or a deduction — you choose' },
  MS: { kind: 'deduction', cap: 10000, capMfj: 20000 },
  MO: { kind: 'deduction', cap: 8000, capMfj: 16000, parity: true },
  MT: { kind: 'deduction', cap: 3000, capMfj: 6000, parity: true },
  NE: { kind: 'deduction', cap: 10000, capMfj: 10000 },
  NV: { kind: 'no_income_tax' },
  NH: { kind: 'no_income_tax' },
  NJ: { kind: 'deduction', cap: 10000, capMfj: 10000, note: 'only for households under roughly $200,000 of gross income' },
  NM: { kind: 'deduction', cap: null, note: 'the full contribution' },
  NY: { kind: 'deduction', cap: 5000, capMfj: 10000 },
  NC: { kind: 'none' },
  ND: { kind: 'deduction', cap: 5000, capMfj: 10000 },
  OH: { kind: 'deduction', cap: 4000, capMfj: 4000, note: 'per beneficiary, with an unlimited carryforward' },
  OK: { kind: 'deduction', cap: 10000, capMfj: 20000, note: 'with a five-year carryforward' },
  OR: { kind: 'credit', creditRate: 100, cap: 360, note: 'a flat credit that shrinks as income rises, not a percentage deduction' },
  PA: { kind: 'deduction', cap: 19000, capMfj: 38000, parity: true, note: 'up to the annual gift-tax exclusion per beneficiary' },
  RI: { kind: 'deduction', cap: 500, capMfj: 1000 },
  SC: { kind: 'deduction', cap: null, note: 'the full contribution, and uniquely you have until the April filing deadline' },
  SD: { kind: 'no_income_tax' },
  TN: { kind: 'no_income_tax' },
  TX: { kind: 'no_income_tax' },
  UT: { kind: 'credit', creditRate: 4.55, cap: 2500, note: 'a credit at roughly the flat state rate rather than a deduction' },
  VT: { kind: 'credit', creditRate: 10, cap: 2500 },
  VA: { kind: 'deduction', cap: 4000, capMfj: 8000, note: 'per account, with an unlimited carryforward, and unlimited from age 70' },
  WA: { kind: 'no_income_tax' },
  WV: { kind: 'deduction', cap: null, note: 'the full contribution' },
  WI: { kind: 'deduction', cap: 3900, capMfj: 3900, note: 'per beneficiary, indexed annually' },
  WY: { kind: 'no_income_tax' },
};

// ---------------------------------------------------------------------------
// Turning a benefit spec plus a user profile into a rate
// ---------------------------------------------------------------------------

/**
 * The headline rate for one row, and the arithmetic behind it in words.
 *
 * Every rate in this file is a return ON SOMETHING SPECIFIC — a deferred dollar,
 * a realised loss, a pre-tax election — and never a return on a portfolio. The
 * `basis` strings exist so the row can say exactly which, and exactly which of
 * the user's settings produced the number, because a figure computed from a
 * stranger's tax bracket that does not say so is a fabrication.
 *
 * @returns {{rate:number, basis:string[], maxInvestment?:number|null, extra?:string}|null}
 */
function benefitRate(benefit, profile) {
  if (!benefit || typeof benefit !== 'object') return null;
  const p = profile;
  const fed = toNum(p.federalOrdinary) ?? 0;
  const ltcg = toNum(p.federalLtcg) ?? 0;
  const state = toNum(p.stateRate) ?? 0;
  const niit = p.niitApplies ? 3.8 : 0;
  const basis = [];
  let rate = null;
  let maxInvestment;
  let extra = '';

  switch (String(benefit.type || '')) {
    case 'fixed':
      rate = toNum(benefit.rate);
      break;

    case 'ordinary': {
      const fica = benefit.fica ? FICA_RATE : 0;
      rate = fed + state + fica;
      basis.push(`${pct(fed)} federal ordinary`);
      basis.push(`${pct(state)} ${p.state} state`);
      if (fica) {
        basis.push(`${pct(FICA_RATE)} employee payroll tax`);
        extra = `The payroll-tax slice only applies to money that never appears on your W-2 as wages, which is what makes an employer-run election different from a deduction you claim on a return. Above the Social Security wage base — roughly ${money(SS_WAGE_BASE)} — it falls to the ${pct(FICA_MEDICARE_ONLY)} Medicare portion, so a high earner should read this row at about ${pct(fed + state + FICA_MEDICARE_ONLY)}.`;
      }
      break;
    }

    case 'ltcg':
      rate = ltcg + state + niit;
      basis.push(`${pct(ltcg)} federal long-term capital gains`);
      basis.push(`${pct(state)} ${p.state} state`);
      if (niit) basis.push('3.8% net investment income tax');
      break;

    case 'bracket_delta': {
      const lower = toNum(benefit.lowerRate) ?? 0;
      rate = Math.max(0, fed - lower);
      basis.push(`${pct(fed)} federal ordinary now`);
      basis.push(`an assumed ${pct(lower)} in the low-income year you would convert in`);
      break;
    }

    case 'state_only': {
      const yieldOn = toNum(benefit.assumedYield);
      rate = yieldOn === null ? state : state * (yieldOn / 100);
      basis.push(`${pct(state)} ${p.state} state rate`);
      if (yieldOn !== null) basis.push(`an assumed ${pct(yieldOn)} yield to apply it to`);
      break;
    }

    case 'drag': {
      const assumedYield = toNum(benefit.assumedYield) ?? 4;
      const taxed = benefit.gainsAreLtcg ? ltcg + state + niit : fed + state + niit;
      rate = taxed * (assumedYield / 100);
      basis.push(`${pct(taxed)} combined rate on the income it would otherwise throw off`);
      basis.push(`an assumed ${pct(assumedYield)} annual return`);
      extra = 'This is the tax drag you avoid each year, not a yield the account pays. It is an estimate: earn more and it is worth more, earn nothing and it is worth nothing.';
      break;
    }

    case 'muni': {
      const assumedYield = toNum(benefit.assumedYield) ?? 3.6;
      const inState = !!benefit.inState;
      const combined = fed + (inState ? state : 0);
      rate = combined * (assumedYield / 100);
      basis.push(`${pct(fed)} federal ordinary, which municipal interest is exempt from`);
      if (inState) basis.push(`${pct(state)} ${p.state} state, which in-state paper is also exempt from`);
      else basis.push(`no state relief — out-of-state paper is still taxed by ${p.state}`);
      basis.push(`an assumed ${pct(assumedYield)} municipal yield`);
      break;
    }

    case 'state_529': {
      const entry = STATE_529[p.state];
      if (!entry) {
        // An unrecognised state code must not silently inherit another state's
        // rules, and it must not throw either.
        rate = 0;
        maxInvestment = null;
        basis.push(`no 529 rules on file for "${p.state}" — set a state in Settings and this row computes itself`);
        break;
      }
      const filingCap = entry.capMfj && benefit.married ? entry.capMfj : entry.cap;
      if (entry.kind === 'no_income_tax') {
        rate = 0;
        maxInvestment = null;
        basis.push(`${p.state} has no state income tax, so a deduction is worth exactly nothing`);
      } else if (entry.kind === 'none') {
        rate = 0;
        maxInvestment = null;
        basis.push(`${p.state} taxes income but offers no 529 deduction or credit`);
      } else if (entry.kind === 'credit') {
        rate = toNum(entry.creditRate) ?? 0;
        maxInvestment = toNum(entry.cap);
        basis.push(`${p.state} gives a credit rather than a deduction, which is worth the same whatever your bracket`);
      } else {
        rate = state;
        maxInvestment = filingCap === null || filingCap === undefined ? null : toNum(filingCap);
        basis.push(`${pct(state)} ${p.state} state rate applied to the deducted contribution`);
        if (maxInvestment !== null) basis.push(`a ${money(maxInvestment)} annual cap on what is deductible`);
        else basis.push('no cap on the deductible amount');
      }
      if (entry.note) extra = `${p.state}: ${entry.note}.`;
      if (entry.parity) {
        extra += ` ${p.state} is a parity state — the deduction follows contributions to ANY state's plan, so you can take it while holding a cheaper plan elsewhere.`;
      } else if (entry.kind === 'deduction' || entry.kind === 'credit') {
        extra += ` The benefit is only available on the ${p.state} plan, so it has to be weighed against that plan's fees before it is worth chasing.`;
      }
      break;
    }

    case 'spend_bonus': {
      const value = toNum(benefit.bonusValue);
      const spend = toNum(benefit.requiredSpend);
      if (value === null || spend === null || spend <= 0) return null;
      rate = (value / spend) * 100;
      maxInvestment = spend;
      basis.push(`a ${money(value)} bonus against ${money(spend)} of required spending`);
      break;
    }

    default:
      return null;
  }

  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate < 0 || rate > MAX_BENEFIT_RATE) return null;

  return { rate: Math.round(rate * 1e4) / 1e4, basis, maxInvestment, extra: extra.trim() };
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/**
 * The sentence that keeps the two risks apart.
 *
 * The most misleading thing anyone says about a 401(k) match is "it's a 50%
 * return", full stop, with no mention that the money then buys something that
 * can fall 40%. Both statements are true and they are about different objects:
 * the match is a guaranteed uplift on the contribution, and the fund you buy
 * inside the account is a separate holding with its own row and its own risk in
 * this app. Every account-based row says this.
 */
const SEPARATION = 'The return shown is on the contribution, and it is separate from whatever you then buy inside the account: the uplift is guaranteed, the investment is not. Look up the fund you hold as its own row — its risk is not described here.';

const VERIFY = 'Every dollar limit here is indexed annually and the rules change with each Act of Congress. Confirm the current figures against the IRS page linked before you act.';

/** One curated play -> one normalized opportunity, or null if it is unusable. */
function buildRow(item, { dataAsOf, schema, C, profile, nowMs }) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const kind = KINDS[String(item.kind || '').trim()];
  if (!kind) return null;

  const key = String(item.id ?? item.name ?? '').trim();
  const name = String(item.name ?? item.id ?? '').trim();
  if (!key || !name) return null;

  // A row nobody can act on is noise, and the aggregator refuses rows with
  // neither a link nor instructions anyway.
  const url = String(item.url ?? '').trim();
  const accessNotes = String(item.accessNotes ?? '').trim();
  const appliesTo = String(item.appliesTo ?? '').trim();
  if (!url || !accessNotes || !appliesTo) return null;

  const computed = benefitRate(item.benefit, profile);
  if (!computed) return null;

  const win = resolveWindow(item.window, nowMs);

  // The cap is the plan or statutory limit on what earns this rate. Where the
  // benefit computation derives its own (a state 529 cap), that wins, because it
  // is the one that reflects the user's actual state.
  const maxInvestment = computed.maxInvestment !== undefined
    ? computed.maxInvestment
    : (toNum(item.maxInvestment));

  const minInvestment = toNum(item.minInvestment) ?? 0;
  const termDays = toNum(item.termDays);

  /**
   * The rate these rows compute is a FLAT percentage of the amount, collected
   * once — "your long-term capital gains rate plus state", not a rate per year.
   * Everywhere else in the app a one-off's headline is an annualised figure
   * (bonuses and deals both divide by their holding period to get one), and
   * score.js un-annualises it back into dollars on that assumption.
   *
   * For a tax action taken and collected inside the same year the two are the
   * same number and nothing was ever wrong. For one that takes five years to
   * pay — QSBS — they are not: 15% of a gain realised after five years is a
   * 2.8%-a-year return, and quoting it at 15% ranks it alongside a savings
   * account paying 15% every year, which is the exact category error the whole
   * blending section of score.js exists to prevent.
   *
   * So the rate is annualised here, once, at the source that knows it is flat.
   * The flat figure is not lost: it is what the notes and the payout basis
   * quote, because it is the number the rule is actually about.
   */
  const oneTime = item.oneTime !== false;
  const yearsToPay = Number.isFinite(termDays) && termDays > 365 ? termDays / 365 : 1;
  const headlineRate = (oneTime && yearsToPay > 1 && Number.isFinite(computed.rate) && computed.rate > -100)
    ? (Math.pow(1 + computed.rate / 100, 1 / yearsToPay) - 1) * 100
    : computed.rate;

  const liquidity = Object.values(C.LIQUIDITY).includes(item.liquidity)
    ? item.liquidity
    : C.LIQUIDITY.INSTANT;

  const settingsDependent = computed.basis.length > 0;
  // "The cap" means something specific and worth stating plainly: money beyond it
  // does not earn this rate AT ALL, so the whole opportunity is bounded in
  // dollars however much capital you have. That is also what score.js uses to
  // blend the headline down over a larger budget.
  const capSentence = Number.isFinite(maxInvestment) && maxInvestment > 0
    ? `Capped at ${money(maxInvestment)} a year: money beyond that does not earn this rate at all, so the whole thing is worth at most ${money(maxInvestment * (computed.rate / 100))} in a year, however much you have.`
    : (maxInvestment === null && item.uncappedNote ? String(item.uncappedNote) : '');

  const computedSentence = settingsDependent
    ? `Computed from your tax settings — ${computed.basis.join(', ')}. Change the state or bracket in Settings and this number changes with it.`
    : '';

  const rateOn = String(item.rateOn || '').trim();
  const rateSentence = rateOn
    ? `${pct(computed.rate)} on ${rateOn} — a rate ON that money, not on anything you already hold. Multiply it by what you actually put in.`
    : `${pct(computed.rate)}, as a return on the money this specific action moves rather than on anything you already hold.`;

  // The rows whose dollar value depends on a salary this app has never been
  // told. Quoting a dollar figure for those would be inventing one, so they are
  // rates and they say what the rate is against.
  const salarySentence = item.salaryBased
    ? 'The dollars depend on your pay, which this app does not know and does not ask for — work them out from your own salary and the percentage above.'
    : '';

  const notes = [
    rateSentence,
    salarySentence,
    computedSentence,
    capSentence,
    win.sentence,
    kind.guarantee,
    item.separate === false ? '' : SEPARATION,
    computed.extra,
    String(item.notes || '').trim(),
    VERIFY,
  ].filter(Boolean).join(' ');

  // Eligibility first, always. A backdoor Roth is useless below the phase-out
  // and describing it as universally available would be a lie by omission, so
  // the "who this is for" line is the first requirement on every single row.
  const requirements = [
    `Applies to: ${appliesTo}`,
    ...(Array.isArray(item.requirements) ? item.requirements.map((r) => String(r)).filter(Boolean) : []),
  ];

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key,
    name,
    provider: item.provider || null,
    // Not a security, not a deposit, not something with a ticker. CASH is the
    // honest bucket: the benefit arrives as dollars in your pocket, and the
    // section is what actually files it in the interface.
    assetClass: C.ASSET_CLASS.CASH,
    subType: item.subType || kind.subType,
    track: 'income',
    section: 'deals',
    region: 'US',
    currency: 'USD',

    apy: { total: headlineRate },
    yieldKind: item.yieldKind || kind.yieldKind,
    payoutFrequency: item.payoutFrequency || (item.oneTime === false ? 'annual' : 'one-time'),
    compounding: 1,

    term: {
      days: termDays,
      kind: item.termKind || (Number.isFinite(termDays) && termDays > 0 ? 'lockup' : null),
      label: item.termLabel || null,
      earlyExitPenalty: item.earlyExitPenalty || null,
    },

    minInvestment,
    maxInvestment: Number.isFinite(maxInvestment) ? maxInvestment : null,
    // The rate is exact; the dollars are not, because the cap is a share of a
    // salary this app has never been told. Saying so in the notes was not
    // enough once the ranker started quoting dollar figures — the flag stops it
    // printing "$10,000 once" beside a sentence explaining that the amount is
    // unknowable.
    dollarsUnknown: item.salaryBased === true,
    liquidity,

    risk: {
      insurance: kind.insurance,
      principalAtRisk: kind.insurance === C.INSURANCE.NONE,
    },

    taxTreatment: item.taxTreatment || kind.taxTreatment,

    expiresAt: win.expiresAt,
    startsAt: win.startsAt,
    effort: item.effort || 'light',
    reach: item.reach || 'niche',
    // A tax action is collected once for the year it is taken; it does not
    // compound at its own rate. Rows whose benefit genuinely recurs on a balance
    // year after year say so by setting oneTime false.
    oneTime,
    series: Array.isArray(item.series) ? item.series : null,

    url,
    notes,
    accessNotes,
    requirements,

    dataAsOf: item.dataAsOf || dataAsOf,
    live: false,
    seed: item.origin !== 'user',
  };

  const out = schema.normalize(row, { source: ID, seed: row.seed });
  if (!out) return null;

  // A stated confidence may only LOWER the ceiling, never raise it, and the age
  // decay normalize() already applied still wins if it is lower.
  const ceiling = row.seed ? SEED_CONFIDENCE : CURATED_CONFIDENCE;
  const stated = toNum(item.confidence);
  const cap = stated === null ? ceiling : Math.max(0, Math.min(stated, ceiling));
  out.confidence = Number(Math.min(out.confidence ?? cap, cap).toFixed(3));
  return out;
}

/** PURE ENTRY POINT: curated items -> opportunities. Never throws. */
function buildRows(items, ctx = {}) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const dataAsOf = ctx.dataAsOf || FALLBACK_AS_OF;
  const profile = safeProfile(ctx.taxProfile);
  const nowMs = safeNow(ctx.now);

  const opportunities = [];
  const seen = new Set();
  let skipped = 0;
  let zeroValue = 0;

  for (const item of Array.isArray(items) ? items : []) {
    let row = null;
    try {
      row = buildRow(item, { dataAsOf, schema, C, profile, nowMs });
    } catch {
      row = null;   // one malformed play must never take the source down
    }
    if (!row || seen.has(row.id)) { skipped += 1; continue; }
    seen.add(row.id);
    if (row.apy.total === 0) zeroValue += 1;
    opportunities.push(row);
  }

  return { opportunities, skipped, zeroValue, profile };
}

// ---------------------------------------------------------------------------
// Adapter entry points
// ---------------------------------------------------------------------------

const VERIFY_WARNING = 'Nothing here is tax advice, and no row is a quote. Contribution limits are indexed every year, income phase-outs move, several of these rules were rewritten by recent legislation and a few depend entirely on what your specific employer\'s plan document allows. Every row is computed from the tax settings you entered — a wrong state or bracket makes every number on this list wrong. Open the linked IRS or Treasury page and confirm the current figures before you move money, and take advice before doing anything irreversible.';

const MATCH_WARNING = 'An employer match is your employer\'s promise, not an insured or government-backed one, and it is subject to a vesting schedule: an unvested match is not your money and you forfeit it if you leave early. It is also completely separate from investment risk — the match is guaranteed on the contribution, and whatever you buy inside the account can still fall.';

function collect(ctx) {
  const schema = ctx?.schema || baseSchema;
  const C = ctx?.C || baseC;
  const { items, meta } = contract.readSeed(ctx?.seedDir, SEED_FILE);
  const asOf = typeof meta?.dataAsOf === 'string' && meta.dataAsOf.trim() ? meta.dataAsOf.trim() : FALLBACK_AS_OF;

  const built = buildRows(items, {
    schema, C, dataAsOf: asOf, now: ctx?.now,
    taxProfile: ctx?.settings?.tax || {},
  });

  const p = built.profile;
  const notes = [
    `${built.opportunities.length} structural and tax plays, bundled as of ${asOf}.`,
    `Computed for a ${pct(p.federalOrdinary)} federal ordinary bracket, ${pct(p.federalLtcg)} long-term capital gains and ${p.state} at ${pct(p.stateRate)}${p.niitApplies ? ', including the 3.8% net investment income tax' : ''}. These come from your tax settings and every dollar figure on every row depends on them.`,
    'These are not securities and they have no tickers, which is exactly why no screener lists them. A 50% employer match is a larger, safer, more certain return than anything else in this app, and it is invisible to every yield table ever built because there is nothing to buy.',
    'Where a figure depends on something this app cannot know — your salary, your plan document, how much you have to harvest — the row is expressed as a RATE and says what the rate is on. Multiply it by your own numbers.',
  ];
  if (built.skipped) {
    notes.push(`${built.skipped} row(s) skipped — unknown kind, no link, no access notes, no eligibility statement, or a benefit rate that could not be computed.`);
  }
  if (built.zeroValue) {
    notes.push(`${built.zeroValue} row(s) are worth exactly nothing to you and are shown anyway: a 529 deduction or a state tax exemption is worth zero in a state with no income tax, and knowing not to pay up for it is worth as much as knowing to chase it.`);
  }
  const withDeadlines = built.opportunities.filter((o) => o.expiresAt).length;
  if (withDeadlines) {
    notes.push(`${withDeadlines} of these have a real deadline attached. Most die at midnight on 31 December, which is exactly when people forget them, so they are dated rather than described.`);
  }

  return { built, notes };
}

/**
 * There is nothing to fetch, and saying so plainly every time is the point.
 *
 * The IRS publishes limits as HTML pages and PDFs, not as an API; plan documents
 * are private; state 529 rules live in fifty separate statutes. Even with a
 * network this source would be a curated dataset, so it is 'partial' at best —
 * the thing that would make it 'ok' is a human reading their own plan document.
 */
async function fetch(ctx) {
  try {
    const { built, notes } = collect(ctx || {});
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        notes,
        warnings: ['No usable rows in the bundled structural dataset.'],
      });
    }
    ctx?.log?.(`structural: ${built.opportunities.length} plays computed for ${built.profile.state} at ${built.profile.federalOrdinary}% federal`);
    return contract.result({
      opportunities: built.opportunities,
      status: 'partial',
      notes,
      warnings: [VERIFY_WARNING, MATCH_WARNING],
    });
  } catch (err) {
    return contract.failure(err);
  }
}

function loadSeed(ctx) {
  try {
    const { built, notes } = collect(ctx || {});
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        warnings: ['Bundled structural dataset is missing or unreadable.'],
      });
    }
    return contract.result({
      opportunities: built.opportunities,
      status: 'offline',
      notes,
      warnings: [VERIFY_WARNING, MATCH_WARNING],
    });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'The highest-return things an ordinary person can do, none of which have tickers: employer matches, the triple-tax HSA, backdoor and mega-backdoor Roth, tax-loss harvesting before 31 December, I-bond rate-reset timing, state 529 deductions, FSA and commuter elections, and the churning cadence rules.',
  homepage: 'https://www.irs.gov/retirement-plans',
  assetClasses: [baseC.ASSET_CLASS.CASH],
  requiresNetwork: false,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 24 * 60 * 60 * 1000,

  fetch,
  loadSeed,

  // The maths and the pure path, for the tests and anything else that wants them.
  matchValue,
  harvestValue,
  stateDeductionValue,
  benefitRate,
  buildRow,
  buildRows,
  resolveWindow,
  safeProfile,
  nextAnnual,
  annualWindow,
  nextMonthEnd,
  nextIBondReset,
  isoAt,
  KINDS,
  STATE_529,
  FICA_RATE,
  MAX_BENEFIT_RATE,
  CURATED_CONFIDENCE,
  SEED_CONFIDENCE,
};
