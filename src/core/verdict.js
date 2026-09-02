'use strict';

const C = require('./constants');

/**
 * The plain-English read on one opportunity.
 *
 * Everything else in this app is a panel: a grade here, five axes there, an
 * expectations band, trap flags, notes, vehicles. All of it is true and none of
 * it is an answer — the reader is left to assemble "is this worth doing, what am
 * I risking, and why is it ranked here" out of six boxes, every time, for every
 * row.
 *
 * This writes that answer. Four questions, in the order people actually ask
 * them:
 *
 *   What is it, and what does it do for me?
 *   Why is it worth my attention at all?
 *   What is the single worst thing that happens?
 *   What would change the answer?
 *
 * Two rules hold every sentence honest. Every claim is built from a field on
 * the row, so nothing here can drift from the numbers beside it — if the grade
 * changes, this changes. And no sentence is generic: each one carries a figure
 * or a specific fact, because "this investment carries risk" is noise wearing
 * the costume of advice.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v, dp = 2) => `${v.toFixed(dp)}%`;
const money = (v) => `$${Math.round(Math.abs(v)).toLocaleString()}`;

/** How long your money is committed, in words a person uses. */
function commitment(o) {
  const d = o.term?.days;
  if (o.liquidity === C.LIQUIDITY.INSTANT) return 'you can take it out the same day';
  if (o.liquidity === C.LIQUIDITY.DAILY) return 'you can sell any trading day';
  if (o.liquidity === C.LIQUIDITY.NOTICE) return 'getting out needs notice';
  if (finite(d) && d > 0) {
    if (d >= 360) return `your money is committed for about ${Math.round(d / 365)} year${d >= 700 ? 's' : ''}`;
    return `your money is committed for about ${Math.round(d / 30)} months`;
  }
  if (o.liquidity === C.LIQUIDITY.LOCKED) return 'the money is locked up';
  return null;
}

/** The headline: what this is and what it actually does for the reader. */
/** A provider name that reads correctly inside a sentence. */
function providerName(o) {
  const raw = o.provider || o.sourceLabel || null;
  if (!raw) return null;
  // "from Your employer's retirement plan" — the capital is a proper noun rule
  // that does not apply once the name is mid-sentence.
  return /^(Your|Any|The|A) /.test(raw) ? raw.charAt(0).toLowerCase() + raw.slice(1) : raw;
}

function headlineFor(o, s, amount) {
  const name = providerName(o) || 'This';

  if (o.section === 'movement') {
    const m = o.movement;
    const typical = m?.expected?.typicalPct;
    const heat = m?.heat;
    return `${o.symbol || o.name} is a thing you own for the price, not the payout.`
      + (finite(typical) ? ` A move of about ${pct(Math.abs(typical), 1)} over the next month would be ordinary for it.` : '')
      + (finite(heat) && heat >= 40 ? ' It is unusually active right now.' : '');
  }

  if (o.oneTime) {
    const once = s?.oneTimeDollars;
    const eff = o.effort === 'social' ? ', and it depends on other people acting'
      : o.effort === 'hoops' ? ', with real requirements to track'
        : o.effort === 'ongoing' ? ', and it needs ongoing attention' : '';
    return finite(once)
      ? `A one-off payment of about ${money(once)} from ${name}${eff}. It does not repeat.`
      : `A one-off benefit from ${name}${eff}. It does not repeat.`;
  }

  const rate = s?.blendedAfterTax ?? o.tax?.afterTaxApy ?? o.apy?.total;
  const dollars = s?.incomeYear1;
  const on = finite(amount) && amount > 0 ? ` on ${money(amount)}` : '';
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  if (finite(rate) && finite(dollars)) {
    return `${Name} pays about ${pct(rate)} after your tax — ${money(dollars)} in the first year${on}.`;
  }
  if (finite(rate)) return `${Name} pays about ${pct(rate)} after your tax.`;
  return `${Name}: ${o.name}.`;
}

/** Why it is worth attention. Only facts that are actually true of this row. */
function theCase(o, s, opts) {
  const out = [];
  const g = o.rating?.grade;
  const rate = s?.blendedAfterTax ?? o.tax?.afterTaxApy;
  const rf = opts.riskFree ?? 4;

  // Recurring income only. Setting a one-off 50% match against an annual
  // risk-free rate is a category error, and it printed "beats cash by 96.2%"
  // under a benefit you collect once.
  if (!o.oneTime && ['A+', 'A'].includes(g) && finite(rate) && rate > rf) {
    out.push(`It beats cash by about ${pct(rate - rf, 1)} a year while still being graded ${g} for safety.`);
  }
  if (o.risk?.insurance === C.INSURANCE.FDIC || o.risk?.insurance === C.INSURANCE.NCUA) {
    out.push('Your principal is federally insured, so the institution failing is not your problem.');
  }
  if (o.section === 'deals' && finite(s?.valuePerHour ?? null)) {
    out.push(`It works out to about ${money(s.valuePerHour)} an hour for the effort involved.`);
  }
  if (finite(o.daysLeft) && o.daysLeft >= 0 && o.daysLeft <= 30) {
    out.push(`It closes in ${Math.round(o.daysLeft)} day${Math.round(o.daysLeft) === 1 ? '' : 's'}, which is the only reason it is this high up.`);
  }
  if (o.reach === 'obscure') {
    out.push('Few people know about it, so it is uncrowded — which cuts both ways and is why it is worth reading twice.');
  }
  if (o.effort === 'passive' && !o.oneTime && finite(rate) && rate > rf) {
    out.push('It pays this for doing nothing after the first afternoon.');
  }
  const setup = o.movement?.setupLabel;
  if (setup && o.movement?.catalyst?.event) {
    const e = o.movement.catalyst.event;
    out.push(`It is ${String(setup).toLowerCase()} with ${e.label.toLowerCase()} ${Math.round(e.daysAway)} days out.`);
  }
  return out.slice(0, 3);
}

/**
 * The single worst thing that happens, said plainly.
 *
 * One risk, not a list. A list of six risks is read as "risky in general",
 * which is precisely the thing people already assume and act on anyway.
 */
function theRisk(o, s, exp) {
  const g = o.rating?.grade;

  // A row can be both flagged AND capable of total loss, and reporting only the
  // first drops the more important fact. The zero warning is never displaced by
  // anything — it is the one sentence that changes how much someone puts in.
  // The grade, and ONLY the grade. Triggering on "not FDIC insured" as well was
  // far too broad and produced a flatly wrong sentence: a 401(k) match is
  // graded A, is not insured by anyone, and had "the whole position can go to
  // zero" printed under it. Treasuries, employer promises and government paper
  // are all uninsured in that narrow sense and none of them goes to zero. The
  // grade is the app's own synthesis of exactly this question, so deferring to
  // it keeps the verdict from contradicting the letter shown beside it.
  const canGoToZero = g === 'F';
  const flagged = o.scores?.traps?.verdict === 'likely_trap';
  if (flagged || canGoToZero) {
    const parts = [];
    if (flagged) {
      parts.push(`This app's own checks flag it: ${o.scores.traps.reasons?.[0] || 'the advertised rate does not survive scrutiny'}.`);
    }
    if (canGoToZero) {
      parts.push('The whole position can go to zero, and things like this have. Size it as money you can lose '
        + 'entirely, not as a percentage of a portfolio.');
    } else {
      parts.push('Read the terms before anything else.');
    }
    return { severity: 'high', text: parts.join(' ') };
  }
  const tail = exp?.income?.pct?.tail;
  if (finite(tail) && tail < -0.05) {
    return {
      severity: g === 'D' || g === 'E' ? 'high' : 'medium',
      text: `A genuinely bad year here is about ${pct(tail * 100, 0)} — not a percentage point of yield, but that `
        + 'much of your money. That is the number to decide on, not the headline rate.',
    };
  }
  // One-offs fail in quite different ways, and the generic version of this said
  // "miss a direct deposit or a minimum balance" under an employer match, whose
  // actual risk is vesting. The failure mode has to match the thing.
  if (o.oneTime) {
    const sub = String(o.subType || '');
    if (o.effort === 'social' || sub === 'referral_bonus') {
      return {
        severity: 'medium',
        text: 'It pays only if other people sign up and follow through, which you do not control. Until they do, '
          + 'this is worth nothing.',
      };
    }
    if (sub === 'employer_match') {
      return {
        severity: 'medium',
        text: 'The match itself is your employer\'s promise, and it vests on a schedule — leave before you are '
          + 'fully vested and the unvested part goes back. It is also separate from investment risk: the match is '
          + 'guaranteed on the contribution, and whatever you buy inside the account can still fall.',
      };
    }
    if (['tax_rule', 'tax_deferral', 'tax_free_growth'].includes(sub)) {
      return {
        severity: 'low',
        text: 'The rule is not in doubt; your eligibility for it might be. Income limits, filing status and plan '
          + 'documents all decide whether it applies to you, and the deadline is the day it stops applying at all.',
      };
    }
    if (['signup_bonus', 'checking_bonus', 'savings_bonus', 'brokerage_bonus', 'credit_union_bonus'].includes(sub)) {
      return {
        severity: 'low',
        text: 'The risk is not losing money, it is the requirements: miss a direct deposit or a minimum balance '
          + 'and the payment simply does not arrive.',
      };
    }
    return {
      severity: 'low',
      text: 'The risk is not losing money, it is that the conditions are not met — read what has to happen before '
        + 'it pays, because a one-off that half-completes pays nothing.',
    };
  }
  if (o.section === 'movement') {
    // `risk.maxDrawdown`, which is where schema.js puts it. Read from the top
    // level it was always undefined, so this sentence never rendered on any of
    // the 353 rows that carry a drawdown.
    const dd = o.risk?.maxDrawdown;
    return {
      severity: 'high',
      text: finite(dd) && dd > 0
        ? `It has fallen ${pct(dd, 0)} from a high before. Nothing says it cannot do that again while you hold it.`
        : 'The return here is the price, and the price can fall as easily as it rises.',
    };
  }
  const commit = commitment(o);
  if (o.liquidity === C.LIQUIDITY.LOCKED || o.term?.days > 180) {
    return {
      severity: 'medium',
      text: `The rate is fine; the constraint is that ${commit}${o.term?.earlyExitPenalty ? `, and leaving early costs you ${o.term.earlyExitPenalty.toLowerCase()}` : ''}.`,
    };
  }
  return {
    severity: 'low',
    text: 'The main risk is that the rate changes — it is not contractual, and an advertised rate can be cut at any time.',
  };
}

/** What would flip the answer. The question people forget to ask. */
function whatWouldChangeIt(o, s, opts) {
  const out = [];
  if (o.yieldKind !== C.YIELD_KIND.CONTRACTUAL && !o.oneTime) {
    out.push('The rate being cut — nothing here obliges them to keep paying it.');
  }
  if (finite(o.maxInvestment) && s?.blendApplied) {
    out.push(`Having more than ${money(o.maxInvestment)} to place: above the cap this pays nothing extra, and the blended figure falls.`);
  }
  if (s?.hasBudget === false) {
    out.push('Telling the app how much you have — capped offers are ranked against a reference amount until you do.');
  }
  if (o.measured === false) {
    out.push('Refreshing: this row has not been measured, so its figures are the bundled snapshot rather than a quote.');
  }
  if (o.section === 'movement' && o.seriesBasis === 'illustrative') {
    out.push('Real price history arriving — its chart is currently drawn from its own statistics, not recorded.');
  }
  if (o.effort === 'hoops') {
    out.push('Whether you will actually keep up the requirements every month, which is what most people overestimate.');
  }
  return out.slice(0, 3);
}

/** Who it suits, and who it does not. Both, because only one is a sales pitch. */
function suitability(o, s) {
  const g = o.rating?.grade;
  if (o.section === 'movement') {
    return {
      bestFor: 'Someone who wants exposure to a price and has already decided they want this one.',
      notFor: 'Money you need on a date. Nothing here predicts direction, and the timing is not yours to choose.',
    };
  }
  if (o.oneTime) {
    return {
      bestFor: o.effort === 'passive' || o.effort === 'light'
        ? 'Anyone with an afternoon and the minimum deposit. It is close to free money.'
        : 'Someone who will actually complete the requirements — the payment is all or nothing.',
      notFor: 'Anyone counting on it as income. It happens once and then it is over.',
    };
  }
  if (['A+', 'A'].includes(g)) {
    return {
      bestFor: 'Money you cannot afford to lose — an emergency fund, or a purchase with a date on it.',
      notFor: 'Money that has decades to grow, where this rate will lose quietly to inflation.',
    };
  }
  if (['D', 'E', 'F'].includes(g)) {
    return {
      bestFor: 'A small slice of a portfolio, sized so a total loss would be annoying rather than serious.',
      notFor: 'An emergency fund, a house deposit, or anything you would be forced to sell at a bad moment.',
    };
  }
  return {
    bestFor: 'The middle of a portfolio — money with a few years to work and some tolerance for a bad year.',
    notFor: 'Cash you might need next month.',
  };
}

/**
 * @param {object} o    a scored opportunity
 * @param {object} opts { amount, riskFree, expectations }
 */
function verdictFor(o, opts = {}) {
  if (!o || typeof o !== 'object') return null;
  const s = o.scores || {};
  const exp = opts.expectations || null;
  const amount = finite(opts.amount) && opts.amount > 0 ? opts.amount : null;

  const risk = theRisk(o, s, exp);
  const suits = suitability(o, s);
  return {
    headline: headlineFor(o, s, amount),
    theCase: theCase(o, s, { riskFree: opts.riskFree ?? 4 }),
    risk,
    changesIt: whatWouldChangeIt(o, s, opts),
    bestFor: suits.bestFor,
    notFor: suits.notFor,
    // One line for a hover or a compact row, when the panel is too much.
    oneLine: `${headlineFor(o, s, amount)} ${risk.text}`.slice(0, 260),
  };
}

module.exports = { verdictFor, providerName, commitment, headlineFor, theCase, theRisk, whatWouldChangeIt, suitability };
