'use strict';

const C = require('./constants');

/**
 * The query engine.
 *
 * One pure function over the scored list, so the UI can re-filter instantly on
 * every keystroke without touching the network. Filters are additive (AND), and
 * anything left null/undefined is simply not applied — an empty query returns
 * everything.
 *
 * A note on nulls: "unknown" is not "fails the test". If a user filters on
 * minimum TVL and a bank CD has no TVL concept at all, excluding it would be
 * wrong. So each filter decides explicitly how it treats missing data, and the
 * `strictUnknowns` flag lets the user flip that global default when they want to
 * see only fully-documented rows.
 */

const DEFAULT_QUERY = {
  text: '',                     // free text over name/symbol/provider/chain/notes
  assetClasses: [],             // [] = all
  sources: [],                  // [] = all
  chains: [],                   // DeFi chains
  regions: [],

  minApy: null,                 // percent
  maxApy: null,                 // percent — yes, a max: 400% rows are usually noise
  apyBasis: 'headline',         // 'headline' | 'afterTax' | 'taxEquivalent' | 'afterTaxReal'

  termMinDays: null,
  termMaxDays: null,
  includeOpenEnded: true,       // things with no fixed term
  termPreset: null,             // key from constants.TERM.presets

  priceMin: null,               // per-share/unit price
  priceMax: null,
  minInvestmentMax: null,       // "I only have $X to put in"
  budget: null,                 // amount being deployed; also drives income figures

  maxRisk: null,                // 0..100
  riskTiers: [],                // [] = all
  insuredOnly: false,
  principalGuaranteedOnly: false,

  liquidity: [],                // subset of constants.LIQUIDITY
  maxLockupDays: null,

  denominations: [],            // 'usd' | 'stable' | 'crypto' — what you get paid in
  minTvl: null,                 // pool TVL / fund AUM floor
  minConfidence: null,          // 0..1

  hideTraps: true,              // hide verdict === 'likely_trap'
  maxTrapScore: null,
  excludeFlags: [],             // specific trap flags to exclude

  includeSpeculative: false,    // the modelled-expectation rows are opt-in
  onlySpeculative: false,
  minExpectedReturn: null,
  maxProbabilityOfLoss: null,

  taxTreatments: [],
  hideSeed: false,              // show only live-refreshed rows
  watchlistOnly: false,
  watchlist: [],                // ids

  strictUnknowns: false,
  sortBy: 'dogScore',
  sortDir: 'desc',
  limit: null,
};

const has = (v) => v !== null && v !== undefined && v !== '';
const inSet = (list, v) => !list?.length || list.includes(v);

/** Which number a min/max APY filter compares against. */
function basisValue(o, basis) {
  switch (basis) {
    case 'afterTax': return o.tax?.afterTaxApy;
    case 'taxEquivalent': return o.tax?.taxEquivalentYield;
    case 'afterTaxReal': return o.tax?.afterTaxRealApy;
    default: return o.apy?.total ?? o.expected?.annualReturn;
  }
}

/** Effective days your money is committed. null means "not committed". */
function lockupDays(o) {
  if (o.liquidity === C.LIQUIDITY.LOCKED) return o.term?.days ?? null;
  const f = C.LIQUIDITY_FRICTION_DAYS[o.liquidity];
  return f === null ? (o.term?.days ?? null) : f;
}

function matches(o, q, unknownPasses) {
  // --- speculative gating comes first: these are a different kind of thing ---
  const isSpec = o.yieldKind === C.YIELD_KIND.EXPECTED;
  if (q.onlySpeculative && !isSpec) return false;
  if (!q.onlySpeculative && isSpec && !q.includeSpeculative) return false;

  // --- text ---------------------------------------------------------------
  if (has(q.text)) {
    const needle = String(q.text).toLowerCase().trim();
    const terms = needle.split(/\s+/).filter(Boolean);
    const hay = [o.name, o.symbol, o.provider, o.chain, o.sourceLabel, o.subType,
      o.poolMeta, o.notes, C.ASSET_CLASS_LABELS[o.assetClass]]
      .filter(Boolean).join(' ').toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }

  // --- categorical ---------------------------------------------------------
  if (!inSet(q.assetClasses, o.assetClass)) return false;
  if (!inSet(q.sources, o.source)) return false;
  if (q.chains?.length && !q.chains.includes(o.chain)) return false;
  if (!inSet(q.regions, o.region)) return false;
  if (!inSet(q.taxTreatments, o.taxTreatment)) return false;
  if (!inSet(q.liquidity, o.liquidity)) return false;
  if (!inSet(q.denominations, o.denomination)) return false;
  if (q.riskTiers?.length && !q.riskTiers.includes(o.risk?.tier)) return false;

  // --- rate ----------------------------------------------------------------
  const rate = basisValue(o, q.apyBasis);
  if (has(q.minApy)) {
    if (!Number.isFinite(rate)) { if (!unknownPasses) return false; }
    else if (rate < q.minApy) return false;
  }
  if (has(q.maxApy)) {
    if (Number.isFinite(rate) && rate > q.maxApy) return false;
  }

  // --- term ----------------------------------------------------------------
  const days = o.term?.days;
  const openEnded = !Number.isFinite(days) || days <= 0;
  if (openEnded && !q.includeOpenEnded && (has(q.termMinDays) || has(q.termMaxDays))) return false;
  if (!openEnded) {
    if (has(q.termMinDays) && days < q.termMinDays) return false;
    if (has(q.termMaxDays) && days > q.termMaxDays) return false;
  }
  if (has(q.maxLockupDays)) {
    const lock = lockupDays(o);
    // null lockup on a LOCKED item means "indefinite", which fails any max.
    if (o.liquidity === C.LIQUIDITY.LOCKED && !Number.isFinite(lock)) return false;
    if (Number.isFinite(lock) && lock > q.maxLockupDays) return false;
  }

  // --- money ---------------------------------------------------------------
  // A price filter is an explicit statement that per-unit price matters, so
  // rows with no share price concept (a CD, a savings account) are excluded
  // rather than waved through. Use minInvestmentMax for "what can I afford".
  if (has(q.priceMin) || has(q.priceMax)) {
    if (!Number.isFinite(o.price)) return false;
    if (has(q.priceMin) && o.price < q.priceMin) return false;
    if (has(q.priceMax) && o.price > q.priceMax) return false;
  }
  if (has(q.minInvestmentMax)) {
    // Keep rows whose entry ticket you can actually afford. Unknown minimum is
    // treated as affordable, because most things have no minimum at all.
    if (Number.isFinite(o.minInvestment) && o.minInvestment > q.minInvestmentMax) return false;
  }
  if (has(q.minTvl)) {
    if (!Number.isFinite(o.tvl)) { if (!unknownPasses) return false; }
    else if (o.tvl < q.minTvl) return false;
  }

  // --- risk ----------------------------------------------------------------
  if (has(q.maxRisk) && Number.isFinite(o.risk?.score) && o.risk.score > q.maxRisk) return false;
  if (q.insuredOnly) {
    const ok = [C.INSURANCE.FDIC, C.INSURANCE.NCUA, C.INSURANCE.US_GOV].includes(o.risk?.insurance);
    if (!ok) return false;
  }
  if (q.principalGuaranteedOnly && o.risk?.principalAtRisk !== false) return false;
  if (has(q.minConfidence) && (o.confidence ?? 0) < q.minConfidence) return false;

  // --- traps ---------------------------------------------------------------
  if (q.hideTraps && o.scores?.traps?.verdict === 'likely_trap') return false;
  if (has(q.maxTrapScore) && (o.trapScore ?? 0) > q.maxTrapScore) return false;
  if (q.excludeFlags?.length && o.trapFlags?.some((f) => q.excludeFlags.includes(f))) return false;

  // --- speculative specifics ------------------------------------------------
  if (isSpec) {
    if (has(q.minExpectedReturn) && (o.expected?.annualReturn ?? -1e9) < q.minExpectedReturn) return false;
    if (has(q.maxProbabilityOfLoss) && Number.isFinite(o.expected?.probabilityOfLoss)
        && o.expected.probabilityOfLoss > q.maxProbabilityOfLoss) return false;
  }

  // --- provenance -----------------------------------------------------------
  if (q.hideSeed && o.seed) return false;
  if (q.watchlistOnly && !q.watchlist?.includes(o.id)) return false;

  return true;
}

function applyQuery(list, query = {}) {
  const q = { ...DEFAULT_QUERY, ...query };

  // A term preset is sugar over termMin/MaxDays.
  if (q.termPreset) {
    const preset = C.TERM.presets.find((p) => p.key === q.termPreset);
    if (preset) {
      if (preset.key === 'liquid') {
        q.termMinDays = null; q.termMaxDays = null;
        q.maxLockupDays = q.maxLockupDays ?? 2;
      } else {
        q.termMinDays = preset.min ?? q.termMinDays;
        q.termMaxDays = preset.max ?? q.termMaxDays;
        if (preset.min !== null) q.includeOpenEnded = false;
      }
    }
  }

  const unknownPasses = !q.strictUnknowns;
  let out = list.filter((o) => matches(o, q, unknownPasses));

  const { SORTERS } = require('./score');
  const sorter = SORTERS[q.sortBy] || SORTERS.dogScore;
  out.sort(sorter);
  if (q.sortDir === 'asc') out.reverse();

  if (Number.isFinite(q.limit) && q.limit > 0) out = out.slice(0, q.limit);
  return out;
}

/**
 * Facet counts for the sidebar: how many rows each option WOULD yield, computed
 * with that one filter lifted, so the user can see what turning it off buys them.
 */
function facets(list, query = {}) {
  const q = { ...DEFAULT_QUERY, ...query };
  const unknownPasses = !q.strictUnknowns;
  const count = (mutate) => {
    const q2 = { ...q, ...mutate };
    return list.reduce((n, o) => n + (matches(o, q2, unknownPasses) ? 1 : 0), 0);
  };

  const byAssetClass = {};
  for (const key of Object.values(C.ASSET_CLASS)) {
    byAssetClass[key] = count({ assetClasses: [key] });
  }
  const byDenomination = {};
  for (const d of ['usd', 'stable', 'crypto']) byDenomination[d] = count({ denominations: [d] });
  const bySource = {};
  for (const s of new Set(list.map((o) => o.source))) bySource[s] = count({ sources: [s] });
  const byTier = {};
  for (const t of C.RISK_TIER) byTier[t.key] = count({ riskTiers: [t.key] });
  const byChain = {};
  for (const ch of new Set(list.map((o) => o.chain).filter(Boolean))) byChain[ch] = count({ chains: [ch] });

  return {
    byAssetClass, bySource, byTier, byChain, byDenomination,
    total: list.length,
    matching: applyQuery(list, query).length,
    trapsHidden: q.hideTraps ? list.filter((o) => o.scores?.traps?.verdict === 'likely_trap').length : 0,
    seedRows: list.filter((o) => o.seed).length,
  };
}

/** Human sentence describing the active query, for the results header. */
function describeQuery(q = {}) {
  const bits = [];
  if (has(q.minApy)) bits.push(`at least ${q.minApy}%`);
  if (has(q.maxApy)) bits.push(`at most ${q.maxApy}%`);
  if (q.assetClasses?.length) bits.push(q.assetClasses.map((a) => C.ASSET_CLASS_LABELS[a] || a).join(', '));
  if (q.termPreset && q.termPreset !== 'any') {
    bits.push((C.TERM.presets.find((p) => p.key === q.termPreset) || {}).label);
  }
  if (has(q.maxRisk)) bits.push(`risk ${q.maxRisk} or below`);
  if (q.insuredOnly) bits.push('insured only');
  if (has(q.minInvestmentMax)) bits.push(`entry under $${Number(q.minInvestmentMax).toLocaleString()}`);
  if (has(q.priceMin) || has(q.priceMax)) {
    bits.push(`price ${has(q.priceMin) ? `$${q.priceMin}` : 'any'}–${has(q.priceMax) ? `$${q.priceMax}` : 'any'}`);
  }
  if (q.denominations?.length) {
    bits.push(q.denominations.map((d) => ({ usd: 'paid in dollars', stable: 'paid in stablecoins', crypto: 'paid in crypto' }[d] || d)).join(' or '));
  }
  if (q.onlySpeculative) bits.push('high-upside only');
  else if (q.includeSpeculative) bits.push('including high-upside');
  if (has(q.text)) bits.push(`matching "${q.text}"`);
  return bits.filter(Boolean).join(' · ') || 'everything';
}

module.exports = { applyQuery, facets, matches, describeQuery, basisValue, lockupDays, DEFAULT_QUERY };
