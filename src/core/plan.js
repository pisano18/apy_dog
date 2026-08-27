'use strict';

const { EFFORT_INFO } = require('./opportunity-kinds');

/**
 * Turn a ranked list into an ordered plan.
 *
 * A sorted table answers "what pays the most", which is not the question anyone
 * actually has. The real question is "given this much money and this much
 * patience, what should I do first" — and the answer is frequently NOT the row
 * at the top, because personal finance has a strict ordering that dominates any
 * yield comparison.
 *
 * A dollar-for-dollar employer match is a 100% instant return. No security in
 * this app or any other beats it, and someone comparing a 5.4% CD against a
 * 4.9% one while leaving a match on the table is optimising the wrong decimal
 * by two orders of magnitude. Same for a credit card at 25%: paying it is a
 * guaranteed 25% after-tax return, which nothing here can touch.
 *
 * So the plan is tiered, and within a tier it allocates capital until the tier
 * is full and moves on. The ordering is the opinion; every number in it comes
 * from the same scoring the rest of the app uses.
 *
 * What it deliberately will not do is pretend to know things it has not been
 * told. It does not know your salary, your debts, or whether your employer
 * matches at all. Those are asked for as plain facts, and every step that
 * depends on one says which.
 */

/** Tiers, most-binding first. The order here IS the advice. */
const TIERS = [
  {
    key: 'match',
    title: 'Take the whole employer match',
    why: 'A dollar-for-dollar match is a 100% return the day you make it, guaranteed by your employer and '
      + 'available to nobody else. Nothing else in this app is close, and every dollar of it you leave behind '
      + 'is gone at the end of the year.',
  },
  {
    key: 'debt',
    title: 'Clear the expensive debt',
    why: 'Paying down a balance at 25% is a guaranteed, tax-free 25% return. No investment here can promise '
      + 'that, and carrying the balance while chasing a 6% yield loses money every month with certainty.',
  },
  {
    key: 'buffer',
    title: 'Put the buffer somewhere that pays',
    why: 'Not the highest return on the page, and the one that stops the others from being sold at the worst '
      + 'possible moment. Cash you might need within a year does not belong anywhere it can fall.',
  },
  {
    key: 'expiring',
    title: 'Collect what is about to disappear',
    why: 'Bounded money with a deadline. The return per dollar is usually the highest in the app and the window '
      + 'is the only reason it is this high up — these are worth doing before the tier below, purely because '
      + 'the tier below will still be there next month and these will not.',
  },
  {
    key: 'bounded',
    title: 'Take the free money that is not going anywhere',
    why: 'Same bounded offers, no deadline pressure. Ordered by what an hour of your time earns rather than by '
      + 'headline rate, because a $1,500 referral needing five friends to sign up and four hours of nagging is '
      + 'worth less per hour than a $300 bonus you finish this afternoon.',
  },
  {
    key: 'tax',
    title: 'Use the tax room',
    why: 'A deduction or an exemption is a return, collected once a year, with no market risk attached to it. '
      + 'It is invisible to every yield table because there is nothing to buy.',
  },
  {
    key: 'core',
    title: 'Put the rest to work',
    why: 'What is left, ranked by what it is actually worth to you after tax and after the risk you are '
      + 'willing to carry.',
  },
];

const TIER_INFO = Object.fromEntries(TIERS.map((t) => [t.key, t]));

/** Facts the app cannot derive and will not guess. */
const DEFAULT_FACTS = {
  employerMatches: null,        // true | false | null (unknown)
  cardBalance: null,            // dollars carried month to month
  cardApr: 24.99,
  bufferMonths: 3,
  monthlyExpenses: null,        // dollars
  hoursAvailable: 4,            // how much hassle they will tolerate this month
};

const money = (v) => `$${Math.round(v).toLocaleString()}`;

/** Minutes of work a row costs, from its effort class. */
function minutesFor(o) {
  return EFFORT_INFO[o.effort]?.minutes ?? 30;
}

/**
 * Value per hour of work, which is the comparison that actually decides whether
 * a bounded offer is worth taking. A $1,500 referral needing five friends and
 * four hours of nagging is $375/hour; a $300 bonus for one transfer is $600/hour
 * and finishes this afternoon.
 */
function valuePerHour(o) {
  const v = o.scores?.oneTimeDollars;
  if (!Number.isFinite(v)) return null;
  return v / Math.max(0.25, minutesFor(o) / 60);
}

function stepFrom(o, tier, { capital = null, note = null, dollars = null } = {}) {
  return {
    tier,
    id: o.id,
    name: o.name,
    provider: o.provider || o.sourceLabel || null,
    section: o.section,
    grade: o.rating?.grade || null,
    gradeColor: o.rating?.gradeColor || null,
    effort: o.effort || 'light',
    minutes: minutesFor(o),
    daysLeft: Number.isFinite(o.daysLeft) ? o.daysLeft : null,
    capital,
    ratePct: o.scores?.blendedGross ?? o.apy?.total ?? null,
    dollars,
    dollarsUnknown: !!o.dollarsUnknown,
    valuePerHour: valuePerHour(o),
    note,
    // A plan that says "open this card for $1,030" and omits that it needs
    // spend you were already making, adds a hard inquiry, and is wiped out by
    // one carried balance is not a plan, it is an advert.
    warnings: (o.trapFlags || []).slice(0, 3),
    caution: cautionFor(o),
    accessNotes: o.accessNotes || null,
  };
}

/** The one sentence that most changes whether a step is a good idea. */
function cautionFor(o) {
  const sub = String(o.subType || '');
  if (sub === 'signup_bonus' || sub === 'category_bonus' || sub === 'intro_apr_carry') {
    return 'Only worth it on spend you were already going to make, paid in full every statement. One carried '
      + 'balance at a typical 25% APR wipes this out within months, and applying adds a hard inquiry.';
  }
  if (sub === 'referral_bonus') {
    return 'Depends on other people signing up and funding. You do not control whether this pays.';
  }
  if (o.scores?.traps?.verdict === 'likely_trap') {
    return 'Flagged as a likely trap by this app\'s own checks. Read the row before acting on it.';
  }
  if (['C', 'D', 'E', 'F'].includes(o.rating?.grade)) {
    return `Grade ${o.rating.grade}: principal is genuinely at risk here.`;
  }
  return null;
}

/**
 * @param {object[]} rows   scored opportunities
 * @param {object} opts     { budget, facts, riskFree, appetite }
 */
function buildPlan(rows, opts = {}) {
  const {
    budget = null,
    facts: rawFacts = {},
    riskFree = 4,
  } = opts;
  const facts = { ...DEFAULT_FACTS, ...rawFacts };

  const hasBudget = Number.isFinite(budget) && budget > 0;
  let left = hasBudget ? budget : null;
  let minutesLeft = Math.max(0, Number(facts.hoursAvailable) || 0) * 60;

  const steps = [];
  const assumptions = [];
  const notKnown = [];
  const skipped = [];

  const spend = (want) => {
    if (!hasBudget) return null;
    const take = Math.max(0, Math.min(left, want));
    left -= take;
    // Zero is not an allocation. Reporting "$0 committed" beside a step reads
    // as a failure to allocate rather than as a step that needs no capital.
    return take > 0 ? take : null;
  };
  const canAfford = (o) => !hasBudget || !Number.isFinite(o.minInvestment) || o.minInvestment <= left;

  // ---- tier 1: the employer match -----------------------------------------
  const matches = rows
    .filter((o) => o.subType === 'employer_match')
    .sort((a, b) => (b.apy?.total ?? 0) - (a.apy?.total ?? 0));

  if (facts.employerMatches === false) {
    skipped.push({ tier: 'match', why: 'You said your employer does not match.' });
  } else if (matches.length) {
    const best = matches[0];
    steps.push(stepFrom(best, 'match', {
      note: facts.employerMatches === null
        ? 'Only if your plan actually matches — check your Summary Plan Description, because roughly a third of '
          + 'plans do not. The dollars depend on your pay, which this app does not ask for.'
        : 'The dollars depend on your pay, which this app does not ask for. Set your deferral to at least the '
          + 'full match threshold and the rest of this plan can proceed.',
    }));
    if (facts.employerMatches === null) {
      notKnown.push('Whether your employer matches, and at what rate. It changes the first step entirely.');
    }
  }

  // ---- tier 2: expensive debt ---------------------------------------------
  if (Number.isFinite(facts.cardBalance) && facts.cardBalance > 0) {
    const apr = Number(facts.cardApr) || 24.99;
    const use = spend(facts.cardBalance);
    steps.push({
      tier: 'debt',
      id: '_debt',
      name: `Pay down ${money(facts.cardBalance)} of card balance`,
      provider: 'Your card issuer',
      section: 'deals',
      grade: 'A+',
      gradeColor: '#3ddc97',
      effort: 'passive',
      minutes: 5,
      daysLeft: null,
      capital: use,
      ratePct: apr,
      dollars: (use ?? facts.cardBalance) * (apr / 100),
      dollarsUnknown: false,
      valuePerHour: null,
      note: `A guaranteed ${apr.toFixed(2)}% and tax-free, because you are not earning it, you are not losing it. `
        + `The best insured account in this scan pays about ${riskFree.toFixed(2)}%. There is no contest.`,
      accessNotes: null,
    });
  } else if (facts.cardBalance === null) {
    notKnown.push('Whether you carry a credit card balance. At a typical 25% APR, paying it beats everything '
      + 'below the employer match.');
  }

  // ---- tier 3: the buffer --------------------------------------------------
  const bufferTarget = Number.isFinite(facts.monthlyExpenses) && facts.monthlyExpenses > 0
    ? facts.monthlyExpenses * (Number(facts.bufferMonths) || 3)
    : null;
  if (bufferTarget) {
    const safe = rows
      .filter((o) => o.section === 'income'
        && ['A+', 'A'].includes(o.rating?.grade)
        && (o.liquidity === 'instant' || o.liquidity === 'daily')
        && !o.oneTime
        && canAfford(o))
      .sort((a, b) => (b.scores?.blendedAfterTax ?? -1) - (a.scores?.blendedAfterTax ?? -1));
    if (safe.length) {
      const o = safe[0];
      const use = spend(bufferTarget);
      steps.push(stepFrom(o, 'buffer', {
        capital: use,
        dollars: use === null ? null : use * ((o.scores?.blendedAfterTax ?? 0) / 100),
        note: `Sized at ${facts.bufferMonths} months of the ${money(facts.monthlyExpenses)} you said you spend. `
          + 'Same-day access is the point; the rate is a bonus.',
      }));
    }
  } else {
    notKnown.push('What you spend in a month. Without it there is no way to size a buffer, so the plan puts '
      + 'everything to work and assumes you have cash elsewhere.');
  }

  // ---- tier 4: things with a deadline --------------------------------------
  // Ordered by what an hour of your time is worth, not by headline rate, and
  // filtered by the time you actually said you had.
  const expiring = rows
    .filter((o) => o.section === 'deals'
      && Number.isFinite(o.daysLeft) && o.daysLeft >= 0 && o.daysLeft <= 45
      && Number.isFinite(o.scores?.oneTimeDollars) && o.scores.oneTimeDollars > 0)
    .sort((a, b) => (valuePerHour(b) ?? 0) - (valuePerHour(a) ?? 0));

  for (const o of expiring) {
    // Fits, not merely "there is time left". Asking whether any time remains
    // let a two-hour chore land on someone who said they had one hour.
    if (minutesFor(o) > minutesLeft) { skipped.push({ tier: 'expiring', name: o.name, why: `needs ${Math.round(minutesFor(o) / 60 * 10) / 10}h and you have ${Math.round(minutesLeft / 6) / 10}h left` }); continue; }
    if (!canAfford(o)) { skipped.push({ tier: 'expiring', name: o.name, why: `needs ${money(o.minInvestment)} you have not got left` }); continue; }
    const use = Number.isFinite(o.minInvestment) ? spend(o.minInvestment) : null;
    minutesLeft -= minutesFor(o);
    steps.push(stepFrom(o, 'expiring', {
      capital: use,
      dollars: o.scores.oneTimeDollars,
      note: `${o.daysLeft <= 1 ? 'Closes within a day' : `Closes in ${Math.round(o.daysLeft)} days`}. `
        + `About ${money(valuePerHour(o))} an hour for the work it takes.`,
    }));
    if (steps.filter((s) => s.tier === 'expiring').length >= 4) break;
  }

  // ---- tier 5: bounded money with no clock on it ---------------------------
  const TAX_SUBTYPES = ['tax_rule', 'tax_deferral', 'tax_free_growth', 'employer_match'];
  const takenIds = new Set(steps.map((s) => s.id));
  const bounded = rows
    .filter((o) => o.section === 'deals'
      && !takenIds.has(o.id)
      // The tier below owns these. Without the split both tiers filled up with
      // the same six structural plays and the plan repeated itself.
      && !TAX_SUBTYPES.includes(o.subType)
      && !Number.isFinite(o.daysLeft)
      && Number.isFinite(o.scores?.oneTimeDollars) && o.scores.oneTimeDollars > 0
      && o.scores?.traps?.verdict !== 'likely_trap')
    .sort((a, b) => (valuePerHour(b) ?? 0) - (valuePerHour(a) ?? 0));

  for (const o of bounded) {
    if (minutesFor(o) > minutesLeft) { skipped.push({ tier: 'bounded', name: o.name, why: `needs ${Math.round(minutesFor(o) / 60 * 10) / 10}h and you have ${Math.round(minutesLeft / 6) / 10}h left` }); continue; }
    if (!canAfford(o)) { skipped.push({ tier: 'bounded', name: o.name, why: `needs ${money(o.minInvestment)} you have not got left` }); continue; }
    const use = Number.isFinite(o.minInvestment) && o.minInvestment > 0 ? spend(o.minInvestment) : null;
    minutesLeft -= minutesFor(o);
    steps.push(stepFrom(o, 'bounded', {
      capital: use,
      dollars: o.scores.oneTimeDollars,
      note: `About ${money(valuePerHour(o))} an hour for the work it takes`
        + `${Number.isFinite(o.minInvestment) && o.minInvestment > 0 ? `, and it ties up ${money(o.minInvestment)} while you qualify` : ''}.`,
    }));
    if (steps.filter((s) => s.tier === 'bounded').length >= 4) break;
  }

  // ---- tier 6: tax room ----------------------------------------------------
  for (const s of steps) takenIds.add(s.id);
  const taxPlays = rows
    .filter((o) => ['tax_rule', 'tax_deferral', 'tax_free_growth'].includes(o.subType) && !takenIds.has(o.id))
    .sort((a, b) => (b.apy?.total ?? 0) - (a.apy?.total ?? 0))
    .slice(0, 4);
  for (const o of taxPlays) {
    steps.push(stepFrom(o, 'tax', {
      dollars: o.scores?.oneTimeDollars ?? null,
      note: o.dollarsUnknown ? 'The rate is exact; the size depends on numbers this app does not have.' : null,
    }));
  }

  // ---- tier 7: everything else --------------------------------------------
  const core = rows
    .filter((o) => o.section === 'income' && !o.oneTime
      && o.scores?.traps?.verdict !== 'likely_trap'
      && canAfford(o))
    .sort((a, b) => (b.scores?.dogScore ?? -1) - (a.scores?.dogScore ?? -1))
    .slice(0, 3);
  for (const o of core) {
    const use = hasBudget && left > 0 ? spend(left) : null;
    const g = o.rating?.grade;
    const risky = ['C', 'D', 'E', 'F'].includes(g);
    steps.push(stepFrom(o, 'core', {
      capital: use,
      dollars: use === null ? null : use * ((o.scores?.blendedAfterTax ?? 0) / 100),
      // This tier is ranked by the same risk-adjusted score as everything else,
      // which at a middling appetite can genuinely surface a C. Saying so is
      // the difference between a ranking and a recommendation.
      note: [
        use === null ? null : 'Everything the tiers above did not consume.',
        risky ? `Grade ${g} — this is not a savings account, and a bad year here can be a real loss. `
          + 'Lower the risk appetite in Settings and this step changes.' : null,
      ].filter(Boolean).join(' ') || null,
    }));
    if (hasBudget && left <= 0) break;
  }

  if (hasBudget) {
    assumptions.push(`Allocated against the ${money(budget)} you set.`);
  } else {
    assumptions.push('No amount set, so the plan is an order of operations rather than an allocation.');
  }
  assumptions.push(`${facts.hoursAvailable} hour${facts.hoursAvailable === 1 ? '' : 's'} of hassle budgeted, which `
    + 'is what decides how many bounded offers are worth chasing.');

  // Two different kinds of money, and adding them together is how a $1,200 plan
  // came to claim $9,201. A pre-tax commuter election saves real money and
  // needs no capital, so it does not scale with what you have and does not
  // belong in the same total as a yield on a balance. The plan reports both and
  // never sums them.
  const fromCapital = steps
    .filter((s) => Number.isFinite(s.capital) && s.capital > 0 && Number.isFinite(s.dollars))
    .reduce((n, s) => n + s.dollars, 0);
  const fromActions = steps
    .filter((s) => !(Number.isFinite(s.capital) && s.capital > 0) && Number.isFinite(s.dollars))
    .reduce((n, s) => n + s.dollars, 0);

  return {
    steps,
    tiers: TIERS.filter((t) => steps.some((s) => s.tier === t.key)),
    tierInfo: TIER_INFO,
    unallocated: hasBudget ? Math.max(0, left) : null,
    minutesUsed: Math.max(0, facts.hoursAvailable * 60 - minutesLeft),
    fromCapital: fromCapital > 0 ? fromCapital : null,
    fromActions: fromActions > 0 ? fromActions : null,
    firstYearIncomplete: steps.some((s) => s.dollarsUnknown),
    assumptions,
    notKnown,
    skipped,
    facts,
  };
}

module.exports = { buildPlan, TIERS, TIER_INFO, DEFAULT_FACTS, valuePerHour };
