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
const B = require('../src/core/backtest');
const { fetchDaily } = require('../src/core/history-providers');

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

  const opts = { horizon, relativeMultiple: multiple, thresholdMode: 'relative' };
  const res = B.walkForward(instruments, opts);
  if (!res.ok) { console.error(res.reason); process.exit(2); }
  const fp = B.falsePositiveProfile(instruments, opts);

  const report = {
    generatedAt: new Date().toISOString(),
    universe: instruments.map((i) => i.symbol),
    providers: byProvider,
    failed: failed.map((f) => f.symbol),
    failureDetail: failed.slice(0, 20),
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
