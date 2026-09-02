#!/usr/bin/env node
'use strict';

/**
 * What can this machine actually reach, and what does each thing say when it
 * refuses.
 *
 * This exists because "0 ok, 105 failed" happened on a real machine and neither
 * the person running it nor the person who wrote it could tell whether that was
 * a firewall, an expired API contract, a rate limit or a bug. Every failure in
 * this app now has to name itself: which provider, which HTTP status, and the
 * first bytes of whatever came back.
 *
 *   npm run doctor              # every feed the app uses
 *   npm run doctor -- --json    # machine-readable, for pasting into a bug report
 *
 * It never writes anything and never needs a key.
 */

const http = require('../src/core/http');
const { fetchDaily, PROVIDERS, UA } = require('../src/core/history-providers');

const asJson = process.argv.includes('--json');
const log = asJson ? () => {} : (...a) => console.log(...a);

/** Every endpoint the app depends on, with what a healthy answer looks like. */
const CHECKS = [
  {
    id: 'sec-index',
    label: 'SEC company index',
    why: 'Every US-listed issuer. Free, no key. If this fails the Browse list loses its long tail.',
    url: 'https://www.sec.gov/files/company_tickers_exchange.json',
    as: 'json',
    ok: (d) => Array.isArray(d?.data) && d.data.length > 1000,
    describe: (d) => `${d.data.length.toLocaleString()} issuers`,
  },
  {
    id: 'treasury',
    label: 'US Treasury yield curve',
    why: 'The risk-free rate. Everything else is scored relative to it, so a failure here skews every ranking.',
    url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv',
    as: 'text',
    ok: (t) => String(t).split('\n').length > 3 && /date/i.test(String(t).slice(0, 200)),
    describe: (t) => `${String(t).trim().split('\n').length - 1} rows of curve`,
  },
  {
    id: 'coingecko',
    label: 'CoinGecko markets',
    why: 'All crypto pricing and 7-day series.',
    url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1',
    as: 'json',
    ok: (d) => Array.isArray(d) && d.length > 0 && d[0].current_price,
    describe: (d) => `${d.length} assets, top is ${d[0].symbol?.toUpperCase()} at $${d[0].current_price}`,
  },
  {
    id: 'defillama',
    label: 'DefiLlama pools',
    why: 'Every DeFi yield in the app.',
    url: 'https://yields.llama.fi/pools',
    as: 'json',
    ok: (d) => Array.isArray(d?.data) && d.data.length > 100,
    describe: (d) => `${d.data.length.toLocaleString()} pools`,
  },
  {
    id: 'edgar',
    label: 'SEC EDGAR filings feed',
    why: 'The Calendar\'s "what just happened" entries.',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=10&output=atom',
    as: 'text',
    ok: (t) => /<entry|<feed/i.test(String(t)),
    describe: () => 'feed parsed',
  },
];

async function runCheck(c) {
  const started = Date.now();
  try {
    const data = await http.request(c.url, {
      as: c.as, timeout: 20000, retries: 0, headers: { 'User-Agent': UA },
    });
    const good = c.ok(data);
    return {
      id: c.id,
      label: c.label,
      ok: good,
      ms: Date.now() - started,
      detail: good ? c.describe(data) : 'reachable, but the response was not the shape this app expects',
    };
  } catch (e) {
    return {
      id: c.id,
      label: c.label,
      ok: false,
      ms: Date.now() - started,
      status: e?.status ?? null,
      detail: String(e?.message || e).slice(0, 200),
      sample: String(e?.body || '').slice(0, 200).replace(/\s+/g, ' ').trim() || null,
    };
  }
}

/** Price history gets its own section: it is the one that failed for real. */
async function runHistory() {
  const symbols = ['AAPL', 'SPY', 'GME'];
  const out = [];
  for (const s of symbols) {
    for (const p of PROVIDERS) {
      const started = Date.now();
      const r = await fetchDaily(s, { years: 1, only: p.key });
      if (r.ok) {
        out.push({
          symbol: s, provider: p.key, label: p.label, ok: true, ms: Date.now() - started,
          detail: `${r.data.closes.length} daily bars, last close ${r.data.closes.at(-1)}`,
        });
      } else {
        const a = r.attempts[0] || {};
        out.push({
          symbol: s, provider: p.key, label: p.label, ok: false, ms: Date.now() - started,
          status: a.status ?? null, detail: a.message || 'failed', sample: a.sample || null,
        });
      }
    }
  }
  return out;
}

/** Turn a set of failures into the specific thing to do about them. */
function advise(feeds, hist) {
  const tips = [];
  const allDead = [...feeds, ...hist].every((r) => !r.ok);
  const histDead = hist.every((r) => !r.ok);
  const stooqOk = hist.some((r) => r.provider === 'stooq' && r.ok);
  const yahooDead = hist.filter((r) => r.provider === 'yahoo').every((r) => !r.ok);
  const has403 = [...feeds, ...hist].some((r) => r.status === 403 || r.status === 401);
  const has429 = [...feeds, ...hist].some((r) => r.status === 429);

  if (allDead) {
    tips.push('EVERYTHING failed, which almost never means every provider broke at once. '
      + 'Check whether you are behind a corporate proxy, a VPN, or a DNS filter — and whether this machine '
      + 'can reach the open internet at all right now.');
  }
  if (has429) {
    tips.push('Something returned 429 (too many requests). Wait a few minutes and run this again; '
      + 'the free tiers throttle by IP.');
  }
  const yahooOk = hist.some((r) => r.provider === 'yahoo' && r.ok);
  const stooqDead = hist.filter((r) => r.provider === 'stooq').every((r) => !r.ok);
  if (yahooOk && stooqDead) {
    tips.push('Stooq is serving a JavaScript bot challenge and Yahoo is answering. This is the normal state and '
      + 'nothing is wrong: the app tries Yahoo first and only falls back to Stooq if Yahoo is down. Price history '
      + 'works, and the backtest will run.');
  }
  if (yahooDead && stooqOk) {
    tips.push('Yahoo is refusing and Stooq is answering. The app will fall back to Stooq automatically, so price '
      + 'history still works — but Stooq carries no dividend data, so trailing yields on stock rows will stay as '
      + 'the bundled figures until Yahoo is reachable again.');
  }
  if (histDead) {
    tips.push('No price history provider answered, so Signals cannot be calibrated and charts will stay drawn '
      + 'rather than recorded. This is the one failure that matters most — paste this output into a bug report.');
  }
  if (has403 && !allDead) {
    tips.push('A 403 usually means the provider blocked the request rather than the network blocking the host. '
      + 'A VPN exit node shared with heavy scrapers is the usual cause.');
  }
  if (!tips.length) tips.push('Everything the app needs is reachable from here.');
  return tips;
}

async function main() {
  log('Checking every feed this app depends on. Nothing is written and no key is needed.\n');

  const feeds = [];
  for (const c of CHECKS) {
    const r = await runCheck(c);
    feeds.push(r);
    log(`${r.ok ? ' ok ' : 'FAIL'}  ${c.label.padEnd(28)} ${r.ok ? r.detail : `${r.status ? `HTTP ${r.status} — ` : ''}${r.detail}`}`);
    if (!r.ok && r.sample) log(`      server said: ${r.sample}`);
  }

  log('\nPrice history — the one that decides whether Signals can ever be calibrated:\n');
  const hist = await runHistory();
  for (const r of hist) {
    log(`${r.ok ? ' ok ' : 'FAIL'}  ${r.symbol.padEnd(6)} via ${r.label.padEnd(28)} ${r.ok ? r.detail : `${r.status ? `HTTP ${r.status} — ` : ''}${r.detail}`}`);
    if (!r.ok && r.sample) log(`      server said: ${r.sample}`);
  }

  // What the Signals view will actually be able to say, which is the question
  // behind almost every "why is this empty". A feed being reachable and a row
  // being readable are different facts: the detectors need recorded daily
  // closes, and a bundled row carries a drawn shape with no timescale at all.
  log('\nSignals — what the detectors can and cannot read:\n');
  try {
    const { loadAdapters } = require('../src/sources');
    const { aggregate } = require('../src/core/aggregate');
    const { signalsPayload } = require('../src/core/views');
    const { loadCalibration } = require('../src/core/calibration');
    const SIG = require('../src/core/signals');

    const { adapters } = loadAdapters();
    const data = await aggregate(adapters, { offline: true });
    const cal = loadCalibration({ maxAgeMs: 0 });
    const pay = signalsPayload(data, cal);

    log(` ok   calibration            ${cal
      ? `present — measured on ${(cal.universe || []).length} symbols over ${cal.years} years`
      : 'none — run npm run backtest; every pressure reading is labelled uncalibrated until you do'}`);
    log(`${pay.counts.readable ? ' ok ' : 'FAIL'}  readable rows          ${pay.counts.readable} of `
      + `${pay.counts.total} rows carry price history the detectors can use`);
    for (const r of pay.unreadableReasons || []) log(`      ${String(r.count).padStart(5)} — ${r.why}`);
    // Two different reasons a detector is on a guess, and saying the wrong one
    // is worse than saying nothing. With no calibration at all, every detector
    // is on a prior because nobody has run the backtest — not because the
    // backtest could not reach them. Only three are structurally unmeasurable.
    const unreachable = pay.onPriors.filter((k) => !SIG.MEASURABLE_BY_BACKTEST.includes(k));
    const unmeasured = pay.onPriors.filter((k) => SIG.MEASURABLE_BY_BACKTEST.includes(k));
    log(` ok   running on a guess     ${pay.onPriors.length
      ? pay.onPriors.join(', ')
      : 'nothing; every detector in play has been measured'}`);
    if (unreachable.length) {
      log(`      ${unreachable.join(', ')}: a backtest over closes has no short interest, event schedule or `
        + 'unlock calendar, so these can never be measured by it either way.');
    }
    if (unmeasured.length) {
      log(`      ${unmeasured.join(', ')}: measurable, but nothing has measured them yet — run npm run backtest.`);
    }
    log(`      note: this reads the BUNDLED data. Rows only become readable after a live refresh in the app, `
      + `which is why 0 here is normal and 0 in the app after a refresh is not.`);
  } catch (err) {
    log(`FAIL  signals check          ${err?.message || err}`);
  }

  const tips = advise(feeds, hist);
  log('\n' + '─'.repeat(76));
  for (const t of tips) log(`• ${t}`);
  log('─'.repeat(76));

  const okFeeds = feeds.filter((f) => f.ok).length;
  const okHist = hist.filter((h) => h.ok).length;
  log(`\n${okFeeds}/${feeds.length} feeds reachable · ${okHist}/${hist.length} history fetches succeeded`);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      proxyEnv: {
        HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || null,
        HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || null,
        NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || null,
      },
      feeds, history: hist, advice: tips,
    }, null, 2));
  }
  process.exit(okHist > 0 ? 0 : 1);
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
