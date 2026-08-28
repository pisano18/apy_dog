'use strict';

/**
 * What the last measurement actually found.
 *
 * A backtest takes twenty minutes and writes its verdict into a JSON file, and
 * until now the only way to read that verdict back was to run it again. That is
 * a bad trade for a question people ask often — "which detectors survived, and
 * how sure is it" — and an especially bad one when the answer is the reason to
 * trust or distrust every pressure number in the app.
 *
 * Prints the stored calibration in exactly the form the backtest printed it,
 * because it IS that report: scripts/backtest.js writes the report object
 * straight to the file.
 *
 *   npm run calibration                 the file the app reads
 *   npm run calibration -- --outcome move    a specific run
 *   npm run calibration -- --json       the raw object
 */

const fs = require('node:fs');
const path = require('node:path');

const { renderReport } = require('../src/core/report');
const SIG = require('../src/core/signals');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

function main() {
  const dir = path.join(__dirname, '..', 'data');
  const outcome = flag('outcome');
  const file = path.join(dir, outcome ? `calibration-${outcome}.json` : 'calibration.json');

  if (!fs.existsSync(file)) {
    console.log(`\nNothing measured yet — ${path.relative(process.cwd(), file)} does not exist.`);
    console.log('\nRun  npm run backtest  to measure the detectors against real price history.');
    console.log('Until then every pressure reading in the app is labelled uncalibrated, and means it.\n');
    const others = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^calibration.*\.json$/.test(f))
      : [];
    if (others.length) console.log(`Other runs on disk: ${others.join(', ')}\n`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`\n${path.relative(process.cwd(), file)} is not readable JSON: ${err.message}`);
    console.log('Re-run  npm run backtest  to replace it.\n');
    process.exit(1);
  }

  if (has('json')) { process.stdout.write(JSON.stringify(report, null, 2)); return; }

  for (const line of renderReport(report, { symbols: (report.universe || []).length })) console.log(line);

  // The part the report itself cannot know: which detectors this run had no way
  // to reach. A backtest over closes cannot see short interest, an event
  // calendar or an unlock schedule, so those three are never in the file and
  // are running on the weight somebody chose by hand.
  const measured = Object.keys(report.weights || {});
  const unmeasured = SIG.DETECTOR_KEYS.filter((k) => !measured.includes(k));
  if (unmeasured.length) {
    console.log(`\nNot measurable by a backtest over closes, so still on a hand-chosen weight:`);
    console.log(`  ${unmeasured.join(', ')}`);
    console.log('  These need short interest, an event calendar and an unlock schedule. They are not');
    console.log('  part of what the numbers above verify, and the app says so on the Signals banner.');
  }

  console.log(`\nRead from ${path.relative(process.cwd(), file)}`
    + `${report.generatedAt ? `, written ${report.generatedAt}` : ''}.`);
  console.log('This is the file the app reads. Nothing was re-run.\n');
}

// Only when run.
if (require.main === module) main();
