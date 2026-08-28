'use strict';

const { applyQuery } = require('./filters');
const { DEFAULT_QUERY } = require('./constants');

/**
 * The payloads the interface asks for, as pure functions of the dataset.
 *
 * These lived inline in the Electron main process, where they could not be
 * tested at all: thirty-one IPC handlers, none of them covered, and between
 * them every crash the app could show a user. It is the same shape of gap that
 * put three separate crashes into scripts/backtest.js — logic reachable only by
 * running the whole application, and therefore reached first by whoever is
 * using it.
 *
 * The two most involved handlers now live here instead. They take a dataset and
 * some settings and return data; they touch no Electron, no store and no disk,
 * so the merging, capping and ranking that the Radar and Signals views depend
 * on runs in the ordinary test suite.
 */

/**
 * The Radar digest.
 *
 * @param {object} dataset   { opportunities, events, meta }
 * @param {object} opts      { settings, watchlist }
 */
function radarPayload(dataset, { settings = {}, watchlist = [] } = {}) {

    const rows = dataset.opportunities || [];
    const budget = Number.isFinite(settings.budget) && settings.budget > 0 ? settings.budget : null;
    const take = (q, n = 5) => applyQuery(rows, { ...DEFAULT_QUERY, ...q, watchlist: watchlist, limit: n });
    const countOf = (q) => applyQuery(rows, { ...DEFAULT_QUERY, ...q, watchlist: watchlist }).length;
    const spec = (q) => ({ rows: take(q), count: countOf(q), query: q });

    // What is scheduled, whether or not it belongs to a ticker. Most of a given
    // week is macro — a CPI print, an FOMC decision, an auction — and none of
    // that hangs off a row, so a card built only from row catalysts showed one
    // earnings date and silently dropped the five events that move everything.
    const bySymbol = new Map();
    for (const o of rows) if (o.symbol && !bySymbol.has(o.symbol)) bySymbol.set(o.symbol, o.id);
    const upcoming = (dataset.events || [])
      .filter((e) => Number.isFinite(e.daysAway) && e.daysAway >= 0 && e.daysAway <= 7)
      .sort((a, b) => a.dateMs - b.dateMs);
    // Earnings season can put forty companies in one week. Cap any single kind
    // so a card of six does not become six identical rows.
    const perKind = new Map();
    const weekEvents = [];
    for (const e of upcoming) {
      const n = perKind.get(e.kind) || 0;
      if (n >= 3) continue;
      perKind.set(e.kind, n + 1);
      weekEvents.push({ ...e, linkId: e.symbol ? (bySymbol.get(e.symbol) || null) : null });
      if (weekEvents.length >= 6) break;
    }

    /**
     * Everything with a clock on it, in one list.
     *
     * An offer that expires and a deadline after which an action is no longer
     * possible are the same thing to the person holding the money, and keeping
     * them in separate views is why "Closing soon" could show three items while
     * a hundred and fifty dated things sat one tab away.
     */
    const clockRows = applyQuery(rows, {
      ...DEFAULT_QUERY, expiringWithinDays: 45, hideTraps: false, watchlist: watchlist, limit: 40,
    }).map((o) => ({
      type: 'opportunity',
      id: o.id,
      name: o.name,
      sub: [o.provider || o.sourceLabel, o.section].filter(Boolean).join(' · '),
      daysLeft: o.daysLeft,
      value: Number.isFinite(o.scores?.oneTimeDollars) ? o.scores.oneTimeDollars : null,
      grade: o.rating?.grade || null,
    }));

    // Ex-dividend dates: the most under-served deadline there is. Every
    // dividend payer has a date you must own it by, it recurs visibly in the
    // payment record, and no screener lists it as something that runs out.
    // Only present on rows whose actual payment history supports projecting
    // one, so this is empty until a live refresh has fetched dividends.
    const exDiv = rows
      .filter((o) => o.exDividend && o.exDividend.daysAway >= 0 && o.exDividend.daysAway <= 45)
      .sort((a, b) => a.exDividend.daysAway - b.exDividend.daysAway)
      .slice(0, 8)
      .map((o) => ({
        type: 'opportunity',
        id: o.id,
        name: `${o.name} goes ex-dividend`,
        sub: `Own it before this date to collect the ${o.exDividend.cadence} payment · estimated from its last ${o.exDividend.basedOn} payments`,
        daysLeft: o.exDividend.daysAway,
        value: null,
        grade: o.rating?.grade || null,
      }));

    const clockEvents = (dataset.events || [])
      .filter((e) => Number.isFinite(e.daysAway) && e.daysAway >= 0 && e.daysAway <= 45)
      // Earnings for a single ticker is a catalyst, not a deadline you can miss.
      // Money deadlines, maturities and expiries genuinely close.
      .filter((e) => ['money_deadline', 'maturity', 'call_date', 'token_unlock', 'lockup_expiry', 'opex', 'index_rebalance', 'treasury_auction'].includes(e.kind))
      .map((e) => ({
        type: 'event',
        id: `event:${e.kind}:${e.dateMs}`,
        name: e.title || e.label,
        sub: `${e.label}${e.certainty === 'estimated' ? ' · estimated date' : ''}`,
        daysLeft: e.daysAway,
        value: null,
        grade: null,
        url: e.url || null,
      }));

    // Treasury auctions run weekly and options expire monthly, so a naive
    // merge fills the card with the most routine dates on the calendar and
    // buries the offer that genuinely disappears on Friday. Two per kind keeps
    // the recurring ones represented without letting them dominate; scarcity is
    // most of what makes a deadline worth showing.
    const clockPerKind = new Map();
    const onTheClock = [...clockRows, ...exDiv, ...clockEvents]
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .filter((x) => {
        if (x.type !== 'event') return true;
        const kind = String(x.id).split(':')[1];
        const n = clockPerKind.get(kind) || 0;
        if (n >= 2) return false;
        clockPerKind.set(kind, n + 1);
        return true;
      })
      .slice(0, 40);

    return {
      budget,
      meta: dataset.meta,
      onTheClock,
      onTheClockCount: onTheClock.length,
      weekEvents,
      weekEventCount: upcoming.length,
      groups: {
        // What a flat table can never show you: things with a deadline. Note
        // this is opportunities only — the card below merges these with dated
        // events, because "three things closing in the next month" was never
        // true of the world, only of the subset the app happened to model as
        // an offer with an expiry date.
        closing: spec({ expiringWithinDays: 45, sortBy: 'closingSoon', hideTraps: false }),
        // What is coming, for what you already hold or might.
        thisWeek: spec({ track: 'movement', catalystWithinDays: 7, sortBy: 'soonest' }),
        // The three shelves.
        income: spec({ sections: ['income'], sortBy: 'dogScore' }),
        movement: spec({ sections: ['movement'], sortBy: 'heat' }),
        deals: spec({ sections: ['deals'], sortBy: 'dogScore', hideTraps: false }),
        // Things few people follow, which is genuinely informative both ways.
        obscure: spec({ reaches: ['obscure', 'niche'], sortBy: 'dogScore' }),
        // Money for an afternoon's work, ranked by least effort first.
        easy: spec({ sections: ['deals'], effortMax: 'light', sortBy: 'dogScore', hideTraps: false }),
        // What you are already tracking.
        watching: spec({ watchlistOnly: true, hideTraps: false, includeSpeculative: true }),
      },
    };
}

/**
 * The Signals view payload.
 *
 * @param {object} dataset      { opportunities, events, health, meta }
 * @param {object|null} calibration  a measured calibration, or null
 */
function signalsPayload(dataset, calibration = null) {

        const cal = calibration;
    const rows = (dataset.opportunities || []).filter((o) => o.signals);
    const readable = rows.filter((o) => !o.signals.unreadable);
    const ranked = readable
      .filter((o) => o.signals.fired.length > 0)
      .sort((a, b) => (b.signals.pressure || 0) - (a.signals.pressure || 0))
      .slice(0, 60)
      .map((o) => ({
        id: o.id,
        name: o.name,
        symbol: o.symbol || null,
        section: o.section,
        subType: o.subType || null,
        price: o.price ?? null,
        grade: o.rating?.grade || null,
        gradeColor: o.rating?.gradeColor || null,
        series: o.series || null,
        seriesBasis: o.seriesBasis || null,
        pressure: o.signals.pressure,
        lean: o.signals.lean,
        fired: o.signals.fired.map((f) => ({
          key: f.key, strength: f.strength, value: f.value ?? null, evidence: f.evidence || [],
        })),
        missing: o.signals.missing || [],
        onPriors: o.signals.onPriors || [],
        expected: o.movement?.expected || null,
        catalyst: o.movement?.catalyst?.event || null,
      }));

    return {
      rows: ranked,
      // Detectors the backtest has no way to measure, so they are still running
      // on their prior weight even though a calibration exists. Squeeze,
      // catalyst and unlock need short interest, an event calendar and an
      // unlock schedule — none of which a run over historical closes can
      // reconstruct — so the file never mentions them, and a reader deserves to
      // know which half of the reading was measured.
      onPriors: [...new Set(readable.flatMap((o) => o.signals.onPriors || []))],
      calibration: cal ? {
        generatedAt: cal.generatedAt,
        universe: (cal.universe || []).length,
        years: cal.years,
        horizon: cal.horizon,
        definition: cal.definition,
        baseRate: cal.testBaseRate,
        bars: cal.testBars,
        scores: cal.scores,
        composite: cal.composite,
        validated: cal.validated,
        failed: cal.failedSignals,
        weights: cal.weights,
      } : null,
      counts: {
        total: rows.length,
        readable: readable.length,
        unreadable: rows.length - readable.length,
        firing: readable.filter((o) => o.signals.fired.length).length,
      },
      // Not one reason any more. A row can be unreadable because its chart was
      // drawn rather than recorded, or because its bars are not the trading days
      // every detector here was measured on — crypto's history is hourly — and
      // an empty screen that names the wrong reason is worse than one that names
      // none. Most common first, since that is the one worth reading.
      unreadableReasons: Object.entries(
        rows.filter((o) => o.signals.unreadable)
          .reduce((acc, o) => {
            const why = o.signals.unreadable;
            acc[why] = (acc[why] || 0) + 1;
            return acc;
          }, {}),
      ).sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count })),
      // Why there is nothing to show, in terms of what actually happened rather
      // than a generic instruction to press Refresh. "Hit refresh" is useless
      // advice to somebody who already did.
      diagnosis: (() => {
        const m = (dataset.meta || {}) || {};
        const priceSources = ((dataset.health || []) || []).filter((h) => ['equities', 'crypto'].includes(h.id));
        return {
          everScanned: !!m.generatedAt,
          scannedAt: m.generatedAt || null,
          offline: !!m.offline,
          seedRows: m.seedRows ?? null,
          liveRows: m.liveRows ?? null,
          sources: priceSources.map((h) => ({
            id: h.id,
            label: h.label,
            status: h.status,
            rows: h.count ?? 0,
            problem: h.error || (h.warnings || [])[0] || null,
          })),
        };
      })(),
    };
}

/**
 * Fold a freshly-measured row back into the one already on screen.
 *
 * An adapter's fetchOne does not return a row. It returns a SourceResult
 * envelope — { opportunities, status, notes, warnings } — and the difference
 * matters, because the measure handler used to spread the envelope over the
 * existing row. Every field the measurement was for (price, series, apy, risk,
 * movementStats) stayed exactly as it was; what changed instead was that the
 * row grew `opportunities`, `status` and `warnings` keys it has no business
 * having, its `notes` turned from a string into an array, and the "not
 * measured" badge disappeared because `measured: true` was the one part of the
 * spread that landed. Pressing Measure appeared to work and measured nothing.
 *
 * So: unwrap deliberately, take the row, and keep the identity fields that
 * belong to the row already on screen.
 *
 * @param {object} existing  the row currently in the dataset
 * @param {object} res       whatever the adapter's fetchOne returned
 * @returns {{row: object, notes: string[], warnings: string[]}}
 * @throws  {Error} with a message fit to show a user, if nothing usable came back
 */
function mergeMeasured(existing, res) {
  if (!existing || typeof existing !== 'object') throw new Error('Not found in the current scan.');
  if (!res || typeof res !== 'object') throw new Error('No data came back for that one.');

  const list = Array.isArray(res.opportunities) ? res.opportunities.filter(Boolean) : [];
  const warnings = Array.isArray(res.warnings) ? res.warnings.filter(Boolean) : [];
  const notes = Array.isArray(res.notes) ? res.notes.filter(Boolean) : [];

  if (!list.length) {
    // The adapter's own warning is a better explanation than any we could write.
    throw new Error(warnings[0] || `No price history came back for ${existing.symbol || existing.name || 'that one'}.`);
  }

  // Prefer the row that is actually this one. A fetchOne that returns several
  // (an ETF and its index, say) must not silently overwrite one with the other.
  const fresh = list.find((r) => r && (r.id === existing.id || (r.symbol && r.symbol === existing.symbol))) || list[0];

  const row = { ...existing, ...fresh };

  // Identity is the dataset's, not the adapter's. The id is what the open
  // detail pane, the watchlist and every alert already hold; a re-keyed row
  // would deselect itself the moment it was measured.
  row.id = existing.id;
  row.source = existing.source;
  if (existing.sourceLabel) row.sourceLabel = existing.sourceLabel;
  if (existing.section && !fresh.section) row.section = existing.section;
  row.measured = true;

  // Envelope diagnostics are not row content. `notes` on a row is prose the
  // user reads; the envelope's notes are a fetch log, and assigning one to the
  // other is how the schema's string field became an array.
  // Only keys the envelope owns and a row never has. `fetchedAt` is deliberately
  // not in this list: rows carry one too, and `fresh` is a row, so it is the
  // measurement's own timestamp and exactly what should win here.
  for (const k of ['opportunities', 'status', 'warnings']) delete row[k];
  if (Array.isArray(row.notes)) row.notes = row.notes.filter(Boolean).join(' ');

  return { row, notes, warnings };
}

module.exports = { radarPayload, signalsPayload, mergeMeasured };
