'use strict';

const path = require('node:path');
const C = require('./constants');
const schema = require('./schema');
const http = require('./http');
const { scoreAll } = require('./score');
const { peerMedians } = require('./traps');
const { rate } = require('./rating');
const { readMovement } = require('./movement');
const T = require('./tracks');

/**
 * The orchestrator.
 *
 * Runs every enabled source, merges what comes back, de-duplicates, scores the
 * whole set together and reports honestly on what worked.
 *
 * Design rule: one broken source must never take down the run. A refresh where
 * four of six feeds answered is a good refresh, clearly labelled, not a failure.
 * The Source Health report is a first-class output, not an afterthought — when
 * the user is making money decisions off this table they need to know which
 * numbers are live and which are a bundled snapshot.
 */

/** Scoring needs the risk-free rate; fall back sensibly if Treasury is down. */
const FALLBACK_RISK_FREE = 4.0;

async function runSource(adapter, ctx) {
  const started = Date.now();
  try {
    if (ctx.offline) {
      const res = adapter.loadSeed(ctx) || {};
      return {
        ...res,
        id: adapter.id,
        label: adapter.label,
        status: res.opportunities?.length ? C.SOURCE_STATUS.OFFLINE : C.SOURCE_STATUS.FAILED,
        ms: Date.now() - started,
      };
    }
    const res = await adapter.fetch(ctx);
    const opportunities = res?.opportunities || [];
    // An adapter that "succeeds" with nothing is not a success. Fall back so the
    // user still sees rows rather than an empty category.
    if (!opportunities.length) {
      const seeded = adapter.loadSeed(ctx) || {};
      return {
        ...seeded,
        id: adapter.id,
        label: adapter.label,
        status: seeded.opportunities?.length ? C.SOURCE_STATUS.PARTIAL : C.SOURCE_STATUS.FAILED,
        warnings: [...(res?.warnings || []), ...(seeded.warnings || []),
          'Live fetch returned no usable rows; showing the bundled snapshot instead.'],
        ms: Date.now() - started,
      };
    }
    return { ...res, id: adapter.id, label: adapter.label, ms: Date.now() - started };
  } catch (err) {
    // Live path died. Seed data is the safety net.
    let seeded = { opportunities: [], warnings: [] };
    try { seeded = adapter.loadSeed(ctx) || seeded; } catch { /* seed is optional */ }
    const blocked = err?.status === 403 || err?.status === 407;
    return {
      id: adapter.id,
      label: adapter.label,
      opportunities: seeded.opportunities || [],
      status: seeded.opportunities?.length ? C.SOURCE_STATUS.PARTIAL : C.SOURCE_STATUS.FAILED,
      notes: seeded.notes || [],
      warnings: [
        blocked
          ? `${adapter.label}: blocked by a network policy or firewall (HTTP ${err.status}).`
          : `${adapter.label}: ${err?.message || String(err)}`,
        ...(seeded.opportunities?.length ? ['Showing the bundled snapshot for this source.'] : []),
      ],
      error: String(err?.message || err),
      ms: Date.now() - started,
    };
  }
}

/**
 * Two rows describe the same thing when they share a symbol/provider identity.
 * Keep the more trustworthy one and remember that the other agreed — corroboration
 * across independent sources is itself evidence, so it raises confidence.
 */
function dedupe(list) {
  const keyOf = (o) => {
    if (o.symbol && ['etf', 'cef', 'reit', 'bdc', 'preferred', 'dividend_equity', 'corp_bond', 'muni_bond'].includes(o.assetClass)) {
      return `sym:${o.symbol.toUpperCase()}`;
    }
    if (o.assetClass === 'govt_bond' && o.subType && Number.isFinite(o.term?.days)) {
      return `gov:${o.subType}:${Math.round(o.term.days)}`;
    }
    return `id:${o.id}`;
  };
  const best = new Map();
  let merged = 0;
  for (const o of list) {
    const k = keyOf(o);
    const cur = best.get(k);
    if (!cur) { best.set(k, o); continue; }
    merged += 1;
    const winner = (o.confidence ?? 0) > (cur.confidence ?? 0) || (!o.seed && cur.seed) ? o : cur;
    const loser = winner === o ? cur : o;
    // Replace rather than mutate: these objects belong to their adapter, and a
    // confidence bump applied in place would compound if this ever ran twice.
    best.set(k, {
      ...winner,
      corroboratedBy: [...new Set([...(winner.corroboratedBy || []), loser.source])],
      // Independent agreement is real evidence; a small bump, capped.
      confidence: Math.min(1, (winner.confidence ?? 0.5) + 0.05),
    });
  }
  return { list: [...best.values()], merged };
}

/**
 * @param {object[]} adapters  loaded source adapters
 * @param {object} opts
 *   - settings, cache, seedDir, offline, signal, onProgress(evt)
 */
async function aggregate(adapters, opts = {}) {
  const {
    settings = {},
    cache = null,
    seedDir = path.join(__dirname, '..', '..', 'data', 'seed'),
    offline = false,
    signal = null,
    onProgress = () => {},
  } = opts;

  const enabled = settings.enabledSources;
  const active = adapters.filter((a) => (enabled === null || enabled === undefined ? a.defaultEnabled !== false : enabled.includes(a.id)));
  const skipped = adapters.filter((a) => !active.includes(a));

  const now = Date.now();
  const makeCtx = (adapter) => ({
    http,
    cache,
    schema,
    C,
    settings,
    signal,
    seedDir,
    now,
    offline,
    log: (msg) => onProgress({ type: 'log', source: adapter.id, message: String(msg) }),
  });

  onProgress({ type: 'start', total: active.length });

  const results = await Promise.all(active.map(async (a) => {
    onProgress({ type: 'source_start', source: a.id, label: a.label });
    const r = await runSource(a, makeCtx(a));
    onProgress({
      type: 'source_done', source: a.id, label: a.label,
      status: r.status, count: r.opportunities.length, ms: r.ms,
    });
    return r;
  }));

  // --- risk-free rate, from Treasury if it answered ------------------------
  let riskFree = FALLBACK_RISK_FREE;
  let riskFreeSource = 'fallback';
  const treasury = results.find((r) => r.id === 'treasury');
  if (treasury?.opportunities?.length) {
    try {
      const adapter = active.find((a) => a.id === 'treasury');
      const rf = adapter?.getRiskFreeRate?.(treasury);
      if (Number.isFinite(rf) && rf > 0 && rf < 25) { riskFree = rf; riskFreeSource = 'treasury'; }
      else {
        // Fall back to whatever short bill we can find in the returned rows.
        const bill = treasury.opportunities
          .filter((o) => o.subType === 'bill' && Number.isFinite(o.term?.days) && o.term.days <= 120)
          .sort((a, b) => Math.abs(91 - a.term.days) - Math.abs(91 - b.term.days))[0];
        if (Number.isFinite(bill?.apy?.total)) { riskFree = bill.apy.total; riskFreeSource = 'treasury:3mo-bill'; }
      }
    } catch { /* keep the fallback */ }
  }

  // --- events ---------------------------------------------------------------
  // Some sources (the calendar, the filings feed) produce dated events rather
  // than opportunities. They are collected here and attached to matching rows
  // below, which is what turns a static table into "what is about to happen".
  const events = results.flatMap((r) => (Array.isArray(r.events) ? r.events : [])).filter(Boolean);

  // --- merge ---------------------------------------------------------------
  const raw = results.flatMap((r) => r.opportunities || []);
  const dismissed = new Set(opts.dismissed || []);
  const kept = raw.filter((o) => o && !dismissed.has(o.id));
  const { list: deduped, merged } = dedupe(kept);

  // --- validate, dropping anything malformed rather than rendering nonsense --
  const invalid = [];
  const valid = deduped.filter((o) => {
    const problems = schema.validate(o);
    if (problems.length) { invalid.push({ id: o?.id, problems }); return false; }
    return true;
  });

  // --- score everything together -------------------------------------------
  const scored = scoreAll(valid, {
    riskFree,
    appetite: settings.riskAppetite ?? 45,
    taxProfile: settings.tax || {},
    basis: settings.rankingBasis || 'afterTax',
    horizonDays: settings.horizonDays ?? null,
    amount: settings.budget ?? 10000,
  });

  // --- attach events, rate, and read movement -------------------------------
  const bySymbol = new Map();
  for (const e of events) {
    if (!e.symbol) continue;
    const k = String(e.symbol).toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k).push(e);
  }
  const rateSensitive = new Set(['govt_bond', 'muni_bond', 'corp_bond', 'cash', 'cd', 'rwa', 'preferred', 'annuity']);
  const broadEvents = events.filter((e) => e.scope === 'rates');
  const marketEvents = events.filter((e) => e.scope === 'market');

  const enriched = scored.map((o) => {
    const own = [
      ...(o.symbol ? bySymbol.get(String(o.symbol).toUpperCase()) || [] : []),
      ...(rateSensitive.has(o.assetClass) || o.subType === 'index_proxy' ? broadEvents : []),
      ...(o.track !== T.TRACK.INCOME ? marketEvents : []),
      ...(o.events || []),
    ];
    // Deduplicate: an event can arrive by more than one route.
    const seen = new Set();
    const own2 = own.filter((e) => {
      const k = `${e.kind}:${e.dateMs}:${e.symbol || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const withEvents = { ...o, events: own2 };
    const rating = rate(withEvents);
    const movement = withEvents.track === T.TRACK.INCOME
      ? null
      : readMovement(withEvents, { events: own2, now, horizonDays: settings.movementHorizonDays ?? 30 });

    return { ...withEvents, rating, movement };
  });

  const health = results.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status || C.SOURCE_STATUS.OK,
    count: r.opportunities?.length || 0,
    ms: r.ms,
    notes: r.notes || [],
    warnings: r.warnings || [],
    fetchedAt: r.fetchedAt || new Date().toISOString(),
    live: !offline && r.status === C.SOURCE_STATUS.OK,
  })).concat(skipped.map((a) => ({
    id: a.id, label: a.label, status: C.SOURCE_STATUS.DISABLED,
    count: 0, ms: 0, notes: ['Disabled in settings.'], warnings: [], live: false,
  })));

  const seedCount = enriched.filter((o) => o.seed).length;
  onProgress({ type: 'done', count: enriched.length });

  return {
    opportunities: enriched,
    events,
    health,
    meta: {
      generatedAt: new Date().toISOString(),
      riskFree,
      riskFreeSource,
      total: enriched.length,
      byTrack: {
        income: enriched.filter((o) => o.track === T.TRACK.INCOME).length,
        movement: enriched.filter((o) => o.track === T.TRACK.MOVEMENT).length,
        both: enriched.filter((o) => o.track === T.TRACK.BOTH).length,
      },
      eventCount: events.length,
      upcomingEvents: events.filter((e) => !e.past).length,
      measured: enriched.filter((o) => o.measured !== false).length,
      liveRows: enriched.length - seedCount,
      seedRows: seedCount,
      duplicatesMerged: merged,
      invalidDropped: invalid.length,
      invalidSample: invalid.slice(0, 8),
      peerMedians: peerMedians(enriched),
      offline,
      sourcesOk: health.filter((h) => h.status === C.SOURCE_STATUS.OK).length,
      sourcesTotal: active.length,
    },
  };
}

module.exports = { aggregate, runSource, dedupe, FALLBACK_RISK_FREE };
