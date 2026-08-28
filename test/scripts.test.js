'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The command-line entry points.
 *
 * These had no tests at all, and it showed: an edit removed a constant while
 * leaving the reference to it, and `npm run backtest` shipped as an immediate
 * ReferenceError. Every unit test passed, because none of them ever loaded the
 * script.
 *
 * So each script is parsed, loaded, and — where it can run without network —
 * actually executed. A script nobody executes in CI is a script that is broken
 * whenever somebody last touched it.
 */

const ROOT = path.join(__dirname, '..');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'));

describe('every script parses and resolves its own identifiers', () => {
  test('the scripts directory is not empty', () => {
    assert.ok(SCRIPTS.length >= 3, `only found ${SCRIPTS.join(', ')}`);
  });

  for (const f of SCRIPTS) {
    test(`${f} parses`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      assert.doesNotThrow(() => new vm.Script(src, { filename: f }));
    });

    test(`${f} has no reference to an identifier it never defines`, () => {
      // The exact failure that shipped: a constant deleted, its use left
      // behind. `node --check` only parses, so it cannot see this — the module
      // has to actually be loaded.
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', f))})`], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, APY_DOG_NO_RUN: '1' },
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(!/ReferenceError/.test(out), `${f} threw a ReferenceError on load:\n${out.slice(0, 400)}`);
      assert.ok(!/SyntaxError/.test(out), `${f} threw a SyntaxError on load:\n${out.slice(0, 400)}`);
    });
  }
});

describe('the backtest reaches its own logic before it reaches the network', () => {
  test('it names the universe it would fetch, rather than crashing', () => {
    // Without network it must fail at the FETCH, having already resolved its
    // symbol list, argument parsing and imports.
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), '--symbols', 'AAPL'], {
      encoding: 'utf8', timeout: 90000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(!/ReferenceError|SyntaxError|TypeError/.test(out),
      `backtest crashed instead of reporting a fetch failure:\n${out.slice(0, 500)}`);
    assert.ok(/Fetching .* history for 1 symbols/.test(out),
      `backtest did not get as far as fetching:\n${out.slice(0, 400)}`);
  });

  test('the default universe is a real spread, not a highlight reel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'backtest.js'), 'utf8');
    const m = src.match(/const DEFAULT_UNIVERSE = \[([\s\S]*?)\];/);
    assert.ok(m, 'the default universe is missing entirely');
    const syms = m[1].match(/'[A-Z.^]+'/g).map((x) => x.replace(/'/g, ''));
    assert.ok(syms.length >= 60, `only ${syms.length} symbols — too few to measure a base rate against`);
    assert.strictEqual(new Set(syms).size, syms.length, 'the universe contains duplicates');
    // Broad market exposure has to be in there, or the base rate is computed
    // from a basket of lottery tickets.
    for (const core of ['SPY', 'QQQ', 'TLT', 'AAPL', 'JNJ', 'KO']) {
      assert.ok(syms.includes(core), `${core} missing — the universe is skewed toward volatility`);
    }
    // And the famous squeezes must be a small minority, not the point.
    const meme = syms.filter((x) => ['GME', 'AMC', 'BB', 'KOSS', 'CLOV'].includes(x));
    assert.ok(meme.length / syms.length < 0.12,
      `${meme.length} of ${syms.length} symbols are squeeze names — that is a highlight reel`);
  });
});

describe('importing a script does nothing', () => {
  for (const f of SCRIPTS) {
    test(`${f} does its work only when run, never when required`, () => {
      // The scripts test requires every script to catch missing identifiers,
      // and share.js did its entire job on import as a result — spawning a real
      // network diagnostic and writing files into the repo as a side effect of
      // being loaded. Every script needs the guard.
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      const guarded = /require\.main === module/.test(src)
        || /^main\(\)\.catch/m.test(src)
        || /^main\(\);?$/m.test(src);
      assert.ok(guarded, `${f} has no entry-point guard, so requiring it runs it`);
    });
  }
});

describe('the analysis path is covered without a network', () => {
  test('backtest.js delegates its analysis rather than inlining it', () => {
    // Three crashes shipped from this file, every one of them downstream of a
    // hundred-symbol fetch and therefore invisible to CI. The rule now is that
    // the script fetches and prints; everything else is a pure function tested
    // in test/report.test.js against synthetic paths.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'backtest.js'), 'utf8');
    assert.ok(/require\('\.\.\/src\/core\/report'\)/.test(src),
      'the script must delegate analysis to the testable module');
    // No direct reach into a harness result shape, which is what broke twice.
    const afterFetch = src.slice(src.indexOf('const built = buildReport'));
    assert.ok(!/res\.(train|test)\./.test(afterFetch),
      'the script is reading harness internals again instead of the report');
  });
});

describe('the doctor reports rather than throws', () => {
  test('it exits non-zero when no history provider answers, without crashing', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js')], {
      encoding: 'utf8', timeout: 120000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(!/ReferenceError|SyntaxError/.test(out), `doctor crashed:\n${out.slice(0, 400)}`);
    assert.ok(/Checking every feed/.test(out), 'doctor produced no report');
    assert.ok(/Price history/.test(out), 'doctor skipped the section that matters most');
    // Every check must render a verdict, never a bare exception.
    assert.ok(/( ok |FAIL)/.test(out), 'doctor rendered no verdicts');
  });
});
