'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildReport, renderReport } = require('../src/core/report');
const syn = require('../src/core/synthetic');

/**
 * The whole analysis and rendering path, exercised without a network.
 *
 * This exists because scripts/backtest.js shipped three crashes past a fully
 * green suite: a deleted constant still referenced, and twice a changed return
 * shape whose caller was never updated. Each one only appeared after a
 * hundred-symbol fetch, so nothing in CI could reach it.
 *
 * Now everything downstream of the fetch is a pure function and runs here
 * against synthetic price paths. If a return shape changes again, this breaks
 * first.
 */

const BASKET = () => syn.regimeBasket({ count: 22, n: 2000, seed: 11 });
const NOISE = () => syn.randomBasket({ count: 22, n: 2000, seed: 404 });

describe('the report builds end to end', () => {
  test('a sweep produces every field the renderer and the app read', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion', years: 5 });
    assert.ok(r.ok, r.reason);
    const rep = r.report;
    // The exact fields whose absence crashed the script, named individually so
    // a rename cannot pass by being merely undefined.
    for (const k of ['generatedAt', 'universe', 'horizon', 'outcome', 'definition',
      'testBaseRate', 'testBars', 'scores', 'composite', 'weights',
      'validated', 'failedSignals', 'falsePositives']) {
      assert.ok(rep[k] !== undefined, `report.${k} is missing`);
    }
    assert.ok(Array.isArray(rep.scores) && rep.scores.length >= 4);
    assert.ok(Number.isFinite(rep.testBaseRate) && Number.isFinite(rep.testBars));
  });

  test('walkForward mode also produces a complete report', () => {
    // The crash was that sweep() has no `train` slice and the caller read
    // res.train.baseRate unconditionally. Both modes must build.
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion', sweep: false });
    assert.ok(r.ok, r.reason);
    assert.ok(Number.isFinite(r.report.trainBaseRate), 'walkForward should report a train base rate');
    assert.strictEqual(r.report.configsTried, null, 'no sweep means no configurations tried');
  });

  test('sweep mode reports null for the fields it genuinely does not have', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion' });
    assert.strictEqual(r.report.trainBaseRate, null, 'a sweep has no single train slice — null, not undefined');
    assert.ok(r.report.configsTried > 0);
    assert.ok(r.report.chosenParams && r.report.chosenParams.coil);
  });

  test('both outcome modes build', () => {
    for (const outcome of ['move', 'vol_expansion']) {
      const r = buildReport(BASKET(), { horizon: 21, outcome });
      assert.ok(r.ok, `${outcome}: ${r.reason}`);
      assert.match(r.report.definition, /\w/);
    }
  });

  test('too little history is refused with a reason, not a crash', () => {
    const r = buildReport(syn.randomBasket({ count: 3, n: 200, seed: 1 }), { horizon: 21 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason && r.reason.length > 10, 'a refusal must explain itself');
  });
});

describe('the rendering never throws on any report it is given', () => {
  test('a normal report renders the table and the verdicts', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion', years: 5 });
    const lines = renderReport(r.report, { symbols: 22 });
    const text = lines.join('\n');
    assert.ok(/Base rate:/.test(text));
    assert.ok(/signal\s+verdict\s+fires/.test(text), 'the table header is missing');
    assert.ok(/Validated:/.test(text) && /Failed:/.test(text));
    for (const s of r.report.scores) {
      assert.ok(text.includes(s.key), `${s.key} missing from the rendered table`);
    }
  });

  test('a report where nothing validated says so plainly', () => {
    const r = buildReport(NOISE(), { horizon: 21, outcome: 'vol_expansion' });
    assert.ok(r.ok, r.reason);
    const text = renderReport(r.report).join('\n');
    if (!r.report.validated.length) {
      assert.ok(/Nothing validated/.test(text));
      assert.ok(/real result and not a bug/.test(text), 'a null result must not read as a failure of the tool');
    }
  });

  test('missing optional fields render as a dash rather than NaN or undefined', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion' });
    const stripped = {
      ...r.report,
      falsePositives: [],
      scores: r.report.scores.map((s) => ({ ...s, lift: null, recall: null })),
    };
    const text = renderReport(stripped).join('\n');
    assert.ok(!/undefined|NaN/.test(text), `rendered undefined or NaN:\n${text}`);
    assert.ok(text.includes('—'), 'missing values should render as a dash');
  });

  test('it renders without a symbol count or a year count', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion' });
    assert.doesNotThrow(() => renderReport(r.report));
  });
});

describe('the null survives the whole pipeline, not just the harness', () => {
  test('pure noise produces a report claiming nothing', () => {
    // The end-to-end version of the most important test in the repository.
    let validated = 0;
    for (let k = 0; k < 5; k += 1) {
      const r = buildReport(syn.randomBasket({ count: 22, n: 2000, seed: 900 + k * 77 }),
        { horizon: 21, outcome: 'vol_expansion' });
      if (!r.ok) continue;
      validated += r.report.validated.length;
    }
    assert.strictEqual(validated, 0, 'the full pipeline found an edge in noise');
  });

  test('and planted structure still comes through it', () => {
    const r = buildReport(BASKET(), { horizon: 21, outcome: 'vol_expansion' });
    assert.ok(r.ok);
    assert.ok(r.report.validated.includes('coil'),
      `planted compression lost somewhere in the pipeline: ${JSON.stringify(r.report.validated)}`);
  });
});
