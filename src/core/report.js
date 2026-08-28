'use strict';

const B = require('./backtest');
const S = require('./signals');

/**
 * Turning a set of price histories into a calibration report, and that report
 * into something readable.
 *
 * Extracted from scripts/backtest.js because that script has now shipped three
 * separate crashes — a deleted constant still referenced, and twice a changed
 * return shape the caller was never updated for. Every one of them got past a
 * full green test suite, because the only thing testable about a script that
 * begins by fetching a hundred symbols is that it starts.
 *
 * Everything downstream of the fetch lives here instead, as pure functions of
 * their inputs. They take instruments and return data; they touch no network,
 * no filesystem and no console, so the whole analysis and rendering path runs
 * against synthetic price paths in the test suite. The script keeps only the
 * parts that genuinely need the outside world.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => (finite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/**
 * @param {object[]} instruments  [{ symbol, closes, volumes?, highs?, lows? }]
 * @param {object} opts  { horizon, outcome, relativeMultiple, years, sweep }
 * @returns {{ok:true, report:object} | {ok:false, reason:string}}
 */
function buildReport(instruments, opts = {}) {
  const {
    horizon = S.DEFAULT_HORIZON,
    outcome = 'vol_expansion',
    relativeMultiple = 2,
    years = null,
    sweep = true,
    providers = {},
    failed = [],
  } = opts;

  const runOpts = { horizon, relativeMultiple, thresholdMode: 'relative', outcome };
  const res = sweep ? B.sweep(instruments, runOpts) : B.walkForward(instruments, runOpts);
  if (!res.ok) return { ok: false, reason: res.reason };

  let falsePositives = [];
  try { falsePositives = B.falsePositiveProfile(instruments, runOpts).rows; } catch { /* optional */ }

  return {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      universe: instruments.map((i) => i.symbol),
      providers,
      failed: failed.map((f) => (typeof f === 'string' ? f : f.symbol)),
      years,
      horizon,
      outcome,
      relativeMultiple,
      definition: outcome === 'vol_expansion'
        ? `volatility rising to at least 1.25x this instrument's own long-run normal within ${horizon} trading days`
        : `a peak excursion over ${relativeMultiple}x the instrument's own trailing volatility scaled to `
          + `${horizon} trading days, measured from the bar AFTER the signal`,
      // Present only when a sweep ran; walkForward reports a train slice instead.
      configsTried: res.configsTried ?? null,
      chosenParams: res.chosen ?? null,
      trainBaseRate: res.train?.baseRate ?? null,
      testBaseRate: res.test.baseRate,
      testBars: res.test.bars,
      scores: res.test.scores,
      composite: res.composite,
      weights: res.weights,
      validated: res.validated,
      failedSignals: res.failed,
      falsePositives,
    },
  };
}

/** The report as lines of text. Returns an array so it is trivially assertable. */
function renderReport(report, { symbols = null } = {}) {
  const L = [];
  const bar = '─'.repeat(78);
  L.push('');
  L.push(bar);
  L.push(`Out-of-sample results · ${symbols ?? report.universe.length} symbols`
    + `${report.years ? ` · ${report.years}y` : ''} · ${report.horizon}-day horizon`);
  L.push(`Predicting: ${report.definition}`);
  if (report.configsTried) {
    L.push(`Parameters fitted: ${report.configsTried} configurations searched on a validation slice, `
      + 'reported on a holdout neither the fitting nor the choosing ever saw.');
  }
  L.push(`Base rate: ${pct(report.testBaseRate)} of ${report.testBars} independent observations`);
  L.push(bar);
  L.push('signal              verdict       fires   hit    base   lift   recall  FP');
  for (const s of report.scores) {
    const f = (report.falsePositives || []).find((r) => r.key === s.key);
    L.push(
      `${s.key.padEnd(20)}${s.verdict.padEnd(14)}${String(s.fires).padStart(5)}`
      + `${pct(s.hitRate).padStart(7)}${pct(s.baseRate).padStart(7)}`
      + `${(finite(s.lift) ? s.lift.toFixed(2) : '—').padStart(7)}${pct(s.recall).padStart(8)}`
      + `${pct(f?.falsePositiveRate).padStart(7)}`,
    );
  }
  L.push(bar);
  const c = report.composite;
  L.push(`composite (cutoff ${c.cutoff}): ${c.verdict} · ${pct(c.hitRate)} vs ${pct(c.baseRate)} base `
    + `· lift ${finite(c.lift) ? c.lift.toFixed(2) : '—'} · n=${c.fires}`);
  L.push('');
  L.push(`Validated: ${report.validated.length ? report.validated.join(', ') : 'none'}`);
  L.push(`Failed:    ${report.failedSignals.length ? report.failedSignals.join(', ') : 'none'}`);

  if (report.chosenParams) {
    L.push('');
    L.push('Parameters the data chose:');
    for (const [k, v] of Object.entries(report.chosenParams)) {
      L.push(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);
    }
  }

  if (!report.validated.length) {
    L.push('');
    L.push('Nothing validated. That is a real result and not a bug — it means these detectors, on this');
    L.push('universe, at this horizon, do not beat simply knowing how often the event happens anyway.');
    L.push('Try: --outcome move, a different --horizon, or --years 10 for more observations.');
  }
  return L;
}

module.exports = { buildReport, renderReport };
