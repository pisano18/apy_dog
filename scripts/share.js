#!/usr/bin/env node
'use strict';

/**
 * Put everything I would otherwise ask you to paste into the repo.
 *
 * I run in a cloud container and cannot see your machine. Until now that meant
 * asking you to copy terminal output back to me every time, which is slow, and
 * loses whatever scrolled past — the truncated table, the error above the error.
 *
 * Git is already a channel between your machine and mine. This writes the full
 * results of the diagnostics into the repo as files, so one commit hands me the
 * complete output instead of the part that fitted on screen.
 *
 *   npm run share            # doctor + backtest -> data/reports/
 *   npm run share -- --quick # skip the backtest (no ~100 symbol fetch)
 *
 * Nothing personal goes in. It is HTTP statuses, hit rates and base rates —
 * your amount, tax settings and watchlist live in your user data directory and
 * are never touched.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'reports');
const quick = process.argv.includes('--quick');

function run(label, args, file) {
  process.stdout.write(`${label}… `);
  const started = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 40 * 1024 * 1024,
  });
  const body = `${r.stdout || ''}${r.stderr || ''}`;
  fs.writeFileSync(path.join(OUT, file), body);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  // A crash is the most useful thing this can capture, so it is never treated
  // as a reason to stop — the file is written either way and the exit code is
  // recorded next to it.
  console.log(`${r.status === 0 ? 'ok' : `exit ${r.status}`} (${secs}s) -> data/reports/${file}`);
  return r.status;
}

/**
 * Guarded so that importing this file does nothing.
 *
 * Without it, `require('scripts/share.js')` runs the whole thing — which the
 * scripts test does deliberately, to catch the missing-identifier crashes this
 * project has shipped three of. That test spawned a real doctor run and wrote
 * files into the repo as a side effect of loading a module, which is exactly
 * the sort of thing a script should never do.
 */
function main() {
fs.mkdirSync(OUT, { recursive: true });

const env = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  appVersion: require(path.join(ROOT, 'package.json')).version,
  proxy: {
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || null,
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || null,
  },
};
fs.writeFileSync(path.join(OUT, 'environment.json'), JSON.stringify(env, null, 2));
console.log(`environment -> data/reports/environment.json`);

run('doctor', [path.join(ROOT, 'scripts', 'doctor.js')], 'doctor.txt');

if (!quick) {
  // Price move first, volatility expansion second, so the primary outcome is
  // the one left in data/calibration.json when both have run.
  run('backtest (price move)', [path.join(ROOT, 'scripts', 'backtest.js'), '--outcome', 'move'], 'backtest-move.txt');
  run('backtest (volatility expansion)', [path.join(ROOT, 'scripts', 'backtest.js')], 'backtest-vol.txt');
} else {
  console.log('skipping the backtests (--quick)');
}

console.log('\nDone. Send it over with:\n');
console.log('  git add data/reports data/calibration*.json');
console.log('  git commit -m "share: diagnostics"');
console.log('  git push origin claude/investment-opportunity-finder-tyyj0s');
}

if (require.main === module) main();
