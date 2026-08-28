'use strict';

const fs = require('node:fs');
const contract = require('./_contract');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * CASH & ACCOUNT BONUSES — the highest genuinely-safe return in the app, and the
 * one no yield screener will show you.
 *
 * A bank paying $300 for a $5,000 balance held 90 days is a 26% annualised
 * return on FDIC-insured money. That is not a trick and it is not a scam; it is
 * a customer-acquisition cost, paid in cash, to anyone willing to do the
 * paperwork. It belongs in an app about the highest available APY.
 *
 * It is also three things a savings account is not, and every row here has to
 * say all three out loud or the number is a lie:
 *
 *   1. IT IS ONE-OFF. The 26% is a 6% return that happened to take 90 days.
 *      Annualising it is the right way to compare it against a savings account
 *      FOR THOSE 90 DAYS, and it is completely wrong as a statement about what
 *      you earn over a year. Both numbers are computed and both are shown:
 *      effectiveApy() for the comparison, firstYearReturn() for the reality.
 *   2. IT IS CAPPED. More money does not earn more. The bonus is a fixed dollar
 *      amount, so the marginal return on anything above the required balance is
 *      the account's ordinary rate. That is encoded structurally as
 *      maxInvestment === minInvestment === requiredDeposit, which is also what
 *      trips CAPPED_BALANCE in traps.js.
 *   3. IT IS NOT REPEATABLE. One per customer, usually with a "no account in the
 *      last N months" clause. You cannot compound it, and there is no version of
 *      this where the money keeps earning the headline rate.
 *
 * There is no free API for promotional offers — they live on landing pages,
 * change weekly, and are frequently targeted to individual customers. So this
 * source works exactly like savings.js: the curated dataset IS the payload, and
 * the user can keep their own copy current through ctx.settings.userBonusesPath.
 * The status is never better than 'partial', because an offer we have not seen
 * today is a lead, not a quote.
 */

const ID = 'bonuses';
const LABEL = 'Cash & Account Bonuses';
const SEED_FILE = 'bonuses.json';
const FALLBACK_AS_OF = '2026-08-01';

/**
 * Confidence ceiling, lower than the deposit-rate table's.
 *
 * Two separate reasons to distrust the headline: the offer itself churns faster
 * than a savings rate does (weeks, and often targeted rather than public), and
 * the number is a MODEL — an annualisation of a one-off, which is a judgement
 * about what the money was doing, not a rate anyone published. A row here must
 * never outrank a real quoted yield on trust.
 */
const CURATED_CONFIDENCE = 0.5;

/**
 * And a lower ceiling again for the bundled snapshot, because a promotional
 * offer is not a rate: a savings rate from a month ago is probably still
 * roughly right, whereas an offer from a month ago has a real chance of simply
 * no longer existing. A row the user checked themselves is worth strictly more
 * than one this app shipped, and the two must not flatten into the same number.
 */
const SEED_CONFIDENCE = 0.4;

/** Per depositor, per institution, per ownership category. */
const INSURED_LIMIT = 250000;

/**
 * Annualising a one-off stops meaning anything once the period return is large.
 * $100 for a $50 deposit held 90 days is genuinely 8,500% annualised, and that
 * figure is arithmetically correct and completely useless: nobody can repeat it
 * four times a year, because the offer pays once and caps at $100. So the
 * displayed rate is clamped here and the clamp is stated on the row. The plain
 * first-year percentage is the honest headline for those, and it is in notes.
 */
const MAX_EFFECTIVE_APY = 500;

/** A bonus larger than this multiple of the deposit is a data-entry error. */
const MAX_BONUS_RATIO = 20;

/** An ongoing account rate outside this band is a typo, not an account. */
const MAX_ONGOING_APY = 25;

/** Past this the "promotion" is a lockup wearing a promotion's clothes. */
const MAX_HOLD_DAYS = 3650;

/**
 * What kind of institution is holding the money, which decides the only thing
 * that actually matters about safety here: whether a failure costs you anything.
 *
 * A bank bonus and a brokerage transfer bonus look identical on the row and are
 * not the same product. Cash in an insured deposit account is protected to the
 * limit; assets transferred to a broker are exposed to whatever you hold in
 * them, and SIPC covers the broker failing, never the market falling. Conflating
 * those would put a false insurance badge on half this source.
 */
const KINDS = {
  bank_checking: {
    subType: 'checking_bonus',
    insurance: baseC.INSURANCE.FDIC,
    custody: 'deposit',
  },
  bank_savings: {
    subType: 'savings_bonus',
    insurance: baseC.INSURANCE.FDIC,
    custody: 'deposit',
  },
  credit_union: {
    subType: 'credit_union_bonus',
    insurance: baseC.INSURANCE.NCUA,
    custody: 'deposit',
  },
  brokerage: {
    subType: 'brokerage_bonus',
    insurance: baseC.INSURANCE.SIPC,
    custody: 'brokerage',
  },
  ira_transfer: {
    subType: 'ira_transfer_bonus',
    insurance: baseC.INSURANCE.SIPC,
    custody: 'brokerage',
    // Money credited inside an IRA is not income this year; it compounds
    // untaxed and is taxed on withdrawal, which is a materially better deal
    // than the 1099 that comes with every other row in this file.
    taxTreatment: baseC.TAX_TREATMENT.TAX_DEFERRED,
  },
  cash_management: {
    subType: 'cash_management_bonus',
    insurance: baseC.INSURANCE.FDIC,
    custody: 'sweep',
  },
};

/**
 * Where the required money has to be, which changes what the annualised figure
 * means. Stated per row rather than guessed, because the difference is the whole
 * argument about whether the number is honest.
 */
const DEPOSIT_BASIS = {
  balance_held: 'balance_held',       // must sit in the account for the period
  deposits_received: 'deposits_received', // must arrive; you may spend it again
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const money = (n) => {
  const frac = Math.abs(n % 1) > 1e-9 ? 2 : 0;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
};

const pct = (n) => `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)}%`;

/**
 * A date we are willing to hand to the rest of the app.
 *
 * Date.parse returns NaN on junk and new Date(t).toISOString() throws RangeError
 * outside +/-8.64e15 ms. A hand-edited user file is exactly where a "2026-13-45"
 * or a millisecond value pasted as seconds turns up, and an adapter that throws
 * on one bad date takes the whole source down.
 */
function isoDay(value, fallback) {
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
 * The honest annualised rate on money committed to a bonus offer.
 *
 * The bonus is a one-off payment on a required balance held for a required
 * period, so the period return is bonus/requiredDeposit and the annual figure is
 * that COMPOUNDED over the year, not multiplied:
 *
 *     bonusApy = ((1 + bonus/requiredDeposit) ^ (365/holdDays) - 1) * 100
 *
 * The distinction is not pedantry. A 6% return over 90 days is 26.7% annualised,
 * not 24%; over 30 days a 6% return is 103%, not 73%. Simple multiplication
 * understates short offers badly and would rank a 30-day $300 bonus below a
 * 180-day one that pays the same dollars, which is backwards. Getting this wrong
 * in either direction is the class of error this app exists to catch.
 *
 * The account's own ongoing rate is added on top, because you earn it on the
 * same money at the same time. It is added rather than compounded with the bonus
 * figure: over the holding period the two returns run in parallel on the same
 * principal, and the cross-term is smaller than the uncertainty in the offer.
 *
 * Returns percent, or null if the inputs cannot describe a real offer.
 */
function effectiveApy({ bonus, requiredDeposit, holdDays, ongoingApy } = {}) {
  const b = toNum(bonus);
  const deposit = toNum(requiredDeposit);
  const days = toNum(holdDays);
  // Absent means the account pays nothing. A value that is PRESENT and
  // unreadable is a different thing entirely, and quietly reading it as zero
  // would understate the row rather than admit we could not parse it.
  const ongoing = ongoingApy === undefined || ongoingApy === null || ongoingApy === '' ? 0 : toNum(ongoingApy);

  if (b === null || deposit === null || days === null || ongoing === null) return null;
  if (b < 0 || deposit <= 0 || days <= 0) return null;

  const bonusApy = (Math.pow(1 + b / deposit, 365 / days) - 1) * 100;
  // A one-day offer on a one-dollar deposit overflows to Infinity. Refuse rather
  // than emit it: an infinite APY is not a small mistake in a yield table.
  if (!Number.isFinite(bonusApy)) return null;

  const total = bonusApy + ongoing;
  return Number.isFinite(total) ? total : null;
}

/**
 * What you actually make in year one, un-annualised, if you do this once and
 * stop — which is what almost everybody does, because the offer is one per
 * customer.
 *
 *     firstYear = bonus/requiredDeposit * 100 + ongoingApy
 *
 * You end the year holding the deposit plus a year of the account's own interest
 * plus the bonus, so the two components are simply additive. This number is
 * always far below the annualised one and it is the number that belongs in
 * somebody's head: a 26% annualised 90-day bonus is a 6% year.
 *
 * Note what this does NOT do: it does not pro-rate the bonus away when the hold
 * requirement runs past a year. A five-year IRA match is credited up front, so
 * you do earn it in year one — you just cannot leave with it. That constraint is
 * a lockup, and it is carried on term.days, not smuggled into the return.
 */
function firstYearReturn({ bonus, requiredDeposit, ongoingApy } = {}) {
  const b = toNum(bonus);
  const deposit = toNum(requiredDeposit);
  const ongoing = ongoingApy === undefined || ongoingApy === null || ongoingApy === '' ? 0 : toNum(ongoingApy);

  if (b === null || deposit === null || ongoing === null) return null;
  if (b < 0 || deposit <= 0) return null;

  const r = (b / deposit) * 100 + ongoing;
  return Number.isFinite(r) ? r : null;
}

// ---------------------------------------------------------------------------
// Curated dataset: merge, then build. Both pure — no network, no clock.
// ---------------------------------------------------------------------------

/**
 * Merge the user's own offers file over the bundled dataset.
 *
 * Same rules as the savings rates file, for the same reason: matching id
 * replaces field-by-field, new id appends, bundled order is preserved so the
 * table does not reshuffle on an edit. Field-level matters more here than it
 * does for rates — the realistic edit is "Chase is $400 now", and nobody is
 * going to retype the requirements list to change one number.
 */
function mergeUserBonuses(seedItems, userItems) {
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

/** The sentence that makes traps.js see this for what it is. */
const PROMO_REQUIREMENT = 'Promotional one-time offer — the headline rate reverts to the account rate once the bonus is paid, and it does not repeat next year';

function custodyNotes(kind, item) {
  switch (kind.custody) {
    case 'brokerage':
      return 'The cash you transfer is not an insured deposit. SIPC covers the broker failing and your positions going missing; it never covers the market falling, so whatever you buy with this money carries its own risk.';
    case 'sweep':
      return 'Cash sits in a sweep to partner banks rather than at the broker itself. FDIC coverage is pass-through — real, but it depends on the program banks and on the records being right, and it stops applying the moment you invest the money.';
    default: {
      const base = `Insured to ${money(INSURED_LIMIT)} per depositor, per bank, per ownership category.`;
      // Several of the large-deposit offers require MORE than the insured limit
      // in one place, which quietly turns a guaranteed row into a partly
      // uninsured one for the whole holding period. That has to be said on the
      // row, not left to the reader to notice.
      const extra = String(item?.aboveLimitNote || '').trim();
      return extra ? `${base} ${extra}` : base;
    }
  }
}

/** One curated offer -> one normalized opportunity, or null if it is unusable. */
function buildRow(item, { dataAsOf, schema, C }) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const kind = KINDS[String(item.kind || '').trim()];
  if (!kind) return null;

  const key = String(item.id ?? item.name ?? '').trim();
  const name = String(item.name ?? item.id ?? '').trim();
  if (!key || !name) return null;

  const bonus = toNum(item.bonus);
  const requiredDeposit = toNum(item.requiredDeposit);
  const holdDays = toNum(item.holdDays);
  const ongoingApy = toNum(item.ongoingApy) ?? 0;

  if (bonus === null || bonus <= 0) return null;                     // no bonus, no offer
  if (requiredDeposit === null || requiredDeposit <= 0) return null;  // nothing to measure against
  if (holdDays === null || holdDays <= 0 || holdDays > MAX_HOLD_DAYS) return null;
  if (ongoingApy < 0 || ongoingApy > MAX_ONGOING_APY) return null;
  if (bonus / requiredDeposit > MAX_BONUS_RATIO) return null;         // 2000% on a deposit is a typo

  // A row nobody can act on is noise, and the aggregator refuses rows without
  // either of these anyway.
  const url = String(item.url ?? '').trim();
  const accessBase = String(item.accessNotes ?? '').trim();
  if (!url || !accessBase) return null;

  const rawApy = effectiveApy({ bonus, requiredDeposit, holdDays, ongoingApy });
  if (rawApy === null || rawApy <= 0) return null;
  const clamped = rawApy > MAX_EFFECTIVE_APY;
  const apyTotal = clamped ? MAX_EFFECTIVE_APY : rawApy;

  const firstYear = firstYearReturn({ bonus, requiredDeposit, ongoingApy });
  if (firstYear === null) return null;

  const insurance = String(item.insurance || kind.insurance).toLowerCase();
  const insured = insurance === C.INSURANCE.FDIC || insurance === C.INSURANCE.NCUA;
  const basis = item.depositBasis === DEPOSIT_BASIS.deposits_received
    ? DEPOSIT_BASIS.deposits_received
    : DEPOSIT_BASIS.balance_held;

  // Almost every offer here is a FIXED DOLLAR amount, so the required deposit is
  // also the ceiling and the marginal return on anything above it is the
  // account's ordinary rate. A percentage match — the IRA transfer offers — is
  // the exception: it is proportional, so its annualised rate is the same at any
  // size and there is no cap to encode. Writing a cap onto those anyway would be
  // a false statement about the product, and would also trip CAPPED_BALANCE on a
  // row that genuinely is not capped.
  const scales = item.scales === true;

  // The requirements list is where the hoops live, and it is also what traps.js
  // reads. The promotional sentence is prepended by code rather than trusted to
  // the dataset so that every row in this source trips TEASER_RATE — which is
  // the literal truth about every one of them.
  const stated = Array.isArray(item.requirements) ? item.requirements.map((r) => String(r)).filter(Boolean) : [];
  const requirements = [PROMO_REQUIREMENT, ...stated];

  const basisSentence = basis === DEPOSIT_BASIS.deposits_received
    ? `The ${money(requiredDeposit)} is what has to ARRIVE, not what has to stay — direct deposits can be spent again once they land. The figure below treats it as parked for the whole ${holdDays} days, which understates the return on money you never actually tied up.`
    : `The ${money(requiredDeposit)} has to SIT there for ${holdDays} days. Take it out early and the bonus is forfeited or clawed back.`;

  const taxSentence = kind.taxTreatment === C.TAX_TREATMENT.TAX_DEFERRED
    ? 'Credited inside a retirement account, so it is not taxable income this year — it compounds untaxed and is taxed as ordinary income when you eventually withdraw.'
    : 'The bonus is fully taxable: banks report it on a 1099-INT and brokerages on a 1099-MISC, so set aside roughly a third of it depending on your bracket.';

  const clampSentence = clamped
    ? `Annualising a return this large is arithmetically correct and practically meaningless — the real figure is ${pct(rawApy)}, shown capped at ${pct(MAX_EFFECTIVE_APY)}, because the bonus pays once and caps at ${money(bonus)}. Read the ${pct(firstYear)} first-year number instead.`
    : '';

  // What the marginal dollar earns once the bonus is maxed out. An account that
  // pays literally nothing has to say so in words: "the ordinary 0.00% rate"
  // reads like a rounding artefact rather than like the fact that this is a
  // parking space with no yield at all.
  const restRate = ongoingApy > 0
    ? `the ordinary ${pct(ongoingApy)} rate`
    : (kind.custody === 'deposit' ? 'nothing at all — this account pays no interest' : 'only whatever you choose to invest it in');
  const revertSentence = ongoingApy > 0 ? ` Once the bonus lands the account pays ${pct(ongoingApy)}.` : '';

  const capSentence = scales
    ? `Not repeatable and not compoundable: it pays once, per customer. It is proportional rather than capped — ${money(bonus)} is what ${money(requiredDeposit)} earns, and moving twice as much earns twice the dollars at the same rate — but it still happens once.${revertSentence}`
    : `Not repeatable and not compoundable: one bonus per customer, and money above ${money(requiredDeposit)} earns ${restRate}, not the bonus, so the effective return falls the more you deposit.${revertSentence}`;

  const notes = [
    `${money(bonus)} once, not a rate.`,
    basisSentence,
    `Do it once and stop and you earn ${pct(firstYear)} in year one. The ${pct(apyTotal)} headline is that same one-off annualised over ${holdDays} days, which is the fair way to compare it against a savings account for those ${holdDays} days and is NOT what a year looks like.`,
    clampSentence,
    capSentence,
    taxSentence,
    custodyNotes(kind, item),
    String(item.notes || '').trim(),
  ].filter(Boolean).join(' ');

  const accessNotes = [
    accessBase,
    scales
      ? `One-time and one per customer: the match pays once on what you move, and there is no version of this where the money keeps earning it.`
      : `One-time, one per customer, and worth ${money(bonus)} in total no matter how much you deposit — treat it as a ${money(bonus)} errand, not as somewhere to keep money.`,
  ].join(' ');

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key,
    name,
    provider: item.provider || null,
    assetClass: C.ASSET_CLASS.CASH,
    subType: item.subType || kind.subType,
    // The return is entirely a contractual cash payment. Nothing here moves.
    track: 'income',
    region: item.region || 'US',
    currency: 'USD',

    // base is what is left when the promotion is over, which is the number that
    // matters if you were thinking of leaving the money there. reward is
    // deliberately NOT set: traps.js reads that field as incentive-token
    // emissions and would print a sentence about DeFi farms on a bank row.
    apy: { total: apyTotal, base: ongoingApy },
    // The offer terms are a contract: hit the conditions and the bank owes you
    // the money. What is uncertain is whether the offer still exists, not
    // whether it pays.
    yieldKind: C.YIELD_KIND.CONTRACTUAL,
    payoutFrequency: 'one-time',
    compounding: 1,

    term: {
      days: holdDays,
      kind: 'lockup',
      earlyExitPenalty: `Leave early and you forfeit or repay the ${money(bonus)} bonus`,
    },

    // The structural fact of the whole product: for a fixed-dollar bonus the
    // required deposit is both the floor and the ceiling, because more money
    // does not earn more. That is also what trips CAPPED_BALANCE in traps.js,
    // which is exactly the warning this row should carry.
    minInvestment: requiredDeposit,
    maxInvestment: scales ? null : requiredDeposit,

    // You can have the money back whenever you like; you just cannot have the
    // bonus too. That is a notice account, not a locked one.
    liquidity: C.LIQUIDITY.NOTICE,

    risk: {
      insurance,
      insuredLimit: insured ? INSURED_LIMIT : null,
      principalAtRisk: !insured,
    },

    taxTreatment: item.taxTreatment || kind.taxTreatment || C.TAX_TREATMENT.ORDINARY,
    url,
    notes,
    accessNotes,
    requirements,

    // When the offer itself stops being available, which is not the same thing
    // as the holding period. A sign-up bonus is a promotion: it has an end date,
    // it gets pulled, and the day it closes is the day it most needs to be on
    // screen. Nothing here could carry one — the field was not read, so even a
    // date written into the offers file was dropped — and 44 of the most
    // deadline-driven rows in the app were absent from every "closing soon"
    // count. It stays null when nobody has published one, because inventing a
    // deadline is worse than admitting there is no date.
    expiresAt: isoDay(item.expiresAt ?? item.offerEndsAt, null),
    startsAt: isoDay(item.startsAt, null),

    dataAsOf: isoDay(item.dataAsOf, dataAsOf),
    live: false,
    seed: item.origin !== 'user',
  };

  const out = schema.normalize(row, { source: ID, seed: row.seed });
  if (!out) return null;

  // Same ceiling logic as the rates file: a stated confidence may only lower the
  // cap, never raise it, and the age decay normalize() already applied still
  // wins if it is lower.
  const ceiling = row.seed ? SEED_CONFIDENCE : CURATED_CONFIDENCE;
  const statedConfidence = toNum(item.confidence);
  const cap = statedConfidence === null
    ? ceiling
    : Math.max(0, Math.min(statedConfidence, ceiling));
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
  let skipped = 0;
  let clamped = 0;

  for (const item of Array.isArray(items) ? items : []) {
    let row = null;
    try {
      row = buildRow(item, { dataAsOf, schema, C });
    } catch {
      row = null; // one malformed offer must never take the source down
    }
    if (!row || seen.has(row.id)) { skipped += 1; continue; }
    seen.add(row.id);
    if (row.apy.total >= MAX_EFFECTIVE_APY) clamped += 1;
    opportunities.push(row);
  }

  return { opportunities, skipped, clamped };
}

// ---------------------------------------------------------------------------
// The user's own offers file
// ---------------------------------------------------------------------------

/**
 * Read ctx.settings.userBonusesPath. Missing is the normal case and says
 * nothing; present but broken is a warning, because the user edited it, believes
 * their offers are current, and they silently are not.
 */
function readUserBonuses(filePath, readFile = fs.readFileSync) {
  if (!filePath) return { items: [], configured: false, warning: null };
  // fs.readFileSync treats a NUMBER as a file descriptor, so a settings value
  // that is not a path does not fail — it reads whatever fd happens to be open,
  // and on a pipe it blocks the whole app forever. Only a string is a path.
  if (typeof filePath !== 'string') {
    return { items: [], configured: true, warning: `Your bonus offers file setting is not a path (${typeof filePath}), so nothing was loaded from it.` };
  }
  let raw;
  try {
    raw = readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], configured: true, warning: null };
    return { items: [], configured: true, warning: `Could not read your bonus offers file (${filePath}): ${err?.message || err}` };
  }
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
    if (!items) {
      return { items: [], configured: true, warning: `Your bonus offers file (${filePath}) has no "items" array, so nothing in it was used.` };
    }
    return { items, configured: true, warning: null };
  } catch (err) {
    return { items: [], configured: true, warning: `Your bonus offers file (${filePath}) is not valid JSON, so your edits were ignored: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Adapter entry points
// ---------------------------------------------------------------------------

const VERIFY_WARNING = 'Bank and brokerage bonuses change weekly, are often targeted to individual customers, and are routinely withdrawn without notice. Every row here is a lead to check on the institution\'s own offer page, never a quote — open the link and read the current terms before you move any money.';

function collect(ctx) {
  const schema = ctx?.schema || baseSchema;
  const C = ctx?.C || baseC;
  const { items: seedItems, meta } = contract.readSeed(ctx?.seedDir, SEED_FILE);
  const user = readUserBonuses(ctx?.settings?.userBonusesPath ?? null);

  const merged = mergeUserBonuses(seedItems, user.items);
  const asOf = isoDay(meta?.dataAsOf, FALLBACK_AS_OF);
  const built = buildRows(merged, { schema, C, dataAsOf: asOf });

  const fromUser = built.opportunities.filter((o) => o.seed === false).length;
  const notes = [
    `${built.opportunities.length} promotional offers (${fromUser} from your own offers file, ${built.opportunities.length - fromUser} bundled as of ${asOf}).`,
    'Every rate here is a one-off bonus annualised over its required holding period, plus whatever the account itself pays. It is the right comparison for that period and the wrong one for a year — each row carries the plain first-year percentage in its notes, and that is the number to plan around.',
    'The required deposit is also the cap: it is set as both the minimum and the maximum, because a fixed dollar bonus means every extra dollar you deposit earns the ordinary rate and drags the effective return down.',
    'No public API publishes promotional offers. Keep your own current at Settings -> Open my bonus offers file: same shape as data/seed/bonuses.json, a matching id replaces the bundled row, a new id is added, and a fresh dataAsOf earns back the confidence the snapshot has lost.',
  ];
  if (built.skipped) {
    notes.push(`${built.skipped} row(s) skipped — unknown kind, missing bonus or deposit, no link or access notes, or a bonus/deposit ratio above ${MAX_BONUS_RATIO}x.`);
  }
  if (built.clamped) {
    notes.push(`${built.clamped} row(s) show a rate capped at ${MAX_EFFECTIVE_APY}%: annualising a very large return on a very small deposit produces a true number that nobody can act on, so the first-year figure in the notes is the real headline for those.`);
  }
  const deposits = built.opportunities.filter((o) => [C.INSURANCE.FDIC, C.INSURANCE.NCUA].includes(o.risk?.insurance)).length;
  const brokerage = built.opportunities.length - deposits;
  if (brokerage) {
    notes.push(`${deposits} sit in insured deposit accounts; ${brokerage} are brokerage or transfer offers where the money you move is invested at your own risk and SIPC does not cover market losses.`);
  }

  const warnings = user.warning ? [user.warning] : [];
  return { built, notes, warnings, meta };
}

/**
 * There is nothing to fetch. Saying so plainly, every time, is the point: this
 * source is a curated list that can only ever be 'partial', because the one
 * thing that would make it 'ok' — confirming the offer is live today — cannot be
 * done without a human opening the page.
 */
async function fetch(ctx) {
  try {
    const { built, notes, warnings } = collect(ctx || {});
    if (!built.opportunities.length) {
      return contract.result({
        status: 'failed',
        notes,
        warnings: warnings.concat('No usable offers in the bundled dataset or your offers file.'),
      });
    }
    ctx?.log?.(`bonuses: ${built.opportunities.length} curated offers, none verifiable without opening the offer page`);
    return contract.result({
      opportunities: built.opportunities,
      status: 'partial',
      notes,
      warnings: warnings.concat(VERIFY_WARNING),
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
        warnings: warnings.concat('Bundled bonus offers dataset is missing or unreadable.'),
      });
    }
    return contract.result({
      opportunities: built.opportunities,
      status: 'offline',
      notes,
      warnings: warnings.concat(VERIFY_WARNING),
    });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Real US bank, credit union and brokerage sign-up bonuses, annualised honestly: a one-off $300 on a 90-day balance is a huge rate for 90 days and a small return for a year, and both numbers are on the row.',
  homepage: 'https://www.fdic.gov/resources/deposit-insurance/',
  assetClasses: [baseC.ASSET_CLASS.CASH],
  requiresNetwork: false,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 24 * 60 * 60 * 1000,

  fetch,
  loadSeed,

  // The maths, and the pure path, for the tests and anything else that wants them.
  effectiveApy,
  firstYearReturn,
  mergeUserBonuses,
  buildRows,
  buildRow,
  readUserBonuses,
  isoDay,
  KINDS,
  DEPOSIT_BASIS,
  CURATED_CONFIDENCE,
  SEED_CONFIDENCE,
  MAX_EFFECTIVE_APY,
  MAX_BONUS_RATIO,
  MAX_HOLD_DAYS,
  INSURED_LIMIT,
  PROMO_REQUIREMENT,
};
