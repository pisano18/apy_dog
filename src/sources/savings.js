'use strict';

const fs = require('node:fs');
const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * SAVINGS, CDs & MONEY MARKET — the boring end, where most people's cash lives.
 *
 * There is no free public API for retail deposit rates. The FDIC's API carries
 * institution metadata and insurance status but not one advertised APY; NCUA
 * publishes bulk quarterly files, not a live feed; and every rate aggregator
 * that does have the numbers sells them. So this source inverts the usual
 * adapter shape: the CURATED DATASET is the payload, and the network is used
 * only to confirm that the institutions behind it are real, insured, and still
 * open for business.
 *
 * That makes staleness the central design problem. Three defences:
 *   1. Every row carries an honest dataAsOf, so traps.js flags it as stale and
 *      schema.defaultConfidence decays it as the snapshot ages.
 *   2. Confidence is capped (see CURATED_CONFIDENCE) — a hand-maintained rate is
 *      never allowed to outrank a live quote from another source.
 *   3. The dataset is USER-EDITABLE. ctx.settings.userRatesPath points at a JSON
 *      file in the app's userData dir with the same shape as data/seed/savings.json.
 *      A row there with the same id replaces the bundled one (field by field, so
 *      {id, apy, dataAsOf} is a complete edit) and a new id is appended. That is
 *      how a user keeps their own rates current, and a refreshed dataAsOf on
 *      their row earns back the confidence the bundled snapshot has lost.
 *
 * What lives here: deposit accounts, certificates, and money market MUTUAL FUNDS
 * quoted on their 7-day SEC yield. Ultrashort bond ETFs are a different animal —
 * they have a floating NAV and can lose money — and belong in funds.js.
 */

const ID = 'savings';
const LABEL = 'Savings, CDs & Money Market';
const SEED_FILE = 'savings.json';
const FALLBACK_AS_OF = '2026-08-01';

/**
 * The ceiling on how much we trust a hand-maintained rate. Deposit rates change
 * without notice and this table is not a quote, so even a freshly-edited row
 * stays below a live market feed. The floor is whatever schema's age decay says,
 * so an untouched snapshot keeps sinking on its own.
 */
const CURATED_CONFIDENCE = 0.7;

const FDIC_API = 'https://banks.data.fdic.gov/api/institutions';
const FDIC_TTL_MS = 30 * 24 * 60 * 60 * 1000; // cert numbers change ~never
const FDIC_INSURED_LIMIT = 250000;            // per depositor, per bank, per ownership category

/**
 * Product kinds -> the taxonomy in constants.js. The differences that matter are
 * WHO CAN CHANGE THE RATE (administered vs contractual vs market) and WHAT IT
 * COSTS TO LEAVE (instant vs notice vs locked). Everything else is decoration.
 */
const KINDS = {
  savings: {
    assetClass: baseC.ASSET_CLASS.CASH,
    subType: 'hysa',
    yieldKind: baseC.YIELD_KIND.ADMINISTERED,
    liquidity: baseC.LIQUIDITY.INSTANT,
    payoutFrequency: 'monthly',
    compounding: 365,
    needsTerm: false,
  },
  money_market_fund: {
    assetClass: baseC.ASSET_CLASS.CASH,
    subType: 'money_market_fund',
    yieldKind: baseC.YIELD_KIND.MARKET,
    liquidity: baseC.LIQUIDITY.DAILY,
    payoutFrequency: 'monthly',
    compounding: 12,
    insurance: baseC.INSURANCE.SIPC,
    needsTerm: false,
  },
  cd: {
    assetClass: baseC.ASSET_CLASS.CD,
    subType: 'cd',
    yieldKind: baseC.YIELD_KIND.CONTRACTUAL,
    liquidity: baseC.LIQUIDITY.LOCKED,
    payoutFrequency: 'monthly',
    compounding: 365,
    needsTerm: true,
  },
  no_penalty_cd: {
    assetClass: baseC.ASSET_CLASS.CD,
    subType: 'no_penalty_cd',
    yieldKind: baseC.YIELD_KIND.CONTRACTUAL,
    // Not LOCKED: you can have the money, but only in full and only after the
    // opening window, so it is a notice account wearing a CD's clothes.
    liquidity: baseC.LIQUIDITY.NOTICE,
    payoutFrequency: 'monthly',
    compounding: 365,
    needsTerm: true,
  },
};

/**
 * A deposit rate outside this band is a data-entry error, not an opportunity —
 * 5 typed as 500, or an APY field holding a dollar balance. Reject it rather
 * than letting it top the table.
 */
const MIN_APY = 0;
const MAX_APY = 25;

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const appendNote = (existing, add) => (existing ? `${existing} ${add}` : add);

// ---------------------------------------------------------------------------
// Curated dataset: merge, then build. Both pure — no network, no clock.
// ---------------------------------------------------------------------------

/**
 * Merge the user's own rate file over the bundled dataset.
 *
 * Same id -> replaced, new id -> appended, bundled order preserved so the table
 * does not reshuffle when a user edits one row. The replacement is field-level
 * on purpose: the realistic edit is "Ally is 3.9% now", and demanding that the
 * user restage the URL, penalty schedule and access notes to change one number
 * guarantees the file rots.
 */
function mergeUserRates(seedItems, userItems) {
  const keyOf = (it) => String(it?.id ?? it?.name ?? '').trim().toLowerCase();
  const out = [];
  const at = new Map();

  const put = (item, origin) => {
    if (!item || typeof item !== 'object') return;
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

/** One curated item -> one normalized opportunity, or null if it is unusable. */
function buildRow(item, { dataAsOf, schema, C }) {
  if (!item || typeof item !== 'object') return null;

  const kind = KINDS[String(item.kind || '').trim()];
  if (!kind) return null;

  const apy = toNum(item.apy);
  if (apy === null || apy < MIN_APY || apy > MAX_APY) return null;

  const key = String(item.id ?? item.name ?? '').trim();
  const name = String(item.name ?? item.id ?? '').trim();
  if (!key || !name) return null;

  const termDays = toNum(item.termDays);
  if (kind.needsTerm && (termDays === null || termDays <= 0)) return null;

  const insurance = String(item.insurance || kind.insurance || C.INSURANCE.FDIC).toLowerCase();
  const insured = insurance === C.INSURANCE.FDIC || insurance === C.INSURANCE.NCUA;

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key,
    name,
    symbol: item.symbol || null,
    provider: item.provider || null,
    assetClass: kind.assetClass,
    subType: item.subType || kind.subType,
    region: 'US',
    currency: 'USD',

    apy: { total: apy },
    yieldKind: item.yieldKind || kind.yieldKind,
    payoutFrequency: item.payoutFrequency || kind.payoutFrequency,
    compounding: kind.compounding,

    term: {
      days: termDays,
      label: item.termLabel || null,
      earlyExitPenalty: item.earlyExitPenalty || null,
    },

    // A money market fund is a $1.00 NAV security, not a balance. Saying so is
    // what makes "it can break the buck" a fact on the row rather than a footnote.
    price: kind.subType === 'money_market_fund' ? 1 : null,
    minInvestment: toNum(item.minInvestment) ?? 0,
    maxInvestment: toNum(item.maxInvestment),
    expenseRatio: toNum(item.expenseRatio),

    liquidity: item.liquidity || kind.liquidity,
    risk: {
      insurance,
      // SIPC covers the broker failing, never the fund losing money, so it gets
      // no insured limit here — a number in that field would read as protection
      // this does not have.
      insuredLimit: insured ? (toNum(item.insuredLimit) ?? FDIC_INSURED_LIMIT) : null,
      principalAtRisk: !insured,
    },

    taxTreatment: item.taxTreatment || C.TAX_TREATMENT.ORDINARY,
    url: item.url || null,
    notes: item.notes || null,
    accessNotes: item.accessNotes || null,
    requirements: Array.isArray(item.requirements) ? item.requirements.map(String) : [],

    dataAsOf: item.dataAsOf || dataAsOf,
    // Nothing in this source is ever a live quote: the bundled rows are a
    // snapshot and the user's rows are whatever they last typed.
    live: false,
    seed: item.origin !== 'user',
  };

  const out = schema.normalize(row, { source: ID, seed: row.seed });
  if (!out) return null;

  // Curated confidence is a ceiling, not a floor: whichever is lower, our cap or
  // the age decay schema just applied, is the honest number.
  const cap = Number.isFinite(toNum(item.confidence)) ? toNum(item.confidence) : CURATED_CONFIDENCE;
  out.confidence = Number(Math.min(out.confidence ?? cap, cap).toFixed(3));
  return out;
}

/**
 * PURE ENTRY POINT: curated items -> opportunities.
 *
 * Also returns `lookups`, the map from opportunity id to the institution's legal
 * FDIC name, because the marketing brand on the row ("Marcus by Goldman Sachs")
 * is not what the FDIC register is keyed on ("Goldman Sachs Bank USA").
 */
function buildRows(items, ctx = {}) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const dataAsOf = ctx.dataAsOf || FALLBACK_AS_OF;

  const opportunities = [];
  const lookups = new Map();
  const seen = new Set();
  let skipped = 0;

  for (const item of Array.isArray(items) ? items : []) {
    let row = null;
    try {
      row = buildRow(item, { dataAsOf, schema, C });
    } catch {
      row = null; // one malformed row must never take the source down
    }
    if (!row || seen.has(row.id)) { skipped += 1; continue; }
    seen.add(row.id);
    opportunities.push(row);

    if (row.risk?.insurance === C.INSURANCE.FDIC) {
      // An explicit null fdicName means "do not look this up": a brokerage sweep
      // is not itself a bank, so a register search on its name can only ever
      // miss and would print a scary non-finding on a perfectly normal product.
      const explicit = item && Object.prototype.hasOwnProperty.call(item, 'fdicName');
      const legal = String((explicit ? item.fdicName : item?.provider) || '').trim();
      if (legal) lookups.set(row.id, legal);
    }
  }

  return { opportunities, lookups, skipped };
}

// ---------------------------------------------------------------------------
// FDIC verification — the one thing here that is actually machine-checkable
// ---------------------------------------------------------------------------

function fdicUrl(name) {
  const quoted = encodeURIComponent(`"${String(name).replace(/"/g, '')}"`);
  return `${FDIC_API}?filters=NAME:${quoted}&fields=NAME,CERT,ACTIVE&limit=1`;
}

/**
 * FDIC wraps each hit as {data:{...}, score:n}; older responses and some proxies
 * hand back the fields flat. Accept both, and treat a missing CERT as no match
 * rather than as a match with an unknown cert.
 */
function parseFdicInstitution(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const first = rows[0];
  const d = first?.data && typeof first.data === 'object' ? first.data : first;
  if (!d || typeof d !== 'object') return null;

  const cert = toNum(d.CERT ?? d.cert);
  if (cert === null || cert <= 0) return null;

  const activeRaw = d.ACTIVE ?? d.active;
  const active = activeRaw === undefined || activeRaw === null
    ? null
    : !(activeRaw === 0 || activeRaw === '0' || activeRaw === false || activeRaw === 'N');

  const name = d.NAME ?? d.name;
  return { name: name ? String(name).trim() : null, cert, active };
}

/**
 * PURE: fold verification results onto the rows. `byName` maps a legal name to
 * {cert, active} for a hit, or null for "looked it up, no match". Names absent
 * from `byName` were never checked and are left alone.
 *
 * A miss never strips the insurance claim. Bank brands, legal names and merger
 * history diverge constantly, so a name that does not match the register is far
 * more likely to be our string than an uninsured bank. An INACTIVE cert is the
 * opposite — that is a real, actionable signal that the institution is gone.
 */
function applyFdicVerification(opportunities, lookups, byName = {}) {
  const nameFor = (id) => (lookups instanceof Map ? lookups.get(id) : lookups?.[id]);
  const summary = { verified: 0, unmatched: [], inactive: [] };

  for (const o of Array.isArray(opportunities) ? opportunities : []) {
    const legal = nameFor(o?.id);
    if (!legal || !Object.prototype.hasOwnProperty.call(byName, legal)) continue;

    const hit = byName[legal];
    if (!hit) {
      summary.unmatched.push(legal);
      o.notes = appendNote(o.notes, `FDIC register has no exact match for "${legal}", so insurance is unverified here — check the bank's own disclosure.`);
      continue;
    }
    if (hit.active === false) {
      summary.inactive.push(legal);
      o.notes = appendNote(o.notes, `FDIC cert #${hit.cert} is marked INACTIVE — ${legal} has merged or closed. Find out who holds these deposits now before funding anything.`);
      continue;
    }
    summary.verified += 1;
    o.notes = appendNote(o.notes, `FDIC insured, certificate #${hit.cert} (${hit.name || legal}), confirmed against the FDIC register.`);
  }
  return summary;
}

/**
 * Look up each distinct institution, cached for a month.
 *
 * One name is probed first: if the FDIC API is blocked, down, or serving
 * something that is not JSON, there is no point firing twenty more requests at
 * it, and the whole point of the probe is to fail cheaply.
 */
async function verifyFdicNames(ctx, names) {
  const http = ctx.http || baseHttp;
  const cache = ctx.cache;
  const byName = {};
  const warnings = [];
  if (!names.length) return { byName, warnings, reachable: true };

  const lookup = async (name) => {
    const run = async () => parseFdicInstitution(await http.getJSON(fdicUrl(name), {
      signal: ctx.signal, timeout: 12000, retries: 1, concurrency: 3,
    }));
    if (!cache?.wrap) return run();
    const hit = await cache.wrap(`fdic:institution:${name.toLowerCase()}`, FDIC_TTL_MS, run);
    return hit?.value ?? null;
  };

  try {
    byName[names[0]] = await lookup(names[0]);
  } catch (err) {
    const status = err?.status ? `HTTP ${err.status}` : (err?.message || String(err));
    warnings.push(`FDIC insurance check unavailable (${status}). Rates below are user-maintained and were not verified against the FDIC register.`);
    return { byName: {}, warnings, reachable: false };
  }

  const rest = names.slice(1);
  const results = await Promise.all(rest.map(async (name) => {
    try { return [name, await lookup(name)]; } catch { return null; }
  }));
  let failed = 0;
  for (const r of results) {
    if (r) byName[r[0]] = r[1];
    else failed += 1;
  }
  if (failed) warnings.push(`${failed} of ${names.length} FDIC lookups failed; those rows are unverified.`);

  return { byName, warnings, reachable: true };
}

// ---------------------------------------------------------------------------
// The user's own rate file
// ---------------------------------------------------------------------------

/**
 * Read ctx.settings.userRatesPath. A file that is missing is the normal case and
 * says nothing; a file that is present but broken is a warning, because the user
 * edited it, believes their rates are live, and they are silently not.
 */
function readUserRates(filePath, readFile = fs.readFileSync) {
  if (!filePath) return { items: [], configured: false, warning: null };
  let raw;
  try {
    raw = readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], configured: true, warning: null };
    return { items: [], configured: true, warning: `Could not read your rates file (${filePath}): ${err?.message || err}` };
  }
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
    if (!items) {
      return { items: [], configured: true, warning: `Your rates file (${filePath}) has no "items" array, so nothing in it was used.` };
    }
    return { items, configured: true, warning: null };
  } catch (err) {
    return { items: [], configured: true, warning: `Your rates file (${filePath}) is not valid JSON, so your edits were ignored: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Adapter entry points
// ---------------------------------------------------------------------------

function collect(ctx, { verifyNames } = {}) {
  const schema = ctx?.schema || baseSchema;
  const C = ctx?.C || baseC;
  const { items: seedItems, meta } = contract.readSeed(ctx?.seedDir, SEED_FILE);
  const user = readUserRates(ctx?.settings?.userRatesPath);

  const merged = mergeUserRates(seedItems, user.items);
  const built = buildRows(merged, { schema, C, dataAsOf: meta?.dataAsOf || FALLBACK_AS_OF });

  // Rows the user maintains are the ones that came out non-seed; counting the
  // merged input instead would claim credit for rows that failed to build.
  const fromUser = built.opportunities.filter((o) => o.seed === false).length;
  const notes = [
    `${built.opportunities.length} curated deposit products (${fromUser} from your own rates file, ${built.opportunities.length - fromUser} bundled as of ${meta?.dataAsOf || FALLBACK_AS_OF}).`,
    'No free API publishes retail deposit APYs, so this list is hand-maintained. Edit it at Settings -> Open my rates file: same shape as data/seed/savings.json, a row with a matching id replaces the bundled one, a new id is added, and setting dataAsOf on a row you refresh raises how much the app trusts it.',
  ];
  if (built.skipped) notes.push(`${built.skipped} row(s) skipped — unknown kind, missing term, or an APY outside ${MIN_APY}-${MAX_APY}%.`);
  const ncua = built.opportunities.filter((o) => o.risk?.insurance === C.INSURANCE.NCUA).length;
  if (ncua) notes.push(`${ncua} credit union row(s) cannot be machine-verified: NCUA publishes bulk quarterly files, not a live API.`);

  const warnings = user.warning ? [user.warning] : [];
  if (verifyNames) {
    // Distinct names only — several products share one bank.
    const names = [...new Set(built.lookups.values())];
    return { built, notes, warnings, names, meta };
  }
  return { built, notes, warnings, names: [], meta };
}

async function fetchLive(ctx) {
  const { built, notes, warnings, names } = collect(ctx, { verifyNames: true });

  if (!built.opportunities.length) {
    return contract.result({
      status: 'failed',
      notes,
      warnings: warnings.concat('No usable rows in the bundled dataset or your rates file.'),
    });
  }

  ctx.log?.(`savings: ${built.opportunities.length} curated rows, verifying ${names.length} institutions with the FDIC`);
  const fdic = await verifyFdicNames(ctx, names);
  const summary = applyFdicVerification(built.opportunities, built.lookups, fdic.byName);

  if (summary.verified) notes.push(`FDIC register: ${summary.verified} institution row(s) confirmed insured and active.`);
  if (summary.unmatched.length) notes.push(`No FDIC name match for: ${[...new Set(summary.unmatched)].join(', ')}. Name mismatch is the usual cause, not a missing insurance.`);
  const allWarnings = warnings.concat(fdic.warnings);
  if (summary.inactive.length) allWarnings.push(`FDIC lists these as INACTIVE: ${[...new Set(summary.inactive)].join(', ')}.`);

  // "partial" is the honest ceiling whenever the only live check we have did not
  // run: the rates themselves were never live either way.
  const status = fdic.reachable && !summary.inactive.length ? 'ok' : 'partial';
  return contract.result({ opportunities: built.opportunities, status, notes, warnings: allWarnings });
}

async function fetch(ctx) {
  try {
    return await fetchLive(ctx || {});
  } catch (err) {
    return contract.failure(err);
  }
}

function loadSeed(ctx) {
  try {
    // The user's file is local, so it is just as available offline as the bundle.
    const { built, notes, warnings } = collect(ctx || {});
    if (!built.opportunities.length) {
      return contract.result({ status: 'failed', warnings: warnings.concat('Bundled savings dataset is missing or unreadable.') });
    }
    return contract.result({
      opportunities: built.opportunities,
      status: 'offline',
      notes: notes.concat('Insurance status was not verified — that check needs the FDIC API.'),
      warnings,
    });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Hand-curated US high-yield savings, CDs and money market funds, checked against the FDIC register and editable with your own rates file.',
  homepage: 'https://banks.data.fdic.gov/docs/',
  assetClasses: [baseC.ASSET_CLASS.CASH, baseC.ASSET_CLASS.CD],
  requiresNetwork: false,   // the dataset is local; the network only confirms insurance
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 12 * 60 * 60 * 1000,

  fetch,
  loadSeed,

  // Consumed by the tests, and by anything that wants the pure path.
  mergeUserRates,
  buildRows,
  buildRow,
  readUserRates,
  parseFdicInstitution,
  applyFdicVerification,
  fdicUrl,
  KINDS,
  CURATED_CONFIDENCE,
};
