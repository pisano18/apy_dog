'use strict';

const fs = require('node:fs');
const contract = require('./_contract');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');
const K = require('../core/opportunity-kinds');

/**
 * REFERRALS, PROMOS & REWARDS — the money that appears in no screener.
 *
 * bonuses.js covers one specific thing: cash for opening and funding an account.
 * This file covers everything else a real institution will pay an ordinary
 * person, and it is a bigger pile than the yield table it sits next to:
 *
 *   - Referrals. Acorns will pay around $1,500 for five funded referrals. That
 *     is a real, published, promotional offer and it is also five other people's
 *     decisions, none of which you control.
 *   - Credit card sign-up bonuses. A $200 bonus on $500 of spend you were going
 *     to do anyway is a 40% return ON THAT SPEND, collected once. Nothing in a
 *     yield table comes close, and nothing in a yield table is as easy to turn
 *     negative: a $95 annual fee against a $200 bonus is a $105 net, and one
 *     month of carrying the balance at 25% APR eats the rest.
 *   - Category and portal rebates, rotating quarterly cards, transfer promos and
 *     fintech offers, most of which are capped, dated, or both.
 *
 * THREE THINGS EVERY ROW HERE HAS TO SAY OUT LOUD
 * -----------------------------------------------
 * 1. WHAT IT ACTUALLY TAKES. A referral that needs five friends is not "click
 *    once"; it is `effort: social`, meaning you do not control whether it pays.
 *    A sign-up bonus is `effort: hoops`. That is a first-class field, not prose.
 * 2. WHAT THE DENOMINATOR IS. Most of this money has no capital behind it, so
 *    there is no percentage to quote. `apy.total` is NULL on those rows and the
 *    dollars live in `payout`. Where a percentage IS meaningful it is a percent
 *    of the money you must MOVE (the required spend), not of money you park —
 *    and that is stated in `expected.basis` every time. Inventing an annualised
 *    rate for a thing with no denominator is how a screener starts lying.
 * 3. THAT IT IS BOUNDED. Caps, deadlines and one-per-customer clauses are
 *    encoded (maxInvestment, expiresAt, oneTime), never buried in a sentence.
 *
 * WHY THERE IS NO API
 * -------------------
 * Referral tiers, card offers and portal rates live on landing pages, are
 * frequently targeted to individual customers, and change weekly — several of
 * them change while you read the page. Nothing published quotes them. So the
 * curated dataset IS the payload, exactly as in savings.js and bonuses.js, and
 * the status is never better than 'partial': an offer we have not opened today
 * is a lead, not a quote. The live path exists for one thing only — a JSON feed
 * in this file's own documented item shape, which a user can point at through
 * ctx.settings.dealsFeedUrl to keep their own copy current.
 */

const ID = 'deals';
const LABEL = 'Referrals, Promos & Rewards';
const SEED_FILE = 'deals.json';
const FALLBACK_AS_OF = '2026-08-01';

/**
 * Confidence ceilings, both lower than bonuses.js.
 *
 * A bank bonus is at least published on a page that stays up for a quarter. A
 * referral tier is promotional, frequently targeted, and can be different for
 * two people looking at the same screen on the same day; a card sign-up offer
 * has public and elevated versions running simultaneously. The right posture
 * toward every number in this file is "approximately right on the stated date,
 * verify before acting", and the confidence has to encode that rather than the
 * warnings alone carrying it.
 */
const CURATED_CONFIDENCE = 0.45;
const SEED_CONFIDENCE = 0.35;

/** A consumer promotion paying more than this is a data-entry error. */
const MAX_PAYOUT = 25000;

/** Nobody has 200 friends who will all open a brokerage account. */
const MAX_REFERRALS = 50;

/** A sign-up bonus worth more than 3x the required spend is a typo. */
const MAX_SPEND_RETURN_PCT = 300;

/** A cash-back rate above this is a typo, not a category bonus. */
const MAX_REBATE_RATE = 30;

/** Past this a "promotion" is a lockup wearing a promotion's clothes. */
const MAX_HOLD_DAYS = 3650;

/**
 * Same clamp, same reason, as bonuses.js: annualising a large return over a
 * short window produces an arithmetically correct number nobody can repeat,
 * because the payment happens once and is capped.
 */
const MAX_EFFECTIVE_APY = 500;

/**
 * What kind of offer this is. The kind decides the shape of the maths, what the
 * denominator is, and — the part that matters most on this shelf — how much work
 * it takes and whether other people have to act.
 */
const KINDS = {
  referral: {
    subType: 'referral_bonus',
    effort: 'social',
    liquidity: 'instant',
    oneTime: true,
    label: 'referral',
  },
  card_signup: {
    subType: 'signup_bonus',
    effort: 'hoops',
    liquidity: 'instant',
    oneTime: true,
    label: 'credit card sign-up bonus',
  },
  card_category: {
    subType: 'category_bonus',
    effort: 'ongoing',
    liquidity: 'instant',
    oneTime: false,
    label: 'category or rotating bonus',
  },
  cashback_app: {
    subType: 'cashback_program',
    effort: 'ongoing',
    liquidity: 'instant',
    oneTime: false,
    label: 'cash-back program',
  },
  transfer_promo: {
    subType: 'transfer_bonus',
    effort: 'light',
    // The assets have to arrive and then stay put for the holding period, so
    // this is the one kind here where money is genuinely committed.
    liquidity: 'notice',
    oneTime: true,
    label: 'brokerage transfer promotion',
  },
  credit_promo: {
    subType: 'intro_apr_carry',
    effort: 'hoops',
    liquidity: 'notice',
    oneTime: false,
    label: 'intro-APR carry',
  },
  fintech_promo: {
    subType: 'promo_offer',
    effort: 'light',
    liquidity: 'instant',
    oneTime: true,
    label: 'promotion',
  },
  found_money: {
    subType: 'unclaimed_funds',
    effort: 'light',
    liquidity: 'settled',
    oneTime: true,
    label: 'money already yours',
  },
};

const EFFORT_KEYS = new Set(K.EFFORT.map((e) => e.key));
const REACH_KEYS = new Set(K.REACH.map((r) => r.key));

/** How many times a spend cap resets in a year. */
const PERIODS_PER_YEAR = { month: 12, quarter: 4, year: 1 };

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Absent means zero; present-but-unreadable means "we could not parse it". */
const optNum = (v) => (v === null || v === undefined || v === '' ? 0 : toNum(v));

const money = (n) => {
  const frac = Math.abs(n % 1) > 1e-9 ? 2 : 0;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
};

const pct = (n) => `${n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2)}%`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A date we are willing to hand to the rest of the app.
 *
 * Date.parse returns NaN on junk and new Date(t).toISOString() throws RangeError
 * outside +/-8.64e15 ms. A hand-edited offers file is exactly where a "2026-13-45"
 * or a millisecond value pasted as seconds turns up, and an adapter that throws
 * on one bad date takes the whole source down with it.
 */
function isoDay(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return fallback;
  try {
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// The maths. This is the actual product of this file.
// ---------------------------------------------------------------------------

/**
 * What a referral offer is worth if it works.
 *
 * Deliberately simple arithmetic, because the arithmetic is not the hard part —
 * the honesty is. Three things have to survive into the output and none of them
 * are a percentage:
 *
 *   perReferral      what one signed-up, funded friend is worth
 *   referralsNeeded  how many of them the headline number assumes
 *   cap              the ceiling the program puts on a year's referral earnings
 *
 * "$1,500 from Acorns" is `perReferral: 300, referralsNeeded: 5`. Reporting only
 * the $1,500 would be true and useless: the work is five conversations and five
 * other people's decisions, and if only two of them sign up the row paid $600,
 * not $1,500. So the shape is preserved rather than collapsed into a headline.
 *
 * There is NO rate here on purpose. A referral needs no capital, so a return on
 * capital is a division by zero, not a big number — see the comment on
 * expectedFor() for what the app shows instead.
 *
 * @returns {{perReferral:number, referralsNeeded:number, gross:number,
 *            total:number, cap:number|null, capped:boolean}|null}
 */
function referralValue({ perReferral, referralsNeeded = 1, cap = null } = {}) {
  const per = toNum(perReferral);
  const neededRaw = referralsNeeded === null || referralsNeeded === undefined || referralsNeeded === ''
    ? 1
    : toNum(referralsNeeded);
  const capGiven = !(cap === null || cap === undefined || cap === '');
  const capValue = capGiven ? toNum(cap) : null;

  if (per === null || neededRaw === null) return null;
  if (capGiven && (capValue === null || capValue <= 0)) return null;
  if (per < 0 || per > MAX_PAYOUT) return null;
  if (neededRaw < 1 || neededRaw > MAX_REFERRALS) return null;

  const people = Math.round(neededRaw);
  const gross = per * people;
  if (!Number.isFinite(gross) || gross > MAX_PAYOUT) return null;

  const total = capValue === null ? gross : Math.min(gross, capValue);
  return {
    perReferral: per,
    referralsNeeded: people,
    gross,
    total,
    cap: capValue,
    // A cap that bites is the difference between "$100 a friend forever" and
    // "$100 a friend until May, then nothing" — it belongs on the row.
    capped: capValue !== null && gross > capValue,
  };
}

/**
 * What a credit card sign-up bonus is worth, as a percentage OF THE SPEND.
 *
 * This is the most misrepresented number in consumer finance in both directions.
 * The advertised version ("$200 bonus!") ignores that you had to move $500
 * through the card and may have paid $95 for the privilege. The cynical version
 * ("credit cards are a trap") ignores that a $200 bonus on $500 of groceries you
 * were buying anyway is a 40% return on that money, collected inside 90 days,
 * with no capital at risk at all.
 *
 * Both numbers are computed and both are returned:
 *
 *   returnOnSpendPct     bonus / spendRequired            — the headline
 *   netReturnOnSpendPct  (bonus - annualFee) / spend      — what you keep
 *
 * The fee is what flips some of these. A $200 bonus against a $95 annual fee is
 * a $105 net, and the app shows the $105. A $800 bonus against an $895 fee is
 * MINUS $95 in year one, and the app shows that too rather than the $800 —
 * feeEatsBonus is set so the row can say it in words.
 *
 * The figure is deliberately NOT annualised. Compounding a 40% one-off over a
 * 90-day window gives 268%, which is arithmetically correct and describes a
 * world where four different banks each hand you a sign-up bonus on the same
 * $500 every quarter forever. What is true is that you collect it once, inside
 * the year, on that spend — so this is a year-one return, matching
 * bonuses.firstYearReturn() rather than bonuses.effectiveApy().
 *
 * @returns {object|null} null when the inputs cannot describe a real offer.
 */
function spendBonusReturn({ bonus, spendRequired, windowDays, annualFee = 0 } = {}) {
  const b = toNum(bonus);
  const spend = toNum(spendRequired);
  const days = toNum(windowDays);
  // Absent means no annual fee. Present and unparseable is a different thing,
  // and quietly reading it as zero would overstate every row it happened on.
  const fee = optNum(annualFee);

  if (b === null || spend === null || days === null || fee === null) return null;
  if (b < 0 || b > MAX_PAYOUT) return null;
  if (spend <= 0 || fee < 0) return null;
  // A qualifying window is measured in months, never years. Anything longer is
  // a different product being mislabelled.
  if (days <= 0 || days > 730) return null;

  const returnOnSpendPct = (b / spend) * 100;
  if (!Number.isFinite(returnOnSpendPct) || returnOnSpendPct > MAX_SPEND_RETURN_PCT) return null;

  const netBonus = b - fee;
  const netReturnOnSpendPct = (netBonus / spend) * 100;
  if (!Number.isFinite(netReturnOnSpendPct)) return null;

  return {
    bonus: b,
    spendRequired: spend,
    windowDays: days,
    annualFee: fee,
    returnOnSpendPct,
    netBonus,
    netReturnOnSpendPct,
    // The number that decides whether this is doable: hitting $6,000 in 90 days
    // means $2,000 a month, which is not "spend you were doing anyway" for most
    // people, and manufacturing it is how the bonus turns into debt.
    monthlySpend: spend / (days / 30.44),
    feeEatsBonus: netBonus <= 0,
  };
}

/**
 * The annualised rate on money that has to sit somewhere for a promotion.
 *
 * Only used where capital is genuinely committed — a transfer bonus that
 * requires the assets to stay for a year. Same compounding as bonuses.js, for
 * the same reason: a 1% bonus over 180 days is 2.01% annualised, not 2.00%, and
 * over 30 days a 1% bonus is 12.8%, not 12%. Multiplying understates short
 * offers and would rank them below longer ones paying the same dollars.
 */
function holdBonusApy({ bonus, capital, holdDays } = {}) {
  const b = toNum(bonus);
  const cap = toNum(capital);
  const days = toNum(holdDays);
  if (b === null || cap === null || days === null) return null;
  if (b < 0 || cap <= 0 || days <= 0 || days > MAX_HOLD_DAYS) return null;
  const apy = (Math.pow(1 + b / cap, 365 / days) - 1) * 100;
  // A huge bonus on a tiny balance over one day overflows to Infinity. An
  // infinite APY is not a small mistake in a yield table.
  return Number.isFinite(apy) ? apy : null;
}

/**
 * What a category bonus or cash-back program is worth in a year.
 *
 * Two corrections that most "5% cash back!" claims omit, and both are large:
 *
 *   THE BASELINE. You already earn something on that spend. A 5% rotating
 *   category against a 2% everyday card is worth 3%, not 5%. The incremental
 *   rate is what the row reports, because the other 2% was never at stake.
 *
 *   THE CAP. 5% on $1,500 a quarter is $75 a quarter, full stop. Spending
 *   $10,000 in the category earns the same $75. So the spend that counts is
 *   min(what you spend, cap x periods), and the annual dollars follow from that
 *   rather than from the rate.
 *
 * A membership fee (Costco Executive, Amazon Prime) is subtracted, because a 2%
 * reward that costs $65 a year is negative until you spend $3,250 — and the
 * breakeven is returned so the row can say exactly where that line is.
 */
function rebateValue({
  rate, baselineRate = 0, spendCap = null, capPeriod = 'year',
  referenceSpend = null, membershipFee = 0,
} = {}) {
  const r = toNum(rate);
  const base = optNum(baselineRate);
  const fee = optNum(membershipFee);
  const capGiven = !(spendCap === null || spendCap === undefined || spendCap === '');
  const cap = capGiven ? toNum(spendCap) : null;
  const refGiven = !(referenceSpend === null || referenceSpend === undefined || referenceSpend === '');
  const ref = refGiven ? toNum(referenceSpend) : null;
  const periods = PERIODS_PER_YEAR[String(capPeriod || 'year')];

  if (r === null || base === null || fee === null || !periods) return null;
  if (capGiven && (cap === null || cap <= 0)) return null;
  if (refGiven && (ref === null || ref <= 0)) return null;
  if (r < 0 || r > MAX_REBATE_RATE || base < 0 || base > MAX_REBATE_RATE || fee < 0) return null;

  const incrementalRate = r - base;
  const cappedAnnualSpend = cap === null ? null : cap * periods;
  // With no cap and no reference spend there is nothing to multiply, and
  // inventing a spending figure for somebody would be exactly the sort of
  // fabrication this file exists to avoid.
  if (cappedAnnualSpend === null && ref === null) return null;

  const spendCounted = cappedAnnualSpend === null
    ? ref
    : (ref === null ? cappedAnnualSpend : Math.min(ref, cappedAnnualSpend));
  if (!Number.isFinite(spendCounted) || spendCounted <= 0) return null;

  const grossAnnual = (incrementalRate / 100) * spendCounted;
  const netAnnual = grossAnnual - fee;
  if (!Number.isFinite(netAnnual) || Math.abs(netAnnual) > MAX_PAYOUT) return null;

  return {
    rate: r,
    baselineRate: base,
    incrementalRate,
    spendCounted,
    cappedAnnualSpend,
    periodsPerYear: periods,
    grossAnnual,
    netAnnual,
    membershipFee: fee,
    netRatePct: (netAnnual / spendCounted) * 100,
    breakevenSpend: fee > 0 && incrementalRate > 0 ? fee / (incrementalRate / 100) : null,
  };
}

/**
 * The carry on a 0%-intro-APR balance transfer: borrow at the fee, park at the
 * savings rate, keep the difference.
 *
 * This is real and it is genuinely how some people make a few hundred dollars,
 * and it is also the single most dangerous row in this file, so the maths has to
 * be blunt about the fee:
 *
 *     netRatePct = parkRate - feePct x (365 / introDays)
 *
 * The 3% transfer fee is paid once, up front, so its ANNUALISED cost depends
 * entirely on how long the 0% window runs. Over 18 months a 3% fee costs 2% a
 * year; over 6 months the same fee costs 6% a year and the trade is underwater
 * before it starts. Anyone quoting "0% APR, park it at 4%, free money" has
 * skipped this line.
 *
 * What the arithmetic cannot capture is on the row in words: this is leverage on
 * a consumer credit line, one missed payment ends the promotional rate, and the
 * balance reverts to a mid-20s APR that costs more in two months than the whole
 * trade earns in a year.
 */
function introCarry({ introDays, feePct, parkRate, amount = null } = {}) {
  const days = toNum(introDays);
  const fee = toNum(feePct);
  const park = toNum(parkRate);
  const amt = amount === null || amount === undefined || amount === '' ? null : toNum(amount);

  if (days === null || fee === null || park === null) return null;
  if (days <= 0 || days > 1460) return null;
  if (fee < 0 || fee > 10) return null;         // transfer fees are 0-5%; 10% is a typo
  if (park < 0 || park > 25) return null;       // a 30% "savings account" is not one
  if (amount !== null && amount !== undefined && amount !== '' && (amt === null || amt <= 0)) return null;

  const annualisedFeeCost = fee * (365 / days);
  const netRatePct = park - annualisedFeeCost;
  if (!Number.isFinite(netRatePct)) return null;

  return {
    introDays: days,
    feePct: fee,
    parkRate: park,
    annualisedFeeCost,
    netRatePct,
    // Dollars over the actual promotional window, which is all this ever earns:
    // the trade ends when the 0% does.
    periodDollars: amt === null ? null : amt * (netRatePct / 100) * (days / 365),
    amount: amt,
    profitable: netRatePct > 0,
  };
}

// ---------------------------------------------------------------------------
// Turning one curated offer into one opportunity
// ---------------------------------------------------------------------------

/**
 * The sentence that makes traps.js see every row here for what it is.
 *
 * Prepended by code rather than trusted to the dataset, so that every row in
 * this source trips TEASER_RATE — which is the literal truth about all of them:
 * these are promotional terms that revert, and the version you see today is not
 * necessarily the version that was live when this snapshot was taken.
 */
const PROMO_REQUIREMENT = 'Promotional offer — the terms, the amount and the qualifying conditions are set by the provider, change without notice, and are often targeted, so confirm the current offer on their own page before doing anything';

/** Credit cards get one extra sentence, because it is the one that costs money. */
const CARD_REQUIREMENT = 'Only worth doing on spend you were going to make anyway, paid in full each statement: at a typical 25% purchase APR, carrying the required spend for four months costs more than most of these bonuses pay';

/** The other-people clause. A referral is not work you control. */
const REFERRAL_REQUIREMENT = 'Depends on other people: the money only arrives if your friends actually sign up, fund, and stay past the qualifying window, and you cannot make any of that happen';

/**
 * What this offer is worth, in whatever unit is honest for its kind.
 *
 * Returns a bundle the row builder turns into fields, or null if the numbers
 * cannot describe a real offer. Every branch answers the same three questions:
 * how many dollars, against what denominator (if any), and how long the money
 * is committed (usually: not at all).
 */
function valueOf(item, kind) {
  const currency = String(item.currency || 'USD').toUpperCase();

  switch (kind.subType) {
    case 'referral_bonus': {
      const rv = referralValue({
        perReferral: item.perReferral,
        referralsNeeded: item.referralsNeeded,
        cap: item.cap,
      });
      if (!rv || rv.total <= 0) return null;
      const form = String(item.payoutForm || 'cash');
      const basis = [
        `${money(rv.perReferral)} per funded referral`,
        rv.referralsNeeded > 1 ? `x ${plural(rv.referralsNeeded, 'referral')}` : null,
        rv.cap !== null ? `capped at ${money(rv.cap)} a year` : null,
        form !== 'cash' ? `paid in ${form}` : null,
      ].filter(Boolean).join(', ');
      return {
        math: { kind: 'referral', ...rv },
        payout: { amount: rv.total, currency, basis },
        apyTotal: null,
        // No capital, no denominator, no rate. See expectedFor().
        capitalRequired: toNum(item.minInvestment) ?? 0,
        capDollars: rv.cap,
        termDays: null,
        horizonDays: toNum(item.qualifyingDays) ?? 90,
      };
    }

    case 'signup_bonus': {
      // Points are converted at a stated, conservative cents-per-point that the
      // row shows, because "60,000 points" is not a dollar figure and pretending
      // it is one at somebody's aspirational redemption rate is how these get
      // oversold.
      const cents = toNum(item.pointValueCents);
      const points = toNum(item.bonusPoints);
      const cash = toNum(item.bonusCash);
      const dollars = cash !== null ? cash
        : (points !== null && cents !== null ? (points * cents) / 100 : null);
      if (dollars === null) return null;

      const sr = spendBonusReturn({
        bonus: dollars,
        spendRequired: item.spendRequired,
        windowDays: item.windowDays,
        annualFee: item.annualFee,
      });
      if (!sr) return null;

      const valueNote = cash !== null
        ? `${money(dollars)} in cash back`
        : `${points.toLocaleString('en-US')} ${item.pointProgram || 'points'} valued at ${cents}c each = ${money(dollars)}`;
      const basis = [
        valueNote,
        `after ${money(sr.spendRequired)} of spend in ${sr.windowDays} days`,
        sr.annualFee > 0 ? `less the ${money(sr.annualFee)} annual fee` : 'no annual fee',
      ].join(', ');
      return {
        math: { kind: 'card_signup', ...sr, pointValueCents: cents, bonusPoints: points },
        payout: { amount: sr.netBonus, currency, basis, gross: sr.bonus, net: sr.netBonus },
        apyTotal: null,
        capitalRequired: 0,
        // The required spend is both the money that earns the bonus and the
        // ceiling on it: the 40% applies to the first $500 and to nothing after.
        capDollars: sr.spendRequired,
        termDays: null,          // nothing is committed; the window is a deadline
        horizonDays: sr.windowDays,
        spendDenominator: sr.spendRequired,
        returnOnSpend: sr.netReturnOnSpendPct,
      };
    }

    case 'category_bonus':
    case 'cashback_program': {
      const rb = rebateValue({
        rate: item.rate,
        baselineRate: item.baselineRate,
        spendCap: item.spendCap,
        capPeriod: item.capPeriod,
        referenceSpend: item.referenceSpend,
        membershipFee: item.membershipFee,
      });
      if (!rb) return null;
      const basis = [
        `${pct(rb.rate)} back`,
        rb.baselineRate > 0 ? `against a ${pct(rb.baselineRate)} everyday card, so ${pct(rb.incrementalRate)} is the part at stake` : null,
        rb.cappedAnnualSpend !== null
          ? `capped at ${money(rb.cappedAnnualSpend / rb.periodsPerYear)} of spend per ${item.capPeriod || 'year'}`
          : `modelled on ${money(rb.spendCounted)} of spend a year`,
        rb.membershipFee > 0 ? `less the ${money(rb.membershipFee)} membership` : null,
      ].filter(Boolean).join(', ');
      return {
        math: { kind: 'rebate', ...rb },
        payout: { amount: rb.netAnnual, currency, basis, perYear: true },
        apyTotal: null,
        capitalRequired: toNum(item.minInvestment) ?? 0,
        capDollars: rb.spendCounted,
        termDays: null,
        horizonDays: 365,
        spendDenominator: rb.spendCounted,
        returnOnSpend: rb.netRatePct,
      };
    }

    case 'transfer_bonus': {
      // The one kind here where real capital is committed for a real period, so
      // it is the one kind that gets a genuine annualised rate.
      const assets = toNum(item.requiredAssets);
      const holdDays = toNum(item.holdDays);
      const bonus = toNum(item.bonus);
      if (assets === null || assets <= 0 || bonus === null || bonus <= 0) return null;
      if (holdDays === null || holdDays <= 0 || holdDays > MAX_HOLD_DAYS) return null;
      if (bonus > MAX_PAYOUT) return null;
      const raw = holdBonusApy({ bonus, capital: assets, holdDays });
      if (raw === null || raw <= 0) return null;
      const scales = item.scales === true;
      return {
        math: {
          kind: 'transfer',
          bonus,
          requiredAssets: assets,
          holdDays,
          rawApy: raw,
          clamped: raw > MAX_EFFECTIVE_APY,
          firstYear: (bonus / assets) * 100,
          scales,
        },
        payout: {
          amount: bonus,
          currency,
          basis: `${money(bonus)} on ${money(assets)} transferred and held ${holdDays} days`,
        },
        apyTotal: Math.min(raw, MAX_EFFECTIVE_APY),
        capitalRequired: assets,
        // A percentage match is proportional, not capped: moving twice as much
        // earns twice the dollars at the same rate. Writing a cap onto one would
        // be a false statement about the product.
        capDollars: scales ? null : assets,
        termDays: holdDays,
        horizonDays: holdDays,
      };
    }

    case 'intro_apr_carry': {
      const ic = introCarry({
        introDays: item.introDays,
        feePct: item.feePct,
        parkRate: item.parkRate,
        amount: item.amount,
      });
      // A carry that does not clear its own fee is not an opportunity, it is a
      // fee. Refuse it rather than listing a negative rate as a deal.
      if (!ic || !ic.profitable) return null;
      return {
        math: { kind: 'intro_carry', ...ic },
        payout: {
          amount: ic.periodDollars,
          currency,
          basis: `${pct(ic.netRatePct)} net carry on ${money(ic.amount)} for the ${Math.round(ic.introDays / 30.44)}-month 0% window, after the ${pct(ic.feePct)} transfer fee`,
        },
        apyTotal: ic.netRatePct,
        // Borrowed money, not yours. The entry cost is the fee, not the balance.
        capitalRequired: 0,
        capDollars: ic.amount,
        termDays: ic.introDays,
        horizonDays: ic.introDays,
      };
    }

    case 'promo_offer':
    case 'unclaimed_funds': {
      const amountDollars = toNum(item.payoutAmount);
      if (amountDollars === null || amountDollars <= 0 || amountDollars > MAX_PAYOUT) return null;
      const assets = toNum(item.requiredAssets);
      const holdDays = toNum(item.holdDays);
      const spend = toNum(item.referenceSpend);

      // Three shapes, in order of how much the number can honestly claim.
      if (assets !== null && assets > 0 && holdDays !== null && holdDays > 0 && holdDays <= MAX_HOLD_DAYS) {
        const raw = holdBonusApy({ bonus: amountDollars, capital: assets, holdDays });
        if (raw === null || raw <= 0) return null;
        return {
          math: { kind: 'promo_on_capital', bonus: amountDollars, requiredAssets: assets, holdDays, rawApy: raw },
          payout: { amount: amountDollars, currency, basis: String(item.payoutBasis || `${money(amountDollars)} on ${money(assets)} held ${holdDays} days`) },
          apyTotal: Math.min(raw, MAX_EFFECTIVE_APY),
          capitalRequired: assets,
          capDollars: item.scales === true ? null : assets,
          termDays: holdDays,
          horizonDays: holdDays,
        };
      }
      if (spend !== null && spend > 0) {
        return {
          math: { kind: 'promo_on_spend', bonus: amountDollars, referenceSpend: spend, returnOnSpend: (amountDollars / spend) * 100 },
          payout: { amount: amountDollars, currency, basis: String(item.payoutBasis || `${money(amountDollars)} on ${money(spend)} of qualifying spend`) },
          apyTotal: null,
          capitalRequired: 0,
          capDollars: spend,
          termDays: null,
          horizonDays: toNum(item.windowDays) ?? 365,
          spendDenominator: spend,
          returnOnSpend: (amountDollars / spend) * 100,
        };
      }
      return {
        math: { kind: 'promo_flat', bonus: amountDollars },
        payout: { amount: amountDollars, currency, basis: String(item.payoutBasis || `${money(amountDollars)}, once`) },
        apyTotal: null,
        capitalRequired: toNum(item.minInvestment) ?? 0,
        capDollars: toNum(item.cap),
        termDays: null,
        horizonDays: toNum(item.windowDays) ?? 365,
      };
    }

    default:
      return null;
  }
}

/**
 * The number the app is allowed to print in a percentage column.
 *
 * This is the honesty problem this whole file turns on. The app ranks on a rate,
 * and most of the money here has no rate, because a return is a ratio of money
 * earned to money committed and these commit nothing. There are three cases and
 * they are kept strictly apart:
 *
 *   CAPITAL IS COMMITTED (a transfer bonus, an intro-APR carry). A real
 *   denominator exists, so apy.total carries a real annualised figure and this
 *   returns null — one number, not two.
 *
 *   MONEY MUST MOVE BUT IS NOT AT RISK (a sign-up bonus, a category rebate).
 *   The denominator is the SPEND. The figure is the year-one return on that
 *   spend, not annualised past the year, and expected.basis says so in words so
 *   nobody reads "40%" as a savings rate. A 40% return on $500 of groceries is
 *   $200 and it is not 40% of anything you own.
 *
 *   NOTHING IS COMMITTED AT ALL (a referral, a retention offer, unclaimed
 *   property). There is no denominator. The return on capital is not "large", it
 *   is undefined — and printing a large number for it, or annualising the payout
 *   against nothing, would be the exact fabrication this app exists to avoid. So
 *   the rate reads zero, meaning "none of this comes from your money", and every
 *   dollar of it lives in `payout` with the row saying so in its first sentence.
 */
function expectedFor(valued, item, kind) {
  if (valued.apyTotal !== null) return null;   // a real rate already exists

  const basis = [];
  let annualReturn;
  let thesis;

  if (Number.isFinite(valued.returnOnSpend) && Number.isFinite(valued.spendDenominator)) {
    annualReturn = valued.returnOnSpend;
    basis.push(`percent of the ${money(valued.spendDenominator)} you have to route through it, not of money you park`);
    basis.push('collected inside the year and deliberately not annualised past it — it happens once, on that spend');
    if (kind.subType === 'signup_bonus' && valued.math.annualFee > 0) {
      basis.push(`net of the ${money(valued.math.annualFee)} annual fee`);
    }
    thesis = kind.subType === 'signup_bonus'
      ? `${money(valued.payout.amount)} kept on ${money(valued.spendDenominator)} of spend inside ${valued.horizonDays} days. No capital is at risk; the risk is the fee and the interest if you carry a balance.`
      : `${money(valued.payout.amount)} a year on ${money(valued.spendDenominator)} of spend, which is a rebate on money leaving your account rather than a return on money in it.`;
  } else {
    // The undefined case. Zero is not a claim that this pays nothing — the
    // payout field says exactly what it pays. It is the statement that none of
    // it is a return on capital, because no capital is involved.
    annualReturn = 0;
    basis.push('no capital is required, so there is no rate: a return needs a denominator and this has none');
    basis.push(`the value is ${money(valued.payout.amount)} in cash, carried in the payout field rather than invented as a percentage`);
    thesis = `${money(valued.payout.amount)} of cash for work, not for money. The percentage column reads zero because nothing of yours is deployed — read the payout, and read the effort next to it.`;
  }

  return {
    annualReturn,
    basis,
    thesis,
    horizonDays: valued.horizonDays,
  };
}

/** One curated offer -> one normalized opportunity, or null if it is unusable. */
function buildRow(item, { dataAsOf, schema, C }) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const kind = KINDS[String(item.kind || '').trim()];
  if (!kind) return null;

  const key = String(item.id ?? item.name ?? '').trim();
  const name = String(item.name ?? item.id ?? '').trim();
  if (!key || !name) return null;

  // A row nobody can act on is noise, and the audit refuses rows without either
  // of these anyway.
  const url = String(item.url ?? '').trim();
  const accessBase = String(item.accessNotes ?? '').trim();
  if (!url || !accessBase) return null;

  const valued = valueOf(item, kind);
  if (!valued) return null;
  if (!Number.isFinite(valued.payout.amount)) return null;

  const expected = expectedFor(valued, item, kind);
  const effort = EFFORT_KEYS.has(String(item.effort)) ? String(item.effort) : kind.effort;
  const reach = REACH_KEYS.has(String(item.reach)) ? String(item.reach) : 'common';
  const oneTime = typeof item.oneTime === 'boolean' ? item.oneTime : kind.oneTime;

  // Dates are the whole point of the deals shelf: a thing that closes on Friday
  // and a thing with no deadline are not comparable. Anything unparseable is
  // dropped rather than guessed at — a wrong countdown is worse than none.
  const expiresAt = isoDay(item.expiresAt, null);
  const startsAt = isoDay(item.startsAt, null);

  const stated = Array.isArray(item.requirements) ? item.requirements.map((r) => String(r)).filter(Boolean) : [];
  const requirements = [PROMO_REQUIREMENT];
  if (kind.subType === 'referral_bonus') requirements.push(REFERRAL_REQUIREMENT);
  if (kind.subType === 'signup_bonus' || kind.subType === 'category_bonus' || kind.subType === 'intro_apr_carry') {
    requirements.push(CARD_REQUIREMENT);
  }
  requirements.push(...stated);

  // --- the sentences, which are most of what this row is for ----------------
  const notes = [];
  notes.push(`${money(valued.payout.amount)}${valued.payout.perYear ? ' a year' : ''}: ${valued.payout.basis}.`);

  const m = valued.math;
  if (m.kind === 'referral') {
    notes.push(`It takes ${plural(m.referralsNeeded, 'person')} other than you. `
      + `${m.referralsNeeded > 1 ? `Two of five signing up pays ${money(m.perReferral * 2)}, not ${money(m.total)}` : 'If nobody signs up it pays nothing'} — `
      + 'this is not a rate and it is not passive.');
    if (m.capped) {
      notes.push(`The program stops paying at ${money(m.cap)} a year, so ${money(m.gross)} of referrals only collects ${money(m.total)}.`);
    }
    notes.push('There is no percentage here on purpose: you deploy no money, so a return on capital would be a division by zero rather than a big number.');
  } else if (m.kind === 'card_signup') {
    notes.push(`${pct(m.returnOnSpendPct)} of the required spend, which is the only denominator this has — it is not ${pct(m.returnOnSpendPct)} on money you own.`);
    if (m.annualFee > 0) {
      notes.push(m.feeEatsBonus
        ? `The ${money(m.annualFee)} annual fee is LARGER than the ${money(m.bonus)} bonus: year one is ${money(m.netBonus)}, a loss, unless you actually use the card's credits. That is the whole calculation and the advertisement never shows it.`
        : `The ${money(m.annualFee)} annual fee comes straight off it: ${money(m.bonus)} headline, ${money(m.netBonus)} net. The app ranks the net.`);
    }
    notes.push(`Hitting ${money(m.spendRequired)} in ${m.windowDays} days means about ${money(m.monthlySpend)} a month. If that is more than you normally spend, the gap is either debt or manufactured spend, and both cost more than the bonus.`);
  } else if (m.kind === 'rebate') {
    if (m.baselineRate > 0) {
      notes.push(`The honest figure is the increment: ${pct(m.rate)} against the ${pct(m.baselineRate)} you would earn anyway is ${pct(m.incrementalRate)} of new money.`);
    }
    if (m.cappedAnnualSpend !== null) {
      notes.push(`Capped: ${money(m.cappedAnnualSpend / m.periodsPerYear)} of spend per ${m.periodsPerYear === 12 ? 'month' : m.periodsPerYear === 4 ? 'quarter' : 'year'} counts and not a dollar more, so the ceiling is ${money(m.grossAnnual)} a year however much you spend.`);
    }
    if (m.membershipFee > 0) {
      notes.push(`It costs ${money(m.membershipFee)} a year, so it is negative until you spend ${money(m.breakevenSpend)} in the category. Below that line this is a subscription, not a rebate.`);
    }
  } else if (m.kind === 'transfer') {
    notes.push(`${pct(m.firstYear)} of the transferred balance, paid once, which annualises to ${pct(m.rawApy)} over the ${m.holdDays}-day holding period. The annualised figure is the fair comparison for those ${m.holdDays} days and is NOT what a year looks like.`);
    notes.push(m.scales
      ? 'Proportional rather than capped — moving twice as much earns twice the dollars at the same rate — but it still pays once.'
      : `Pull the assets out early and the bonus is forfeited or clawed back. Money above ${money(m.requiredAssets)} earns nothing extra.`);
    notes.push('What you transfer stays invested in whatever you hold; the bonus does not protect it. SIPC covers the broker failing, never the market falling.');
  } else if (m.kind === 'intro_carry') {
    notes.push(`The fee is the trade: ${pct(m.feePct)} paid up front over a ${Math.round(m.introDays / 30.44)}-month window is ${pct(m.annualisedFeeCost)} a year of cost against a ${pct(m.parkRate)} parking rate, leaving ${pct(m.netRatePct)}.`);
    notes.push('This is leverage on a consumer credit line. One late payment typically ends the promotional rate and the balance reverts to a mid-20s APR, which costs more in two months than this earns in a year. It also raises your utilisation, which lowers your score while it runs.');
  }

  if (valued.capDollars !== null && valued.capDollars !== undefined && kind.subType === 'referral_bonus') {
    notes.push(`The ${money(valued.capDollars)} ceiling is a cap on what the program will PAY you, not on money you deposit — there is no deposit here.`);
  }

  notes.push(oneTime
    ? 'One-off and not repeatable: it pays once per customer and there is no version of this where the money keeps arriving.'
    : 'Recurring while the program lasts, but the provider sets the rate and the categories and can change either at any time.');

  notes.push(valued.capitalRequired > 0
    ? `Requires ${money(valued.capitalRequired)} of your own money to be in place.`
    : 'No capital required, which is why the rate column cannot say anything useful about it.');

  notes.push('Taxable: cash referral and promotional payments are generally reported on a 1099-MISC and bank-style payments on a 1099-INT. Credit card rewards earned by spending are normally treated as a rebate and not taxed, but referral rewards from an issuer usually are — a distinction that surprises people every February.');

  if (String(item.notes || '').trim()) notes.push(String(item.notes).trim());

  const accessNotes = [
    accessBase,
    K.EFFORT_INFO[effort]?.text,
  ].filter(Boolean).join(' ');

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key,
    name,
    provider: item.provider || null,
    assetClass: C.ASSET_CLASS.CASH,
    subType: item.subType || kind.subType,
    // The return is a contractual cash payment for doing a stated thing. Nothing
    // here moves with a market.
    track: 'income',
    section: K.SECTION.DEALS,
    region: item.region || 'US',
    currency: valued.payout.currency,

    // Null for everything without capital behind it. That is the point.
    apy: valued.apyTotal === null ? { total: null } : { total: valued.apyTotal },
    // Hit the stated conditions and the provider owes you the money. What is
    // uncertain is whether the offer still exists, not whether it pays.
    yieldKind: C.YIELD_KIND.CONTRACTUAL,
    payoutFrequency: oneTime ? 'one-time' : 'recurring',
    compounding: 1,

    term: valued.termDays === null ? {} : {
      days: valued.termDays,
      kind: 'lockup',
      earlyExitPenalty: kind.subType === 'transfer_bonus'
        ? `Leave early and you forfeit or repay the ${money(valued.payout.amount)}`
        : null,
    },

    minInvestment: valued.capitalRequired,
    maxInvestment: valued.capDollars ?? null,

    liquidity: item.liquidity || kind.liquidity,

    risk: {
      // Nothing here is insured, and most of it has nothing to insure.
      insurance: C.INSURANCE.NONE,
      // You cannot lose money you never put in. Where money IS committed
      // (transfers, an intro-APR carry) it is exposed to whatever it is in.
      principalAtRisk: valued.capitalRequired > 0 || kind.subType === 'intro_apr_carry',
    },

    expected,
    oneTime,
    effort,
    reach,
    expiresAt,
    startsAt,
    series: Array.isArray(item.series) ? item.series.filter((n) => Number.isFinite(n)) : null,

    taxTreatment: item.taxTreatment || C.TAX_TREATMENT.ORDINARY,
    url,
    notes: notes.join(' '),
    accessNotes,
    requirements,

    dataAsOf: isoDay(item.dataAsOf, dataAsOf),
    live: false,
    seed: item.origin !== 'user',

    // The dollars, and the arithmetic that produced them, carried through raw so
    // the UI can show a payment rather than a percentage on rows where the
    // percentage is meaningless.
    raw: { payout: valued.payout, dealMath: valued.math, kind: item.kind },
  };

  const out = schema.normalize(row, { source: ID, seed: row.seed, keepRaw: true });
  if (!out) return null;

  // Top-level too: `raw` is dropped by exports and by anything that re-normalizes,
  // and the payout is the headline fact of the row, not a debugging aid.
  out.payout = valued.payout;
  out.dealMath = valued.math;

  // Same ceiling logic as bonuses.js: a stated confidence may only lower the
  // cap, never raise it, and the age decay normalize() already applied still
  // wins if it is lower.
  const ceiling = row.seed ? SEED_CONFIDENCE : CURATED_CONFIDENCE;
  const stated2 = toNum(item.confidence);
  const cap = stated2 === null ? ceiling : Math.max(0, Math.min(stated2, ceiling));
  out.confidence = Number(Math.min(out.confidence ?? cap, cap).toFixed(3));
  return out;
}

/** PURE ENTRY POINT: curated items -> opportunities. Never throws. */
function buildRows(items, ctx = {}) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const dataAsOf = ctx.dataAsOf || FALLBACK_AS_OF;

  const opportunities = [];
  const seen = new Set();
  const byKind = {};
  let skipped = 0;

  for (const item of Array.isArray(items) ? items : []) {
    let row = null;
    try {
      row = buildRow(item, { dataAsOf, schema, C });
    } catch {
      row = null;   // one malformed offer must never take the source down
    }
    if (!row || seen.has(row.id)) { skipped += 1; continue; }
    seen.add(row.id);
    const k = String(item?.kind || 'unknown');
    byKind[k] = (byKind[k] || 0) + 1;
    opportunities.push(row);
  }

  return { opportunities, skipped, byKind };
}

// ---------------------------------------------------------------------------
// The user's own offers, from a file or a feed
// ---------------------------------------------------------------------------

/**
 * Merge the user's own offers over the bundled dataset.
 *
 * Same rules as savings.js and bonuses.js, for the same reason: matching id
 * replaces field by field, new id appends, bundled order is preserved so the
 * table does not reshuffle on an edit. Field-level matters even more here — the
 * realistic edit is "the Acorns tier is $900 now", and nobody is going to retype
 * a requirements list to change one number.
 */
function mergeUserDeals(seedItems, userItems) {
  const keyOf = (it) => String(it?.id ?? it?.name ?? '').trim().toLowerCase();
  const out = [];
  const at = new Map();

  const put = (item, origin) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const k = keyOf(item);
    if (!k) return;
    const base = at.has(k) ? out[at.get(k)] : null;
    const row = { ...(base || {}), ...item, origin };
    if (base) out[at.get(k)] = row;
    else { at.set(k, out.length); out.push(row); }
  };

  for (const it of Array.isArray(seedItems) ? seedItems : []) put(it, 'seed');
  for (const it of Array.isArray(userItems) ? userItems : []) put(it, 'user');
  return out;
}

/**
 * Read a payload in this file's documented shape: an array of items, or an
 * object with an `items` array and optional `meta`. Pure, total, and shared by
 * the file path and the feed path so both degrade identically.
 */
function parseFeed(payload) {
  if (Array.isArray(payload)) return { items: payload.filter((x) => x && typeof x === 'object' && !Array.isArray(x)), meta: {} };
  if (!payload || typeof payload !== 'object') return { items: [], meta: {} };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta) ? payload.meta : {};
  return { items: items.filter((x) => x && typeof x === 'object' && !Array.isArray(x)), meta };
}

/**
 * Read ctx.settings.userDealsPath. Missing is the normal case and says nothing;
 * present but broken is a warning, because the user edited it, believes their
 * offers are current, and they silently are not.
 */
function readUserDeals(filePath, readFile = fs.readFileSync) {
  if (!filePath) return { items: [], configured: false, warning: null };
  // fs.readFileSync treats a NUMBER as a file descriptor, so a settings value
  // that is not a path does not fail — it reads whatever fd happens to be open,
  // and on a pipe it blocks the whole app forever. Only a string is a path.
  if (typeof filePath !== 'string') {
    return { items: [], configured: true, warning: `Your deals file setting is not a path (${typeof filePath}), so nothing was loaded from it.` };
  }
  let rawText;
  try {
    rawText = readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], configured: true, warning: null };
    return { items: [], configured: true, warning: `Could not read your deals file (${filePath}): ${err?.message || err}` };
  }
  try {
    const parsed = JSON.parse(rawText);
    const { items } = parseFeed(parsed);
    if (!items.length) {
      return { items: [], configured: true, warning: `Your deals file (${filePath}) has no usable "items" array, so nothing in it was used.` };
    }
    return { items, configured: true, warning: null };
  } catch (err) {
    return { items: [], configured: true, warning: `Your deals file (${filePath}) is not valid JSON, so your edits were ignored: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Adapter entry points
// ---------------------------------------------------------------------------

const VERIFY_WARNING = 'Every figure here is approximately right for the stated date and nothing more. Referral tiers, card sign-up bonuses and portal rates change weekly, run at several levels at once, and are frequently targeted to individual customers — the offer on your screen is the only one that counts. Open the link and read the current terms before you spend, transfer or invite anybody.';

const CARD_WARNING = 'The credit card rows only make money on spend you were already going to make, paid in full every statement. Carrying the balance at a typical 25% APR wipes out any of these bonuses within months, and applying adds a hard inquiry and a new account to your file.';

const POINTS_WARNING = 'Points and miles are converted to dollars at a conservative, stated cents-per-point on each row. That conversion is an assumption, not a price: what a point is worth depends entirely on how you redeem it, and airline and hotel programs devalue theirs without notice.';

const REFERRAL_WARNING = 'Referral rows pay nothing unless other people act. They are marked "needs other people" for that reason, and the headline figure assumes every referral the program requires actually signs up, funds, and stays past the qualifying window.';

function collect(ctx, extraItems = []) {
  const schema = ctx?.schema || baseSchema;
  const C = ctx?.C || baseC;
  const { items: seedItems, meta } = contract.readSeed(ctx?.seedDir, SEED_FILE);
  const user = readUserDeals(ctx?.settings?.userDealsPath ?? null);

  const merged = mergeUserDeals(seedItems, [...user.items, ...extraItems]);
  const asOf = isoDay(meta?.dataAsOf, FALLBACK_AS_OF);
  const built = buildRows(merged, { schema, C, dataAsOf: asOf });

  const fromUser = built.opportunities.filter((o) => o.seed === false).length;
  const dated = built.opportunities.filter((o) => o.expiresAt).length;
  const social = built.opportunities.filter((o) => o.effort === 'social').length;
  const hidden = built.opportunities.filter((o) => o.reach === 'niche' || o.reach === 'obscure').length;

  const notes = [
    `${built.opportunities.length} offers (${fromUser} from your own file, ${built.opportunities.length - fromUser} bundled as of ${asOf}).`,
    `${social} need other people to act before they pay anything, ${dated} have a stated closing date, and ${hidden} are not widely advertised.`,
    'Most rows here have no APY at all, and that is deliberate: a referral or a sign-up bonus commits no capital, so there is no denominator and no rate. The money is in the payout field, and where a percentage is shown it is a percentage of the SPEND you route through the offer, never of money you park.',
    'Caps, deadlines and annual fees are structural fields, not prose: maxInvestment carries the cap, expiresAt the closing date, and the annual fee is netted off every card bonus before it is ranked.',
    'No public API publishes any of this. Keep your own copy current at Settings -> deals file: same shape as data/seed/deals.json, a matching id replaces the bundled row, a new id is added, and a fresh dataAsOf earns back the confidence the snapshot has lost.',
  ];
  if (built.skipped) {
    notes.push(`${built.skipped} row(s) skipped — unknown kind, missing link or access notes, no usable amount, or figures outside the sanity limits.`);
  }
  const kinds = Object.entries(built.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KINDS[k]?.label || k}`);
  if (kinds.length) notes.push(`By kind: ${kinds.join(', ')}.`);

  const warnings = user.warning ? [user.warning] : [];
  return { built, notes, warnings, meta };
}

/**
 * The live path.
 *
 * There is no third-party API for promotional offers, so there is nothing to
 * scrape and this source is honest about that every single time. What CAN be
 * live is a feed the user controls: point ctx.settings.dealsFeedUrl at JSON in
 * the documented item shape and it is merged over the bundle exactly like the
 * local file. Anything else — a blocked proxy, a 404, HTML where JSON should be
 * — degrades to the bundled snapshot with a warning and never throws.
 */
async function fetch(ctx) {
  try {
    const url = typeof ctx?.settings?.dealsFeedUrl === 'string' ? ctx.settings.dealsFeedUrl.trim() : '';
    let extra = [];
    const warnings = [];

    if (url) {
      try {
        const payload = await ctx.http.getJSON(url, { signal: ctx.signal });
        const parsed = parseFeed(payload);
        extra = parsed.items;
        ctx?.log?.(`deals: ${extra.length} offers from your feed`);
        if (!extra.length) warnings.push(`Your deals feed (${url}) returned no usable items, so only the bundled snapshot is shown.`);
      } catch (err) {
        const status = err?.status ? `HTTP ${err.status}${err.status === 403 || err.status === 407 ? ' (blocked by network policy)' : ''}: ` : '';
        warnings.push(`Could not read your deals feed (${url}): ${status}${err?.message || err}. Showing the bundled snapshot instead.`);
      }
    }

    const { built, notes, warnings: base } = collect(ctx || {}, extra);
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        notes,
        warnings: [...base, ...warnings, 'No usable offers in the bundled dataset or your own file.'],
      });
    }
    ctx?.log?.(`deals: ${built.opportunities.length} curated offers, none verifiable without opening the offer page`);
    return contract.result({
      opportunities: built.opportunities,
      // Never better than partial: the one thing that would make this 'ok' —
      // confirming the offer is live today — cannot be done without a human
      // opening the page.
      status: 'partial',
      notes,
      warnings: [...base, ...warnings, VERIFY_WARNING, CARD_WARNING, POINTS_WARNING, REFERRAL_WARNING],
    });
  } catch (err) {
    return contract.failure(err);
  }
}

function loadSeed(ctx) {
  try {
    const { built, notes, warnings } = collect(ctx || {});
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        warnings: warnings.concat('Bundled deals dataset is missing or unreadable.'),
      });
    }
    return contract.result({
      opportunities: built.opportunities,
      status: 'offline',
      notes,
      warnings: warnings.concat(VERIFY_WARNING, CARD_WARNING, POINTS_WARNING, REFERRAL_WARNING),
    });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Referral programs, credit card sign-up bonuses, category and portal rebates, transfer promotions and fintech offers — real money with no capital behind it, priced in dollars rather than in a percentage nobody can compute, with the caps, deadlines and annual fees on the row.',
  homepage: 'https://www.consumerfinance.gov/consumer-tools/credit-cards/',
  assetClasses: [baseC.ASSET_CLASS.CASH],
  requiresNetwork: false,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 24 * 60 * 60 * 1000,

  fetch,
  loadSeed,

  // The maths and the pure path, for the tests and anything else that wants them.
  referralValue,
  spendBonusReturn,
  holdBonusApy,
  rebateValue,
  introCarry,
  valueOf,
  expectedFor,
  buildRow,
  buildRows,
  mergeUserDeals,
  parseFeed,
  readUserDeals,
  isoDay,
  KINDS,
  CURATED_CONFIDENCE,
  SEED_CONFIDENCE,
  MAX_PAYOUT,
  MAX_REFERRALS,
  MAX_SPEND_RETURN_PCT,
  MAX_REBATE_RATE,
  MAX_EFFECTIVE_APY,
  MAX_HOLD_DAYS,
  PROMO_REQUIREMENT,
  CARD_REQUIREMENT,
  REFERRAL_REQUIREMENT,
};
