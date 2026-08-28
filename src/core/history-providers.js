'use strict';

const http = require('./http');

/**
 * Daily price history, from whichever provider is actually reachable.
 *
 * Written after the previous single-provider version returned zero of 105
 * symbols on a real machine — and, worse, could not say why, because the fetch
 * swallowed its errors in a bare catch. Two lessons are baked in here.
 *
 * ── One provider is not a source, it is a single point of failure ───────────
 *
 * Yahoo's chart endpoint wants a browser User-Agent, a cookie minted at one
 * host and a "crumb" token from another, and returns 401 without them. Supply
 * all three and it answers reliably, which is why it is tried FIRST — and why
 * the original single-provider version returned zero of 105 symbols on a real
 * machine: it asked without the crumb.
 *
 * Stooq was originally first, on the reasoning that plain CSV with no key and
 * no token must be the more robust option. On a real machine it turns out to
 * serve a JavaScript bot challenge instead of data — "This site requires
 * JavaScript to verify" — so from any non-browser client it is useless. It is
 * kept as a fallback because it costs nothing to try when Yahoo is down, and
 * because being wrong about which provider is sturdier is exactly the reason to
 * carry two.
 *
 * ── Never swallow the reason ────────────────────────────────────────────────
 *
 * Every failure carries the provider, the HTTP status, and the first bytes of
 * whatever came back. "0 ok, 105 failed" is not a diagnosis; "Yahoo said 401
 * Invalid Cookie" is one, and it is the difference between a fixable problem
 * and a mystery.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Describe a thrown error in terms a person can act on. */
function describe(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  const body = String(err?.body || err?.responseText || '').slice(0, 160).replace(/\s+/g, ' ').trim();
  const code = err?.code || null;
  return {
    status,
    code,
    message: String(err?.message || err || 'unknown error').slice(0, 200),
    sample: body || null,
  };
}

// ---------------------------------------------------------------------------
// Stooq — CSV, no authentication of any kind
// ---------------------------------------------------------------------------

/**
 * Stooq wants its own symbol spelling: US equities take a `.us` suffix and
 * indices take a caret. Getting this wrong returns a 200 with an empty body
 * rather than an error, which is its own small trap.
 */
function stooqSymbol(symbol) {
  const s = String(symbol).trim().toLowerCase();
  if (s.startsWith('^')) return s;
  if (s.includes('.')) return s;
  return `${s}.us`;
}

function parseStooqCsv(text) {
  const lines = String(text || '').trim().split('\n');
  if (lines.length < 30) return null;
  const head = lines[0].toLowerCase();
  if (!head.startsWith('date')) return null;
  const cols = head.split(',');
  const iC = cols.indexOf('close');
  const iH = cols.indexOf('high');
  const iL = cols.indexOf('low');
  const iV = cols.indexOf('volume');
  if (iC === -1) return null;

  const dates = []; const closes = []; const highs = []; const lows = []; const volumes = [];
  for (let i = 1; i < lines.length; i += 1) {
    const p = lines[i].split(',');
    const c = parseFloat(p[iC]);
    if (!Number.isFinite(c) || c <= 0) continue;
    dates.push(p[0]);
    closes.push(c);
    highs.push(iH === -1 ? NaN : parseFloat(p[iH]));
    lows.push(iL === -1 ? NaN : parseFloat(p[iL]));
    volumes.push(iV === -1 ? NaN : parseFloat(p[iV]));
  }
  return closes.length >= 30 ? { dates, closes, highs, lows, volumes } : null;
}

async function fromStooq(symbol, { years = 5, signal = null } = {}) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&i=d`;
  const text = await http.getText(url, {
    timeout: 20000, retries: 1, concurrency: 4, signal, headers: { 'User-Agent': UA },
  });
  const parsed = parseStooqCsv(text);
  if (!parsed) {
    // A bot challenge arrives as a 200 with an HTML page, which is the nastiest
    // failure mode there is because it looks like success. Naming it as such
    // beats "no usable rows", which sounds like a bad ticker.
    const body = String(text || '');
    const challenged = /noscript|requires JavaScript|<!DOCTYPE html/i.test(body);
    const e = new Error(challenged
      ? 'Stooq served a JavaScript bot challenge instead of data — it does not answer non-browser clients'
      : `Stooq returned no usable rows for "${stooqSymbol(symbol)}"`);
    e.body = body.slice(0, 160);
    e.botChallenge = challenged;
    throw e;
  }
  // Stooq serves the full history; trim to the window asked for.
  const keep = Math.min(parsed.closes.length, Math.ceil(years * 252) + 40);
  const cut = parsed.closes.length - keep;
  return {
    provider: 'stooq',
    symbol,
    dates: parsed.dates.slice(cut),
    closes: parsed.closes.slice(cut),
    highs: parsed.highs.slice(cut),
    lows: parsed.lows.slice(cut),
    volumes: parsed.volumes.slice(cut),
  };
}

// ---------------------------------------------------------------------------
// Yahoo — needs a cookie and a crumb now
// ---------------------------------------------------------------------------

let crumbCache = { crumb: null, cookie: null, at: 0 };

/**
 * Mint the cookie/crumb pair Yahoo now requires.
 *
 * Cached for an hour: it is two extra round trips, and doing them per symbol
 * across a hundred symbols is what turns a working fetch into a rate limit.
 */
async function yahooCredentials({ signal = null } = {}) {
  if (crumbCache.crumb && Date.now() - crumbCache.at < 3600000) return crumbCache;
  const res = await http.request('https://fc.yahoo.com/', {
    as: 'response', timeout: 12000, retries: 0, signal,
    headers: { 'User-Agent': UA }, acceptStatus: () => true,
  });
  const setCookie = res?.headers?.['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  const cookie = list.length ? list.map((c) => String(c).split(';')[0]).join('; ') : null;
  const crumb = await http.getText('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    timeout: 12000, retries: 0, signal,
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!crumb || crumb.length > 32 || /[<{]/.test(crumb)) {
    const e = new Error('Yahoo would not issue a crumb (its anti-bot gate is up)');
    e.body = String(crumb || '').slice(0, 120);
    throw e;
  }
  crumbCache = { crumb: crumb.trim(), cookie, at: Date.now() };
  return crumbCache;
}

async function fromYahoo(symbol, { years = 5, signal = null } = {}) {
  let creds = { crumb: null, cookie: null };
  // The crumb is best-effort: some regions still serve the chart endpoint
  // without one, and failing to get it should not stop us trying.
  try { creds = await yahooCredentials({ signal }); } catch { /* try bare */ }

  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}`
        + `?range=${years}y&interval=1d${creds.crumb ? `&crumb=${encodeURIComponent(creds.crumb)}` : ''}`;
      const payload = await http.getJSON(url, {
        timeout: 20000, retries: 1, concurrency: 4, signal,
        headers: { 'User-Agent': UA, ...(creds.cookie ? { Cookie: creds.cookie } : {}) },
      });
      const r = payload?.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      const closes = q?.close;
      if (!Array.isArray(closes) || closes.length < 30) {
        throw new Error(payload?.chart?.error?.description || 'Yahoo returned no closes');
      }
      return {
        provider: 'yahoo',
        symbol,
        dates: (r.timestamp || []).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
        closes,
        highs: q.high || [],
        lows: q.low || [],
        volumes: q.volume || [],
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Yahoo unreachable');
}

// ---------------------------------------------------------------------------

const PROVIDERS = [
  { key: 'yahoo', label: 'Yahoo Finance (cookie + crumb)', fn: fromYahoo },
  { key: 'stooq', label: 'Stooq (CSV, no key)', fn: fromStooq },
];

/**
 * Clean a close series without changing its length.
 *
 * Dropping a bad bar silently shortens the forward window, which makes a
 * 21-day horizon mean something different for every instrument — a quiet way to
 * corrupt a backtest. Forward-filling keeps the index aligned.
 */
function cleanCloses(closes) {
  const out = [];
  let last = null;
  for (const c of closes) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) { last = c; out.push(c); } else out.push(last ?? NaN);
  }
  return out;
}

/**
 * One symbol, trying each provider in turn, reporting every failure.
 *
 * @returns {{ok:true, data:object} | {ok:false, attempts:object[]}}
 */
async function fetchDaily(symbol, opts = {}) {
  const attempts = [];
  for (const p of PROVIDERS) {
    if (opts.only && opts.only !== p.key) continue;
    try {
      const d = await p.fn(symbol, opts);
      return { ok: true, data: { ...d, closes: cleanCloses(d.closes) }, attempts };
    } catch (e) {
      attempts.push({ provider: p.key, label: p.label, ...describe(e) });
    }
  }
  return { ok: false, attempts };
}

module.exports = { fetchDaily, fromStooq, fromYahoo, yahooCredentials, PROVIDERS, stooqSymbol, parseStooqCsv, cleanCloses, describe, UA };
