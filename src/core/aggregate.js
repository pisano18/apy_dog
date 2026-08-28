'use strict';

const path = require('node:path');
const C = require('./constants');
const schema = require('./schema');
const http = require('./http');
const { scoreAll } = require('./score');
const { peerMedians } = require('./traps');
const { rate } = require('./rating');
const { readMovement } = require('./movement');
const { readSignals } = require('./signals');
const { loadCalibration } = require('./calibration');
const { vehiclesFor, outOfReach } = require('./vehicles');
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

/**
 * Did this source actually produce anything?
 *
 * Not every source produces opportunities. The calendar and filings feeds
 * produce dated EVENTS and an empty opportunities array by design, so judging
 * them on row count alone reports a healthy source as failed and sends the user
 * to the Sources panel to debug something that is working perfectly.
 */
function yielded(res) {
  return (res?.opportunities?.length || 0) + (res?.events?.length || 0) > 0;
}

/**
 * Strip everything the pipeline derives, so a carried-forward row is re-scored
 * against the current settings rather than keeping a stale grade computed under
 * a different tax bracket or budget.
 */
function stripDerived(o) {
  const { scores, rating, movement, vehicles, vehiclesOutOfReach, tax, ...rest } = o;
  return rest;
}

async function runSource(adapter, ctx) {
  const started = Date.now();
  try {
    if (ctx.offline) {
      const res = adapter.loadSeed(ctx) || {};
      return {
        ...res,
        id: adapter.id,
        label: adapter.label,
        status: yielded(res) ? C.SOURCE_STATUS.OFFLINE : C.SOURCE_STATUS.FAILED,
        ms: Date.now() - started,
      };
    }
    const res = await adapter.fetch(ctx);
    const opportunities = res?.opportunities || [];
    // An adapter that "succeeds" with nothing is not a success. Fall back so the
    // user still sees rows rather than an empty category.
    if (!yielded(res)) {
      const seeded = adapter.loadSeed(ctx) || {};
      return {
        ...seeded,
        id: adapter.id,
        label: adapter.label,
        status: yielded(seeded) ? C.SOURCE_STATUS.PARTIAL : C.SOURCE_STATUS.FAILED,
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
      events: seeded.events || [],
      status: yielded(seeded) ? C.SOURCE_STATUS.PARTIAL : C.SOURCE_STATUS.FAILED,
      notes: seeded.notes || [],
      warnings: [
        blocked
          ? `${adapter.label}: blocked by a network policy or firewall (HTTP ${err.status}).`
          : `${adapter.label}: ${err?.message || String(err)}`,
        ...(yielded(seeded) ? ['Showing the bundled snapshot for this source.'] : []),
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
  // What counts as "the same thing" depends on the instrument, and getting this
  // wrong in either direction is bad. Ten USDC lending pools on ten protocols
  // are ten genuinely different opportunities paying different rates; the same
  // bond ETF listed by two sources is one instrument described twice.
  //
  // The dividing line is whether a ticker identifies the tradeable thing. For a
  // listed security it does. For a DeFi position the pool does, not the token
  // it happens to hold, so those key on their own id and stay separate.
  const POOLED = ['crypto_lending', 'crypto_lp', 'crypto_staking'];
  const keyOf = (o) => {
    const listed = o.symbol && !POOLED.includes(o.assetClass) && o.source !== 'defillama';
    if (listed) return `sym:${o.symbol.toUpperCase()}`;
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
    // Prefer the row that actually knows more. Confidence alone would let an
    // unmeasured index entry displace a measured one with a full price series.
    const richness = (x) => (x.movementStats ? 4 : 0) + (Array.isArray(x.series) && x.series.length ? 2 : 0)
      + (Number.isFinite(x.price) ? 1 : 0) + (x.measured === false ? -4 : 0) + (x.seed ? -1 : 0);
    const rO = richness(o); const rCur = richness(cur);
    const winner = rO !== rCur
      ? (rO > rCur ? o : cur)
      : ((o.confidence ?? 0) > (cur.confidence ?? 0) ? o : cur);
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
  let active = adapters.filter((a) => (enabled === null || enabled === undefined ? a.defaultEnabled !== false : enabled.includes(a.id)));

  // Partial refresh. Different feeds go stale at wildly different rates: crypto
  // moves by the second, Treasury publishes once a day, and a curated deposit
  // list changes about monthly. Refreshing all of them on one timer is both
  // slower and less current than refreshing each on its own cadence, so a run
  // can be scoped to the sources that are actually due and merged over the rows
  // already held.
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  const carried = only && Array.isArray(opts.previous?.opportunities) ? opts.previous : null;
  if (only) active = active.filter((a) => only.has(a.id));

  const skipped = adapters.filter((a) => !active.includes(a) && (enabled === null || enabled === undefined ? a.defaultEnabled !== false : enabled.includes(a.id)));

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
  // Every event is stamped with the adapter that produced it, under a key the
  // adapter does not own.
  //
  // The carry-forward below filters on `e.source`, which reads like the adapter
  // id and is not: adapters put human provenance there — "Treasury auction
  // cycle", "BLS release pattern", "reporting pattern". So refreshing the
  // calendar recognised only the 25 events tagged literally 'calendar' and
  // carried the other 158 forward while the fresh fetch re-emitted them too.
  // The per-row attach loop dedupes, so rows stayed clean; the events array the
  // interface renders and the counters beside it did not. Calendar cadence is
  // an hour, so it doubled again every hour the app stayed open.
  const events = results.flatMap((r) => (Array.isArray(r.events) ? r.events : [])
    .filter(Boolean)
    .map((e) => (e.adapterId === r.id ? e : { ...e, adapterId: r.id })));

  // --- merge ---------------------------------------------------------------
  // On a partial run, rows and events from sources that were not refreshed are
  // carried forward untouched. They keep their own fetchedAt, so the interface
  // can show per-source freshness honestly rather than implying everything was
  // just checked.
  const refreshedIds = new Set(active.map((a) => a.id));
  const carriedRows = carried
    ? carried.opportunities.filter((o) => !refreshedIds.has(o.source)).map(stripDerived)
    : [];
  const carriedEvents = carried
    ? (carried.events || []).filter((e) => !refreshedIds.has(e.adapterId ?? e.source))
    : [];
  events.push(...carriedEvents);

  const raw = [...results.flatMap((r) => r.opportunities || []), ...carriedRows];
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
    amount: Number.isFinite(settings.budget) && settings.budget > 0 ? settings.budget : null,
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

  // Read once per run rather than per row: it is a file read, and eight hundred
  // of them per scan for a file that changes after a backtest is wasteful.
  const calibration = loadCalibration();

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
    const budget = Number.isFinite(settings.budget) && settings.budget > 0 ? settings.budget : null;
    const vehicles = vehiclesFor(withEvents, { budget });
    const movement = withEvents.track === T.TRACK.INCOME
      ? null
      : readMovement(withEvents, { events: own2, now, horizonDays: settings.movementHorizonDays ?? 30 });

    // Pre-move signals, evaluated at the LAST bar of whatever history the row
    // carries. Everything the detectors need is already on the row; what they
    // add is the reading of it, plus evidence a person can argue with.
    let signals = null;
    if (movement && Array.isArray(withEvents.series) && withEvents.series.length >= 30) {
      try {
        signals = readSignals(
          { closes: withEvents.series, volumes: withEvents.volumeSeries || [], highs: [], lows: [] },
          withEvents.series.length - 1,
          {
            events: own2,
            horizonDays: settings.movementHorizonDays ?? 30,
            weights: calibration?.weights || null,
            // The settings the backtest chose, so the app detects with the same
            // configuration that was actually measured rather than the guesses
            // the measurement rejected.
            params: calibration?.chosenParams || null,
            shortPercentFloat: withEvents.shortPercentFloat,
            daysToCover: withEvents.daysToCover,
            borrowFeePct: withEvents.borrowFeePct,
            floatShares: withEvents.floatShares,
            unlockPercentOfFloat: withEvents.unlockPercentOfFloat,
            unlockDaysAway: withEvents.unlockDaysAway,
            priceVsHigh: Number.isFinite(withEvents.maxDrawdown) ? -withEvents.maxDrawdown / 100 : null,
          },
        );
        // A chart that was drawn rather than recorded cannot support a signal.
        // Reading compression off a curve derived from a volatility number and
        // then reporting it as evidence about volatility is circular.
        if (withEvents.seriesBasis === 'illustrative') {
          signals = { ...signals, unreadable: 'This row has no recorded price history yet — its chart is drawn from its own statistics, so no signal can honestly be read off it. Refresh to measure it.' };
        }
      } catch { signals = null; }
    }

    return {
      ...withEvents,
      rating,
      movement,
      signals,
      vehicles,
      vehiclesOutOfReach: outOfReach(vehicles).length,
    };
  });

  const health = results.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status || C.SOURCE_STATUS.OK,
    count: r.opportunities?.length || 0,
    eventCount: r.events?.length || 0,
    // A calendar feed's contribution is events, not rows; reporting "0 rows" for
    // a working source is how a healthy feed gets mistaken for a broken one.
    produces: (r.events?.length || 0) > 0 && !(r.opportunities?.length || 0) ? 'events' : 'opportunities',
    ms: r.ms,
    notes: r.notes || [],
    warnings: r.warnings || [],
    fetchedAt: r.fetchedAt || new Date().toISOString(),
    live: !offline && r.status === C.SOURCE_STATUS.OK,
  })).concat(skipped.map((a) => {
    // A source skipped by a partial refresh is not disabled and must not be
    // reported as one — its rows are still on screen and still valid.
    const prev = (opts.previous?.health || []).find((h) => h.id === a.id);
    if (only && prev) {
      return { ...prev, carried: true, notes: [...(prev.notes || []), 'Not due for a refresh; showing the last scan.'] };
    }
    return {
      id: a.id, label: a.label, status: C.SOURCE_STATUS.DISABLED,
      count: 0, ms: 0, notes: ['Disabled in settings.'], warnings: [], live: false,
    };
  }));

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
      bySection: {
        income: enriched.filter((o) => o.section === 'income').length,
        movement: enriched.filter((o) => o.section === 'movement').length,
        deals: enriched.filter((o) => o.section === 'deals').length,
      },
      expiringSoon: enriched.filter((o) => Number.isFinite(o.daysLeft) && o.daysLeft >= 0 && o.daysLeft <= 14).length,
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
      partial: !!only,
      refreshed: [...refreshedIds],
      carriedRows: carriedRows.length,
    },
  };
}

module.exports = { aggregate, runSource, dedupe, FALLBACK_RISK_FREE };
