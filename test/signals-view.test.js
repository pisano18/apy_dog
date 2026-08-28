'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The signals view, rendered in plain Node.
 *
 * This exists because the populated layout CANNOT appear offline: every bundled
 * chart is drawn from the row's own statistics rather than recorded, and no
 * signal can honestly be read off one. Without this test the first time the
 * card-rendering code ever ran would be on somebody's machine, after their
 * first refresh, with no way to have caught a typo in it beforehand.
 */

let R;
let F;

before(() => {
  const ctx = { window: {}, document: { documentElement: { dataset: {} } } };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  for (const f of ['format.js', 'render.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8'), ctx, { filename: f });
  }
  R = ctx.window.R;
  F = ctx.window.F;
  assert.ok(R && typeof R.signalsView === 'function', 'render.js did not expose signalsView');
  assert.ok(F, 'format.js did not load');
});

const CARD = {
  id: 'x1',
  name: 'Example Corp',
  symbol: 'EXMP',
  grade: 'D',
  gradeColor: '#e08b3c',
  pressure: 78,
  series: [10, 11, 10.5, 10.4, 10.6, 10.5, 10.55, 10.5],
  seriesBasis: 'measured',
  missing: ['borrow fee'],
  lean: { direction: 'up', strength: 0.6, why: 'Forced buying has a direction.' },
  expected: { typicalPct: 12.4 },
  catalyst: { label: 'Earnings', daysAway: 6 },
  fired: [
    { key: 'coil', strength: 0.82, evidence: ['Trading at 31% of its own normal volatility.'] },
    { key: 'squeeze', strength: 0.71, evidence: ['48% of the free float is sold short.'] },
  ],
};

const payload = (over = {}) => ({
  counts: { total: 40, readable: 40, unreadable: 0, firing: 1 },
  calibration: null,
  rows: [CARD],
  ...over,
});

const count = (html, re) => (html.match(re) || []).length;

describe('the populated layout renders', () => {
  test('one card per row, with one evidence line per fired signal', () => {
    const html = R.signalsView(payload());
    assert.strictEqual(count(html, /class="sigcard"/g), 1);
    assert.strictEqual(count(html, /class="sigline"/g), 2);
    assert.ok(html.includes('Example Corp'));
    assert.ok(html.includes('EXMP'));
    assert.ok(html.includes('78'), 'the pressure reading is missing');
  });

  test('the evidence text itself reaches the page', () => {
    const html = R.signalsView(payload());
    assert.ok(html.includes('31% of its own normal volatility'));
    assert.ok(html.includes('48% of the free float is sold short'));
  });

  test('signal keys are shown as words, never as raw keys', () => {
    const html = R.signalsView(payload());
    assert.ok(html.includes('Compression'));
    assert.ok(html.includes('Squeeze mechanics'));
    assert.ok(!/>coil</.test(html), 'a raw signal key leaked into the interface');
    assert.ok(!/quiet_accumulation/.test(html.replace(/data-key="[^"]*"/g, '')),
      'a snake_case key leaked into visible text');
  });

  test('a row with no chart still renders', () => {
    const html = R.signalsView(payload({ rows: [{ ...CARD, series: null, seriesBasis: null }] }));
    assert.strictEqual(count(html, /class="sigcard"/g), 1);
  });

  test('every signal key the engine can emit has a label', () => {
    const S = require('../src/core/signals');
    for (const key of Object.keys(S.PRIOR_WEIGHTS)) {
      assert.ok(R.SIGNAL_LABELS[key], `signal "${key}" would render as a raw key`);
    }
  });
});

describe('it always says whether it has been checked', () => {
  test('with no calibration it says so, loudly, and names the command', () => {
    const html = R.signalsView(payload());
    assert.ok(/calbanner warn/.test(html));
    assert.ok(html.includes('not a probability'));
    assert.ok(html.includes('npm run backtest'));
  });

  test('with a calibration it reports the base rate and the failures', () => {
    const html = R.signalsView(payload({
      calibration: {
        generatedAt: new Date().toISOString(),
        universe: 100, years: 5, horizon: 21, bars: 900, baseRate: 0.061,
        definition: 'a large move is 2x its own trailing volatility',
        validated: ['coil'], failed: ['extension'],
        weights: { coil: 0.5, extension: 0 },
        scores: [
          { key: 'coil', verdict: 'validated', fires: 210, hitRate: 0.11, baseRate: 0.061, lift: 1.8 },
          { key: 'extension', verdict: 'failed', fires: 180, hitRate: 0.05, baseRate: 0.061, lift: 0.82 },
        ],
      },
    }));
    assert.ok(/calbanner ok/.test(html));
    assert.ok(html.includes('6.1%'), 'the base rate must be on screen');
    assert.ok(html.includes('v-failed'), 'a failed signal must be shown as failed');
    assert.ok(html.includes('zero weight'), 'must explain what happens to a failed signal');
    assert.ok(html.includes('1.80'), 'lift must be reported');
  });
});

describe('the empty state explains itself rather than looking broken', () => {
  const empty = (diagnosis) => R.signalsView({
    counts: { total: 236, readable: 0, unreadable: 236, firing: 0 },
    calibration: null,
    rows: [],
    diagnosis,
  });

  test('before any scan, it says to refresh', () => {
    const html = empty({ everScanned: false, offline: true, sources: [] });
    assert.ok(html.includes('No row has recorded price history yet'));
    assert.ok(html.includes('236'));
    assert.ok(/Refresh/.test(html), 'must say what action fixes it');
    assert.strictEqual(count(html, /class="sigcard"/g), 0);
  });

  test('AFTER a scan it does not tell you to do the thing you already did', () => {
    // "Hit Refresh" is useless advice to somebody who already refreshed, and
    // that is exactly the state this landed in on a real machine.
    const html = empty({
      everScanned: true,
      offline: false,
      scannedAt: new Date().toISOString(),
      sources: [
        { id: 'equities', label: 'Equities & ETFs', status: 'failed', rows: 0, problem: 'HTTP 401 Invalid Cookie' },
        { id: 'crypto', label: 'Crypto assets', status: 'ok', rows: 900, problem: null },
      ],
    });
    assert.ok(/scan DID run/.test(html), 'must acknowledge a scan already happened');
    assert.ok(html.includes('Equities &amp; ETFs') || html.includes('Equities & ETFs'));
    assert.ok(html.includes('HTTP 401 Invalid Cookie'), 'the real provider error must reach the screen');
    assert.ok(html.includes('npm run doctor'), 'must point at the tool that diagnoses it');
  });

  test('a source that answered but gave nothing usable is named as such', () => {
    const html = empty({
      everScanned: true,
      offline: false,
      sources: [{ id: 'equities', label: 'Equities & ETFs', status: 'ok', rows: 190, problem: null }],
    });
    assert.ok(/returned no usable price history/.test(html),
      'a source that succeeded but delivered no history is the confusing case and must be called out');
  });

  test('it still renders with no diagnosis at all', () => {
    const html = R.signalsView({
      counts: { total: 5, readable: 0, unreadable: 5, firing: 0 }, calibration: null, rows: [],
    });
    assert.ok(html.includes('No row has recorded price history yet'));
  });
});

describe('direction is presented honestly', () => {
  test('a mechanical lean is shown with its reason', () => {
    const html = R.signalsView(payload());
    assert.ok(/siglean up/.test(html));
    assert.ok(html.includes('Forced buying has a direction'));
  });

  test('no lean renders as "no direction", not as a blank', () => {
    const html = R.signalsView(payload({
      rows: [{ ...CARD, lean: { direction: 'none', strength: 0, why: 'No mechanically directional signal is firing.' } }],
    }));
    assert.ok(html.includes('no direction'));
    assert.ok(html.includes('No mechanically directional signal is firing'));
  });
});

describe('user-supplied text cannot inject markup', () => {
  test('a hostile name is escaped', () => {
    const html = R.signalsView(payload({
      rows: [{ ...CARD, name: '<img src=x onerror=alert(1)>', symbol: '"><script>bad()</script>' }],
    }));
    assert.ok(!html.includes('<img src=x'), 'unescaped markup reached the page');
    assert.ok(!html.includes('<script>bad()'), 'unescaped script reached the page');
  });

  test('so is hostile evidence text, which comes from source data', () => {
    const html = R.signalsView(payload({
      rows: [{ ...CARD, fired: [{ key: 'coil', strength: 0.5, evidence: ['<b>not bold</b>'] }] }],
    }));
    assert.ok(!html.includes('<b>not bold</b>'));
  });
});
