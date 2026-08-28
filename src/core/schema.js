'use strict';

const C = require('./constants');
const K = require('./opportunity-kinds');

/**
 * The canonical Opportunity record.
 *
 * Adapters produce partial objects; `normalize()` fills defaults, coerces types
 * and derives everything that can be derived, so downstream code (risk, tax,
 * scoring, filtering, UI) can assume every field exists and is the right shape.
 *
 * Rates are stored as PERCENT (4.25 means 4.25%), because every upstream source
 * and every human uses percent. Convert once, at the edges, never in the middle.
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s,]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : v === undefined || v === null ? d : !!v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
const rate = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n * 1e4) / 1e4;
};

/**
 * APY from APR given a compounding frequency. DeFi quotes both and the
 * difference is not cosmetic at high rates: 100% APR daily-compounded is 171% APY.
 */
function aprToApy(apr, periodsPerYear = 365) {
  if (!Number.isFinite(apr)) return null;
  if (periodsPerYear <= 0) return apr;
  return (Math.pow(1 + apr / 100 / periodsPerYear, periodsPerYear) - 1) * 100;
}

function apyToApr(apy, periodsPerYear = 365) {
  if (!Number.isFinite(apy)) return null;
  if (periodsPerYear <= 0) return apy;
  return (Math.pow(1 + apy / 100, 1 / periodsPerYear) - 1) * periodsPerYear * 100;
}

/** Bond-equivalent annualisation of a discount instrument (T-bills). */
function discountToApy(discountRate, days) {
  if (!Number.isFinite(discountRate) || !Number.isFinite(days) || days <= 0) return null;
  const price = 1 - (discountRate / 100) * (days / 360);
  if (price <= 0) return null;
  return (Math.pow(1 / price, 365 / days) - 1) * 100;
}

/** Compound a simple period return into an annualised figure. */
function annualize(periodReturnPct, days) {
  if (!Number.isFinite(periodReturnPct) || !Number.isFinite(days) || days <= 0) return null;
  const growth = 1 + periodReturnPct / 100;
  if (growth <= 0) return -100;
  return (Math.pow(growth, 365 / days) - 1) * 100;
}

/** Deterministic id so the same opportunity keeps identity across refreshes. */
function makeId(source, key) {
  const raw = `${source}:${key}`;
  return raw.toLowerCase().replace(/[^a-z0-9:._-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 160);
}

const EMPTY_APY = { total: null, base: null, reward: null, mean30d: null, mean7d: null, forward: null, net: null };

function normalize(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const source = str(raw.source) || str(ctx.source) || 'unknown';
  const nativeKey = str(raw.key) || str(raw.symbol) || str(raw.name) || Math.random().toString(36).slice(2);
  const id = str(raw.id) || makeId(source, nativeKey);

  // --- headline rate -------------------------------------------------------
  const apyIn = raw.apy && typeof raw.apy === 'object' ? raw.apy : { total: raw.apy };
  const apy = { ...EMPTY_APY };
  // Round to four decimals. Nothing about a rate is meaningful past 0.0001%, and
  // an unrounded float (a 20-year doubling works out to 3.5264923841377582%)
  // leaks straight into the table and the CSV export.
  for (const k of Object.keys(EMPTY_APY)) apy[k] = rate(apyIn[k]);
  if (apy.total === null && (apy.base !== null || apy.reward !== null)) {
    apy.total = rate((apy.base || 0) + (apy.reward || 0));
  }
  if (apy.base === null && apy.total !== null && apy.reward !== null) {
    apy.base = rate(apy.total - apy.reward);
  }

  // --- term ----------------------------------------------------------------
  const termIn = raw.term && typeof raw.term === 'object' ? raw.term : {};
  let termDays = num(termIn.days);
  const maturity = str(termIn.maturity);
  if (termDays === null && maturity) {
    const t = Date.parse(maturity);
    if (Number.isFinite(t)) termDays = Math.round((t - Date.now()) / C.DAY);
  }
  const term = {
    days: termDays,                                  // null => open-ended / perpetual
    maturity: maturity || null,
    callable: bool(termIn.callable),
    earlyExitPenalty: str(termIn.earlyExitPenalty),
    label: str(termIn.label) || termLabel(termDays),
    // What term.days actually MEANS for this row, which is three different
    // things depending on the instrument and must not be conflated:
    //   lockup   — your money is committed and you cannot get it out
    //   maturity — a real redemption date, though you may be able to sell earlier
    //   duration — a synthetic figure for a perpetual fund, present only so the
    //              rate-sensitivity penalty applies. You can sell any trading day.
    // A "1-3 year" filter must match the first two and never the third.
    kind: str(termIn.kind) || inferTermKind(raw, termDays, maturity),
  };

  // --- money ---------------------------------------------------------------
  const price = num(raw.price);
  const minInvestment = num(raw.minInvestment);
  const maxInvestment = num(raw.maxInvestment);      // e.g. balance cap on a HYSA teaser

  // --- risk ----------------------------------------------------------------
  const riskIn = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  const risk = {
    score: num(riskIn.score),
    tier: str(riskIn.tier),
    factors: arr(riskIn.factors),
    principalAtRisk: bool(riskIn.principalAtRisk, true),
    insurance: str(riskIn.insurance) || C.INSURANCE.NONE,
    insuredLimit: num(riskIn.insuredLimit),
    creditRating: str(riskIn.creditRating),
    volatility: num(riskIn.volatility),              // annualised stdev, percent
    // A drawdown is measured from a peak, so it cannot exceed 100%: losing
    // everything is the worst available outcome. A larger figure means the
    // source computed a cumulative decline or a ratio, not a drawdown.
    maxDrawdown: (() => {
      const d = num(riskIn.maxDrawdown);
      return d === null ? null : Math.max(0, Math.min(100, d));
    })(),
    auditCount: num(riskIn.auditCount),
    ageDays: num(riskIn.ageDays),
    leverage: num(riskIn.leverage),
  };

  // --- expected return (speculative track) ---------------------------------
  const expIn = raw.expected && typeof raw.expected === 'object' ? raw.expected : null;
  const expected = expIn ? {
    annualReturn: rate(expIn.annualReturn),
    p10: rate(expIn.p10),
    p50: rate(expIn.p50),
    p90: rate(expIn.p90),
    probabilityOfLoss: num(expIn.probabilityOfLoss) === null ? null : Math.round(num(expIn.probabilityOfLoss) * 1e4) / 1e4,
    horizonDays: num(expIn.horizonDays) || 365,
    basis: arr(expIn.basis),
    thesis: str(expIn.thesis),
  } : null;

  const out = {
    id,
    source,
    sourceLabel: str(raw.sourceLabel) || source,
    name: str(raw.name) || nativeKey,
    symbol: str(raw.symbol),
    provider: str(raw.provider),
    assetClass: str(raw.assetClass) || C.ASSET_CLASS.CASH,
    subType: str(raw.subType),
    // Which question this row answers: "what pays me" or "what's about to move".
    // Some things honestly answer both and are not forced into one.
    track: str(raw.track) || inferTrack(raw),
    // Coarser than asset class, and the axis the interface navigates by. A
    // savings account and a $1,500 referral bonus are both income and belong in
    // completely different places.
    section: str(raw.section) || inferSection(raw),
    chain: str(raw.chain),
    region: str(raw.region) || 'US',
    currency: str(raw.currency) || 'USD',

    apy,
    yieldKind: str(raw.yieldKind) || C.YIELD_KIND.VARIABLE,
    payoutFrequency: str(raw.payoutFrequency),
    compounding: num(raw.compounding),

    term,
    price,
    minInvestment,
    maxInvestment,
    tvl: num(raw.tvl),                                // pool TVL or fund AUM
    volume: num(raw.volume),

    // DeFi / pool descriptors that materially change the risk picture
    stablecoin: bool(raw.stablecoin, false),          // principal denominated in a peg
    // What the yield and the principal are actually denominated in. A 7% yield
    // paid in SOL is a fundamentally different product from 7% paid in dollars:
    // the first is only additive if you already wanted to hold SOL.
    denomination: str(raw.denomination) || inferDenomination(raw),
    ilRisk: str(raw.ilRisk),                          // 'yes' | 'no' — impermanent loss
    exposure: str(raw.exposure),                      // 'single' | 'multi'
    poolMeta: str(raw.poolMeta),
    underlying: arr(raw.underlying),

    // Movement-track inputs. Adapters that fetch price history fill these; the
    // movement engine reads them instead of re-deriving from raw series.
    movementStats: raw.movementStats && typeof raw.movementStats === 'object' ? raw.movementStats : null,
    events: arr(raw.events),

    // Whether anything on this row was actually measured. A source that indexes
    // a universe far too large to price on every refresh (every US-listed
    // ticker, say) emits identity-only rows so the thing is findable; those must
    // never be mistaken for rows we looked at. Absent means measured, which is
    // what every single-tier source produces.
    measured: raw.measured === undefined || raw.measured === null ? true : !!raw.measured,

    // --- findability ---------------------------------------------------------
    // Windows close, work varies, and some things are known to five people. All
    // three decide whether a row is worth someone's afternoon, and none of them
    // are visible from a percentage.
    expiresAt: str(raw.expiresAt),
    startsAt: str(raw.startsAt),
    effort: str(raw.effort) || inferEffort(raw),
    reach: str(raw.reach) || 'common',
    // What you would actually buy. Filled by core/vehicles.js after scoring.
    vehicles: arr(raw.vehicles),
    // Downsampled closes for the row sparkline and the detail chart. Kept short
    // on purpose: a chart needs shape, not every tick, and holding full history
    // for a thousand rows is how an Electron app starts feeling slow.
    // True when the rate is knowable but the dollar size is not, because it
    // depends on something the app was never told — a salary, a plan document,
    // how much there is to harvest. Such a row ranks on its rate and prints no
    // dollar figures at all, rather than dollar figures computed from a guess.
    dollarsUnknown: raw.dollarsUnknown === true,
    // { ts, daysAway, cadence, certainty } where a dividend schedule could be
    // projected from actual payments; null everywhere else, never guessed.
    exDividend: raw.exDividend && Number.isFinite(raw.exDividend.ts) ? raw.exDividend : null,
    series: Array.isArray(raw.series) ? raw.series.filter(Number.isFinite).slice(-180) : null,
    // 'measured' = recorded closes. 'illustrative' = a shape drawn to agree
    // with the statistics beside it. Default to illustrative when a source
    // ships a chart without saying which, because the wrong default here is
    // the one that presents a drawing as evidence.
    seriesBasis: Array.isArray(raw.series) && raw.series.length
      ? (raw.seriesBasis === 'measured' ? 'measured' : 'illustrative')
      : null,

    // A return you can only collect once. An opening bonus annualises to a huge
    // number and is still a single fixed payment, so ranking it as a rate puts
    // 240% at the top of a list of savings accounts.
    oneTime: bool(raw.oneTime, inferOneTime(raw)),

    // Fund descriptors — these decide whether a big distribution is real income
    rocShare: num(raw.rocShare),                      // fraction that is return of capital
    navPremium: num(raw.navPremium),                  // percent above/below NAV
    payoutCoverage: num(raw.payoutCoverage),          // earnings / distribution
    expenseRatio: num(raw.expenseRatio),

    liquidity: str(raw.liquidity) || C.LIQUIDITY.DAILY,
    risk,
    expected,

    taxTreatment: str(raw.taxTreatment) || C.TAX_TREATMENT.ORDINARY,
    stateOfIssue: str(raw.stateOfIssue),

    trapFlags: arr(raw.trapFlags),
    trapScore: num(raw.trapScore),

    url: str(raw.url),
    notes: str(raw.notes),
    accessNotes: str(raw.accessNotes),                // how you actually buy it
    requirements: arr(raw.requirements),              // direct deposit, min balance, KYC...

    confidence: raw.confidence === undefined ? null : clamp(num(raw.confidence) ?? 0, 0, 1),
    dataAsOf: str(raw.dataAsOf) || str(ctx.dataAsOf) || new Date().toISOString(),
    fetchedAt: str(raw.fetchedAt) || new Date().toISOString(),
    live: bool(raw.live, !ctx.seed),
    seed: bool(raw.seed, !!ctx.seed),

    // derived, filled by the pipeline
    scores: null,
    tax: null,
    raw: ctx.keepRaw ? raw.raw ?? null : null,
  };

  if (out.confidence === null) out.confidence = defaultConfidence(out);

  // Derived rather than stored: a cached "12 days left" is wrong tomorrow.
  const expiryMs = out.expiresAt ? Date.parse(out.expiresAt) : NaN;
  out.daysLeft = Number.isFinite(expiryMs) ? Math.round((expiryMs - Date.now()) / C.DAY) : null;
  const startMs = out.startsAt ? Date.parse(out.startsAt) : NaN;
  out.daysUntilOpen = Number.isFinite(startMs) ? Math.round((startMs - Date.now()) / C.DAY) : null;
  out.notYetOpen = Number.isFinite(out.daysUntilOpen) && out.daysUntilOpen > 0;
  out.expired = Number.isFinite(out.daysLeft) && out.daysLeft < 0;

  return out;
}

/**
 * Which track a row belongs to.
 *
 * The test is where the return actually comes from, not what the thing is called.
 * A Treasury bill's return is entirely its yield. A growth stock's is entirely
 * price. A REIT's is genuinely both, and pretending otherwise in either direction
 * misleads — so BOTH is a real answer, not a cop-out.
 */
function inferTrack(raw) {
  const cls = raw.assetClass;
  if (raw.yieldKind === C.YIELD_KIND.EXPECTED) return 'movement';

  const incomeOnly = ['cash', 'cd', 'govt_bond', 'muni_bond', 'annuity', 'rwa', 'p2p_lending',
    'crypto_lending', 'crypto_staking', 'crypto_lp'];
  if (incomeOnly.includes(cls)) return 'income';

  const bothClasses = ['reit', 'bdc', 'cef', 'preferred', 'corp_bond'];
  if (bothClasses.includes(cls)) return 'both';

  if (cls === 'speculative') return 'movement';

  // Funds and equities: the yield decides. A 9% covered-call ETF is an income
  // holding; a 0.4% growth ETF is not, whatever its dividend technically is.
  const y = num(raw.apy?.total ?? raw.apy);
  if (Number.isFinite(y)) {
    if (y >= 4) return 'both';
    if (y >= 1.5) return 'both';
    return 'movement';
  }
  return 'movement';
}

/**
 * Which section this belongs in.
 *
 * Deals are the interesting case: a sign-up bonus is technically income at an
 * enormous rate, and putting it in the income list buries every savings account
 * under three-figure numbers. It is a different kind of thing and gets its own
 * shelf.
 */
function inferSection(raw) {
  if (raw.oneTime || inferOneTime(raw)) return K.SECTION.DEALS;
  if (raw.source === 'bonuses' || raw.source === 'deals') return K.SECTION.DEALS;
  const track = raw.track || inferTrack(raw);
  if (track === 'movement') return K.SECTION.MOVEMENT;
  return K.SECTION.INCOME;
}

/**
 * How much work it takes, guessed from what the requirements actually say. A
 * source that knows better sets it explicitly.
 */
function inferEffort(raw) {
  const reqs = (Array.isArray(raw.requirements) ? raw.requirements.join(' ') : '').toLowerCase();
  if (!reqs) return 'passive';
  if (/refer|friend|invite|sign up.*(other|someone)/.test(reqs)) return 'social';
  if (/direct deposit|debit transaction|minimum balance|qualifying activit|maintain/.test(reqs)) return 'hoops';
  if (/transfer|membership|eligib|new customer|open an account/.test(reqs)) return 'light';
  return 'passive';
}

function inferTermKind(raw, days, maturity) {
  if (!Number.isFinite(days) || days <= 0) return null;
  const liq = raw.liquidity;
  if (liq === 'locked' || liq === 'notice' || liq === 'illiquid') return 'lockup';
  if (maturity) return 'maturity';
  if (['bill', 'note', 'bond', 'tips', 'cd'].includes(raw.subType)) return 'maturity';
  return 'duration';
}

/**
 * Is this a one-off payment rather than a rate?
 *
 * Adapters can say so explicitly. Failing that, the two reliable tells are a
 * sub-type that names itself a bonus or match, and a requirement line stating
 * the offer does not repeat — both of which the sources already write for
 * honesty reasons.
 */
function inferOneTime(raw) {
  if (/bonus|_match|referral/i.test(raw.subType || '')) return true;
  const reqs = Array.isArray(raw.requirements) ? raw.requirements.join(' ') : '';
  if (/one-time|one time|does not repeat|not repeat|once only/i.test(reqs)) return true;
  return false;
}

/** USD unless the position is in a volatile crypto asset. */
function inferDenomination(raw) {
  const cls = raw.assetClass;
  const isCrypto = ['crypto_staking', 'crypto_lending', 'crypto_lp'].includes(cls);
  if (!isCrypto) return 'usd';
  if (raw.stablecoin) return 'stable';
  return 'crypto';
}

function termLabel(days) {
  if (days === null || days === undefined) return 'No lockup';
  if (days <= 0) return 'No lockup';
  if (days < 31) return `${Math.round(days)} days`;
  if (days < 365) return `${Math.round(days / 30.44)} mo`;
  const y = days / 365.25;
  return y % 1 < 0.08 || y % 1 > 0.92 ? `${Math.round(y)} yr` : `${y.toFixed(1)} yr`;
}

/** How much we trust the headline number, before any risk judgement. */
function defaultConfidence(o) {
  let c = C.YIELD_KIND_QUALITY[o.yieldKind] ?? 0.5;
  if (o.seed) c *= 0.8;                                   // bundled snapshot, not live
  if (o.tvl !== null && o.tvl < 1e6) c *= 0.85;
  const ageMs = Date.now() - Date.parse(o.dataAsOf || '');
  if (Number.isFinite(ageMs) && ageMs > 7 * C.DAY) c *= 0.85;
  if (Number.isFinite(ageMs) && ageMs > 45 * C.DAY) c *= 0.75;
  return clamp(Number(c.toFixed(3)), 0, 1);
}

/** Cheap structural validation; returns a list of human-readable problems. */
function validate(o) {
  const problems = [];
  if (!o || typeof o !== 'object') return ['not an object'];
  if (!o.id) problems.push('missing id');
  if (!o.name) problems.push('missing name');
  if (!Object.values(C.ASSET_CLASS).includes(o.assetClass)) problems.push(`bad assetClass "${o.assetClass}"`);
  if (!Object.values(C.YIELD_KIND).includes(o.yieldKind)) problems.push(`bad yieldKind "${o.yieldKind}"`);
  if (!Object.values(C.LIQUIDITY).includes(o.liquidity)) problems.push(`bad liquidity "${o.liquidity}"`);
  // A movement row can legitimately have no rate at all, and forcing one on it
  // is how a screener starts inventing numbers. A growth stock's entire return
  // is price; an index-tier row was never measured. Both answer "what is this
  // paying?" with "nothing" and "we have not looked", and those are different
  // from an income row that lost its headline figure — which is what this check
  // exists to catch.
  const headline = o.apy?.total ?? o.expected?.annualReturn;
  const ratelessByDesign = o.track === 'movement' && (o.measured === false || !!o.movementStats);
  if (!Number.isFinite(headline) && !ratelessByDesign) problems.push('no headline rate or expected return');
  if (Number.isFinite(o.apy?.total) && (o.apy.total < -100 || o.apy.total > 100000)) {
    problems.push(`implausible apy ${o.apy.total}`);
  }
  return problems;
}

/** The single number the table sorts on before scoring: percent per year. */
function headlineRate(o) {
  if (Number.isFinite(o?.apy?.total)) return o.apy.total;
  if (Number.isFinite(o?.expected?.annualReturn)) return o.expected.annualReturn;
  return null;
}

module.exports = {
  normalize, validate, headlineRate, makeId, defaultConfidence, termLabel, inferDenomination, inferTrack, inferOneTime, inferSection, inferEffort,
  aprToApy, apyToApr, discountToApy, annualize,
  _helpers: { num, str, bool, clamp, arr },
};
