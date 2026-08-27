'use strict';

/**
 * THE SOURCE ADAPTER CONTRACT
 * ===========================
 *
 * Every file in src/sources/ (except this one and index.js) exports one adapter:
 *
 *   module.exports = {
 *     id:            'defillama',            // stable, lowercase, used in ids + settings
 *     label:         'DefiLlama Yields',     // shown in the UI
 *     description:   'one sentence for the Sources panel',
 *     homepage:      'https://…',
 *     assetClasses:  ['crypto_lp', …],       // from constants.ASSET_CLASS
 *     requiresNetwork: true,
 *     requiresKey:   false,                  // true => needs a user-supplied API key
 *     defaultEnabled: true,
 *     ttlMs:         30 * 60 * 1000,         // how long its data stays fresh
 *
 *     async fetch(ctx) -> SourceResult       // live path; may throw
 *     loadSeed(ctx)    -> SourceResult       // offline path; MUST NOT throw
 *   };
 *
 * ctx (provided by the aggregator):
 *   ctx.http      { request, getJSON, getText, parseCSV, xmlTagValues, HttpError }
 *   ctx.cache     Cache instance (get/set/wrap)
 *   ctx.schema    schema module: normalize(), aprToApy(), discountToApy(), annualize(), makeId()
 *   ctx.C         constants module
 *   ctx.settings  user settings (see core/store.js DEFAULT_SETTINGS)
 *   ctx.signal    AbortSignal — pass into http calls, bail out promptly
 *   ctx.log(msg)  progress logging, surfaces in the Source Health panel
 *   ctx.seedDir   absolute path to data/seed
 *   ctx.now       Date.now() at the start of this run
 *
 * SourceResult:
 *   {
 *     opportunities: Opportunity[],   // ALREADY passed through ctx.schema.normalize()
 *     status:        'ok'|'partial'|'failed'|'offline'|'disabled',
 *     notes:         string[],        // neutral facts ("1,842 pools after filtering")
 *     warnings:      string[],        // things the user should know went wrong
 *     fetchedAt:     ISO string,
 *   }
 *
 * HARD RULES
 * ----------
 * 1. Never throw from loadSeed(). Return {opportunities: [], status:'failed', warnings:[…]}.
 * 2. Every opportunity MUST come out of ctx.schema.normalize() so downstream code
 *    can assume the full shape. Set `source` to your adapter id.
 * 3. Rates are PERCENT. 4.25 means 4.25%. Convert APR->APY at the edge with
 *    ctx.schema.aprToApy() when the upstream quotes APR.
 * 4. Be tolerant of upstream shape drift: read fields defensively, skip records
 *    you cannot understand, and count skips in `notes`. One renamed field upstream
 *    must degrade this source, never crash the app.
 * 5. Mark bundled snapshot rows with `seed: true` and an honest `dataAsOf`. Seed
 *    data is a starting point, not a quote — the UI labels it as such.
 * 6. Set `confidence` deliberately when you know better than the default.
 * 7. Set `accessNotes` — how the user actually buys this thing. A yield they
 *    cannot access is noise.
 */

const REQUIRED_KEYS = ['id', 'label', 'assetClasses', 'fetch', 'loadSeed'];

function validateAdapter(a) {
  const problems = [];
  if (!a || typeof a !== 'object') return ['adapter is not an object'];
  for (const k of REQUIRED_KEYS) if (a[k] === undefined) problems.push(`missing "${k}"`);
  if (a.fetch && typeof a.fetch !== 'function') problems.push('fetch must be a function');
  if (a.loadSeed && typeof a.loadSeed !== 'function') problems.push('loadSeed must be a function');
  if (a.assetClasses && !Array.isArray(a.assetClasses)) problems.push('assetClasses must be an array');
  return problems;
}

/** Build a well-formed SourceResult, filling defaults. */
function result({ opportunities = [], status = 'ok', notes = [], warnings = [], fetchedAt = null } = {}) {
  return {
    opportunities: Array.isArray(opportunities) ? opportunities.filter(Boolean) : [],
    status,
    notes: notes.filter(Boolean),
    warnings: warnings.filter(Boolean),
    fetchedAt: fetchedAt || new Date().toISOString(),
  };
}

/** Wrap an adapter error into a failed SourceResult instead of letting it escape. */
function failure(err, extra = {}) {
  const msg = err?.status
    ? `HTTP ${err.status}${err.status === 403 || err.status === 407 ? ' (blocked by network policy)' : ''}: ${err.message}`
    : (err?.message || String(err));
  return result({ status: 'failed', warnings: [msg], ...extra });
}

/** Read a bundled seed JSON safely. Returns [] if anything is wrong with it. */
function readSeed(seedDir, filename) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const raw = fs.readFileSync(path.join(seedDir, filename), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { items: parsed, meta: {} };
    return { items: Array.isArray(parsed.items) ? parsed.items : [], meta: parsed.meta || {} };
  } catch {
    return { items: [], meta: {} };
  }
}

module.exports = { validateAdapter, result, failure, readSeed, REQUIRED_KEYS };
