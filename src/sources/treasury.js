'use strict';

const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * US TREASURY — the risk-free anchor.
 *
 * Everything else in this app is priced relative to what the government pays you
 * for the same money, so this adapter does double duty: it produces one
 * opportunity per tenor, and it exports getRiskFreeRate() which the aggregator
 * feeds into score.js / risk.js. If this source is dark the whole ranking is
 * still correct, just anchored to a default.
 *
 * Upstream is the daily par yield curve CSV. Two curves:
 *   - nominal (bills, notes, bonds)
 *   - real    (TIPS) — inflation-adjusted, NOT comparable head-to-head
 *
 * The column set changes between years (the 1.5-month and 4-month tenors were
 * added mid-history) and row order is not guaranteed, so we parse by header name
 * and sort by date rather than trusting position.
 */

const ID = 'treasury';
const LABEL = 'US Treasury';

const TYPE_NOMINAL = 'daily_treasury_yield_curve';
const TYPE_REAL = 'daily_treasury_real_yield_curve';

const RATES_PAGE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=';

const ACCESS_NOTES =
  'Buy new issues at auction with a noncompetitive bid on TreasuryDirect.gov ($100 minimum, no fee, $10M per auction cap), '
  + 'or buy existing issues on the secondary market through any brokerage. These are secondary-market constant-maturity '
  + 'yields, so an auction can clear a few basis points either side of the number shown.';

function csvUrl(year, type) {
  return 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
    + `${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;
}

// ---------------------------------------------------------------------------
// Pure parsing — no network, no clock. Everything below here is unit tested
// against a hand-authored fixture of the upstream CSV.
// ---------------------------------------------------------------------------

/**
 * Tenor headers are free text that has drifted over the years ("1 Mo", "1.5 Month",
 * "10 YR"). Parsing the number and unit out of whatever is there beats a lookup
 * table, because a tenor Treasury adds next year still lands correctly.
 */
const TENOR_RE = /^(\d+(?:\.\d+)?)\s*(months|month|mos|mo|years|year|yrs|yr|weeks|week|wks|wk)\b/i;

function parseTenor(header) {
  const m = TENOR_RE.exec(String(header || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2].toLowerCase()[0]; // m | y | w
  const days = u === 'w' ? Math.round(n * 7) : u === 'm' ? Math.round(n * 30.4375) : Math.round(n * 365.25);
  const unit = u === 'w' ? 'Week' : u === 'm' ? 'Month' : 'Year';
  return {
    days,
    label: `${n} ${unit}`,
    short: `${n}${u === 'w' ? 'W' : u === 'm' ? 'M' : 'Y'}`,
    slug: `${String(n).replace('.', '-')}-${u === 'w' ? 'wk' : u === 'm' ? 'mo' : 'yr'}`,
  };
}

/** Treasury publishes MM/DD/YYYY; accept ISO too rather than trusting one format. */
function parseCurveDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[%\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Raw CSV -> { dateISO, tenors[] } for the most recent row that actually has data.
 * Returns null for an empty file (which is what the current-year URL serves for
 * the first business days of January) or for anything that is not this CSV.
 */
function parseCurveCSV(csvText, parseCSV = baseHttp.parseCSV) {
  let rows;
  try {
    rows = parseCSV(String(csvText || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;

  const headers = Object.keys(rows[0] || {});
  const dateKey = headers.find((h) => /^date$/i.test(String(h).trim()));
  if (!dateKey) return null;

  const tenorCols = [];
  for (const h of headers) {
    const t = parseTenor(h);
    if (t) tenorCols.push({ header: h, ...t });
  }
  if (!tenorCols.length) return null;

  const dated = [];
  for (const row of rows) {
    const ts = parseCurveDate(row?.[dateKey]);
    if (ts === null) continue;
    const tenors = [];
    for (const col of tenorCols) {
      const rate = toNum(row?.[col.header]);
      // "N/A" and blanks are normal for tenors not published that day. A value
      // outside this band means a column moved and we are reading a price.
      if (rate === null || Math.abs(rate) > 25) continue;
      tenors.push({ days: col.days, label: col.label, short: col.short, slug: col.slug, rate });
    }
    if (tenors.length) dated.push({ ts, tenors });
  }
  if (!dated.length) return null;

  dated.sort((a, b) => b.ts - a.ts);
  const latest = dated[0];
  return { dateISO: new Date(latest.ts).toISOString(), tenors: latest.tenors };
}

/** Bills are 1 year and under, notes run 2-10 years, bonds are 20 and 30. */
function classify(days) {
  if (days <= 366) return 'bill';
  if (days <= 3700) return 'note';
  return 'bond';
}

const SUBTYPE_WORD = { bill: 'Bill', note: 'Note', bond: 'Bond' };

/**
 * One tenor -> one normalized opportunity.
 *
 * The rate goes in AS PUBLISHED. Treasury's par yield curve is already stated on
 * a coupon-equivalent (bond-equivalent) basis — it is not a discount rate. Do not
 * "fix" this by running it through schema.discountToApy(): that function is for
 * raw auction discount rates and applying it here would overstate every bill by
 * roughly the compounding it already contains.
 */
function makeRow(tenor, { curve, dataAsOf, seed, schema, C }) {
  const isReal = curve === 'real';
  const subType = isReal ? 'tips' : classify(tenor.days);
  const isCoupon = isReal || subType !== 'bill';

  const name = isReal
    ? `US Treasury ${tenor.label} TIPS — REAL yield`
    : `US Treasury ${tenor.label} ${SUBTYPE_WORD[subType]}`;

  const notes = isReal
    ? 'REAL (inflation-adjusted) yield. TIPS principal also accretes with CPI, so the nominal return is roughly this '
      + 'number plus realised inflation. Do not compare it head-to-head with the nominal curve above it.'
    : 'Nominal constant-maturity yield from the Treasury\'s daily par yield curve. Already quoted coupon-equivalent, '
      + 'so it is directly comparable with a bank APY.';

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: `${curve}-${tenor.slug}`,
    name,
    symbol: `${isReal ? 'TIPS' : 'UST'} ${tenor.short}`,
    provider: 'U.S. Department of the Treasury',
    assetClass: C.ASSET_CLASS.GOVT_BOND,
    subType,
    region: 'US',
    currency: 'USD',

    apy: { total: tenor.rate },
    yieldKind: C.YIELD_KIND.MARKET,
    payoutFrequency: isCoupon ? 'semiannual' : 'at maturity',
    compounding: isCoupon ? 2 : null,

    // Freely tradable at any time; term.days is what makes risk.js charge the
    // rate-sensitivity penalty on the long end, where a rate move really hurts.
    liquidity: C.LIQUIDITY.DAILY,
    term: { days: tenor.days, label: tenor.label },

    price: null,
    minInvestment: 100,

    risk: {
      insurance: C.INSURANCE.US_GOV,
      principalAtRisk: false,
    },

    taxTreatment: C.TAX_TREATMENT.TREASURY,
    url: RATES_PAGE + (isReal ? TYPE_REAL : TYPE_NOMINAL),
    notes,
    accessNotes: ACCESS_NOTES,
    requirements: ['TreasuryDirect account or any brokerage account'],
    dataAsOf,
    seed: !!seed,
  };

  // An official published rate is as good as a number gets, so live rows say so.
  // Seed rows deliberately leave confidence unset: schema's default decays it as
  // the bundled snapshot ages, which is exactly the right behaviour offline.
  if (!seed) row.confidence = 0.98;

  return schema.normalize(row, { source: ID, seed: !!seed });
}

/**
 * PURE ENTRY POINT: raw upstream CSV text -> opportunities.
 * `ctx` only supplies the schema/constants modules and (optionally) a CSV parser.
 */
function parseCurves({ nominalCsv = null, realCsv = null } = {}, ctx = {}) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const parseCSV = ctx.http?.parseCSV || baseHttp.parseCSV;

  const opportunities = [];
  const notes = [];
  const warnings = [];
  let dataAsOf = null;
  let skipped = 0;

  const curves = [
    { key: 'nominal', csv: nominalCsv, label: 'nominal' },
    { key: 'real', csv: realCsv, label: 'TIPS real' },
  ];

  for (const c of curves) {
    if (c.csv === null || c.csv === undefined) continue;
    const parsed = parseCurveCSV(c.csv, parseCSV);
    if (!parsed) {
      warnings.push(`${c.label} curve CSV had no usable rows.`);
      continue;
    }
    if (!dataAsOf || parsed.dateISO > dataAsOf) dataAsOf = parsed.dateISO;

    let made = 0;
    for (const tenor of parsed.tenors) {
      try {
        const row = makeRow(tenor, { curve: c.key, dataAsOf: parsed.dateISO, seed: false, schema, C });
        if (row) { opportunities.push(row); made += 1; } else skipped += 1;
      } catch {
        skipped += 1; // one malformed tenor must never take the source down
      }
    }
    notes.push(`${c.label} curve: ${made} tenors as of ${parsed.dateISO.slice(0, 10)}.`);
  }

  if (skipped) notes.push(`${skipped} tenor(s) skipped as unparseable.`);
  return { opportunities, notes, warnings, dataAsOf };
}

// ---------------------------------------------------------------------------
// Network path
// ---------------------------------------------------------------------------

/**
 * Fetch one curve for `year`, falling back to the prior year.
 *
 * The current-year file is genuinely empty for the first business days of
 * January, which is the case this exists for. A prior-year curve carries its own
 * (older) date as dataAsOf, so the staleness machinery in traps.js flags it
 * rather than us pretending it is today's number.
 */
async function loadCurveCsv(ctx, type, year, label, notes, warnings) {
  const http = ctx.http || baseHttp;
  for (const y of [year, year - 1]) {
    let text = null;
    try {
      text = await http.getText(csvUrl(y, type), { signal: ctx.signal, timeout: 25000, retries: 1 });
    } catch (err) {
      warnings.push(`${label} curve ${y}: ${err?.status ? `HTTP ${err.status}` : err?.message || String(err)}`);
      continue;
    }
    // Parse here only to decide whether the file has data; parseCurves re-parses
    // so the tested pure path is the one that actually builds the rows.
    if (parseCurveCSV(text, http.parseCSV)) {
      if (y !== year) notes.push(`${label} curve for ${year} was empty; used ${y}.`);
      return text;
    }
    notes.push(`${label} curve ${y} returned no rows.`);
  }
  return null;
}

async function fetchLive(ctx) {
  const notes = [];
  const warnings = [];
  const year = new Date(ctx?.now || Date.now()).getUTCFullYear();

  const [nominalCsv, realCsv] = await Promise.all([
    loadCurveCsv(ctx, TYPE_NOMINAL, year, 'nominal', notes, warnings),
    loadCurveCsv(ctx, TYPE_REAL, year, 'TIPS real', notes, warnings),
  ]);

  ctx.log?.(`treasury: nominal=${nominalCsv ? 'ok' : 'missing'} real=${realCsv ? 'ok' : 'missing'}`);

  const built = parseCurves({ nominalCsv, realCsv }, ctx);
  const allNotes = notes.concat(built.notes);
  const allWarnings = warnings.concat(built.warnings);

  if (!built.opportunities.length) {
    return contract.result({ status: 'failed', notes: allNotes, warnings: allWarnings.length ? allWarnings : ['Treasury curve returned nothing usable.'] });
  }
  // The nominal curve is the one the rest of the app leans on; TIPS alone is partial.
  const status = nominalCsv && realCsv ? 'ok' : 'partial';
  return contract.result({ opportunities: built.opportunities, status, notes: allNotes, warnings: allWarnings });
}

async function fetch(ctx) {
  try {
    return await fetchLive(ctx || {});
  } catch (err) {
    return contract.failure(err);
  }
}

// ---------------------------------------------------------------------------
// Seed path
// ---------------------------------------------------------------------------

function loadSeed(ctx) {
  try {
    const schema = ctx?.schema || baseSchema;
    const C = ctx?.C || baseC;
    const { items, meta } = contract.readSeed(ctx?.seedDir, 'treasury.json');
    const dataAsOf = meta?.dataAsOf || '2026-08-01';

    const opportunities = [];
    let skipped = 0;
    for (const item of items) {
      try {
        const tenor = parseTenor(item?.tenor);
        const rate = toNum(item?.rate);
        if (!tenor || rate === null) { skipped += 1; continue; }
        const curve = item?.curve === 'real' ? 'real' : 'nominal';
        const row = makeRow({ ...tenor, rate }, { curve, dataAsOf, seed: true, schema, C });
        if (row) opportunities.push(row); else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    if (!opportunities.length) {
      return contract.result({ status: 'failed', warnings: ['Bundled Treasury seed is missing or unreadable.'] });
    }
    const notes = [`Bundled Treasury curve snapshot, ${opportunities.length} tenors as of ${dataAsOf}. Refresh for live rates.`];
    if (skipped) notes.push(`${skipped} seed row(s) skipped as unparseable.`);
    return contract.result({ opportunities, status: 'offline', notes });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

// ---------------------------------------------------------------------------

/**
 * The app-wide risk-free rate, in percent, from this source's own result.
 *
 * 3-month bills are the convention: short enough that duration risk is noise,
 * long enough to be a real rate rather than an overnight print. If Treasury only
 * published a neighbouring short tenor that day we take the closest one within a
 * month; beyond that it stops being "the 3-month rate" and we return null so the
 * caller falls back to its own default.
 */
function getRiskFreeRate(result) {
  const list = Array.isArray(result?.opportunities) ? result.opportunities : [];
  let best = null;
  for (const o of list) {
    if (o?.source !== ID || o?.subType !== 'bill') continue;
    const rate = o?.apy?.total;
    const days = o?.term?.days;
    if (!Number.isFinite(rate) || !Number.isFinite(days)) continue;
    const distance = Math.abs(days - 91);
    if (distance > 30) continue;
    if (!best || distance < best.distance) best = { distance, rate };
  }
  return best ? best.rate : null;
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Official daily US Treasury par yield curve: bills, notes and bonds plus TIPS real yields. The risk-free anchor.',
  homepage: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-yield-curve-rates',
  assetClasses: [baseC.ASSET_CLASS.GOVT_BOND],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 6 * 60 * 60 * 1000, // published once per business day, ~3:30pm ET

  fetch,
  loadSeed,

  // Consumed by the aggregator, and by the tests.
  getRiskFreeRate,
  parseCurves,
  parseCurveCSV,
  parseTenor,
  csvUrl,
};
