'use strict';

const { setTimeout: delay } = require('node:timers/promises');

/**
 * HTTP client for source adapters.
 *
 * Runs in Electron's main process (Node), never the renderer, so there is no
 * CORS wall between us and public finance APIs — which is the entire reason this
 * is a desktop app rather than a web page.
 *
 * Every request gets: a timeout, bounded retries with jittered backoff, a real
 * User-Agent (several of these hosts 403 the default Node UA), and a global
 * concurrency cap so we do not hammer a free endpoint and get rate-limited.
 */

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise((res) => this.queue.push(res));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

const pools = new Map();
function poolFor(host, limit = 4) {
  if (!pools.has(host)) pools.set(host, new Semaphore(limit));
  return pools.get(host);
}

class HttpError extends Error {
  constructor(message, { status, url, body, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? null;
    this.url = url ?? null;
    this.body = body ?? null;
    this.cause = cause ?? null;
    // 403/407 from a corporate egress proxy means "policy denied", not "retry".
    this.retryable = status === null ? true : [408, 425, 429, 500, 502, 503, 504].includes(status);
  }
}

/**
 * @param {string} url
 * @param {object} opts
 *  - timeout   ms per attempt (default 20s)
 *  - retries   attempts after the first (default 2)
 *  - as        'json' | 'text' | 'buffer'
 *  - headers, method, body, concurrency, signal
 */
async function request(url, opts = {}) {
  const {
    timeout = 20000,
    retries = 2,
    as = 'json',
    headers = {},
    method = 'GET',
    body = null,
    concurrency = 4,
    signal: outerSignal = null,
    acceptStatus = null,
  } = opts;

  let host;
  try { host = new URL(url).host; } catch { throw new HttpError(`Invalid URL: ${url}`, { url }); }
  const pool = poolFor(host, concurrency);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await pool.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeout}ms`)), timeout);
    const onOuterAbort = () => ctrl.abort(outerSignal.reason);
    if (outerSignal) {
      if (outerSignal.aborted) { clearTimeout(timer); pool.release(); throw new HttpError('aborted', { url }); }
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: as === 'json' ? 'application/json,text/plain,*/*' : '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });

      const ok = acceptStatus ? acceptStatus(res.status) : res.ok;
      if (!ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(`HTTP ${res.status} ${res.statusText} for ${url}`, {
          status: res.status, url, body: text.slice(0, 500),
        });
      }

      if (as === 'text') return await res.text();
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new HttpError(`Response was not JSON (${text.slice(0, 120)}…)`, { url, body: text.slice(0, 500), cause: e });
      }
    } catch (err) {
      lastErr = err instanceof HttpError ? err : new HttpError(err.message || String(err), { url, cause: err });
      const isLast = attempt === retries;
      if (isLast || !lastErr.retryable) break;
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300;
      await delay(backoff);
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      pool.release();
    }
  }
  throw lastErr;
}

const getJSON = (url, opts) => request(url, { ...opts, as: 'json' });
const getText = (url, opts) => request(url, { ...opts, as: 'text' });

/** Minimal CSV parser — several public feeds (Stooq, Treasury) are CSV only. */
function parseCSV(text, { headers = true } = {}) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
  if (!headers) return clean;
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Pull values out of simple XML without a dependency. */
function xmlTagValues(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_]+:)?${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

module.exports = { request, getJSON, getText, parseCSV, xmlTagValues, HttpError, DEFAULT_UA };
