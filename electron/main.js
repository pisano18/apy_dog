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
const T = require('../src/core/tracks');
const { EVENT_INFO } = require('../src/core/catalyst');
const tax = require('../src/core/tax');
const { toCSV, toJSON } = require('../src/core/export');

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
      events: result.events || [],
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

/**
 * Re-score in place without refetching, used when tax or appetite settings
 * change. Ratings and movement reads derive from the scores, so they are rebuilt
 * here too; leaving them stale would show a grade that no longer matches its own
 * risk number.
 */
function rescore() {
  if (!dataset.opportunities.length) return;
  const { rate } = require('../src/core/rating');
  const { readMovement } = require('../src/core/movement');
  dataset.opportunities = scoreAll(dataset.opportunities, {
    riskFree: dataset.meta?.riskFree ?? 4.0,
    appetite: store.settings.riskAppetite ?? 45,
    taxProfile: store.settings.tax || {},
    basis: store.settings.rankingBasis || 'afterTax',
    horizonDays: store.settings.horizonDays ?? null,
    amount: store.settings.budget ?? 10000,
  }).map((o) => ({
    ...o,
    rating: rate(o),
    movement: o.track === T.TRACK.INCOME
      ? null
      : readMovement(o, { events: o.events || [], horizonDays: store.settings.movementHorizonDays ?? 30 }),
  }));
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
      // The movement-track vocabulary the renderer needs to label things.
      TRACK: T.TRACK,
      TRACK_LABELS: T.TRACK_LABELS,
      RATING_AXES: T.AXES,
      GRADES: T.GRADE.map((g) => ({ key: g.key, color: g.color, headline: g.headline, detail: g.detail })),
      SETUP_INFO: T.SETUP_INFO,
      SEVERITY: T.SEVERITY,
      CLARITY: T.CLARITY,
      EVENT_INFO,
      STATE_TOP_RATES: tax.STATE_TOP_RATES,
      FEDERAL_ORDINARY_BRACKETS: tax.FEDERAL_ORDINARY_BRACKETS,
      FEDERAL_LTCG_BRACKETS: tax.FEDERAL_LTCG_BRACKETS,
      DEFAULT_QUERY,
    },
    hasData: dataset.opportunities.length > 0,
    meta: dataset.meta,
    health: dataset.health,
    events: dataset.events || [],
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

  /**
   * Measure a single row on demand.
   *
   * The equities source indexes the whole US market cheaply but only analyses a
   * priority subset, because ten thousand price fetches per refresh is not a
   * reasonable thing to do to anyone's machine or to Yahoo. Opening an unmeasured
   * row promotes just that one.
   */
  handle('data:measure', async (id) => {
    const o = dataset.opportunities.find((x) => x.id === id);
    if (!o) throw new Error('Not found in the current scan.');
    const adapter = adapters.find((a) => a.id === o.source);
    if (typeof adapter?.fetchOne !== 'function') throw new Error(`${o.sourceLabel || o.source} cannot measure a single row.`);
    const ctx = {
      http: require('../src/core/http'),
      cache,
      schema: require('../src/core/schema'),
      C,
      settings: store.settings,
      seedDir: path.join(__dirname, '..', 'data', 'seed'),
      now: Date.now(),
      log: () => {},
    };
    const fresh = await adapter.fetchOne(o.symbol || o.id, ctx);
    if (!fresh) throw new Error('No data came back for that one.');
    const i = dataset.opportunities.findIndex((x) => x.id === id);
    if (i >= 0) dataset.opportunities[i] = { ...dataset.opportunities[i], ...fresh, measured: true };
    rescore();
    return true;
  });

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
    fs.writeFileSync(filePath, toCSV(rows, { meta: dataset.meta }));
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
    fs.writeFileSync(filePath, toJSON(rows, { meta: dataset.meta }));
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
      filterBarItems: document.querySelectorAll('#filterbar > *').length,
      trackButtons: document.querySelectorAll('#trackswitch button').length,
      trackCounts: document.querySelector('#n-all').textContent,
      desc: (document.querySelector('#res-desc') || {}).textContent || '',
      title: document.title,
      bodyText: document.body.innerText.slice(0, 180),
    }))()`);
  } catch (err) {
    errors.push(`executeJavaScript failed: ${err.message}`);
    report = {};
  }

  const outDir = path.join(__dirname, '..', 'build');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'smoke.png'), (await win.webContents.capturePage()).toPNG());
  } catch (err) {
    errors.push(`screenshot failed: ${err.message}`);
  }

  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    try { fs.writeFileSync(path.join(outDir, `smoke-${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch { /* best effort */ }
  };

  // A table that renders but cannot open a row is broken.
  try {
    await js("document.querySelector('#tablewrap tbody tr')?.click(); true");
    await wait(700);
    report.drawerSections = await js("document.querySelectorAll('#drawer .dsection').length");
    await shot('detail');
    if (!report.drawerSections) failuresLate.push('detail drawer did not open');
  } catch (err) {
    failuresLate.push(`drawer check failed: ${err.message}`);
  }

  // The movement track must render a genuinely different set of columns; that
  // separation is the whole point of the rework.
  try {
    await js("document.querySelector('#trackswitch button[data-track=\"movement\"]').click(); true");
    await wait(800);
    report.movementRows = await js("document.querySelectorAll('#tablewrap tbody tr').length");
    report.movementHeaders = await js("Array.from(document.querySelectorAll('#tablewrap thead th')).map(t=>t.textContent.trim().replace(/[▲▼]/g,'')).join('|')");
    await shot('movement');
    if (!report.movementRows) failuresLate.push('movement track rendered no rows');
    if (!/Heat/.test(report.movementHeaders || '')) failuresLate.push('movement track is not showing movement columns');
    if (!/Catalyst|catalyst/.test(report.movementHeaders || '')) failuresLate.push('movement track has no catalyst column');
  } catch (err) {
    failuresLate.push(`track switch failed: ${err.message}`);
  }

  // Filters: open the picker, add one, confirm it becomes a pill and narrows the
  // list, then confirm Clear all provably resets it.
  try {
    await js("document.querySelector('#trackswitch button[data-track=\"income\"]').click(); true");
    await wait(600);
    const before = await js("document.querySelectorAll('#tablewrap tbody tr').length");

    await js("document.querySelector('#filterbar [data-act=\"open-filter-menu\"]').click(); true");
    await wait(350);
    report.filterMenuOptions = await js("document.querySelectorAll('#fmenu .opt').length");
    await shot('filtermenu');
    if (!report.filterMenuOptions) failuresLate.push('filter picker listed no filters');

    await js("document.querySelector('#fmenu .opt[data-key=\"insuredOnly\"]').click(); true");
    await wait(800);
    const after = await js("document.querySelectorAll('#tablewrap tbody tr').length");
    report.pillCount = await js("document.querySelectorAll('#filterbar .fpill').length");
    report.rowsBeforeFilter = before;
    report.rowsAfterFilter = after;
    if (!report.pillCount) failuresLate.push('adding a filter did not produce a pill');
    if (!(after > 0 && after < before)) failuresLate.push(`the insured-only filter did not narrow the list (${before} -> ${after})`);

    await js("document.querySelector('#filterbar [data-act=\"clear-filters\"]').click(); true");
    await wait(600);
    const cleared = await js("document.querySelectorAll('#tablewrap tbody tr').length");
    report.rowsAfterClear = cleared;
    if (cleared !== before) failuresLate.push(`Clear all did not restore the list (${before} -> ${cleared})`);
  } catch (err) {
    failuresLate.push(`filter round trip failed: ${err.message}`);
  }

  // Presets set a whole query at once.
  try {
    await js("document.querySelector('#filterbar [data-act=\"open-presets\"]').click(); true");
    await wait(300);
    report.presetCount = await js("document.querySelectorAll('#fmenu .opt').length");
    if (!report.presetCount) failuresLate.push('no presets offered');
    await js("document.querySelector('#fmenu .opt')?.click(); true");
    await wait(700);
    report.rowsAfterPreset = await js("document.querySelectorAll('#tablewrap tbody tr').length");
    await shot('preset');
    await js("document.querySelector('#filterbar [data-act=\"clear-filters\"]')?.click(); true");
    await wait(400);
  } catch (err) {
    failuresLate.push(`preset check failed: ${err.message}`);
  }

  // Watch something so the watchlist pane has real content.
  try {
    await js("document.querySelector('#tablewrap tbody tr .star[data-act=\"watch\"]').click(); true");
    await wait(600);
    report.watchCount = await js("document.querySelector('#watch-count').textContent");
    if (report.watchCount !== '1') failuresLate.push(`starring did not update the watchlist (${report.watchCount})`);
  } catch (err) {
    failuresLate.push(`watch toggle failed: ${err.message}`);
  }

  // Every other view. A pane that throws on render is invisible from Find alone.
  for (const view of ['events', 'sources', 'settings', 'watch']) {
    try {
      await js(`document.querySelector('.tab[data-view="${view}"]').click(); true`);
      await wait(500);
      const n = await js(`document.querySelector('#view-${view}').innerHTML.length`);
      report[`${view}Html`] = n;
      if (n < 400) failuresLate.push(`${view} pane rendered almost nothing (${n} chars)`);
      await shot(view);
    } catch (err) {
      failuresLate.push(`${view} pane failed: ${err.message}`);
    }
  }

  try {
    await js("document.querySelector('.tab[data-view=\"find\"]').click(); document.documentElement.dataset.theme='dark'; true");
    await wait(400);
    await shot('dark');
  } catch (err) {
    failuresLate.push(`dark theme render failed: ${err.message}`);
  }

  const failures = [...failuresLate];
  if (!report.rows) failures.push('no table rows rendered');
  if (!report.headers) failures.push('no table headers rendered');
  if (!report.trackButtons) failures.push('track switch did not render');
  if (!report.filterBarItems) failures.push('filter bar rendered nothing');
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
