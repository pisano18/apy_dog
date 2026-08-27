'use strict';

const { result, failure, readSeed } = require('./_contract');
const { makeEvent, EVENT_KIND } = require('../core/catalyst');

/**
 * SEC EDGAR — Filings & Disclosures
 *
 * This is the app's news feed, and it is deliberately not a news feed.
 *
 * An 8-K exists because something material happened and the company was legally
 * required to say so promptly, in a machine-readable form, with a timestamp the
 * issuer does not control. Nobody wrote it to get a click. That makes it better
 * signal than a headline about the same event, and it is the only free source of
 * corporate news that is structured, compelled and unspun.
 *
 * Like the calendar, this adapter produces EVENTS, not opportunities: a filing is
 * something that happened to a security, not a thing you can buy. The aggregator
 * attaches them to matching rows by symbol, which is what lets a stock row say
 * "filed an 8-K about a change of auditor yesterday" instead of nothing.
 *
 * The one rule that governs every string in this file: a filing is a FACT, its
 * market impact is NOT. Nothing here says a filing is good or bad news. The item
 * codes with unambiguous mechanical meaning — 3.01 delisting notice, 4.02
 * non-reliance, 1.03 bankruptcy — get a neutral factual sentence explaining what
 * the code means, because withholding that would be its own kind of dishonesty.
 * Everything else gets the plain-English name of the item and a link to the
 * primary document, so the user reads the company rather than a commentator.
 */

const ID = 'filings';
const LABEL = 'Filings & Disclosures';

/**
 * SEC blocks requests without a descriptive User-Agent carrying contact details.
 * This is their documented access condition, not an anti-bot workaround.
 */
const SEC_UA = 'APY Dog research tool (contact via github.com/pisano18/apy_dog)';

const CURRENT_FEED = 'https://www.sec.gov/cgi-bin/browse-edgar';
const SUBMISSIONS = 'https://data.sec.gov/submissions';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_EXCHANGE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';

const FEED_COUNT = 100;              // EDGAR's own maximum for getcurrent
const TICKER_TTL_MS = 24 * 60 * 60 * 1000;   // the CIK->ticker file barely moves
const FEED_TTL_MS = 10 * 60 * 1000;

/**
 * The live feed does not publish 8-K item codes, so a bounded number of the most
 * recent filers get a follow-up call to data.sec.gov for them. Bounded because
 * this is a per-company endpoint and the alternative is one request per filer,
 * which is exactly the pattern this codebase refuses to write. Ten calls at
 * SEC's 10/sec ceiling is under two seconds; a hundred would be a loop.
 */
const DEFAULT_ITEM_LOOKUPS = 10;
const DEFAULT_HISTORY_SYMBOLS = 6;   // deepen the user's own tickers, not the market
const HISTORY_LOOKBACK_DAYS = 120;
const HISTORY_MAX_PER_COMPANY = 25;
const SEC_CALL_GAP_MS = 130;         // ~7.7 req/s, comfortably under SEC's 10/s

const MAX_ENTRIES = 2000;            // a runaway feed must not become a runaway loop

const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every timestamp in this file goes through here.
 *
 * Date only spans +/-8.64e15 ms, and a feed handing over seconds where we expect
 * milliseconds sails past Number.isFinite and then throws RangeError out of
 * toISOString. That has taken down adapters in this codebase before, so the
 * range check is not optional and lives in one place.
 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  let t;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // A bare epoch in seconds is the single most common upstream unit mistake.
    t = Math.abs(v) < 1e12 ? v * 1000 : v;
  } else {
    t = Date.parse(String(v));
  }
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return null;
  return t;
}

/** Safe ISO string, or null. Never throws, which is the entire point. */
function isoOrNull(ms) {
  const t = toMs(ms);
  if (t === null) return null;
  try { return new Date(t).toISOString(); } catch { return null; }
}

/** CIKs are zero-padded to ten digits everywhere in EDGAR; bare integers 404. */
function padCik(v) {
  const n = num(v);
  if (n === null || n < 0) return null;
  return String(Math.round(n)).padStart(10, '0');
}

// ---------------------------------------------------------------------------
// 8-K ITEM CODES
// ---------------------------------------------------------------------------

/**
 * What an 8-K actually says.
 *
 * This map is the most valuable thing in the adapter. "Company X filed an 8-K"
 * is nearly content-free — companies file them constantly. "Company X filed
 * under item 4.02" means the company has told the SEC its own past financial
 * statements should not be relied upon, and that is a fundamentally different
 * piece of information from item 9.01, which means it attached an exhibit.
 *
 * `magnitude` is 0-1 and is a SEVERITY weight, not a direction and not a return.
 * It exists so the UI never dresses up a routine exhibit filing as drama, and
 * never buries a restatement underneath one. The numbers are ordinal judgements
 * about how much a category of disclosure typically changes what is known about
 * a company — they are conventions, shown to the user, not fitted parameters.
 *
 * `note` is present only where the code has an unambiguous mechanical meaning
 * that a reader would otherwise have to look up. It states what the code means
 * and stops there.
 */
const ITEM_MEANINGS = {
  // Section 1 — business and operations
  '1.01': { label: 'entry into a material agreement', magnitude: 0.42 },
  '1.02': { label: 'termination of a material agreement', magnitude: 0.48 },
  '1.03': {
    label: 'bankruptcy or receivership',
    magnitude: 1,
    note: 'Item 1.03 is filed when a company enters bankruptcy or receivership.',
  },
  '1.04': { label: 'mine safety disclosures', magnitude: 0.3 },
  '1.05': { label: 'a material cybersecurity incident', magnitude: 0.68 },

  // Section 2 — financial information
  '2.01': { label: 'completion of an acquisition or disposition of assets', magnitude: 0.62 },
  '2.02': { label: 'results of operations (earnings)', magnitude: 0.6 },
  '2.03': { label: 'a new material debt obligation', magnitude: 0.38 },
  '2.04': {
    label: 'a triggering event that accelerates a debt obligation',
    magnitude: 0.78,
    note: 'Item 2.04 means a condition in an existing debt agreement has been tripped, accelerating or increasing what is owed.',
  },
  '2.05': { label: 'costs associated with an exit or disposal', magnitude: 0.45 },
  '2.06': { label: 'a material impairment', magnitude: 0.65 },

  // Section 3 — securities and trading markets
  '3.01': {
    label: 'notice of delisting or failure to satisfy a continued listing standard',
    magnitude: 0.92,
    note: 'Item 3.01 means the exchange has notified the company that it is out of compliance with a continued-listing rule. It is a notice, not a delisting.',
  },
  '3.02': { label: 'an unregistered sale of equity securities (dilution)', magnitude: 0.5 },
  '3.03': { label: 'a material modification to the rights of security holders', magnitude: 0.46 },

  // Section 4 — accountants and financial statements
  '4.01': { label: 'a change of certifying accountant', magnitude: 0.62 },
  '4.02': {
    label: 'non-reliance on previously issued financial statements',
    magnitude: 1,
    note: 'Item 4.02 means the company has stated that previously issued financial statements should no longer be relied upon.',
  },

  // Section 5 — governance and management
  '5.01': { label: 'a change in control of the registrant', magnitude: 0.85 },
  '5.02': { label: 'the departure or appointment of a director or officer', magnitude: 0.5 },
  '5.03': { label: 'an amendment to the charter or bylaws, or a change of fiscal year', magnitude: 0.22 },
  '5.04': { label: 'a temporary trading suspension under employee benefit plans', magnitude: 0.24 },
  '5.05': { label: 'an amendment to, or waiver of, the code of ethics', magnitude: 0.26 },
  '5.06': { label: 'a change in shell company status', magnitude: 0.55 },
  '5.07': { label: 'the results of a shareholder vote', magnitude: 0.16 },
  '5.08': { label: 'shareholder director nominations', magnitude: 0.2 },

  // Section 6 — asset-backed securities
  '6.01': { label: 'ABS informational and computational material', magnitude: 0.14 },
  '6.02': { label: 'a change of servicer or trustee', magnitude: 0.35 },
  '6.03': { label: 'a change in credit enhancement or external support', magnitude: 0.42 },
  '6.04': {
    label: 'failure to make a required distribution',
    magnitude: 0.82,
    note: 'Item 6.04 means a scheduled distribution to security holders was not made.',
  },
  '6.05': { label: 'a Securities Act updating disclosure', magnitude: 0.14 },

  // Sections 7-9 — disclosure and housekeeping
  '7.01': { label: 'a Regulation FD disclosure', magnitude: 0.28 },
  '8.01': { label: 'other events the company chose to disclose', magnitude: 0.22 },
  '9.01': { label: 'financial statements and exhibits (a routine attachment)', magnitude: 0.05 },
};

/** Anything at or below this is housekeeping and must never be presented as news. */
const ROUTINE_MAGNITUDE = 0.1;

/**
 * Pull item codes out of whatever EDGAR hands over.
 *
 * The submissions API gives a comma-joined string ("2.02,9.01"); some feeds give
 * an array; some give prose with the codes embedded. All three are read the same
 * way, and anything unreadable produces an empty list rather than an exception.
 */
function parseItemCodes(items) {
  const source = Array.isArray(items) ? items.join(',') : items;
  const text = str(source);
  if (!text) return [];
  const found = text.match(/\b\d\.\d{2}\b/g) || [];
  const out = [];
  for (const code of found) {
    if (!out.includes(code)) out.push(code);
    if (out.length >= 24) break;             // a filing with 24 items is already an outlier
  }
  return out;
}

/**
 * Everything the item codes tell us, in one object.
 *
 * `magnitude` takes the MAXIMUM rather than a sum or an average: an 8-K filed
 * under 4.02 and 9.01 is a restatement with an exhibit attached, not the average
 * of a restatement and an exhibit. The most serious disclosure in the filing is
 * what the filing is about.
 */
function summariseItems(items) {
  const codes = parseItemCodes(items);
  const known = codes.filter((c) => ITEM_MEANINGS[c]);
  const unknown = codes.filter((c) => !ITEM_MEANINGS[c]);

  let magnitude = null;
  let headline = null;
  for (const c of known) {
    const m = ITEM_MEANINGS[c].magnitude;
    if (!Number.isFinite(m)) continue;
    if (magnitude === null || m > magnitude) { magnitude = m; headline = ITEM_MEANINGS[c].label; }
  }

  const parts = codes.map((c) => (ITEM_MEANINGS[c] ? ITEM_MEANINGS[c].label : `item ${c}, which this app does not recognise`));
  const notes = known.map((c) => ITEM_MEANINGS[c].note).filter(Boolean);

  let sentence = null;
  if (codes.length) {
    sentence = `8-K item${codes.length > 1 ? 's' : ''} ${codes.join(', ')} — ${parts.join('; ')}.`;
    if (notes.length) sentence += ` ${notes.join(' ')}`;
  }

  return {
    codes,
    known,
    unknown,
    magnitude,
    headline,
    notes,
    sentence,
    routine: magnitude !== null && magnitude <= ROUTINE_MAGNITUDE,
  };
}

/** The required export: one readable sentence, or null when no codes were given. */
function describeItems(items) {
  return summariseItems(items).sentence;
}

// ---------------------------------------------------------------------------
// FORM -> EVENT KIND
// ---------------------------------------------------------------------------

/**
 * Only forms whose meaning we can state plainly get an event.
 *
 * 13G is deliberately absent: it looks like 13D and means the opposite — a
 * passive holder with no intent to influence the company. Mapping it onto the
 * activist event kind would put a false story on the row.
 */
function eventKindForForm(form) {
  const f = str(form);
  if (!f) return null;
  const base = f.toUpperCase().replace(/\/A$/, '').trim();
  if (base === '8-K' || base === '8-K12B' || base === '8-K12G3' || base === '8-K15D5') return EVENT_KIND.FILING_8K;
  if (base === 'S-1' || base === 'F-1') return EVENT_KIND.FILING_S1;
  if (base === 'SC 13D' || base === 'SC13D') return EVENT_KIND.FILING_13D;
  return null;
}

/** True for amendments, which restate an earlier filing rather than break news. */
function isAmendment(form) {
  return /\/A\s*$/i.test(str(form) || '');
}

// ---------------------------------------------------------------------------
// PURE PARSERS — no network, no filesystem, no clock beyond what is passed in
// ---------------------------------------------------------------------------

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
};

/** EDGAR double-escapes the summary block, so decoding runs before parsing it. */
function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d{1,7});/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/**
 * First value of an XML tag inside a block.
 *
 * Stricter about tag boundaries than http.xmlTagValues: that one would let an
 * opening <identifier> start a match for "id". Atom feeds do not currently
 * contain such a tag, but a feed we do not control is not the place to rely on
 * that staying true.
 */
function firstTag(block, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, 'i');
  const m = re.exec(String(block || ''));
  return m ? m[1].trim() : null;
}

/**
 * "8-K - Apple Inc. (0000320193) (Filer)" -> its four parts.
 *
 * Read from the RIGHT rather than by splitting on separators: company names
 * legitimately contain hyphens, commas and parentheses ("Alphabet Inc.",
 * "Bausch + Lomb", "Coca-Cola Consolidated, Inc."), so the parenthesised CIK is
 * the only reliable anchor in the string.
 */
function parseFilingTitle(title) {
  const raw = decodeEntities(str(title) || '');
  if (!raw) return null;

  const dash = raw.indexOf(' - ');
  if (dash <= 0) return null;
  const form = raw.slice(0, dash).trim();
  let rest = raw.slice(dash + 3).trim();
  if (!form || !rest) return null;

  // Optional trailing role: "(Filer)" / "(Subject)" / "(Filed by)".
  //
  // Only stripped when it is a role EDGAR actually uses, or when removing it
  // exposes a CIK underneath. A company legitimately named "... (Delaware)"
  // must keep its parenthetical rather than have it silently eaten.
  const CIK_TAIL = /\((\d{4,10})\)\s*$/;
  let role = null;
  const roleMatch = /\(([A-Za-z][A-Za-z ]{2,20})\)\s*$/.exec(rest);
  if (roleMatch) {
    const known = /^(?:filer|subject|filed by|reporting|issuer)$/i.test(roleMatch[1].trim());
    const head = rest.slice(0, roleMatch.index).trim();
    if (known || CIK_TAIL.test(head)) {
      role = roleMatch[1].trim();
      rest = head;
    }
  }

  // The last parenthesised run of digits is the CIK.
  let cik = null;
  const cikMatch = CIK_TAIL.exec(rest);
  if (cikMatch) {
    cik = padCik(cikMatch[1]);
    rest = rest.slice(0, cikMatch.index).trim();
  }

  const company = rest.replace(/[\s,-]+$/, '').trim();
  if (!company) return null;
  return { form, company, cik, role };
}

/** "<b>Filed:</b> 2026-07-31 <b>AccNo:</b> 0000320193-26-000075 <b>Size:</b> 1 MB" */
function parseSummary(summary) {
  const text = decodeEntities(str(summary) || '').replace(/<[^>]*>/g, ' ');
  const acc = /\b(\d{10}-\d{2}-\d{6})\b/.exec(text);
  const filed = /Filed:\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
  const size = /Size:\s*([\d.,]+\s*[KMG]?B)/i.exec(text);
  // Some feed variants do carry item codes in the summary. Read them if present
  // and say nothing if not, rather than pretending the field exists.
  const items = /Items?:?\s*((?:\d\.\d{2}[,;\s]*)+)/i.exec(text);
  return {
    accession: acc ? acc[1] : null,
    filed: filed ? filed[1] : null,
    size: size ? size[1].trim() : null,
    items: items ? items[1].trim() : null,
  };
}

/**
 * EDGAR getcurrent Atom feed -> flat entry records.
 *
 * One call returns up to a hundred filings across every issuer in the market,
 * which is why this is the primary path: the whole market for the price of one
 * request. Malformed entries are counted and skipped, never thrown.
 */
function parseAtom(xml, opts = {}) {
  const dropped = { unparseable: 0, noTitle: 0, noDate: 0, unknownForm: 0 };
  const entries = [];
  const text = typeof xml === 'string' ? xml : '';
  if (!text || !/<entry[\s>]/i.test(text)) {
    return { entries, dropped, feedTitle: null, empty: true };
  }

  const feedHead = text.slice(0, text.search(/<entry[\s>]/i));
  const feedTitle = firstTag(feedHead, 'title');

  const blocks = text.match(/<entry\b[\s\S]*?<\/entry\s*>/gi) || [];
  for (const block of blocks.slice(0, MAX_ENTRIES)) {
    try {
      const parsedTitle = parseFilingTitle(firstTag(block, 'title'));
      if (!parsedTitle) { dropped.noTitle += 1; continue; }

      const summary = parseSummary(firstTag(block, 'summary'));

      // Prefer <updated> (the acceptance timestamp, to the second) over the
      // summary's filing date, which is a calendar day and loses the ordering
      // that makes a live feed worth reading.
      const filedMs = toMs(firstTag(block, 'updated')) ?? toMs(summary.filed);
      if (filedMs === null) { dropped.noDate += 1; continue; }

      const href = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i.exec(block);
      const idTag = firstTag(block, 'id') || '';
      const accFromId = /accession-number=([\d-]+)/i.exec(idTag);

      // Form type also appears as a <category term="8-K">; trust the title first
      // and fall back, since the two have disagreed on amendment suffixes.
      const category = /<category\b[^>]*\bterm\s*=\s*["']([^"']+)["'][^>]*>/i.exec(block);
      const itemsCategory = /<category\b[^>]*\blabel\s*=\s*["'](?:8-K )?items?["'][^>]*\bterm\s*=\s*["']([^"']+)["']/i.exec(block);

      entries.push({
        via: 'feed',
        form: parsedTitle.form || (category ? decodeEntities(category[1]) : null),
        company: parsedTitle.company,
        cik: parsedTitle.cik,
        role: parsedTitle.role,
        symbol: null,
        items: summary.items || (itemsCategory ? decodeEntities(itemsCategory[1]) : null),
        accession: summary.accession || (accFromId ? accFromId[1] : null),
        filedMs,
        url: href ? decodeEntities(href[1]) : null,
        size: summary.size,
      });
    } catch {
      // A single mangled entry is not a reason to lose the other ninety-nine.
      dropped.unparseable += 1;
    }
  }

  return { entries, dropped, feedTitle, empty: false };
}

/**
 * data.sec.gov submissions -> array of filing objects.
 *
 * The `recent` block is COLUMNAR: a dozen parallel arrays rather than an array
 * of records. The arrays are supposed to be the same length and in practice are
 * not always — a column added mid-stream, or a truncated response, produces
 * ragged input, and zipping to the shortest silently loses real filings while
 * zipping blindly produces records made of undefined.
 *
 * So: zip to the LONGEST column so no filing is lost, null-fill the short ones,
 * report which columns were short, and drop only records that have neither an
 * accession number nor a form — the two fields without which a row means nothing.
 */
function zipFilings(recent) {
  const empty = { rows: [], ragged: [], columns: [], length: 0, dropped: 0 };
  if (!recent || typeof recent !== 'object' || Array.isArray(recent)) return empty;

  const columns = [];
  let length = 0;
  for (const [key, value] of Object.entries(recent)) {
    if (!Array.isArray(value)) continue;          // scalars and objects are not columns
    columns.push(key);
    if (value.length > length) length = value.length;
  }
  if (!columns.length || !length) return { ...empty, columns };

  const ragged = columns
    .filter((k) => recent[k].length < length)
    .map((k) => ({ column: k, length: recent[k].length }));

  const rows = [];
  let dropped = 0;
  for (let i = 0; i < length; i += 1) {
    const row = {};
    for (const k of columns) {
      const v = recent[k][i];
      row[k] = v === undefined ? null : v;
    }
    if (!str(row.accessionNumber) && !str(row.form)) { dropped += 1; continue; }
    rows.push(row);
  }

  return { rows, ragged, columns, length, dropped };
}

/** Direct link to the primary document, which is what the user wants to read. */
function archiveUrl(cik, accession, primaryDocument) {
  const c = num(cik);
  const acc = str(accession);
  if (c === null || !acc) return null;
  const bare = acc.replace(/-/g, '');
  if (!/^\d{18}$/.test(bare)) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${Math.round(c)}/${bare}`;
  const doc = str(primaryDocument);
  return doc ? `${base}/${doc}` : `${base}/${acc}-index.htm`;
}

/** The issuer's own EDGAR filing list. Accepts a ticker or a CIK, both work. */
function edgarCompanyUrl(cikOrTicker, form) {
  const who = str(cikOrTicker);
  if (!who) return 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent';
  const type = form ? `&type=${encodeURIComponent(String(form).replace(/\/A$/, ''))}` : '';
  return `${CURRENT_FEED}?action=getcompany&CIK=${encodeURIComponent(who)}${type}&dateb=&owner=include&count=40`;
}

/**
 * Best available link, in descending order of usefulness: the exact document,
 * the filing index, then the issuer's filing list. Never a fabricated deep link
 * — a URL that 404s or, worse, resolves to an unrelated filing is worse than the
 * company page that definitely works.
 */
function filingUrl(entry) {
  if (!entry) return null;
  const direct = str(entry.url);
  if (direct && /^https:\/\/(?:www\.)?sec\.gov\//i.test(direct)) return direct;
  const built = archiveUrl(entry.cik, entry.accession, entry.primaryDocument);
  if (built) return built;
  return edgarCompanyUrl(entry.symbol || entry.cik, entry.form);
}

/**
 * One accession number is one filing, but the getcurrent feed emits an entry per
 * associated CIK — a 13D produces one for the investor who filed it and one for
 * the company it is about. The company is the one the user holds, so for 13Ds
 * the subject wins; for everything else the filer is the registrant and wins.
 */
function dedupeEntries(entries) {
  const best = new Map();
  const loose = [];
  let merged = 0;

  const preference = (e) => {
    const role = (str(e.role) || '').toLowerCase();
    const wantsSubject = eventKindForForm(e.form) === EVENT_KIND.FILING_13D;
    if (wantsSubject) return role.startsWith('subject') ? 2 : role.startsWith('filed') || role.startsWith('filer') ? 1 : 0;
    return role.startsWith('filer') ? 2 : role.startsWith('subject') ? 0 : 1;
  };

  for (const e of entries) {
    const acc = str(e?.accession);
    if (!acc) { loose.push(e); continue; }
    const cur = best.get(acc);
    if (!cur) { best.set(acc, e); continue; }
    merged += 1;
    if (preference(e) > preference(cur)) best.set(acc, e);
  }

  return { entries: [...best.values(), ...loose], merged };
}

/**
 * Entries -> catalyst events.
 *
 * Pure: the clock arrives as opts.now and nothing here touches the network. The
 * live feed, the per-company history and the bundled snapshot all converge on
 * this one function, so there is exactly one place where a filing turns into
 * something the user reads.
 */
function buildEvents(entries, opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const tickerByCik = opts.tickerByCik instanceof Map ? opts.tickerByCik : new Map();
  const seed = !!opts.seed;
  const dropped = { unknownForm: 0, noDate: 0, badEvent: 0, absurdDate: 0, unparseable: 0 };
  const events = [];
  const withItems = new Set();
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      if (!entry || typeof entry !== 'object') { dropped.unparseable += 1; continue; }

      const kind = eventKindForForm(entry.form);
      if (!kind) { dropped.unknownForm += 1; continue; }

      const filedMs = toMs(entry.filedMs ?? entry.filed ?? entry.date);
      if (filedMs === null) { dropped.noDate += 1; continue; }

      // A filing cannot be accepted a year from now. Something that claims to be
      // is a unit or parse error, not news, and it would sit at the top of a
      // calendar sorted by date forever.
      if (filedMs - nowMs > 365 * 86400000) { dropped.absurdDate += 1; continue; }

      const cik = padCik(entry.cik);
      const symbol = str(entry.symbol)?.toUpperCase()
        || (cik ? str(tickerByCik.get(cik)?.ticker) : null)
        || null;
      const company = str(entry.company) || (cik ? str(tickerByCik.get(cik)?.name) : null) || symbol || 'An SEC registrant';

      const built = describeFiling(entry, { kind, company, symbol });
      if (built.hasItems) withItems.add(entry.accession || `${cik}:${filedMs}`);

      const event = makeEvent({
        kind,
        date: filedMs,
        title: built.title,
        text: built.text,
        symbol,
        url: filingUrl({ ...entry, cik, symbol }),
        source: ID,
        // A filing is a published fact with a published timestamp. There is
        // nothing estimated about it, whatever its consequences turn out to be.
        certainty: 'confirmed',
        magnitude: built.magnitude,
      }, nowMs);

      if (!event) { dropped.badEvent += 1; continue; }

      // The same filing can arrive from the live feed and the per-company
      // history in one run. Identity is the accession number when we have it.
      const key = str(entry.accession) || `${kind}:${symbol || cik || company}:${Math.round(filedMs / 60000)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      event.form = str(entry.form);
      event.cik = cik;
      event.company = company;
      event.items = built.codes;
      event.itemsKnown = built.hasItems;
      event.via = str(entry.via);
      event.routine = built.routine;
      event.seed = seed;
      events.push(event);
    } catch {
      dropped.unparseable += 1;
    }
  }

  events.sort((a, b) => b.dateMs - a.dateMs);
  return { events, dropped, withItems: withItems.size };
}

/**
 * The two strings the user actually reads.
 *
 * Written so that nothing implies a direction. "Filed an 8-K under item 2.02"
 * is a fact; "reported strong earnings" would be a claim this adapter has no
 * basis for and will never make.
 */
function describeFiling(entry, { kind, company, symbol }) {
  const form = str(entry.form) || '';
  const amended = isAmendment(form);
  const who = symbol ? `${company} (${symbol})` : company;

  if (kind === EVENT_KIND.FILING_8K) {
    const s = summariseItems(entry.items);
    const hasItems = s.codes.length > 0;
    const title = hasItems ? `${who} — ${s.headline || `8-K item ${s.codes[0]}`}` : `${who} — ${form || '8-K'} filed`;
    const lead = amended
      ? `${form} amends an 8-K this company already filed, so it revises an earlier disclosure rather than making a new one.`
      : 'An 8-K is filed when something material happens that the company must disclose promptly.';
    // Two different reasons an 8-K can arrive without item codes, and saying the
    // wrong one is a small lie about our own data: the getcurrent feed genuinely
    // does not carry them, whereas the submissions API does and this filing
    // simply left the field blank.
    const detail = hasItems
      ? s.sentence
      : entry.via === 'feed'
        ? 'The live EDGAR feed does not publish item codes, so what this filing covers is only in the document itself.'
        : 'No item codes were published with this filing, so what it covers is only in the document itself.';
    return {
      title,
      text: `${lead} ${detail} Read the filing rather than a summary of it.`,
      magnitude: s.magnitude,
      codes: s.codes,
      hasItems,
      routine: s.routine,
    };
  }

  if (kind === EVENT_KIND.FILING_S1) {
    return {
      title: `${who} — registration statement on Form ${form || 'S-1'}`,
      text: `Form ${form || 'S-1'} registers securities to be offered for sale. The filing states how many shares, `
        + 'at what price range, and whether the company or existing holders are the ones selling. Those three facts '
        + 'decide what it means, and all three are in the document.',
      magnitude: amended ? 0.35 : 0.45,
      codes: [],
      hasItems: false,
      routine: false,
    };
  }

  // 13D
  return {
    title: `${who} — Schedule 13D filed by a holder above 5%`,
    text: 'A Schedule 13D is filed by someone who has crossed 5% of a class of shares and does NOT claim to be a '
      + 'passive investor. The filing names the holder, the size of the stake and, in Item 4, what they say they '
      + 'intend to do about it.',
    magnitude: amended ? 0.45 : 0.6,
    codes: [],
    hasItems: false,
    routine: false,
  };
}

/**
 * Submissions payload -> entries in the same shape parseAtom produces.
 *
 * This is the only path that reliably carries 8-K item codes, which is why it
 * exists at all despite being one request per company.
 */
function parseSubmissions(payload, opts = {}) {
  const dropped = { unparseable: 0, tooOld: 0, unknownForm: 0 };
  if (!payload || typeof payload !== 'object') {
    return { entries: [], dropped: { ...dropped, unparseable: 1 }, company: null, symbol: null, cik: null, ragged: [] };
  }

  const cik = padCik(payload.cik);
  const company = str(payload.name);
  const tickers = Array.isArray(payload.tickers) ? payload.tickers.map(str).filter(Boolean) : [];
  const symbol = str(opts.symbol)?.toUpperCase() || (tickers[0] ? tickers[0].toUpperCase() : null);

  const zipped = zipFilings(payload?.filings?.recent);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lookback = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : HISTORY_LOOKBACK_DAYS;
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : HISTORY_MAX_PER_COMPANY;
  const wanted = opts.forms instanceof Set ? opts.forms : null;

  const entries = [];
  for (const row of zipped.rows) {
    try {
      const form = str(row.form);
      if (!eventKindForForm(form)) { dropped.unknownForm += 1; continue; }
      if (wanted && !wanted.has(String(form).toUpperCase().replace(/\/A$/, ''))) { dropped.unknownForm += 1; continue; }

      // acceptanceDateTime is the real timestamp; filingDate is a calendar day.
      const filedMs = toMs(row.acceptanceDateTime) ?? toMs(row.filingDate);
      if (filedMs === null) { dropped.unparseable += 1; continue; }
      if (Number.isFinite(lookback) && lookback > 0 && nowMs - filedMs > lookback * 86400000) {
        dropped.tooOld += 1;
        continue;
      }

      entries.push({
        via: 'submissions',
        form,
        company,
        cik,
        symbol,
        role: 'Filer',
        items: str(row.items),
        accession: str(row.accessionNumber),
        primaryDocument: str(row.primaryDocument),
        filedMs,
        url: null,
      });
      if (entries.length >= max) break;
    } catch {
      dropped.unparseable += 1;
    }
  }

  return { entries, dropped, company, symbol, cik, ragged: zipped.ragged, scanned: zipped.rows.length };
}

/**
 * CIK -> ticker.
 *
 * equities.js already knows how to read the SEC ticker file in all three shapes
 * it ships in, so reuse that rather than maintaining a second parser that drifts.
 * If equities is absent or broken this degrades to a local reader, and if that
 * fails too the events simply carry no symbol — which costs the row attachment,
 * not the feed.
 */
function buildCikIndex(payload) {
  const index = new Map();
  const add = (cik, ticker, name, exchange) => {
    const c = padCik(cik);
    const t = str(ticker)?.toUpperCase();
    if (!c || !t) return;
    if (index.has(c)) return;     // first listed class wins (BRK-A before BRK-B)
    index.set(c, { ticker: t, name: str(name), exchange: str(exchange) });
  };

  try {
    const equities = require('./equities');
    if (typeof equities?.parseTickerIndex === 'function') {
      const parsed = equities.parseTickerIndex(payload, { limit: 100000 });
      for (const r of parsed?.records || []) add(r.cik, r.ticker, r.name, r.exchange);
      if (index.size) return index;
    }
  } catch {
    // equities.js is a convenience here, never a dependency.
  }

  try {
    if (payload && Array.isArray(payload.data) && Array.isArray(payload.fields)) {
      const f = payload.fields.map((x) => String(x || '').toLowerCase());
      const iCik = f.indexOf('cik');
      const iTicker = f.indexOf('ticker');
      const iName = f.findIndex((x) => x === 'name' || x === 'title');
      const iExch = f.indexOf('exchange');
      for (const row of payload.data) {
        if (!Array.isArray(row)) continue;
        add(row[iCik], row[iTicker], iName >= 0 ? row[iName] : null, iExch >= 0 ? row[iExch] : null);
      }
    } else {
      const rows = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? Object.values(payload) : []);
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        add(r.cik_str ?? r.cik ?? r.CIK, r.ticker ?? r.Ticker, r.title ?? r.name ?? r.Title, r.exchange ?? r.Exchange);
      }
    }
  } catch {
    return index;
  }
  return index;
}

// ---------------------------------------------------------------------------
// NETWORK
// ---------------------------------------------------------------------------

const secHeaders = () => ({ 'User-Agent': SEC_UA, Accept: 'application/json,application/atom+xml,text/xml,*/*' });

function currentFeedUrl(type, count = FEED_COUNT) {
  const params = new URLSearchParams({
    action: 'getcurrent',
    type: String(type),
    company: '',
    dateb: '',
    owner: 'include',
    count: String(count),
    output: 'atom',
  });
  return `${CURRENT_FEED}?${params.toString()}`;
}

const submissionsUrl = (cik) => `${SUBMISSIONS}/CIK${padCik(cik)}.json`;

/** The market-wide feeds. Three requests, the whole tape. */
const FEEDS = [
  { type: '8-K', label: '8-K' },
  { type: 'S-1', label: 'S-1' },
  { type: 'SC 13D', label: 'SC 13D' },
];

async function fetchTickerIndex(ctx) {
  const http = ctx.http || require('../core/http');
  const load = async () => {
    let lastErr = null;
    for (const url of [TICKERS_EXCHANGE_URL, TICKERS_URL]) {
      try {
        const payload = await http.getJSON(url, {
          signal: ctx.signal, timeout: 30000, retries: 1, headers: secHeaders(), concurrency: 2,
        });
        const index = buildCikIndex(payload);
        if (index.size) return { size: index.size, entries: [...index.entries()] };
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return { size: 0, entries: [] };
  };

  // Cached hard: this file changes when a company lists or delists, not hourly.
  // Stored as [cik, record] pairs rather than a Map because the cache is
  // disk-backed JSON, and a Map round-trips through JSON as {}.
  let payload;
  if (ctx.cache?.wrap) {
    const hit = await ctx.cache.wrap(`${ID}:cik-tickers`, TICKER_TTL_MS, load);
    payload = hit?.value ?? hit;
  } else {
    payload = await load();
  }
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return new Map(entries);
}

async function fetchFeed(ctx, feed) {
  const http = ctx.http || require('../core/http');
  const url = currentFeedUrl(feed.type);
  const load = () => http.getText(url, {
    signal: ctx.signal, timeout: 25000, retries: 1, headers: secHeaders(), concurrency: 2,
  });
  if (!ctx.cache?.wrap) return load();
  const hit = await ctx.cache.wrap(`${ID}:feed:${feed.type}`, FEED_TTL_MS, load);
  return hit?.value ?? hit;
}

async function fetchSubmissions(ctx, cik) {
  const http = ctx.http || require('../core/http');
  return http.getJSON(submissionsUrl(cik), {
    signal: ctx.signal, timeout: 25000, retries: 1, headers: secHeaders(), concurrency: 2,
  });
}

// ---------------------------------------------------------------------------
// ADAPTER
// ---------------------------------------------------------------------------

async function fetchLive(ctx) {
  const cfg = ctx.settings?.sources?.filings || {};
  const itemLookups = Number.isFinite(cfg.itemLookupLimit) ? Math.max(0, Math.floor(cfg.itemLookupLimit)) : DEFAULT_ITEM_LOOKUPS;
  const historyLimit = Number.isFinite(cfg.historySymbolLimit) ? Math.max(0, Math.floor(cfg.historySymbolLimit)) : DEFAULT_HISTORY_SYMBOLS;
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  const notes = [];
  const warnings = [];
  let calls = 0;

  // --- CIK -> ticker, so an event can find the row it belongs to ------------
  let tickerByCik = new Map();
  try {
    ctx.log?.('loading the SEC CIK-to-ticker map');
    tickerByCik = await fetchTickerIndex(ctx);
    calls += 1;
  } catch (err) {
    warnings.push(`CIK-to-ticker map unavailable (${err?.message || err}) — filings will be listed by company name `
      + 'but cannot be attached to the tickers you hold this run.');
  }

  // --- the three market-wide feeds -----------------------------------------
  const rawEntries = [];
  const feedCounts = [];
  for (const feed of FEEDS) {
    if (ctx.signal?.aborted) break;
    try {
      ctx.log?.(`fetching the live ${feed.label} feed`);
      const xml = await fetchFeed(ctx, feed);
      calls += 1;
      const parsed = parseAtom(xml, {});
      rawEntries.push(...parsed.entries);
      feedCounts.push(`${parsed.entries.length} ${feed.label}`);
      const skipped = Object.values(parsed.dropped).reduce((a, b) => a + b, 0);
      if (skipped) notes.push(`${feed.label} feed: ${skipped} entr${skipped === 1 ? 'y' : 'ies'} could not be parsed and were skipped.`);
      if (parsed.empty) warnings.push(`${feed.label} feed returned no <entry> elements — EDGAR may have changed the feed shape.`);
    } catch (err) {
      warnings.push(`${feed.label} feed failed: ${err?.message || err}`);
    }
    if (feed !== FEEDS[FEEDS.length - 1]) await sleep(SEC_CALL_GAP_MS);
  }

  if (!rawEntries.length) {
    return {
      ...result({ status: 'failed', notes, warnings: [...warnings, 'No filings came back from any EDGAR feed.'] }),
      events: [],
    };
  }

  const { entries: unique, merged } = dedupeEntries(rawEntries);
  if (merged) notes.push(`${merged} duplicate feed entries merged — EDGAR lists one entry per associated CIK, so a 13D appears under both the investor and the company.`);

  // --- item codes for a bounded, priority subset ----------------------------
  // The getcurrent feed does not carry 8-K item codes, and item codes are the
  // difference between "something happened" and knowing what. So the most
  // recent filers get a follow-up call each, capped, and the cap is stated.
  const needItems = unique
    .filter((e) => eventKindForForm(e.form) === EVENT_KIND.FILING_8K && !e.items && e.cik)
    .sort((a, b) => b.filedMs - a.filedMs);

  // Distinct companies, not distinct filings: one issuer that filed three 8-Ks
  // this morning would otherwise consume the whole budget on one lookup's worth
  // of information, and the submissions call returns all three anyway.
  const targets = [];
  const seenCik = new Set();
  for (const e of needItems) {
    if (seenCik.has(e.cik)) continue;
    seenCik.add(e.cik);
    targets.push(e);
    if (targets.length >= itemLookups) break;
  }

  let resolved = 0;
  const byCik = new Map();
  for (const e of targets) {
    if (ctx.signal?.aborted) break;
    try {
      const payload = await fetchSubmissions(ctx, e.cik);
      calls += 1;
      const parsed = parseSubmissions(payload, { now: nowMs, lookbackDays: 30, max: 40, symbol: null });
      const map = new Map();
      for (const row of parsed.entries) if (row.accession) map.set(row.accession, row);
      // Only trust the ticker if the payload is about the company we asked for.
      // A redirect, a stale cache or an EDGAR mix-up would otherwise stamp one
      // issuer's symbol onto another's filing, which is the single worst thing
      // this adapter could do: it attaches somebody else's news to your holding.
      const sameCompany = parsed.cik === e.cik;
      byCik.set(e.cik, { map, symbol: sameCompany ? parsed.symbol : null, mismatch: !sameCompany });
    } catch (err) {
      byCik.set(e.cik, { map: new Map(), symbol: null, error: err?.message || String(err) });
    }
    await sleep(SEC_CALL_GAP_MS);
  }
  let mismatched = 0;
  for (const e of unique) {
    const hit = e.cik ? byCik.get(e.cik) : null;
    if (!hit) continue;
    if (hit.mismatch) { mismatched += 1; continue; }
    if (!e.symbol && hit.symbol) e.symbol = hit.symbol;
    const match = e.accession ? hit.map.get(e.accession) : null;
    if (match?.items) { e.items = match.items; e.primaryDocument = match.primaryDocument; resolved += 1; }
  }
  if (mismatched) {
    warnings.push(`${mismatched} filings were left without item detail: data.sec.gov returned a submissions record for a different CIK than was requested.`);
  }

  // --- the user's own tickers, in depth -------------------------------------
  const wanted = [...new Set((ctx.settings?.extraSymbols || [])
    .concat(cfg.symbols || [])
    .map((s) => str(s)?.toUpperCase())
    .filter(Boolean))].slice(0, historyLimit);

  const cikBySymbol = new Map();
  for (const [cik, rec] of tickerByCik) if (rec?.ticker) cikBySymbol.set(rec.ticker, cik);
  if (wanted.length && !cikBySymbol.size) {
    notes.push(`Filing history for ${wanted.join(', ')} was skipped: EDGAR is addressed by CIK and the ticker map did not load this run.`);
  }

  let deepened = 0;
  for (const sym of wanted) {
    if (ctx.signal?.aborted) break;
    const cik = cikBySymbol.get(sym);
    if (!cik) continue;
    try {
      const payload = await fetchSubmissions(ctx, cik);
      calls += 1;
      const parsed = parseSubmissions(payload, { now: nowMs, symbol: sym });
      unique.push(...parsed.entries);
      deepened += 1;
      if (parsed.ragged?.length) {
        notes.push(`${sym}: EDGAR returned ragged filing columns (${parsed.ragged.map((r) => r.column).join(', ')} were short); the missing cells were treated as absent rather than dropping the filings.`);
      }
    } catch (err) {
      warnings.push(`${sym} filing history unavailable: ${err?.message || err}`);
    }
    await sleep(SEC_CALL_GAP_MS);
  }

  // --- build ----------------------------------------------------------------
  const built = buildEvents(unique, { now: nowMs, tickerByCik });
  const withSymbol = built.events.filter((e) => e.symbol).length;
  const eightK = built.events.filter((e) => e.kind === EVENT_KIND.FILING_8K);
  const itemised = eightK.filter((e) => e.itemsKnown).length;

  notes.unshift(`${built.events.length} filings in ${calls} request${calls === 1 ? '' : 's'}: `
    + `${feedCounts.join(', ')} from the three market-wide feeds, plus any per-company history below.`);
  notes.push(`${withSymbol} of ${built.events.length} filings matched to a ticker; the rest are issuers with no listed common stock or no entry in the SEC ticker file.`);
  if (eightK.length) {
    notes.push(itemised
      ? `8-K item codes resolved for ${itemised} of ${eightK.length} 8-Ks (${resolved} by follow-up lookup, capped at ${itemLookups} per refresh). The remainder are listed as filed with no item detail, because the live feed does not publish it.`
      : `None of the ${eightK.length} 8-Ks carry item codes this run — the live feed does not publish them and the follow-up lookup is set to ${itemLookups}.`);
  }
  if (deepened) notes.push(`Full ${HISTORY_LOOKBACK_DAYS}-day filing history pulled for ${deepened} of your own tickers.`);
  const skipped = Object.entries(built.dropped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  if (skipped.length) notes.push(`Skipped: ${skipped.join(', ')}.`);

  return {
    ...result({
      opportunities: [],
      status: warnings.length ? 'partial' : 'ok',
      notes,
      warnings,
      fetchedAt: isoOrNull(nowMs) || new Date().toISOString(),
    }),
    events: built.events,
  };
}

const adapter = {
  id: ID,
  label: LABEL,
  description: 'Live SEC EDGAR filings — 8-K material events with their item codes translated into plain English, '
    + 'plus S-1 registrations and 13D activist stakes. Compelled disclosure with a timestamp, not commentary.',
  homepage: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent',

  // The classes whose rows these filings attach to. 8-K, S-1 and 13D are filed
  // by operating companies and by REITs and BDCs; funds file on other forms.
  assetClasses: ['dividend_equity', 'reit', 'bdc', 'speculative'],

  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 15 * 60 * 1000,          // filings arrive all day; a stale feed is a dead feed

  async fetch(ctx) {
    try {
      return await fetchLive(ctx);
    } catch (err) {
      return { ...failure(err), events: [] };
    }
  },

  loadSeed(ctx) {
    try {
      const { items, meta } = readSeed(ctx.seedDir, 'filings.json');
      if (!items.length) {
        return { ...result({ status: 'failed', warnings: ['seed file data/seed/filings.json is missing or unreadable'] }), events: [] };
      }

      const dataAsOf = str(meta.dataAsOf) || '2026-08-01';
      const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();

      const entries = items.map((row) => (row && typeof row === 'object' ? {
        via: 'seed',
        form: str(row.form),
        company: str(row.company),
        cik: padCik(row.cik),
        symbol: str(row.symbol),
        role: str(row.role) || 'Filer',
        items: str(row.items),
        accession: null,          // see the note below — none is invented here
        primaryDocument: null,
        filedMs: toMs(row.filed),
        url: null,
      } : null)).filter(Boolean);

      const built = buildEvents(entries, { now: nowMs, seed: true });
      const eightK = built.events.filter((e) => e.kind === EVENT_KIND.FILING_8K);
      const itemised = eightK.filter((e) => e.itemsKnown).length;

      // The seed's own honesty block is carried through verbatim rather than
      // paraphrased here, so there is one statement of what this data is and it
      // cannot drift away from the file it describes.
      const honesty = Array.isArray(meta.honesty) ? meta.honesty.map(str).filter(Boolean) : [];
      const notes = [
        `Bundled snapshot of ${built.events.length} filings as of ${dataAsOf}. Refresh to read the actual EDGAR feed.`,
        ...honesty,
        `${itemised} of ${eightK.length} 8-Ks carry item codes.`,
      ];
      const skipped = Object.entries(built.dropped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
      if (skipped.length) notes.push(`Skipped: ${skipped.join(', ')}.`);
      if (items.length !== entries.length) notes.push(`${items.length - entries.length} seed rows were not objects and were ignored.`);

      return {
        ...result({ opportunities: [], status: 'offline', notes, warnings: [] }),
        events: built.events,
      };
    } catch (err) {
      // HARD RULE 1: loadSeed never throws.
      return { ...failure(err, { status: 'failed' }), events: [] };
    }
  },

  /**
   * On-demand history for one symbol, for when the user opens a row.
   * Not called during a refresh — a per-company endpoint has no business in a
   * loop over the market.
   */
  async fetchOne(ctx, { symbol = null, cik = null } = {}) {
    const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    let resolved = padCik(cik);
    let sym = str(symbol)?.toUpperCase() || null;

    if (!resolved && sym) {
      try {
        const index = await fetchTickerIndex(ctx);
        for (const [c, rec] of index) if (rec?.ticker === sym) { resolved = c; break; }
      } catch { /* fall through to the error below */ }
    }
    if (!resolved) {
      return { ...result({ status: 'failed', warnings: [`No CIK found for ${sym || 'that symbol'}.`] }), events: [] };
    }

    try {
      const payload = await fetchSubmissions(ctx, resolved);
      const parsed = parseSubmissions(payload, { now: nowMs, symbol: sym });
      const built = buildEvents(parsed.entries, { now: nowMs });
      const notes = [`${built.events.length} filings for ${parsed.company || sym || resolved} in the last ${HISTORY_LOOKBACK_DAYS} days.`];
      if (parsed.ragged?.length) notes.push(`EDGAR returned ragged columns (${parsed.ragged.map((r) => r.column).join(', ')}); missing cells were treated as absent.`);
      return { ...result({ opportunities: [], status: 'ok', notes }), events: built.events };
    } catch (err) {
      return { ...failure(err), events: [] };
    }
  },

  // Exported for the tests and for anyone extending the item map.
  ITEM_MEANINGS,
  describeItems,
  summariseItems,
  parseItemCodes,
  zipFilings,
  parseAtom,
  parseFilingTitle,
  parseSummary,
  parseSubmissions,
  buildEvents,
  buildCikIndex,
  dedupeEntries,
  eventKindForForm,
  filingUrl,
  archiveUrl,
  edgarCompanyUrl,
  decodeEntities,
  currentFeedUrl,
  submissionsUrl,
  toMs,
  SEC_UA,
  FEEDS,
  ROUTINE_MAGNITUDE,
};

module.exports = adapter;
