'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadAdapters, describeAdapters } = require('../src/sources');
const { radarPayload, signalsPayload } = require('../src/core/views');
const { aggregate } = require('../src/core/aggregate');
const { applyQuery, facets, describeQuery, DEFAULT_QUERY } = require('../src/core/filters');
const { scoreAll } = require('../src/core/score');
const { Store } = require('../src/core/store');
const { Cache } = require('../src/core/cache');
const { History } = require('../src/core/history');
const C = require('../src/core/constants');
const T = require('../src/core/tracks');
const { EVENT_INFO } = require('../src/core/catalyst');
const K = require('../src/core/opportunity-kinds');
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
let deadlineTimer = null;
let tray = null;
let quitting = false;

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

async function doRefresh({ offline = false, only = null } = {}) {
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
      only,
      previous: only ? dataset : null,
      onProgress: (evt) => send('refresh:progress', evt),
    });

    // Record what actually came back, so cadence is measured from a real fetch
    // rather than from the attempt.
    for (const h of result.health) {
      if (!h.carried && h.count + (h.eventCount || 0) > 0) lastFetched.set(h.id, Date.now());
    }

    dataset = result;

    // Record history and evaluate alerts only on a real scan, so an offline
    // reload of the same seed data does not manufacture a fake time series.
    if (!result.meta.offline) {
      try { history.record(result.opportunities); } catch (e) { console.warn('[history]', e.message); }
    }

    const fired = runAlerts();
    if (tray) refreshTrayMenu();

    send('data:updated', {
      meta: result.meta,
      health: result.health,
      events: result.events || [],
      alerts: fired.map((f) => ({ message: f.message, id: f.opportunity?.id })),
      elapsedMs: Date.now() - startedAt,
      partial: !!only,
      refreshed: only || null,
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

/**
 * How often each feed is worth re-asking, in seconds.
 *
 * Refreshing everything on one timer is both slower and less current than
 * refreshing each source on its own cadence: crypto prices move by the second,
 * the Treasury curve publishes once a day, and a curated deposit list changes
 * about monthly. Polling the slow ones hard is wasted bandwidth; polling the
 * fast ones on the slow timer means the app is quietly stale.
 *
 * An adapter can override this by exporting ttlMs.
 */
const CADENCE = {
  // CoinGecko's free tier throttles by IP at roughly ten calls a minute, and a
  // full crypto scan is eight of them. At a 60-second cadence that is a
  // sustained 8/min against a 10/min ceiling, which earns a 429 within minutes
  // and then silently serves stale data — observed in the wild, not theorised.
  // Four minutes leaves comfortable headroom and is still far fresher than
  // anything a person acts on.
  crypto: 240,
  equities: 150,
  defillama: 300,
  filings: 420,
  funds: 900,
  speculative: 1800,
  treasury: 3600,
  calendar: 3600,
  savings: 86400,
  bonds: 86400,
  bonuses: 86400,
  deals: 86400,
  structural: 86400,
};

const lastFetched = new Map();   // source id -> ms

function cadenceFor(a) {
  if (Number.isFinite(a.ttlMs) && a.ttlMs > 0) return a.ttlMs;
  return (CADENCE[a.id] ?? 900) * 1000;
}

/** Which sources are due right now. */
function dueSources() {
  const now = Date.now();
  const enabled = store.settings.enabledSources;
  return adapters
    .filter((a) => (enabled === null || enabled === undefined ? a.defaultEnabled !== false : enabled.includes(a.id)))
    .filter((a) => now - (lastFetched.get(a.id) ?? 0) >= cadenceFor(a))
    .map((a) => a.id);
}

/**
 * Run every alert rule against the current dataset and say something if
 * anything fired.
 *
 * Split out of the refresh path because the most important rule does not depend
 * on the feeds at all. A window closing is a function of the clock: nothing in
 * the data changes on the morning a deal expires, so a check that only runs
 * when a source returns fresh rows will reliably miss the one day it mattered.
 */
function runAlerts() {
  if (!dataset?.opportunities?.length) return [];
  let fired = [];
  try {
    fired = store.evaluateAlerts(dataset.opportunities, { settings: store.settings });
  } catch (e) {
    console.warn('[alerts]', e.message);
    return [];
  }
  if (!fired.length) return fired;

  if (store.settings.notify !== false && Notification.isSupported()) {
    const urgent = fired.some((f) => f.urgency === 'critical');
    const top = fired.slice(0, 3);
    const n = new Notification({
      title: fired.length === 1 ? 'APY Dog' : `APY Dog — ${fired.length} things to look at`,
      body: top.map((f) => f.message).join('\n')
        + (fired.length > top.length ? `\n…and ${fired.length - top.length} more` : ''),
      urgency: urgent ? 'critical' : 'normal',
    });
    // A notification you cannot act on is just a distraction. Clicking it opens
    // the app on the row it is about.
    n.on('click', () => {
      showWindow();
      const id = fired[0]?.opportunity?.id;
      if (id) send('nav:open', { id });
    });
    n.show();
  }
  return fired;
}

/** Bring the window back, creating it if the user closed it to the tray. */
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function rescheduleDeadlineWatch() {
  if (deadlineTimer) clearInterval(deadlineTimer);
  // Every fifteen minutes is far more often than a day boundary needs and far
  // cheaper than a refresh: it re-reads the clock against rows already in
  // memory and fetches nothing.
  deadlineTimer = setInterval(() => {
    try { runAlerts(); } catch (e) { console.warn('[deadline]', e.message); }
  }, 15 * 60000);
}

function rescheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  if (store.settings.offlineMode) return;
  if (store.settings.liveUpdates === false) {
    // Fall back to the old single timer when live updating is switched off.
    const mins = Number(store.settings.autoRefreshMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return;
    autoTimer = setInterval(() => {
      if (!refreshing) doRefresh().catch((e) => console.warn('[auto-refresh]', e.message));
    }, Math.max(5, mins) * 60000);
    return;
  }

  // Tick often, act rarely: the tick is cheap and each source decides for itself
  // whether it is due.
  autoTimer = setInterval(() => {
    if (refreshing) return;
    const due = dueSources();
    if (!due.length) return;
    doRefresh({ only: due }).catch((e) => console.warn('[live]', e.message));
  }, 20000);
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
    amount: Number.isFinite(store.settings.budget) && store.settings.budget > 0 ? store.settings.budget : null,
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
      HEAT: T.HEAT,
      EVENT_INFO,
      SECTION: K.SECTION,
      SECTION_INFO: K.SECTION_INFO,
      EFFORT: K.EFFORT,
      EFFORT_INFO: K.EFFORT_INFO,
      REACH: K.REACH,
      REACH_INFO: K.REACH_INFO,
      VEHICLE: K.VEHICLE,
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
    let expectations = null;
    try {
      const { expectationsFor } = require('../src/core/expectations');
      expectations = expectationsFor(o, {
        amount: Number.isFinite(store.settings.budget) && store.settings.budget > 0 ? store.settings.budget : null,
        riskFree: dataset.meta?.riskFree ?? 4,
        horizonDays: store.settings.movementHorizonDays ?? 30,
      });
    } catch (e) { console.warn('[expectations]', e.message); }
    let verdict = null;
    try {
      const { verdictFor } = require('../src/core/verdict');
      verdict = verdictFor(o, {
        amount: Number.isFinite(store.settings.budget) && store.settings.budget > 0 ? store.settings.budget : null,
        riskFree: dataset.meta?.riskFree ?? 4,
        expectations,
      });
    } catch (e) { console.warn('[verdict]', e.message); }
    return { opportunity: o, series, expectations, verdict };
  });

  /**
   * The Radar digest.
   *
   * Assembled here rather than in the renderer because the main process already
   * holds the dataset — six filtered queries over seven hundred rows is trivial
   * in-process and six IPC round trips is not.
   */
  handle('data:radar', () => radarPayload(dataset, {
    settings: store.settings,
    watchlist: store.watchlistIds(),
  }));

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
    if (patch.autoRefreshMinutes !== undefined || patch.liveUpdates !== undefined) rescheduleAuto();
    if (patch.startAtLogin !== undefined) syncLoginItem();
    if (patch.runInBackground !== undefined) {
      if (next.runInBackground) setupTray();
      else if (tray) { tray.destroy(); tray = null; }
    }
    // A shorter deadline window has to take effect now, not at the next scan:
    // the whole point of the setting is the day it fires.
    if (patch.watchClosingDays !== undefined || patch.watchNewDealsWorth !== undefined) {
      try { runAlerts(); } catch { /* best effort */ }
    }
    return next;
  });

  /**
   * The plan.
   *
   * Ordering, not ranking. Assembled here because it reads the whole dataset
   * and the user's settings at once, and because the tiering is a decision the
   * app makes rather than a view the renderer composes.
   */
  handle('data:plan', (facts) => {
    const { buildPlan } = require('../src/core/plan');
    store.updateSettings({ planFacts: { ...(store.settings.planFacts || {}), ...(facts || {}) } });
    return buildPlan(dataset.opportunities, {
      budget: Number.isFinite(store.settings.budget) && store.settings.budget > 0 ? store.settings.budget : null,
      facts: store.settings.planFacts || {},
      riskFree: dataset.meta?.riskFreeRate ?? 4,
    });
  });

  /**
   * The signals view payload.
   *
   * Ranked by pressure, but the calibration status is part of the payload
   * rather than a footnote: an uncalibrated ranking and a measured one are
   * different products, and the interface has to say which one it is showing.
   */
  handle('data:signals', () => {
    const { loadCalibration } = require('../src/core/calibration');
    return signalsPayload(dataset, loadCalibration({ maxAgeMs: 0 }));
  });

  handle('app:checkUpdates', () => checkForUpdates({ interactive: false }));
  handle('app:installUpdate', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      quitting = true;
      autoUpdater.quitAndInstall();
      return true;
    } catch { return false; }
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

/**
 * Updating the app itself.
 *
 * Distinct from updating the data, which happens on its own cadence every time
 * the app runs. This is the code, and it matters more than it sounds: a screener
 * whose source list is frozen at whatever shipped is a screener that goes quietly
 * stale while looking exactly as authoritative as the day it was built.
 *
 * electron-updater does the real work where a signed build exists. Where it does
 * not — a dev checkout, an unsigned Linux build, a platform with no feed — the
 * fallback still answers the only question that matters: is there something
 * newer than what you are running.
 */
async function checkForUpdates({ interactive = false } = {}) {
  let updater = null;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch { /* fall through */ }

  if (updater && app.isPackaged) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.removeAllListeners();
    updater.on('update-downloaded', (info) => {
      send('update:ready', { version: info?.version || null });
      if (tray) refreshTrayMenu();
    });
    updater.on('error', (e) => {
      console.warn('[update]', e?.message || e);
      if (interactive) dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: String(e?.message || e) });
    });
    try {
      const res = await updater.checkForUpdates();
      const v = res?.updateInfo?.version;
      if (interactive && v && v === app.getVersion()) {
        dialog.showMessageBox({ type: 'info', message: `APY Dog ${v} is the latest version.` });
      }
      return { ok: true, version: v || null, channel: 'auto' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // Dependency-free fallback: ask GitHub what the newest release is.
  try {
    const { getJSON } = require('../src/core/http');
    const rel = await getJSON('https://api.github.com/repos/pisano18/apy_dog/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }, timeout: 8000, retries: 0,
    });
    const latest = String(rel?.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    const newer = latest && compareVersions(latest, current) > 0;
    if (newer) {
      send('update:available', { version: latest, url: rel.html_url });
      if (interactive) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message: `APY Dog ${latest} is available.`,
          detail: `You are running ${current}.`,
          buttons: ['Open the release page', 'Later'],
          defaultId: 0,
        });
        if (response === 0) shell.openExternal(rel.html_url);
      }
    } else if (interactive) {
      dialog.showMessageBox({ type: 'info', message: `APY Dog ${current} is the latest version.` });
    }
    return { ok: true, version: latest || null, newer, channel: 'github' };
  } catch (e) {
    if (interactive) {
      dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: String(e?.message || e) });
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Numeric-segment version compare. Returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * The tray presence.
 *
 * The point is not the icon. It is that quitting and closing stop being the
 * same action, so the deadline watch survives the window being shut — which is
 * the only state in which it is any use.
 */
function setupTray() {
  if (tray || !store.settings.runInBackground) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
      .resize({ width: 18, height: 18 });
    icon.setTemplateImage(process.platform === 'darwin');
    tray = new Tray(icon);
    tray.setToolTip('APY Dog');
    refreshTrayMenu();
    tray.on('click', showWindow);
  } catch (e) {
    console.warn('[tray]', e.message);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const m = dataset?.meta || {};
  const closing = (dataset?.opportunities || [])
    .filter((o) => Number.isFinite(o.daysLeft) && o.daysLeft >= 0 && o.daysLeft <= 7).length;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: closing ? `${closing} closing within a week` : 'Nothing closing this week', enabled: false },
    { label: `${m.total ?? dataset?.opportunities?.length ?? 0} opportunities tracked`, enabled: false },
    { type: 'separator' },
    { label: 'Open APY Dog', click: showWindow },
    { label: 'Refresh now', click: () => { if (!refreshing) doRefresh().catch(() => {}); } },
    { label: 'Check for updates', click: () => checkForUpdates({ interactive: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

/** Ask the OS to start us at login, if the user asked for that. */
function syncLoginItem() {
  if (process.platform === 'linux') return;   // handled by the distro, not us
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.settings.startAtLogin,
      openAsHidden: true,
      args: ['--hidden'],
    });
  } catch (e) {
    console.warn('[login item]', e.message);
  }
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  initState();
  registerIpc();
  createWindow();
  rescheduleAuto();
  if (!isSmoke) {
    rescheduleDeadlineWatch();
    setupTray();
    syncLoginItem();
  }

  // Show bundled data immediately so the window is never empty, then go to the
  // network. An instantly-useful window that improves beats a spinner.
  await doRefresh({ offline: true });
  if (store.settings.refreshOnLaunch && !store.settings.offlineMode && !isSmoke) {
    doRefresh().catch((e) => console.warn('[launch refresh]', e.message));
  }

  if (isSmoke) return runSmokeTest();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // Closing the window is not quitting when the app is meant to be watching a
  // deadline for you. A scanner that only runs while you are looking at it
  // cannot tell you about the thing that closes while you are at work.
  if (isSmoke || !store?.settings?.runInBackground) {
    if (process.platform !== 'darwin') app.quit();
  }
});
app.on('before-quit', () => {
  quitting = true;
  try { history.prune(); } catch { /* best effort */ }
});

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


  // The app lands on Radar now. Check the digest first, then move to Browse for
  // everything that exercises the table.
  let report = {};
  // First run puts onboarding in front of everything. Walk it, because a smoke
  // test that only ever sees the post-setup app would never notice the setup
  // being broken — which is the one screen every new user is guaranteed to hit.
  try {
    const shown = await win.webContents.executeJavaScript(
      "!document.querySelector('#onboard').classList.contains('hidden')",
    );
    report.onboardShown = shown;
    if (shown) {
      try { fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true }); } catch { /* exists */ }
      fs.writeFileSync(path.join(__dirname, '..', 'build', 'smoke-onboard.png'),
        (await win.webContents.capturePage()).toPNG());
      report.onboardSteps = 0;
      for (let n = 0; n < 8; n += 1) {
        const open = await win.webContents.executeJavaScript(
          "!document.querySelector('#onboard').classList.contains('hidden')",
        );
        if (!open) break;
        report.onboardSteps += 1;
        await win.webContents.executeJavaScript(
          "document.querySelector('#onboard [data-act=\"ob-next\"]').click(); true",
        );
        await new Promise((r) => setTimeout(r, 260));
      }
      report.onboardDismissed = await win.webContents.executeJavaScript(
        "document.querySelector('#onboard').classList.contains('hidden')",
      );
    }
  } catch (err) {
    errors.push(`onboarding failed: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 600));

  try {
    report.radarCards = await win.webContents.executeJavaScript("document.querySelectorAll('#view-radar .rcard').length");
    report.radarItems = await win.webContents.executeJavaScript("document.querySelectorAll('#view-radar .ritem').length");
    report.budgetPrompt = await win.webContents.executeJavaScript("!!document.querySelector('#view-radar .budgetbar.unset')");
    try { fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(path.join(__dirname, '..', 'build', 'smoke-radar.png'), (await win.webContents.capturePage()).toPNG());
    if (!report.radarCards) failuresLate.push('the radar digest rendered no cards');
    if (!report.radarItems) failuresLate.push('the radar cards are all empty');
    if (!report.budgetPrompt) failuresLate.push('a fresh install should ask for a budget');
    await win.webContents.executeJavaScript("document.querySelector('.tab[data-view=\"find\"]').click(); true");
    await new Promise((r) => setTimeout(r, 700));
  } catch (err) {
    failuresLate.push(`radar check failed: ${err.message}`);
  }

  try {
    report = { ...report, ...await win.webContents.executeJavaScript(`(() => ({
      rows: document.querySelectorAll('#tablewrap tbody tr').length,
      headers: document.querySelectorAll('#tablewrap thead th').length,
      filterBarItems: document.querySelectorAll('#filterbar > *').length,
      trackButtons: document.querySelectorAll('#trackswitch button').length,
      trackCounts: document.querySelector('#n-all').textContent,
      desc: (document.querySelector('#res-desc') || {}).textContent || '',
      title: document.title,
      bodyText: document.body.innerText.slice(0, 180),
    }))()`) };
  } catch (err) {
    errors.push(`executeJavaScript failed: ${err.message}`);
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
    await js("document.querySelector('#trackswitch button[data-section=\"movement\"]').click(); true");
    await wait(800);
    report.movementRows = await js("document.querySelectorAll('#tablewrap tbody tr').length");
    report.movementHeaders = await js("Array.from(document.querySelectorAll('#tablewrap thead th')).map(t=>t.textContent.trim().replace(/[▲▼]/g,'')).join('|')");
    await shot('movement');
    if (!report.movementRows) failuresLate.push('movement track rendered no rows');
    if (!/Heat/.test(report.movementHeaders || '')) failuresLate.push('movement track is not showing movement columns');
    if (!/Catalyst|catalyst/.test(report.movementHeaders || '')) failuresLate.push('movement track has no catalyst column');
    // Only a failure if rows carry a series and it is not being drawn. Until the
    // market sources attach one there is legitimately nothing to plot.
    report.rowsWithSeries = await js("(window.__S && window.__S.rows || []).filter(r => r.series && r.series.length).length");
    report.sparklines = await js("document.querySelectorAll('#tablewrap tbody svg.spark2 path').length");
    if (report.rowsWithSeries > 0 && !report.sparklines) {
      failuresLate.push(`${report.rowsWithSeries} rows carry a price series but no chart rendered`);
    }
  } catch (err) {
    failuresLate.push(`track switch failed: ${err.message}`);
  }

  // Filters: open the picker, add one, confirm it becomes a pill and narrows the
  // list, then confirm Clear all provably resets it.
  try {
    await js("document.querySelector('#trackswitch button[data-section=\"income\"]').click(); true");
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
  for (const view of ['signals', 'plan', 'learn', 'events', 'sources', 'settings', 'watch']) {
    try {
      await js(`document.querySelector('.tab[data-view="${view}"]').click(); true`);
      await wait(view === 'plan' ? 900 : 500);
      const n = await js(`document.querySelector('#view-${view}').innerHTML.length`);
      report[`${view}Html`] = n;
      if (n < 400) failuresLate.push(`${view} pane rendered almost nothing (${n} chars)`);
      await shot(view);
    } catch (err) {
      failuresLate.push(`${view} pane failed: ${err.message}`);
    }
  }

  // The signals view is correctly empty offline: every bundled chart is drawn
  // rather than recorded, so no signal can honestly be read off one. The
  // populated layout is unit-tested in test/signals-view.test.js, which runs
  // render.js in plain Node; here we only confirm the empty state explains
  // itself rather than looking like a crash.
  try {
    await js("document.querySelector('.tab[data-view=\"signals\"]').click(); true");
    await wait(600);
    report.signalCards = await js("document.querySelectorAll('#view-signals .sigcard').length");
    report.signalBanner = await js("!!document.querySelector('#view-signals .calbanner')");
    report.signalEmptyExplained = await js(
      "/recorded price history|measured rows/.test(document.querySelector('#view-signals').innerText)",
    );
    await shot('signals');
    if (!report.signalBanner) failuresLate.push('the signals view did not state its calibration status');
    if (!report.signalEmptyExplained) failuresLate.push('the signals view is empty and does not say why');
  } catch (err) {
    failuresLate.push(`signals check failed: ${err.message}`);
  }

  // Help must be reachable from where the jargon is, not only from the Learn
  // page — a help system you have to go and find is one nobody uses.
  try {
    await js("document.querySelector('.tab[data-view=\"find\"]').click(); true");
    await wait(400);
    report.helpChips = await js("document.querySelectorAll('#tablewrap .helpq').length");
    await js("document.querySelector('#tablewrap .helpq').click(); true");
    await wait(250);
    report.helpPopOpen = await js("!document.querySelector('#helppop').classList.contains('hidden')");
    report.helpPopText = await js("document.querySelector('#helppop').innerText.length");
    await js("document.querySelector('#helppop .hx').click(); true");
    if (!report.helpChips) failuresLate.push('no help affordances rendered on the table');
    if (!report.helpPopOpen) failuresLate.push('the help popover did not open');
    if ((report.helpPopText || 0) < 80) failuresLate.push('the help popover rendered almost nothing');
  } catch (err) {
    failuresLate.push(`help check failed: ${err.message}`);
  }

  try {
    await js("document.querySelector('.tab[data-view=\"learn\"]').click(); true");
    await wait(400);
    report.learnCards = await js("document.querySelectorAll('#view-learn .learncard').length");
    if ((report.learnCards || 0) < 20) failuresLate.push(`glossary rendered only ${report.learnCards} entries`);
  } catch (err) {
    failuresLate.push(`glossary check failed: ${err.message}`);
  }

  // The plan is an ordering, so an empty or single-step one means the tiering
  // silently collapsed — which looks fine on screen and is the whole feature.
  try {
    await js("document.querySelector('.tab[data-view=\"plan\"]').click(); true");
    await wait(700);
    report.planSteps = await js("document.querySelectorAll('#view-plan .planstep').length");
    report.planTiers = await js("document.querySelectorAll('#view-plan section h3').length");
    if (!report.planSteps) failuresLate.push('the plan produced no steps');
  } catch (err) {
    failuresLate.push(`plan check failed: ${err.message}`);
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
  if (!report.trackButtons) failures.push('section switch did not render');
  if (!report.radarCards) failures.push('radar did not render');
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
