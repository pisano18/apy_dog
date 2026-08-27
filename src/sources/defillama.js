'use strict';

const { result, failure, readSeed } = require('./_contract');

/**
 * DefiLlama Yields — https://yields.llama.fi/pools
 *
 * This is simultaneously the richest source of genuinely high yields in the app
 * and the richest source of garbage in the app: thousands of pools, of which a
 * large minority are emissions farms that will pay nothing next month, pools
 * with $30k in them, and outright upstream data errors. So the job here is not
 * "get the APY" — that part is trivial — it is to carry across enough metadata
 * (reward split, TVL, 30-day mean, IL flag, protocol age, audit count) that
 * traps.js and risk.js can tell the two apart downstream. A row that arrives
 * with only a headline number is worse than no row at all.
 */

const POOLS_URL = 'https://yields.llama.fi/pools';
const PROTOCOLS_URL = 'https://api.llama.fi/protocols';

const PROTOCOL_TTL_MS = 24 * 60 * 60 * 1000;   // protocol metadata barely moves
const DEFAULT_LIMIT = 1200;                    // keep the UI table responsive
const MIN_TVL_USD = 10000;                     // below this you cannot exit at size
const MAX_APY = 100000;                        // above this it is an upstream bug, not a yield

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' ? v.trim() || null : v === null || v === undefined ? null : String(v).trim() || null);

/** Gas token per chain, so accessNotes can tell the user what they actually need. */
const GAS_TOKEN = {
  ethereum: 'ETH', arbitrum: 'ETH', optimism: 'ETH', base: 'ETH', blast: 'ETH',
  linea: 'ETH', scroll: 'ETH', zksync: 'ETH', mode: 'ETH', zora: 'ETH', ink: 'ETH',
  polygon: 'POL', avalanche: 'AVAX', bsc: 'BNB', binance: 'BNB', solana: 'SOL',
  fantom: 'FTM', sonic: 'S', gnosis: 'xDAI', celo: 'CELO', cronos: 'CRO',
  mantle: 'MNT', metis: 'METIS', moonbeam: 'GLMR', kava: 'KAVA', tron: 'TRX',
  sui: 'SUI', aptos: 'APT', near: 'NEAR', hyperliquid: 'HYPE', berachain: 'BERA',
};

/**
 * Projects whose yield is consensus rewards rather than lending interest or
 * trading fees. DefiLlama's own `category` covers most of these once the
 * protocol join succeeds; this list is the fallback for when it does not.
 */
const STAKING_PROJECT = /(^|-)(lido|rocket-pool|stakewise|stader|ankr|swell|frax-ether|mantle-staked-eth|binance-staked-eth|coinbase-wrapped-staked-eth|jito|marinade|blazestake|sanctum|benqi-staked|liquid-collective|origin-ether|dinero|puffer|etherfi|ether-fi|kelp|renzo|eigenpie)(-|$)/i;
const STAKING_CATEGORY = /(liquid staking|liquid restaking|restaking|staking pool|staking services)/i;

/** Turn a DefiLlama slug into something a human reads: "aave-v3" -> "Aave V3". */
function prettyProject(slug) {
  if (!slug) return 'an unknown protocol';
  return String(slug).split(/[-_]/).filter(Boolean).map((w) => (
    /^v\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
  )).join(' ');
}

/** Index api.llama.fi/protocols by slug. Tolerates the endpoint being absent. */
function indexProtocols(list) {
  const idx = new Map();
  if (!Array.isArray(list)) return idx;
  for (const p of list) {
    const slug = str(p?.slug) || str(p?.name)?.toLowerCase().replace(/\s+/g, '-');
    if (!slug) continue;
    idx.set(slug.toLowerCase(), p);
  }
  return idx;
}

/**
 * DefiLlama reports `audits` as a string count ("0".."3", where "3" means 3+).
 * Zero is meaningful — traps.js flags it — so distinguish "0" from missing.
 */
function auditCount(proto) {
  const a = proto?.audits;
  if (a === null || a === undefined || a === '') return null;
  const n = num(a);
  return n === null ? null : Math.max(0, Math.round(n));
}

/** Protocol age from its DefiLlama listing date. An approximation of launch. */
function ageDays(proto, nowMs) {
  const listed = num(proto?.listedAt);
  if (listed === null || listed <= 0) return null;
  const days = (nowMs - listed * 1000) / 86400000;
  return days > 0 ? Math.round(days) : null;
}

function classify(p, proto, C) {
  const symbol = str(p?.symbol) || '';
  const project = (str(p?.project) || '').toLowerCase();
  const category = str(proto?.category) || '';
  const exposure = str(p?.exposure);

  // A dash in the symbol usually means a pair, but not always: Pendle PT/YT
  // tokens and wrapped LSTs are hyphenated single-asset positions. DefiLlama's
  // own `exposure` field is the tiebreak, and it is right more often than the
  // string is.
  const pairish = (symbol.includes('-') && exposure !== 'single') || exposure === 'multi';
  if (pairish) return C.ASSET_CLASS.CRYPTO_LP;

  if (STAKING_CATEGORY.test(category) || STAKING_PROJECT.test(project)) return C.ASSET_CLASS.CRYPTO_STAKING;
  return C.ASSET_CLASS.CRYPTO_LENDING;
}

function subTypeFor(assetClass, p, C) {
  if (assetClass === C.ASSET_CLASS.CRYPTO_LP) {
    // traps.js keys impermanent-loss detection off ilRisk OR this subType, so
    // set both rather than relying on one upstream field staying named the same.
    if (str(p?.ilRisk) === 'yes') return 'volatile_lp';
    return p?.stablecoin ? 'stable_lp' : 'lp';
  }
  if (assetClass === C.ASSET_CLASS.CRYPTO_STAKING) return 'liquid_staking';
  return 'lending';
}

/**
 * How much we trust the headline number. DefiLlama publishes both a model
 * confidence bin (1..3) and `count`, the number of days it has actually
 * observed the pool. A 400% APY seen for nine days is not a 400% pool.
 */
function poolConfidence(p, seed) {
  const binned = num(p?.predictions?.binnedConfidence);
  let c = binned === 3 ? 0.62 : binned === 2 ? 0.52 : binned === 1 ? 0.4 : 0.48;

  const observed = num(p?.count);
  if (observed !== null) {
    if (observed >= 180) c *= 1.0;
    else if (observed >= 60) c *= 0.94;
    else if (observed >= 30) c *= 0.86;
    else if (observed >= 14) c *= 0.75;
    else c *= 0.6;
  }
  if (p?.outlier === true) c *= 0.7;     // upstream itself thinks this number is odd
  if (seed) c *= 0.8;                    // bundled snapshot, not a quote
  return Math.max(0.05, Math.min(0.95, Number(c.toFixed(3))));
}

/** Pool page if we have a real uuid; otherwise the protocol page, which exists. */
function poolUrl(key, project) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(key || ''))) {
    return `https://defillama.com/yields/pool/${key}`;
  }
  return project ? `https://defillama.com/protocol/${project}` : 'https://defillama.com/yields';
}

/**
 * Ranking blend used for the cap. Pure APY sorting returns 1200 dust farms and
 * buries Aave; pure TVL sorting returns 1200 blue chips and defeats the point of
 * the app. Log of each, weighted toward yield, keeps both ends of the range.
 */
function rankScore(p) {
  const apy = Math.max(0, num(p?.apy) ?? num(p?.apyBase) ?? 0);
  const tvl = Math.max(1, num(p?.tvlUsd) ?? 1);
  return Math.log10(1 + apy) * 4 + Math.log10(tvl);
}

/**
 * PURE PARSER. Takes the raw upstream payload and returns normalized
 * opportunities. No network, no filesystem, no clock beyond opts.now — so the
 * whole mapping is unit-testable against a fixture.
 *
 * @param {object|Array} payload  the /pools response, or a bare array of pools
 * @param {object} opts { schema, C, protocols, limit, minTvlUsd, maxApy, now, seed, dataAsOf }
 */
function parsePools(payload, opts = {}) {
  const schema = opts.schema || require('../core/schema');
  const C = opts.C || require('../core/constants');
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const minTvl = Number.isFinite(opts.minTvlUsd) ? opts.minTvlUsd : MIN_TVL_USD;
  const maxApy = Number.isFinite(opts.maxApy) ? opts.maxApy : MAX_APY;
  const seed = !!opts.seed;
  const dataAsOf = str(opts.dataAsOf) || new Date(nowMs).toISOString();

  const notes = [];
  const warnings = [];

  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : null;
  if (!rows) {
    return { opportunities: [], notes, warnings: ['upstream payload had no `data` array'], dropped: {} };
  }
  const upstreamStatus = str(payload?.status);
  if (upstreamStatus && upstreamStatus !== 'success') {
    warnings.push(`upstream reported status "${upstreamStatus}"`);
  }

  const protoIndex = opts.protocols instanceof Map ? opts.protocols : indexProtocols(opts.protocols);

  const dropped = { unparseable: 0, noChain: 0, noRate: 0, lowTvl: 0, absurdApy: 0 };
  const kept = [];

  for (const p of rows) {
    // One malformed record must never take the source down, so every record is
    // its own blast radius.
    try {
      if (!p || typeof p !== 'object') { dropped.unparseable += 1; continue; }
      const key = str(p.pool);
      const symbol = str(p.symbol) || str(p.poolMeta);
      if (!key || !symbol) { dropped.unparseable += 1; continue; }
      const chain = str(p.chain);
      if (!chain) { dropped.noChain += 1; continue; }   // unactionable without it

      const apyTotal = num(p.apy);
      const apyBase = num(p.apyBase);
      if (apyTotal === null && apyBase === null) { dropped.noRate += 1; continue; }

      const tvl = num(p.tvlUsd);
      if (tvl !== null && tvl < minTvl) { dropped.lowTvl += 1; continue; }

      const headline = apyTotal ?? apyBase;
      if (headline > maxApy || headline < -100) { dropped.absurdApy += 1; continue; }

      kept.push(p);
    } catch {
      dropped.unparseable += 1;
    }
  }

  // Cap selection. A quarter of the budget is reserved for the deepest pools by
  // TVL before the blended rank fills the rest: without that reserve a few
  // thousand dust farms can mathematically outrank Aave and Lido, and a yield
  // screen that has lost its own baseline is worthless.
  let selected = kept;
  let capped = false;
  let reserved = 0;
  if (kept.length > limit) {
    const reserve = Math.max(1, Math.floor(limit * 0.25));
    const deepest = kept.map((p, i) => ({ i, tvl: num(p.tvlUsd) ?? 0 }))
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, reserve)
      .map((x) => x.i);
    const taken = new Set(deepest);
    const filler = kept.map((p, i) => ({ i, r: rankScore(p) }))
      .filter((x) => !taken.has(x.i))
      .sort((a, b) => b.r - a.r)
      .slice(0, limit - taken.size)
      .map((x) => x.i);
    for (const i of filler) taken.add(i);
    selected = [...taken].sort((a, b) => a - b).map((i) => kept[i]);
    capped = true;
    reserved = deepest.length;
  }

  const opportunities = [];
  let enriched = 0;
  for (const p of selected) {
    try {
      const o = shapeOpportunity(p, { protoIndex, C, schema, nowMs, seed, dataAsOf });
      if (o) {
        opportunities.push(o);
        if (Number.isFinite(o.risk?.auditCount) || Number.isFinite(o.risk?.ageDays)) enriched += 1;
      } else {
        dropped.unparseable += 1;
      }
    } catch {
      dropped.unparseable += 1;
    }
  }

  notes.push(`${rows.length.toLocaleString()} pools upstream, ${opportunities.length.toLocaleString()} kept`);
  const dropTxt = [
    dropped.lowTvl ? `${dropped.lowTvl} under $${minTvl.toLocaleString()} TVL` : null,
    dropped.absurdApy ? `${dropped.absurdApy} with APY above ${maxApy.toLocaleString()}% (upstream data errors)` : null,
    dropped.noRate ? `${dropped.noRate} with no APY at all` : null,
    dropped.noChain ? `${dropped.noChain} with no chain named` : null,
    dropped.unparseable ? `${dropped.unparseable} unparseable` : null,
  ].filter(Boolean);
  if (dropTxt.length) notes.push(`Dropped: ${dropTxt.join('; ')}`);
  if (capped) {
    notes.push(`Capped at ${limit.toLocaleString()} pools: the ${reserved.toLocaleString()} deepest by TVL plus ${(limit - reserved).toLocaleString()} by a blended yield-and-TVL rank (${(kept.length - limit).toLocaleString()} more available upstream)`);
  }
  if (protoIndex.size) notes.push(`Protocol metadata joined for ${enriched.toLocaleString()} of ${opportunities.length.toLocaleString()} pools (audits, age)`);

  return { opportunities, notes, warnings, dropped, capped, reserved, limit, candidates: kept.length };
}

function shapeOpportunity(p, { protoIndex, C, schema, nowMs, seed, dataAsOf }) {
  const key = str(p.pool);
  const chain = str(p.chain);
  const project = str(p.project);
  const proto = project ? protoIndex.get(project.toLowerCase()) : null;
  const projectName = str(proto?.name) || prettyProject(project);
  const symbol = str(p.symbol) || str(p.poolMeta);
  const poolMeta = str(p.poolMeta);

  const assetClass = classify(p, proto, C);
  const subType = subTypeFor(assetClass, p, C);

  const apyBase = num(p.apyBase);
  const apyReward = num(p.apyReward);
  const apyTotal = num(p.apy);

  // DefiLlama already publishes APY, not APR, for these pools — do not compound
  // it a second time.
  const apy = {
    total: apyTotal,
    base: apyBase,
    reward: apyReward,
    mean30d: num(p.apyMean30d),
    mean7d: num(p.apyBase7d),   // upstream only publishes a 7d mean of the base leg
  };

  // Liquid staking pays out instantly on paper but exiting to the underlying
  // goes through an unbonding/withdrawal queue; the secondary market is a
  // workaround, not a guarantee.
  const liquidity = assetClass === C.ASSET_CLASS.CRYPTO_STAKING
    ? C.LIQUIDITY.NOTICE
    : C.LIQUIDITY.INSTANT;

  const gas = GAS_TOKEN[String(chain).toLowerCase()] || `${chain}'s native gas token`;
  const name = `${symbol} on ${projectName} (${chain})`;

  const detail = [];
  if (poolMeta) detail.push(poolMeta);
  const predClass = str(p.predictions?.predictedClass);
  const predProb = num(p.predictions?.predictedProbability);
  if (predClass) {
    detail.push(`DefiLlama's own model calls the next 30 days "${predClass}"${predProb !== null ? ` (${predProb.toFixed(0)}% confidence)` : ''}`);
  }
  const observed = num(p.count);
  if (observed !== null) detail.push(`${observed} days of observed history`);

  const volume = num(p.volumeUsd1d) ?? (num(p.volumeUsd7d) !== null ? num(p.volumeUsd7d) / 7 : null);

  return schema.normalize({
    source: 'defillama',
    sourceLabel: 'DefiLlama Yields',
    key,
    name,
    symbol,
    provider: projectName,
    assetClass,
    subType,
    chain,
    region: 'Global',
    currency: 'USD',

    apy,
    yieldKind: C.YIELD_KIND.VARIABLE,   // floats with utilisation and emissions, always
    liquidity,

    tvl: num(p.tvlUsd),
    volume,
    stablecoin: p.stablecoin === true,
    ilRisk: str(p.ilRisk),
    exposure: str(p.exposure),
    poolMeta,
    underlying: Array.isArray(p.underlyingTokens) ? p.underlyingTokens : [],

    risk: {
      principalAtRisk: true,                 // no deposit insurance exists here
      insurance: C.INSURANCE.NONE,
      auditCount: auditCount(proto),
      ageDays: ageDays(proto, nowMs),
    },

    taxTreatment: C.TAX_TREATMENT.ORDINARY,

    url: poolUrl(key, project),
    accessNotes: `Deposit ${symbol} into ${projectName} on ${chain}. Needs a self-custody wallet holding ${gas} for gas on ${chain} — no broker or exchange account can buy this for you.`,
    requirements: ['Self-custody wallet', `${gas} for gas on ${chain}`],
    notes: detail.length ? `${detail.join('. ')}.` : null,

    confidence: poolConfidence(p, seed),
    dataAsOf,
    seed,
    live: !seed,
  }, { source: 'defillama', seed });
}

/** Protocol metadata is a nice-to-have; it must never be able to fail the source. */
async function fetchProtocols(ctx) {
  const load = () => ctx.http.getJSON(PROTOCOLS_URL, { signal: ctx.signal, timeout: 25000 });
  if (!ctx.cache?.wrap) return load();
  const hit = await ctx.cache.wrap('defillama:protocols', PROTOCOL_TTL_MS, load);
  return hit?.value;
}

const adapter = {
  id: 'defillama',
  label: 'DefiLlama Yields',
  description: 'Every tracked DeFi pool with its reward split, TVL and 30-day mean, so the farm yields can be told apart from the real ones.',
  homepage: 'https://defillama.com/yields',
  assetClasses: ['crypto_lending', 'crypto_staking', 'crypto_lp'],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 30 * 60 * 1000,

  parsePools,
  indexProtocols,

  async fetch(ctx) {
    const cfg = ctx.settings?.sources?.defillama || ctx.settings?.defillama || {};
    const limit = Number.isFinite(cfg.limit) ? cfg.limit : DEFAULT_LIMIT;
    const minTvlUsd = Number.isFinite(cfg.minTvlUsd) ? cfg.minTvlUsd : MIN_TVL_USD;

    ctx.log?.('fetching yields.llama.fi/pools');
    let payload;
    try {
      payload = await ctx.http.getJSON(POOLS_URL, { signal: ctx.signal, timeout: 30000, retries: 2 });
    } catch (err) {
      return failure(err);
    }

    const warnings = [];
    let protocols = null;
    try {
      ctx.log?.('joining protocol metadata (audits, age)');
      protocols = await fetchProtocols(ctx);
    } catch (err) {
      // No audits and no age means traps.js loses two of its tests, which is a
      // degraded source, not a broken one.
      warnings.push(`protocol metadata unavailable (${err?.message || err}) — audit counts and protocol age are missing this run`);
    }

    const parsed = parsePools(payload, {
      schema: ctx.schema, C: ctx.C, protocols, limit, minTvlUsd, now: ctx.now,
    });

    const allWarnings = [...warnings, ...parsed.warnings];
    const notes = [...parsed.notes];
    if (!protocols) notes.push('Protocol metadata skipped this run — audit counts and ages are absent.');

    return result({
      opportunities: parsed.opportunities,
      status: allWarnings.length ? 'partial' : (parsed.opportunities.length ? 'ok' : 'partial'),
      notes,
      warnings: allWarnings,
      fetchedAt: new Date(ctx.now || Date.now()).toISOString(),
    });
  },

  loadSeed(ctx) {
    try {
      const { items, meta } = readSeed(ctx.seedDir, 'defillama.json');
      if (!items.length) {
        return result({ status: 'failed', warnings: ['seed file data/seed/defillama.json is missing or unreadable'] });
      }
      const parsed = parsePools({ status: 'success', data: items }, {
        schema: ctx.schema,
        C: ctx.C,
        protocols: meta.protocols,
        now: ctx.now,
        limit: items.length,
        seed: true,
        dataAsOf: meta.dataAsOf || '2026-08-01',
      });
      return result({
        opportunities: parsed.opportunities,
        status: 'offline',
        notes: [
          `Bundled snapshot of ${parsed.opportunities.length} DefiLlama pools as of ${meta.dataAsOf || '2026-08-01'}. Rates move daily — refresh before acting.`,
          ...parsed.notes.slice(1),
        ],
        warnings: parsed.warnings,
      });
    } catch (err) {
      return failure(err, { status: 'failed' });
    }
  },
};

module.exports = adapter;
