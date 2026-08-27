'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadAdapters, describeAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { applyQuery, facets, describeQuery, DEFAULT_QUERY } = require('../src/core/filters');
const { scoreAll } = require('../src/core/score');
const { Store } = require('../src/core/store');
const { Cache } = require('../src/core/cache');
const { History } = require('../src/core/history');
const C = require('../src/core/constants');
const tax = require('../src/core/tax');

/**
 * Electron main process.
 *
 * All network access and all disk access happen here. The renderer is a sandboxed
 * view with no Node integration at all — it can only reach the narrow, explicit
 * IPC surface defined below. That is deliberate: this app fetches from a dozen
 * third-party endpoints, and none of that content should ever be a step away from
 * the filesystem.
 *
 * It also means no CORS. A web page cannot call the Yahoo or Treasury endpoints
 * directly; a desktop app can. That is the whole reason this is an Electron app.
 */

const isDev = process.argv.includes('--dev');
// Boot, render, capture a screenshot, exit. Lets CI (and a headless box) prove
// the whole app actually starts rather than only that the modules parse.
const isSmoke = process.argv.includes('--smoke');

// A smoke run gets its own throwaway user-data directory. Otherwise it both
// reads and writes the real one, which makes it order-dependent (a star click
// un-stars whatever the last run starred) and quietly stomps a user's settings.
if (isSmoke) {
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'apy-dog-smoke-'));
  app.setPath('userData', tmp);
  app.setPath('sessionData', tmp);
  console.log(`[smoke] isolated userData: ${tmp}`);
}

let win = null;
let store = null;
let cache = null;
let history = null;
let adapters = [];
let adapterProblems = [];

/** The most recent full scan, held in memory so filtering is instant. */
let dataset = { opportunities: [], health: [], meta: null };
let refreshing = false;
let refreshAbort = null;
let autoTimer = null;

const userDataDir = () => app.getPath('userData');

function initState() {
  const dir = userDataDir();
  store = new Store(dir);
  cache = new Cache(path.join(dir, 'cache'));
  history = new History(path.join(dir, 'history'));
  if (!store.settings.userRatesPath) {
    store.updateSettings({ userRatesPath: path.join(dir, 'user-rates.json') });
  }
  const loaded = loadAdapters({ log: (m) => console.warn('[sources]', m) });
  adapters = loaded.adapters;
  adapterProblems = loaded.problems;
  if (adapterProblems.length) console.warn('[sources] problems:', adapterProblems);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 640,
    title: 'APY Dog',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1116' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // External links open in the real browser, never in an app window. Several of
  // these are bank and brokerage sites; they belong somewhere the user can see
  // the address bar and the padlock.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });

  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function doRefresh({ offline = false } = {}) {
  if (refreshing) return { ok: false, reason: 'A refresh is already running.' };
  refreshing = true;
  refreshAbort = new AbortController();
  const startedAt = Date.now();

  try {
    send('refresh:progress', { type: 'start', total: adapters.length });
    const result = await aggregate(adapters, {
      settings: store.settings,
      cache,
      seedDir: path.join(__dirname, '..', 'data', 'seed'),
      offline: offline || store.settings.offlineMode,
      signal: refreshAbort.signal,
      dismissed: store.state.dismissed,
      onProgress: (evt) => send('refresh:progress', evt),
    });

    dataset = result;

    // Record history and evaluate alerts only on a real scan, so an offline
    // reload of the same seed data does not manufacture a fake time series.
    if (!result.meta.offline) {
      try { history.record(result.opportunities); } catch (e) { console.warn('[history]', e.message); }
    }

    let fired = [];
    try { fired = store.evaluateAlerts(result.opportunities); } catch (e) { console.warn('[alerts]', e.message); }
    if (fired.length && Notification.isSupported()) {
      const top = fired.slice(0, 3);
      new Notification({
        title: fired.length === 1 ? 'APY Dog found something' : `APY Dog: ${fired.length} alerts`,
        body: top.map((f) => f.message).join('\n'),
      }).show();
    }

    send('data:updated', {
      meta: result.meta,
      health: result.health,
      alerts: fired.map((f) => ({ message: f.message, id: f.opportunity?.id })),
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, meta: result.meta };
  } catch (err) {
    console.error('[refresh]', err);
    send('refresh:progress', { type: 'error', message: err?.message || String(err) });
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    refreshing = false;
    refreshAbort = null;
  }
}

function rescheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  const mins = Number(store.settings.autoRefreshMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return;
  autoTimer = setInterval(() => {
    if (!refreshing) doRefresh().catch((e) => console.warn('[auto-refresh]', e.message));
  }, Math.max(5, mins) * 60000);
}

/** Re-score in place without refetching — used when tax/appetite settings change. */
function rescore() {
  if (!dataset.opportunities.length) return;
  dataset.opportunities = scoreAll(dataset.opportunities, {
    riskFree: dataset.meta?.riskFree ?? 4.0,
    appetite: store.settings.riskAppetite ?? 45,
    taxProfile: store.settings.tax || {},
    basis: store.settings.rankingBasis || 'afterTax',
    horizonDays: store.settings.horizonDays ?? null,
    amount: store.settings.budget ?? 10000,
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  handle('app:bootstrap', () => ({
    settings: store.settings,
    watchlist: store.watchlist,
    alerts: store.alerts,
    dismissed: store.state.dismissed,
    sources: describeAdapters(adapters),
    sourceProblems: adapterProblems,
    constants: {
      ASSET_CLASS: C.ASSET_CLASS,
      ASSET_CLASS_LABELS: C.ASSET_CLASS_LABELS,
      LIQUIDITY: C.LIQUIDITY,
      RISK_TIER: C.RISK_TIER,
      TAX_TREATMENT: C.TAX_TREATMENT,
      TRAP_FLAG_TEXT: C.TRAP_FLAG_TEXT,
      YIELD_KIND: C.YIELD_KIND,
      TERM_PRESETS: C.TERM.presets,
      STATE_TOP_RATES: tax.STATE_TOP_RATES,
      FEDERAL_ORDINARY_BRACKETS: tax.FEDERAL_ORDINARY_BRACKETS,
      FEDERAL_LTCG_BRACKETS: tax.FEDERAL_LTCG_BRACKETS,
      DEFAULT_QUERY,
    },
    hasData: dataset.opportunities.length > 0,
    meta: dataset.meta,
    health: dataset.health,
    version: app.getVersion(),
    platform: process.platform,
    paths: { userData: userDataDir(), history: history.file, userRates: store.settings.userRatesPath },
  }));

  handle('data:query', (query = {}) => {
    const q = { ...query, watchlist: store.watchlistIds() };
    const rows = applyQuery(dataset.opportunities, q);
    const ids = rows.slice(0, 400).map((r) => r.id);
    let changes = {};
    try { changes = history.changes(ids, { days: 30 }); } catch { /* history is optional */ }
    return {
      rows: rows.slice(0, 1000),
      total: rows.length,
      facets: facets(dataset.opportunities, q),
      description: describeQuery(q),
      changes,
      meta: dataset.meta,
    };
  });

  handle('data:detail', (id) => {
    const o = dataset.opportunities.find((x) => x.id === id);
    if (!o) return null;
    let series = [];
    try { series = history.seriesFor(id, { days: 365 }); } catch { /* optional */ }
    return { opportunity: o, series };
  });

  handle('data:refresh', (opts) => doRefresh(opts || {}));
  handle('data:cancelRefresh', () => {
    if (refreshAbort) { refreshAbort.abort(new Error('cancelled by user')); return true; }
    return false;
  });
  handle('data:health', () => ({ health: dataset.health, meta: dataset.meta, problems: adapterProblems }));

  handle('settings:get', () => store.settings);
  handle('settings:update', (patch) => {
    const before = JSON.stringify({ t: store.settings.tax, a: store.settings.riskAppetite, b: store.settings.rankingBasis, h: store.settings.horizonDays, m: store.settings.budget });
    const next = store.updateSettings(patch);
    const after = JSON.stringify({ t: next.tax, a: next.riskAppetite, b: next.rankingBasis, h: next.horizonDays, m: next.budget });
    // Only the scoring inputs need a re-score; a theme change does not.
    if (before !== after) rescore();
    if (patch.autoRefreshMinutes !== undefined) rescheduleAuto();
    return next;
  });
  handle('settings:reset', () => { const s = store.resetSettings(); rescore(); rescheduleAuto(); return s; });

  handle('watch:toggle', (id, name) => store.toggleWatch(id, name));
  handle('watch:note', (id, note) => store.setWatchNote(id, note));
  handle('watch:list', () => store.watchlist);

  handle('alert:add', (spec) => store.addAlert(spec));
  handle('alert:remove', (id) => store.removeAlert(id));
  handle('alert:list', () => store.alerts);

  handle('row:dismiss', (id) => store.dismiss(id));
  handle('row:undismiss', (id) => store.undismiss(id));

  handle('tax:preview', (treatment, profile) => tax.effectiveRate(treatment, profile || store.settings.tax));

  handle('history:stats', () => history.stats());
  handle('cache:stats', () => cache.stats());
  handle('cache:clear', () => cache.clear());

  handle('shell:open', (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) { shell.openExternal(url); return true; }
    return false;
  });

  handle('export:csv', async (query = {}) => {
    const rows = applyQuery(dataset.opportunities, { ...query, watchlist: store.watchlistIds() });
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Export results',
      defaultPath: path.join(app.getPath('downloads'), `apy-dog-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, toCSV(rows));
    return { saved: true, path: filePath, rows: rows.length };
  });

  handle('export:json', async (query = {}) => {
    const rows = applyQuery(dataset.opportunities, { ...query, watchlist: store.watchlistIds() });
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Export results as JSON',
      defaultPath: path.join(app.getPath('downloads'), `apy-dog-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, JSON.stringify({ meta: dataset.meta, rows }, null, 2));
    return { saved: true, path: filePath, rows: rows.length };
  });

  handle('userRates:open', () => {
    const p = store.settings.userRatesPath;
    if (!p) return false;
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify({
        _comment: 'Your own rates. Same shape as data/seed/savings.json. Rows with an id matching a bundled row replace it; new ids are added. Edit, save, then Refresh in APY Dog.',
        items: [],
      }, null, 2));
    }
    shell.openPath(p);
    return true;
  });
}

function toCSV(rows) {
  const cols = [
    ['Name', (o) => o.name],
    ['Symbol', (o) => o.symbol ?? ''],
    ['Category', (o) => C.ASSET_CLASS_LABELS[o.assetClass] || o.assetClass],
    ['Source', (o) => o.sourceLabel || o.source],
    ['APY %', (o) => o.apy?.total ?? ''],
    ['Base APY %', (o) => o.apy?.base ?? ''],
    ['Reward APY %', (o) => o.apy?.reward ?? ''],
    ['Expected return %', (o) => o.expected?.annualReturn ?? ''],
    ['After-tax %', (o) => o.tax?.afterTaxApy ?? ''],
    ['Tax-equivalent %', (o) => o.tax?.taxEquivalentYield ?? ''],
    ['After-tax real %', (o) => o.tax?.afterTaxRealApy ?? ''],
    ['Dog score', (o) => o.scores?.dogScore ?? ''],
    ['Certainty equiv %', (o) => o.scores?.certaintyEquivalent ?? ''],
    ['Risk', (o) => o.risk?.score ?? ''],
    ['Risk tier', (o) => o.risk?.tierLabel ?? ''],
    ['Trap score', (o) => o.trapScore ?? ''],
    ['Trap flags', (o) => (o.trapFlags || []).join(' ')],
    ['Term', (o) => o.term?.label ?? ''],
    ['Term days', (o) => o.term?.days ?? ''],
    ['Liquidity', (o) => o.liquidity],
    ['Price', (o) => o.price ?? ''],
    ['Min investment', (o) => o.minInvestment ?? ''],
    ['Max investment', (o) => o.maxInvestment ?? ''],
    ['TVL/AUM', (o) => o.tvl ?? ''],
    ['Insurance', (o) => o.risk?.insurance ?? ''],
    ['Tax treatment', (o) => o.taxTreatment],
    ['Confidence', (o) => o.confidence ?? ''],
    ['Income yr1 on budget', (o) => o.scores?.incomeYear1 ?? ''],
    ['Data as of', (o) => o.dataAsOf ?? ''],
    ['Snapshot?', (o) => (o.seed ? 'bundled snapshot' : 'live')],
    ['How to buy', (o) => o.accessNotes ?? ''],
    ['URL', (o) => o.url ?? ''],
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => esc(c[0])).join(','),
    ...rows.map((o) => cols.map((c) => esc(c[1](o))).join(','))].join('\n');
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  initState();
  registerIpc();
  createWindow();
  rescheduleAuto();

  // Show bundled data immediately so the window is never empty, then go to the
  // network. An instantly-useful window that improves beats a spinner.
  await doRefresh({ offline: true });
  if (store.settings.refreshOnLaunch && !store.settings.offlineMode && !isSmoke) {
    doRefresh().catch((e) => console.warn('[launch refresh]', e.message));
  }

  if (isSmoke) return runSmokeTest();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { history.prune(); } catch { /* best effort */ } });

/**
 * Headless self-check: wait for the renderer, assert it actually rendered rows,
 * save a screenshot, report any console errors, and exit non-zero on failure.
 */
async function runSmokeTest() {
  const errors = [];
  const failuresLate = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));

  await new Promise((r) => setTimeout(r, 3500));

  let report;
  try {
    report = await win.webContents.executeJavaScript(`(() => ({
      rows: document.querySelectorAll('#tablewrap tbody tr').length,
      headers: document.querySelectorAll('#tablewrap thead th').length,
      sidebarGroups: document.querySelectorAll('#sidebar .fgroup').length,
      presets: document.querySelectorAll('#sidebar .preset').length,
      desc: (document.querySelector('#res-desc') || {}).textContent || '',
      title: document.title,
      bodyText: document.body.innerText.slice(0, 200),
    }))()`);
  } catch (err) {
    errors.push(`executeJavaScript failed: ${err.message}`);
    report = {};
  }

  const outDir = path.join(__dirname, '..', 'build');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke.png'), img.toPNG());
  } catch (err) {
    errors.push(`screenshot failed: ${err.message}`);
  }

  // Exercise the drawer too: a table that renders but cannot open a row is broken.
  try {
    await win.webContents.executeJavaScript(
      "document.querySelector('#tablewrap tbody tr')?.click(); true",
    );
    await new Promise((r) => setTimeout(r, 700));
    report.drawerSections = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#drawer .dsection').length",
    );
    const img2 = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-detail.png'), img2.toPNG());
  } catch (err) {
    errors.push(`drawer check failed: ${err.message}`);
  }

  // Watch something first, so the watchlist pane is exercised with real content
  // rather than its (correct, but uninformative) empty state.
  try {
    await win.webContents.executeJavaScript(
      "document.querySelector('#tablewrap tbody tr .star[data-act=\"watch\"]').click(); true",
    );
    await new Promise((r) => setTimeout(r, 600));
    report.watchCount = await win.webContents.executeJavaScript(
      "document.querySelector('#watch-count').textContent",
    );
    if (report.watchCount !== '1') failuresLate.push(`starring a row did not update the watchlist (count = ${report.watchCount})`);
  } catch (err) {
    failuresLate.push(`watch toggle failed: ${err.message}`);
  }

  // Every other view, and a filter round trip. A pane that throws on render is
  // invisible from the Find view alone, which is exactly how it ships broken.
  for (const view of ['sources', 'settings', 'watch']) {
    try {
      await win.webContents.executeJavaScript(
        `document.querySelector('.tab[data-view="${view}"]').click(); true`,
      );
      await new Promise((r) => setTimeout(r, 500));
      const n = await win.webContents.executeJavaScript(
        `document.querySelector('#view-${view}').innerHTML.length`,
      );
      report[`${view}Html`] = n;
      if (n < 400) failuresLate.push(`${view} pane rendered almost nothing (${n} chars)`);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `smoke-${view}.png`), img.toPNG());
    } catch (err) {
      failuresLate.push(`${view} pane failed: ${err.message}`);
    }
  }

  // Filters must actually filter, and a preset must actually change the count.
  try {
    await win.webContents.executeJavaScript(
      "document.querySelector('.tab[data-view=\"find\"]').click(); true",
    );
    await new Promise((r) => setTimeout(r, 400));
    const before = await win.webContents.executeJavaScript("document.querySelectorAll('#tablewrap tbody tr').length");
    await win.webContents.executeJavaScript(
      "document.querySelector('.preset[data-val=\"safe\"]').click(); true",
    );
    await new Promise((r) => setTimeout(r, 700));
    const after = await win.webContents.executeJavaScript("document.querySelectorAll('#tablewrap tbody tr').length");
    report.rowsBeforeFilter = before;
    report.rowsAfterSafePreset = after;
    if (!(after > 0 && after < before)) {
      failuresLate.push(`the "Safe & liquid" preset did not narrow the list (${before} -> ${after})`);
    }
  } catch (err) {
    failuresLate.push(`filter round trip failed: ${err.message}`);
  }

  // Dark theme has to render too; it is the default look for most people.
  try {
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'; true");
    await new Promise((r) => setTimeout(r, 350));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-dark.png'), img.toPNG());
  } catch (err) {
    failuresLate.push(`dark theme render failed: ${err.message}`);
  }

  const failures = [...failuresLate];
  if (!report.rows) failures.push('no table rows rendered');
  if (!report.headers) failures.push('no table headers rendered');
  if (!report.sidebarGroups) failures.push('no filter groups rendered');
  if (!report.drawerSections) failures.push('detail drawer did not open');
  failures.push(...errors);

  console.log('\n[smoke] ' + JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error('\n[smoke] FAILED:\n  - ' + failures.join('\n  - '));
    app.exit(1);
  } else {
    console.log('\n[smoke] PASS — screenshots in build/');
    app.exit(0);
  }
}

// Nothing in this app should ever open a second renderer or attach a webview.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
