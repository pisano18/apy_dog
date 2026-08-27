#!/usr/bin/env node
'use strict';

/**
 * Headless scan: the same pipeline the desktop app runs, printed to a terminal.
 *
 * Useful for three things: checking a source without launching the GUI, running
 * APY Dog on a machine with no display, and piping results somewhere else.
 *
 *   node scripts/scan.js                          top 25 by risk-adjusted score
 *   node scripts/scan.js --sort apy --limit 40    highest raw APY
 *   node scripts/scan.js --offline                bundled snapshot only
 *   node scripts/scan.js --min-apy 6 --insured    filtered
 *   node scripts/scan.js --json > out.json        machine readable
 */

const os = require('node:os');
const path = require('node:path');
const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { applyQuery, describeQuery, DEFAULT_QUERY } = require('../src/core/filters');
const { Cache } = require('../src/core/cache');
const { Store } = require('../src/core/store');
const C = require('../src/core/constants');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (has('--help') || has('-h')) {
  console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const dataDir = val('--data', path.join(os.homedir(), '.apy-dog'));
const asJson = has('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

const C_ = { dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const useColor = process.stdout.isTTY && !has('--no-color');
const c = (code, s) => (useColor ? `${C_[code]}${s}${C_.reset}` : String(s));

(async () => {
  const store = new Store(dataDir);
  const cache = new Cache(path.join(dataDir, 'cache'));
  const { adapters, problems } = loadAdapters({ log: (m) => log(c('yellow', `[sources] ${m}`)) });

  if (!adapters.length) {
    console.error('No source adapters loaded. Problems:', problems);
    process.exit(1);
  }
  for (const p of problems) log(c('red', `[sources] ${p.file}: ${p.error}`));

  const offline = has('--offline');
  log(c('bold', `\nAPY Dog — scanning ${adapters.length} sources${offline ? ' (offline)' : ''}…\n`));

  const result = await aggregate(adapters, {
    settings: store.settings,
    cache,
    offline,
    dismissed: store.state.dismissed,
    onProgress: (e) => {
      if (e.type === 'source_done') {
        const colour = e.status === 'ok' ? 'green' : e.status === 'failed' ? 'red' : 'yellow';
        log(`  ${c(colour, '●')} ${e.label.padEnd(38)} ${String(e.count).padStart(5)} rows  ${c('dim', `${e.ms}ms  ${e.status}`)}`);
      }
    },
  });

  const query = {
    ...DEFAULT_QUERY,
    sortBy: val('--sort', 'dogScore'),
    limit: Number(val('--limit', 25)),
    minApy: val('--min-apy') ? Number(val('--min-apy')) : null,
    maxApy: val('--max-apy') ? Number(val('--max-apy')) : null,
    maxRisk: val('--max-risk') ? Number(val('--max-risk')) : null,
    assetClasses: val('--class') ? val('--class').split(',') : [],
    insuredOnly: has('--insured'),
    hideTraps: !has('--show-traps'),
    includeSpeculative: has('--speculative') || has('--only-speculative'),
    onlySpeculative: has('--only-speculative'),
    termMaxDays: val('--max-days') ? Number(val('--max-days')) : null,
    minInvestmentMax: val('--budget') ? Number(val('--budget')) : null,
    text: val('--search', ''),
  };

  const rows = applyQuery(result.opportunities, query);

  if (asJson) {
    process.stdout.write(JSON.stringify({ meta: result.meta, health: result.health, rows }, null, 2));
    return;
  }

  const m = result.meta;
  log(`\n${c('dim', '─'.repeat(120))}`);
  log(`${c('bold', rows.length)} shown of ${m.total} found · risk-free ${m.riskFree.toFixed(2)}% (${m.riskFreeSource}) · ` +
      `${c('green', `${m.liveRows} live`)} / ${c('yellow', `${m.seedRows} snapshot`)} · ${describeQuery(query)}`);
  log(c('dim', '─'.repeat(120)));

  const head = ['', 'OPPORTUNITY', 'APY', 'AFTER TAX', 'SCORE', 'RISK', 'FLAGS', 'LOCKED', 'ACCESS', 'MIN'];
  const widths = [3, 44, 9, 10, 6, 13, 6, 8, 9, 10];
  log(c('dim', head.map((h, i) => h.padEnd(widths[i])).join(' ')));

  rows.forEach((o, i) => {
    const spec = o.yieldKind === C.YIELD_KIND.EXPECTED;
    const rate = spec ? o.expected?.annualReturn : o.apy?.total;
    const rateStr = Number.isFinite(rate) ? `${spec ? '~' : ''}${rate.toFixed(2)}%` : '—';
    const rateCol = spec ? 'cyan' : rate >= 8 ? 'green' : 'reset';
    const tier = o.risk?.tierLabel || '—';
    const tierCol = (o.risk?.score ?? 100) < 22 ? 'green' : (o.risk?.score ?? 100) < 42 ? 'yellow' : 'red';
    const nFlags = (o.trapFlags || []).length;
    const flagCol = o.scores?.traps?.verdict === 'likely_trap' ? 'red' : nFlags ? 'yellow' : 'dim';
    const name = (o.name.length > 42 ? `${o.name.slice(0, 41)}…` : o.name) + (o.seed ? c('dim', ' ▪') : '');

    log([
      c('dim', String(i + 1).padStart(3)),
      name.padEnd(widths[1] + (o.seed && useColor ? 9 : 0)),
      c(rateCol, rateStr.padStart(8)) + ' ',
      (Number.isFinite(o.tax?.afterTaxApy) ? `${o.tax.afterTaxApy.toFixed(2)}%` : '—').padStart(9) + ' ',
      String(Math.round(o.scores?.dogScore ?? 0)).padStart(5) + ' ',
      c(tierCol, tier.padEnd(12)) + ' ',
      c(flagCol, (nFlags ? `⚑${nFlags}` : '·').padEnd(5)) + ' ',
      (['locked', 'notice', 'illiquid'].includes(o.liquidity) ? (o.term?.label || 'Notice') : 'Open').padEnd(7) + ' ',
      (o.liquidity || '').padEnd(8) + ' ',
      (Number.isFinite(o.minInvestment) ? `$${Math.round(o.minInvestment).toLocaleString()}` : '—').padStart(9),
    ].join(' '));
  });

  log(`\n${c('dim', '▪ = bundled snapshot, not a live quote. ⚑ = warning flags; open the app for the reasons.')}`);

  const failed = result.health.filter((h) => h.status === 'failed');
  if (failed.length) {
    log(c('red', `\n${failed.length} source(s) failed:`));
    for (const f of failed) for (const w of f.warnings) log(c('red', `  · ${w}`));
  }
  log('');
})().catch((err) => {
  console.error('scan failed:', err);
  process.exit(1);
});
