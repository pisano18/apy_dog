#!/usr/bin/env node
'use strict';

/**
 * Endpoint probe.
 *
 * APY Dog talks to half a dozen public APIs that it does not control. When one
 * of them changes a field name, moves a URL, or starts demanding a token, the
 * app degrades to bundled data and says so — but it cannot tell you *why*.
 * This can.
 *
 * It hits every upstream endpoint directly, checks the response actually has the
 * shape the adapters expect, and prints a report you can paste into a bug report.
 *
 *   node scripts/probe.js
 *   node scripts/probe.js --verbose     also print a sample record
 *   node scripts/probe.js --json
 */

const http = require('../src/core/http');

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const asJson = argv.includes('--json');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const useColor = process.stdout.isTTY && !argv.includes('--no-color');
const c = (k, s) => (useColor ? `${C[k]}${s}${C.reset}` : String(s));

const year = new Date().getFullYear();
const TREASURY = (type, y) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=${type}&field_tdr_date_value=${y}&page&_format=csv`;

/**
 * Each probe names the fields its adapter depends on, so a green tick means
 * "the data we actually use is present", not merely "the server answered".
 */
const PROBES = [
  {
    id: 'defillama-pools',
    label: 'DefiLlama pools',
    usedBy: 'defillama',
    url: 'https://yields.llama.fi/pools',
    as: 'json',
    check(d) {
      const rows = d?.data;
      if (!Array.isArray(rows)) return { ok: false, why: 'response has no `data` array' };
      const need = ['pool', 'chain', 'project', 'symbol', 'tvlUsd', 'apy'];
      const sample = rows.find((r) => Number.isFinite(r?.apy)) || rows[0] || {};
      const missing = need.filter((k) => sample[k] === undefined);
      const optional = ['apyBase', 'apyReward', 'apyMean30d', 'stablecoin', 'ilRisk', 'exposure', 'predictions']
        .filter((k) => sample[k] === undefined);
      return {
        ok: missing.length === 0,
        why: missing.length ? `missing required fields: ${missing.join(', ')}` : null,
        note: `${rows.length.toLocaleString()} pools${optional.length ? `; optional fields absent: ${optional.join(', ')}` : ''}`,
        sample,
      };
    },
  },
  {
    id: 'defillama-protocols',
    label: 'DefiLlama protocols (audits, age)',
    usedBy: 'defillama',
    url: 'https://api.llama.fi/protocols',
    as: 'json',
    optional: true,
    check(d) {
      if (!Array.isArray(d)) return { ok: false, why: 'expected a top-level array' };
      const s = d[0] || {};
      const missing = ['slug', 'name'].filter((k) => s[k] === undefined);
      return {
        ok: missing.length === 0,
        why: missing.length ? `missing ${missing.join(', ')}` : null,
        note: `${d.length.toLocaleString()} protocols${s.audits === undefined ? '; no `audits` field (risk scoring loses audit input)' : ''}`,
        sample: s,
      };
    },
  },
  {
    id: 'treasury-nominal',
    label: 'US Treasury nominal curve',
    usedBy: 'treasury',
    url: TREASURY('daily_treasury_yield_curve', year),
    as: 'text',
    check(text) {
      const rows = http.parseCSV(text);
      if (!rows.length) return { ok: false, why: `no rows for ${year} (early January? the adapter falls back to ${year - 1})` };
      const head = Object.keys(rows[0]);
      const tenors = head.filter((h) => /\d\s*(Mo|Yr|Month|YR)/i.test(h));
      return {
        ok: head.includes('Date') && tenors.length >= 5,
        why: head.includes('Date') ? (tenors.length < 5 ? `only ${tenors.length} tenor columns` : null) : 'no Date column',
        note: `${rows.length} dated rows, ${tenors.length} tenors: ${tenors.slice(0, 6).join(', ')}…`,
        sample: rows[0],
      };
    },
  },
  {
    id: 'treasury-real',
    label: 'US Treasury real (TIPS) curve',
    usedBy: 'treasury',
    url: TREASURY('daily_treasury_real_yield_curve', year),
    as: 'text',
    optional: true,
    check(text) {
      const rows = http.parseCSV(text);
      const head = rows.length ? Object.keys(rows[0]) : [];
      return {
        ok: rows.length > 0 && head.includes('Date'),
        why: rows.length ? null : `no rows for ${year}`,
        note: `${rows.length} rows: ${head.slice(1, 6).join(', ')}`,
        sample: rows[0],
      };
    },
  },
  {
    id: 'yahoo-chart',
    label: 'Yahoo Finance chart (prices + dividends)',
    usedBy: 'funds, speculative',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/JEPI?range=2y&interval=1d&events=div%7Csplit',
    as: 'json',
    check(d) {
      const r = d?.chart?.result?.[0];
      if (!r) return { ok: false, why: d?.chart?.error?.description || 'no chart.result[0] (auth wall or symbol rejected)' };
      const price = r.meta?.regularMarketPrice;
      const closes = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close;
      const divs = Object.keys(r.events?.dividends || {}).length;
      const problems = [];
      if (!Number.isFinite(price)) problems.push('no regularMarketPrice');
      if (!Array.isArray(closes) || closes.length < 100) problems.push('too few closes for a volatility estimate');
      if (!divs) problems.push('no dividend events (trailing yield will be unavailable)');
      return {
        ok: problems.length === 0,
        why: problems.length ? problems.join('; ') : null,
        note: `price ${price}, ${closes?.length ?? 0} closes, ${divs} dividends`,
        sample: { price, currency: r.meta?.currency, firstDividend: Object.values(r.events?.dividends || {})[0] },
      };
    },
  },
  {
    id: 'yahoo-chart-alt',
    label: 'Yahoo Finance chart (query2 fallback host)',
    usedBy: 'funds, speculative',
    url: 'https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=1mo&interval=1d',
    as: 'json',
    optional: true,
    check(d) {
      const ok = Array.isArray(d?.chart?.result);
      return { ok, why: ok ? null : 'fallback host also unavailable', note: ok ? 'reachable' : '' };
    },
  },
  {
    id: 'stooq',
    label: 'Stooq CSV (price fallback)',
    usedBy: 'funds, speculative',
    url: 'https://stooq.com/q/d/l/?s=spy.us&i=d',
    as: 'text',
    optional: true,
    check(text) {
      const rows = http.parseCSV(text);
      const ok = rows.length > 50 && rows[0].Close !== undefined;
      return {
        ok,
        why: ok ? null : 'no usable OHLC rows (Stooq rate-limits aggressively)',
        note: `${rows.length} rows`,
        sample: rows[rows.length - 1],
      };
    },
  },
  {
    id: 'fdic',
    label: 'FDIC BankFind (insurance status)',
    usedBy: 'savings',
    url: 'https://banks.data.fdic.gov/api/institutions?fields=NAME,CERT,ACTIVE&limit=1',
    as: 'json',
    optional: true,
    check(d) {
      const ok = Array.isArray(d?.data) && d.data.length > 0;
      return { ok, why: ok ? null : 'no data array', note: ok ? 'reachable' : '', sample: d?.data?.[0]?.data };
    },
  },
];

(async () => {
  const results = [];
  if (!asJson) {
    console.log(c('bold', '\nAPY Dog — probing upstream endpoints\n'));
    console.log(c('dim', 'Optional endpoints degrade a source; required ones disable it. Bundled data covers either way.\n'));
  }

  for (const p of PROBES) {
    const t0 = Date.now();
    let entry = { id: p.id, label: p.label, usedBy: p.usedBy, url: p.url, optional: !!p.optional };
    try {
      const body = await http.request(p.url, { as: p.as, timeout: 30000, retries: 1 });
      const r = p.check(body);
      entry = { ...entry, ok: r.ok, status: 200, ms: Date.now() - t0, why: r.why, note: r.note, sample: verbose ? r.sample : undefined };
    } catch (err) {
      const blocked = err?.status === 403 || err?.status === 407;
      entry = {
        ...entry,
        ok: false,
        status: err?.status ?? null,
        ms: Date.now() - t0,
        why: blocked
          ? `HTTP ${err.status} — blocked by a proxy, firewall or network policy, not by the API`
          : (err?.message || String(err)).slice(0, 200),
      };
    }
    results.push(entry);

    if (!asJson) {
      const mark = entry.ok ? c('green', '  ✓') : p.optional ? c('yellow', '  !') : c('red', '  ✗');
      console.log(`${mark} ${entry.label.padEnd(42)} ${c('dim', `${entry.ms}ms`)}`);
      if (entry.note) console.log(c('dim', `      ${entry.note}`));
      if (entry.why) console.log(`      ${entry.ok ? c('dim', entry.why) : c(p.optional ? 'yellow' : 'red', entry.why)}`);
      if (verbose && entry.sample) console.log(c('dim', `      sample: ${JSON.stringify(entry.sample).slice(0, 200)}`));
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ probedAt: new Date().toISOString(), node: process.version, results }, null, 2));
    return;
  }

  const required = results.filter((r) => !r.optional);
  const brokenRequired = required.filter((r) => !r.ok);
  const brokenOptional = results.filter((r) => r.optional && !r.ok);

  console.log(`\n${c('dim', '─'.repeat(72))}`);
  if (!brokenRequired.length && !brokenOptional.length) {
    console.log(c('green', 'All endpoints healthy. Every source can fetch live data.'));
  } else {
    if (brokenRequired.length) {
      console.log(c('red', `${brokenRequired.length} required endpoint(s) down — these sources will fall back to bundled data:`));
      for (const r of brokenRequired) console.log(c('red', `  · ${r.label} (used by ${r.usedBy})`));
    }
    if (brokenOptional.length) {
      console.log(c('yellow', `${brokenOptional.length} optional endpoint(s) unavailable — those sources lose enrichment but still work:`));
      for (const r of brokenOptional) console.log(c('yellow', `  · ${r.label}`));
    }
    console.log(c('dim', '\nIf several are blocked with 403/407, it is your network, not the APIs.'));
  }
  console.log('');
  process.exit(brokenRequired.length ? 1 : 0);
})().catch((err) => {
  console.error('probe failed:', err);
  process.exit(2);
});
