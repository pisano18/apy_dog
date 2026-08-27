#!/usr/bin/env node
'use strict';

/**
 * Validate the signal engine against real price history.
 *
 * The synthetic tests in test/signals.test.js prove the machinery is correct:
 * no lookahead, no edge found in noise, planted structure detected. They cannot
 * tell you the real-world hit rate, because they are not the real world.
 *
 * This does that. It pulls multi-year daily history for a broad symbol list,
 * runs the same walk-forward harness over it, and writes a report with measured
 * hit rates, base rates, lift and out-of-sample verdicts. The weights it fits
 * are the ones the app then uses, and until this has been run the app says
 * plainly that its pressure readings are uncalibrated.
 *
 *   node scripts/backtest.js                        # default universe
 *   node scripts/backtest.js --years 5 --horizon 21
 *   node scripts/backtest.js --symbols AAPL,GME,AMC,TSLA
 *   node scripts/backtest.js --json > report.json
 *
 * Requires network. Nothing here is bundled, because a backtest against data
 * that shipped with the app is a backtest against data chosen after the fact.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('../src/core/http');
const B = require('../src/core/backtest');
const S = require('../src/core/signals');

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/**
 * A universe chosen for spread, not for outcome.
 *
 * Picking symbols because you remember them going up is how a backtest reports
 * a spectacular edge that vanishes the moment it meets tomorrow. This is a wide
 * cross-section — mega caps, sleepy dividend names, indices, small and volatile
 * names, and the famous squeezes — so the result reflects a market rather than
 * a highlight reel. The squeeze names are included precisely because excluding
 * them would be its own bias, and they are a small minority.
 */
const DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'EFA', 'EEM', 'TLT', 'HYG', 'LQD', 'GLD', 'SLV', 'USO', 'XLE', 'XLF',
  'XLK', 'XLV', 'XLU', 'XLP', 'XBI', 'SMH', 'KRE', 'JETS', 'ARKK',
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'AMD', 'INTC', 'CSCO', 'ORCL', 'CRM', 'ADBE',
  'JPM', 'BAC', 'WFC', 'GS', 'C', 'V', 'MA', 'AXP',
  'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'CVS', 'MRNA', 'BNTX',
  'KO', 'PEP', 'PG', 'WMT', 'COST', 'MCD', 'NKE', 'SBUX', 'T', 'VZ', 'XOM', 'CVX', 'COP',
  'BA', 'CAT', 'DE', 'GE', 'F', 'GM', 'UAL', 'DAL', 'CCL', 'NCLH', 'MGM',
  'GME', 'AMC', 'BBBY', 'BB', 'KOSS', 'CLOV', 'SNDL', 'PLTR', 'NIO', 'RIOT', 'MARA', 'MSTR', 'COIN', 'HOOD',
  'SOFI', 'LCID', 'RIVN', 'CHPT', 'SPCE', 'DKNG', 'ROKU', 'PTON', 'ZM', 'DOCU', 'SHOP', 'SQ', 'PYPL',
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const chartUrl = (host, symbol, years) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`;

async function fetchHistory(symbol, years) {
  for (const host of YAHOO_HOSTS) {
    try {
      const payload = await http.getJSON(chartUrl(host, symbol, years), { timeout: 25000, retries: 1, concurrency: 4 });
      const res = payload?.chart?.result?.[0];
      const closes = res?.indicators?.quote?.[0]?.close;
      const volumes = res?.indicators?.quote?.[0]?.volume;
      const highs = res?.indicators?.quote?.[0]?.high;
      const lows = res?.indicators?.quote?.[0]?.low;
      if (!Array.isArray(closes) || closes.length < 200) continue;
      // Forward-fill nulls rather than dropping them: dropping a bar silently
      // shortens the forward window and makes a 21-day horizon mean something
      // different for every instrument.
      const clean = [];
      let lastGood = null;
      for (const c of closes) {
        if (typeof c === 'number' && Number.isFinite(c) && c > 0) { lastGood = c; clean.push(c); } else if (lastGood !== null) clean.push(lastGood);
        else clean.push(NaN);
      }
      return {
        symbol,
        closes: clean,
        volumes: Array.isArray(volumes) ? volumes.map((v) => (Number.isFinite(v) ? v : NaN)) : [],
        highs: Array.isArray(highs) ? highs.map((v) => (Number.isFinite(v) ? v : NaN)) : [],
        lows: Array.isArray(lows) ? lows.map((v) => (Number.isFinite(v) ? v : NaN)) : [],
      };
    } catch { /* try the other host */ }
  }
  return null;
}

async function main() {
  const years = Number(arg('years', 5)) || 5;
  const horizon = Number(arg('horizon', 21)) || 21;
  const multiple = Number(arg('multiple', 2)) || 2;
  const asJson = !!arg('json');
  const symbols = String(arg('symbols', '') || '').trim()
    ? String(arg('symbols')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_UNIVERSE;

  const log = asJson ? () => {} : (...a) => console.log(...a);
  log(`Fetching ${years}y of daily history for ${symbols.length} symbols…`);

  const instruments = [];
  const failed = [];
  const batch = 8;
  for (let i = 0; i < symbols.length; i += batch) {
    const slice = symbols.slice(i, i + batch);
    const got = await Promise.all(slice.map((s) => fetchHistory(s, years).catch(() => null)));
    for (let k = 0; k < slice.length; k += 1) {
      if (got[k]) instruments.push(got[k]); else failed.push(slice[k]);
    }
    log(`  ${Math.min(i + batch, symbols.length)}/${symbols.length}  (${instruments.length} ok, ${failed.length} failed)`);
  }

  if (instruments.length < 10) {
    console.error(`\nOnly ${instruments.length} symbols returned history. `
      + 'This needs network access to Yahoo Finance; nothing can be concluded from a sample this small.');
    if (failed.length) console.error(`Failed: ${failed.slice(0, 20).join(', ')}${failed.length > 20 ? '…' : ''}`);
    process.exit(2);
  }

  const opts = { horizon, relativeMultiple: multiple, thresholdMode: 'relative' };
  const res = B.walkForward(instruments, opts);
  if (!res.ok) { console.error(res.reason); process.exit(2); }
  const fp = B.falsePositiveProfile(instruments, opts);

  const report = {
    generatedAt: new Date().toISOString(),
    universe: instruments.map((i) => i.symbol),
    failed,
    years,
    horizon,
    relativeMultiple: multiple,
    definition: `a "large move" is a peak excursion over ${multiple}x the instrument's own trailing `
      + `volatility scaled to ${horizon} trading days, measured from the bar AFTER the signal`,
    trainBaseRate: res.train.baseRate,
    testBaseRate: res.test.baseRate,
    testBars: res.test.bars,
    scores: res.test.scores,
    composite: res.composite,
    weights: res.weights,
    validated: res.validated,
    failedSignals: res.failed,
    falsePositives: fp.rows,
  };

  const out = path.join(__dirname, '..', 'data', 'calibration.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  if (asJson) { process.stdout.write(JSON.stringify(report, null, 2)); return; }

  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Out-of-sample results · ${instruments.length} symbols · ${years}y · ${horizon}-day horizon`);
  console.log(report.definition);
  console.log(`Base rate: ${pct(res.test.baseRate)} of ${res.test.bars} independent observations`);
  console.log('─'.repeat(78));
  console.log('signal              verdict       fires   hit    base   lift   recall  FP');
  for (const s of res.test.scores) {
    const f = fp.rows.find((r) => r.key === s.key);
    console.log(
      `${s.key.padEnd(20)}${s.verdict.padEnd(14)}${String(s.fires).padStart(5)}`
      + `${pct(s.hitRate).padStart(7)}${pct(s.baseRate).padStart(7)}`
      + `${(s.lift ?? 0).toFixed(2).padStart(7)}${pct(s.recall).padStart(8)}${pct(f?.falsePositiveRate).padStart(7)}`,
    );
  }
  console.log('─'.repeat(78));
  console.log(`composite (cutoff ${res.composite.cutoff}): ${res.composite.verdict} · `
    + `${pct(res.composite.hitRate)} vs ${pct(res.composite.baseRate)} base · lift ${(res.composite.lift ?? 0).toFixed(2)} `
    + `· n=${res.composite.fires}`);
  console.log(`\nValidated: ${res.validated.length ? res.validated.join(', ') : 'none'}`);
  console.log(`Failed:    ${res.failed.length ? res.failed.join(', ') : 'none'}`);
  console.log(`\nWritten to ${out} — the app reads this and stops calling itself uncalibrated.`);
  console.log('A verdict of "failed" is a real result, not a bug. It means that detector does not work,');
  console.log('and it will be given zero weight rather than quietly kept because it sounded plausible.');
}

main().catch((e) => { console.error(e); process.exit(1); });
