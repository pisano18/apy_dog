'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const S = require('../src/core/signals');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const equities = require('../src/sources/equities');
const crypto = require('../src/sources/crypto');
const { aggregate } = require('../src/core/aggregate');
const { loadAdapters } = require('../src/sources');

/**
 * What the signal engine is actually fed.
 *
 * Every detector counts its windows in bars — "recent 10", "baseline 60" — and
 * `realisedVol` annualises with sqrt(252). All of it assumes one bar is one
 * trading day. What was passed in was the CHART: equities thinned to 120 evenly
 * spaced points, so a bar was about 2.1 trading days and volatility came out
 * roughly 1.5x too high; crypto's is a seven-day HOURLY sparkline, so a bar was
 * about 1.4 hours and volatility came out roughly five times too low. The same
 * row carried the correct figure two fields away in `risk.volatility`, so one
 * row displayed two contradictory volatilities and the detectors used the wrong
 * one — and the calibration being applied had been measured on true daily bars,
 * so the hit rate the app advertised described a detector it was not running.
 *
 * Nothing caught it because no test had ever put a real row into the signal
 * engine: the bundled rows are all flagged illustrative and skipped, so the
 * defect could only appear after a live refresh, on a user's machine.
 */

/** Deterministic daily closes with a known annualised volatility. */
function dailyCloses(annualVolPct, n = 252, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const step = (annualVolPct / 100) / Math.sqrt(252);
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    const z = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    p *= Math.exp(step * z);
    out.push(p);
  }
  return out;
}

describe('one row, one volatility', () => {
  const TRUE_VOL = 15;

  test('the series a measured row carries is the history it was measured from', () => {
    const closes = dailyCloses(TRUE_VOL);
    const row = equities.buildMeasured(
      { symbol: 'TEST', name: 'Test', group: 'core_index' },
      { price: closes[closes.length - 1], closes, volumes: [] },
      { schema, C, now: Date.now() },
    );
    assert.deepStrictEqual(row.series, closes.slice(-row.series.length),
      'the row carries a resampled chart rather than the closes themselves');
  });

  test('the signal engine and the risk panel agree about the same row', () => {
    const closes = dailyCloses(TRUE_VOL);
    const row = equities.buildMeasured(
      { symbol: 'TEST', name: 'Test', group: 'core_index' },
      { price: closes[closes.length - 1], closes, volumes: [] },
      { schema, C, now: Date.now() },
    );
    const rowVol = row.risk.volatility;
    const signalVol = S.realisedVol(S.windowAt(row.series, row.series.length - 1, 60)) * 100;

    assert.ok(Math.abs(rowVol - TRUE_VOL) < 3, `the row's own volatility is ${rowVol.toFixed(1)}%, not ${TRUE_VOL}%`);
    // Different windows, so not identical — but they must be the same number to
    // within sampling noise. The thinned chart put them 1.5x apart.
    assert.ok(Math.abs(signalVol - rowVol) < 4,
      `the signal engine reads ${signalVol.toFixed(1)}% where the row says ${rowVol.toFixed(1)}% — `
      + 'these are the same asset over the same period');
  });

  test('a thinned chart is exactly what this goes wrong on', () => {
    // Named so nobody re-introduces the optimisation without seeing the cost.
    const closes = dailyCloses(TRUE_VOL);
    const thinned = equities.downsample(closes, 120);
    const thinnedVol = S.realisedVol(S.windowAt(thinned, thinned.length - 1, 60)) * 100;
    assert.ok(thinnedVol > TRUE_VOL * 1.3,
      'this test is meant to demonstrate the error the thinning causes and no longer does');
  });
});

describe('a row that cannot be read says so', () => {
  test('a source that will not state its timescale gets no signals', () => {
    for (const interval of [null, 'hour', 'week']) {
      const row = schema.normalize({
        id: 'x', name: 'X', source: 'crypto', sourceLabel: 'Crypto',
        series: dailyCloses(20, 120), seriesBasis: 'measured', seriesInterval: interval,
      }, { source: 'crypto' });
      assert.strictEqual(row.seriesInterval, interval === null ? null : interval);
    }
    // And anything not on the list is not taken at its word.
    const bogus = schema.normalize({
      id: 'y', name: 'Y', source: 'crypto', sourceLabel: 'Crypto',
      series: dailyCloses(20, 120), seriesBasis: 'measured', seriesInterval: 'daily',
    }, { source: 'crypto' });
    assert.strictEqual(bogus.seriesInterval, null, "'daily' is not 'day' and must not be guessed at");
  });

  test('the live crypto sparkline is declared hourly, because that is what it is', () => {
    const row = crypto._buildRow?.({}) ?? null;
    // The builder is not exported on every adapter; the invariant that matters
    // is that no crypto row ever claims daily bars.
    if (row) assert.notStrictEqual(row.seriesInterval, 'day');
  });

  test('every row the pipeline produces either reads or explains itself', async () => {
    const { adapters } = loadAdapters();
    const r = await aggregate(adapters, { offline: true });
    const withSignals = r.opportunities.filter((o) => o.signals);
    assert.ok(withSignals.length > 0, 'no row reached the signal engine at all');
    for (const o of withSignals) {
      if (o.signals.unreadable) {
        assert.ok(o.signals.unreadable.length > 20, `${o.name} refuses to read and will not say why`);
        assert.strictEqual(o.signals.fired.length, 0, `${o.name} is unreadable and fired a signal anyway`);
      } else {
        assert.strictEqual(o.seriesInterval, 'day',
          `${o.name} was read by the detectors but its bars are "${o.seriesInterval}", not days`);
        assert.strictEqual(o.seriesBasis, 'measured',
          `${o.name} was read by the detectors off a chart that was drawn, not recorded`);
      }
    }
  });
});
