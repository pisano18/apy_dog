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
const { buildReport, renderReport } = require('../src/core/report');
const { fetchDaily } = require('../src/core/history-providers');

/**
 * A universe chosen for spread, not for outcome.
 *
 * Picking symbols because you remember them going up is how a backtest reports
 * a spectacular edge that vanishes the moment it meets tomorrow. This is a wide
 * cross-section — indices, mega caps, sleepy dividend names, sectors, and small
 * volatile ones — so the result describes a market rather than a highlight
 * reel. The famous squeezes are included precisely because excluding them would
 * be its own bias, and they are a small minority of the list.
 */
const DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'EFA', 'EEM', 'TLT', 'HYG', 'LQD', 'GLD', 'SLV', 'USO', 'XLE', 'XLF',
  'XLK', 'XLV', 'XLU', 'XLP', 'XBI', 'SMH', 'KRE', 'JETS', 'ARKK',
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'AMD', 'INTC', 'CSCO', 'ORCL', 'CRM', 'ADBE',
  'JPM', 'BAC', 'WFC', 'GS', 'C', 'V', 'MA', 'AXP',
  'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'CVS', 'MRNA', 'BNTX',
  'KO', 'PEP', 'PG', 'WMT', 'COST', 'MCD', 'NKE', 'SBUX', 'T', 'VZ', 'XOM', 'CVX', 'COP',
  'BA', 'CAT', 'DE', 'GE', 'F', 'GM', 'UAL', 'DAL', 'CCL', 'NCLH', 'MGM',
  'GME', 'AMC', 'BB', 'KOSS', 'CLOV', 'PLTR', 'NIO', 'RIOT', 'MARA', 'MSTR', 'COIN', 'HOOD',
  'SOFI', 'LCID', 'RIVN', 'CHPT', 'DKNG', 'ROKU', 'PTON', 'ZM', 'DOCU', 'SHOP', 'PYPL',
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
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
  const byProvider = {};
  const batch = 8;
  for (let i = 0; i < symbols.length; i += batch) {
    const slice = symbols.slice(i, i + batch);
    const got = await Promise.all(slice.map((sym) => fetchDaily(sym, { years }).catch((e) => ({ ok: false, attempts: [{ provider: 'thrown', message: String(e?.message || e) }] }))));
    for (let k = 0; k < slice.length; k += 1) {
      const r = got[k];
      if (r.ok) {
        instruments.push(r.data);
        byProvider[r.data.provider] = (byProvider[r.data.provider] || 0) + 1;
      } else {
        failed.push({ symbol: slice[k], attempts: r.attempts });
      }
    }
    log(`  ${Math.min(i + batch, symbols.length)}/${symbols.length}  (${instruments.length} ok, ${failed.length} failed)`);
  }

  if (instruments.length < 10) {
    // The previous version said "0 ok, 105 failed" and stopped, which told
    // nobody anything. Every failure now names the provider, the status and
    // what the server actually said, because that is the difference between a
    // fixable problem and a mystery.
    console.error(`\nOnly ${instruments.length} of ${symbols.length} symbols returned history, `
      + 'so there is nothing to conclude. Here is exactly what each provider said:\n');
    const seen = new Map();
    for (const f of failed) {
      for (const a of f.attempts || []) {
        const key = `${a.provider}|${a.status || ''}|${a.message}`;
        if (!seen.has(key)) seen.set(key, { ...a, count: 0, example: f.symbol });
        seen.get(key).count += 1;
      }
    }
    for (const v of [...seen.values()].sort((a, b) => b.count - a.count)) {
      console.error(`  ${String(v.provider).padEnd(7)} ${v.count.toString().padStart(4)}x  `
        + `${v.status ? `HTTP ${v.status} ` : ''}${v.message}`);
      if (v.sample) console.error(`               server said: ${v.sample}`);
    }
    console.error('\nRun "npm run doctor" for a full picture of what this machine can reach, '
      + 'and paste that output into a bug report.');
    process.exit(2);
  }

  log(`\nHistory sources used: ${Object.entries(byProvider).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (failed.length) log(`${failed.length} symbols had no history from any provider and were skipped.`);

  // Everything below the fetch lives in src/core/report.js as pure functions,
  // because this script has shipped three crashes that a green test suite could
  // not see: the only thing testable about a script that starts by fetching a
  // hundred symbols is that it starts. The analysis and the rendering now run
  // against synthetic price paths in the test suite instead.
  //
  //   'move'          does a large price move follow
  //   'vol_expansion' does volatility come back above this instrument's own
  //                   long-run normal
  //
  // A compression detector claims the second. Scoring it on the first was a
  // methodological error: the bar is a multiple of the 121-day BASELINE
  // volatility, while compression fires exactly when recent volatility sits far
  // below that baseline.
  const outcome = String(arg('outcome', 'vol_expansion'));
  const built = buildReport(instruments, {
    horizon,
    outcome,
    relativeMultiple: multiple,
    years,
    sweep: !arg('no-sweep'),
    providers: byProvider,
    failed,
  });
  if (!built.ok) { console.error(built.reason); process.exit(2); }
  const { report } = built;

  // Two files, deliberately. Each run writes its own outcome-tagged result, and
  // only the primary outcome updates the file the app actually reads.
  //
  // Without the split, running both outcomes in sequence left the app holding
  // whichever finished last — so a session that had genuinely validated a
  // detector against volatility expansion ended up reporting "validated: none",
  // because the price-move run overwrote it on the way past.
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const tagged = path.join(dir, `calibration-${outcome}.json`);
  fs.writeFileSync(tagged, JSON.stringify(report, null, 2));

  const PRIMARY = 'vol_expansion';
  const out = path.join(dir, 'calibration.json');
  if (outcome === PRIMARY) {
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }

  if (asJson) { process.stdout.write(JSON.stringify(report, null, 2)); return; }

  for (const line of renderReport(report, { symbols: instruments.length })) console.log(line);
  console.log(`\nWritten to ${tagged}.`);
  console.log(outcome === PRIMARY
    ? `The app reads ${out} and stops calling itself uncalibrated.`
    : `The app keeps reading ${out}, which holds the ${PRIMARY} run — a secondary outcome does not `
      + 'overwrite the primary one.');
  console.log('A verdict of "failed" is a real result, not a bug. It means that detector does not work,');
  console.log('and it will be given zero weight rather than quietly kept because it sounded plausible.');
}

// Only when run. Requiring this file must define functions and do nothing
// else: the scripts test loads every script to catch an identifier that was
// deleted with its use left behind, and without this guard that load fired a
// real hundred-symbol fetch — `npm test` quietly ran a live backtest. The
// guard test was written for exactly this and its pattern accepted a bare
// top-level `main()`, so it passed on the thing it existed to prevent.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
