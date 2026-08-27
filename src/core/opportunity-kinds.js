'use strict';

/**
 * The dimensions that decide whether an opportunity is findable.
 *
 * A flat list sorted by return is unusable once it passes a few hundred rows —
 * 250 crypto tickers bury the one bank offer that pays $1,500 for an afternoon's
 * work. The fix is not fewer rows, it is more axes: the things people actually
 * search on are "how soon does this disappear", "how much work is it", "does
 * anyone know about this", and "what do I actually buy to get it".
 *
 * None of these existed before, which is why everything collapsed into one
 * undifferentiated wall.
 */

/**
 * Sections. Coarser than asset class and finer than the income/movement split,
 * because "a savings account" and "a $1,500 referral bonus" are both income and
 * have nothing else in common.
 */
const SECTION = {
  INCOME: 'income',        // pays a yield: savings, CDs, bonds, DeFi, dividend funds
  MOVEMENT: 'movement',    // return comes from price: stocks, crypto, commodities
  DEALS: 'deals',          // bounded, often one-off money: bonuses, referrals, promos
  EVENTS: 'events',        // dated things that move the above
};

const SECTION_INFO = {
  income: {
    label: 'Income',
    blurb: 'Things that pay you a rate you can compute.',
    icon: '◆',
  },
  movement: {
    label: 'Movement',
    blurb: 'Things whose return is price. What is about to move, and how hard.',
    icon: '◈',
  },
  deals: {
    label: 'Deals',
    blurb: 'Bounded money: sign-up bonuses, referrals, promotions. Often the highest return per dollar in the whole app, and always capped.',
    icon: '★',
  },
  events: {
    label: 'Calendar',
    blurb: 'Dated things that move everything else.',
    icon: '▣',
  },
};

/**
 * How long the window stays open.
 *
 * "Short-lasting opportunities should be easy to find" — so expiry is a first
 * class field, not a note buried in the description. Anything with a real
 * deadline gets a countdown and can be sorted and filtered on it.
 */
const WINDOW = [
  { key: 'closing', maxDays: 7, label: 'Closing', color: '#ff6b6b', text: 'Gone within a week.' },
  { key: 'weeks', maxDays: 31, label: 'Weeks left', color: '#e08b3c', text: 'A few weeks left.' },
  { key: 'months', maxDays: 120, label: 'Months left', color: '#c9a227', text: 'Some months of runway.' },
  { key: 'open', maxDays: Infinity, label: 'Open', color: '#5fb85f', text: 'No published deadline.' },
];

function windowFor(daysLeft) {
  if (!Number.isFinite(daysLeft)) return WINDOW[WINDOW.length - 1];
  if (daysLeft < 0) return { key: 'expired', maxDays: 0, label: 'Expired', color: '#8f9aab', text: 'The window has closed.' };
  return WINDOW.find((w) => daysLeft <= w.maxDays) || WINDOW[WINDOW.length - 1];
}

/**
 * How much work it takes.
 *
 * A 12% yield you click once for and a $1,500 referral bonus that needs five
 * friends to actually sign up are not comparable, and hiding that difference
 * behind a percentage is how a screener wastes someone's afternoon.
 */
const EFFORT = [
  { key: 'passive', label: 'Click once', minutes: 5, text: 'Open it, fund it, done.' },
  { key: 'light', label: 'Light setup', minutes: 30, text: 'Some paperwork or a transfer to arrange.' },
  { key: 'hoops', label: 'Hoops', minutes: 120, text: 'Direct deposits, minimum balances, debit transactions — real requirements to track.' },
  { key: 'social', label: 'Needs other people', minutes: 240, text: 'Depends on other people signing up or acting. You do not control whether it pays.' },
  { key: 'ongoing', label: 'Ongoing work', minutes: 600, text: 'Needs continued attention to keep earning.' },
];

const EFFORT_INFO = Object.fromEntries(EFFORT.map((e) => [e.key, e]));

/**
 * How widely known something is.
 *
 * "Opportunities only a small group of people know about should be easy to find."
 * Obscurity is genuinely informative in both directions: an obscure deal is
 * often better because it is uncrowded, and an obscure DeFi pool is often worse
 * because nobody has audited it. So it is shown, not scored.
 */
const REACH = [
  { key: 'everyone', label: 'Well known', color: '#8f9aab', text: 'Widely advertised. No edge, but no surprises.' },
  { key: 'common', label: 'Common', color: '#8f9aab', text: 'Easy to find if you look.' },
  { key: 'niche', label: 'Niche', color: '#c9a227', text: 'Known to people who follow this area. Not advertised.' },
  { key: 'obscure', label: 'Obscure', color: '#3ddc97', text: 'Few people know about this. Verify it carefully — obscurity cuts both ways.' },
];

const REACH_INFO = Object.fromEntries(REACH.map((r) => [r.key, r]));

/**
 * What you actually buy.
 *
 * The same view can often be expressed several ways, and which one is right
 * depends on the account, the capital and the goal. A $600 share is out of reach
 * for a small account unless you buy fractionally or use a long-dated call. A
 * stock you want income from is a covered call. A stock you would happily own
 * cheaper is a cash-secured put. Naming the vehicle is the difference between a
 * screener and something usable.
 */
const VEHICLE = {
  SHARES: 'shares',
  FRACTIONAL: 'fractional',
  ETF: 'etf',
  LONG_CALL: 'long_call',
  LEAPS: 'leaps',
  COVERED_CALL: 'covered_call',
  CASH_SECURED_PUT: 'cash_secured_put',
  PROTECTIVE_PUT: 'protective_put',
  SPREAD: 'spread',
  DEPOSIT: 'deposit',
  DIRECT: 'direct',
  ON_CHAIN: 'on_chain',
  AUCTION: 'auction',
};

module.exports = {
  SECTION, SECTION_INFO,
  WINDOW, windowFor,
  EFFORT, EFFORT_INFO,
  REACH, REACH_INFO,
  VEHICLE,
};
