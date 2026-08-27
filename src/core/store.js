'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Persistent state: settings, watchlist and alert rules.
 *
 * Everything lives in plain JSON in the app's userData directory. No accounts,
 * no telemetry, no cloud — this app reads public rate data and does arithmetic,
 * and there is no reason for any of it to leave the machine. The user's tax
 * bracket in particular is nobody else's business.
 */

const DEFAULT_SETTINGS = {
  // --- who the user is, for the tax maths ---------------------------------
  tax: {
    federalOrdinary: 24,
    federalLtcg: 15,
    state: 'TX',
    stateRate: null,
    niitApplies: false,
    accountType: 'taxable',
    inflation: 2.6,
  },

  // --- how they want things ranked ----------------------------------------
  riskAppetite: 45,             // 0..100, drives the certainty-equivalent maths
  rankingBasis: 'afterTax',     // gross | afterTax | afterTaxReal
  horizonDays: null,            // when they want the money back
  // null until the user says otherwise: the app shows rates and no dollar
  // figures rather than quietly assuming a number on their behalf.
  budget: null,
  movementHorizonDays: 30,      // window the expected-move bands are computed over

  // --- sources -------------------------------------------------------------
  enabledSources: null,         // null = all enabled; else array of source ids
  autoRefreshMinutes: 60,
  refreshOnLaunch: true,
  offlineMode: false,
  maxDefiPools: 4000,
  extraSymbols: [],             // user-added tickers for the fund/speculative scans
  userRatesPath: null,          // filled in at runtime: userData/user-rates.json

  // --- display -------------------------------------------------------------
  // Dark by default. The app is designed dark; following a bright system
  // setting hands people a white wall of numbers they did not ask for.
  theme: 'dark',                // dark | light | system
  density: 'comfortable',
  visibleColumns: null,         // null = the default set
  lastQuery: null,

  // --- safety rails --------------------------------------------------------
  acknowledgedDisclaimer: false,
};

const DEFAULT_STATE = {
  settings: DEFAULT_SETTINGS,
  watchlist: [],                // [{ id, name, addedAt, note }]
  alerts: [],                   // [{ id, opportunityId, kind, threshold, active, lastFired }]
  dismissed: [],                // ids the user never wants to see again
  version: 1,
};

/** Deep merge that keeps unknown user keys and fills in new defaults on upgrade. */
function mergeDeep(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = mergeDeep(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

class Store {
  constructor(dir, filename = 'apy-dog-state.json') {
    this.dir = dir;
    this.file = path.join(dir, filename);
    fs.mkdirSync(dir, { recursive: true });
    this.state = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return mergeDeep(structuredClone(DEFAULT_STATE), parsed);
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      return false;
    }
  }

  get settings() { return this.state.settings; }

  updateSettings(patch) {
    this.state.settings = mergeDeep(this.state.settings, patch);
    this.save();
    return this.state.settings;
  }

  resetSettings() {
    this.state.settings = structuredClone(DEFAULT_SETTINGS);
    this.save();
    return this.state.settings;
  }

  // --- watchlist ------------------------------------------------------------
  get watchlist() { return this.state.watchlist; }
  watchlistIds() { return this.state.watchlist.map((w) => w.id); }

  toggleWatch(id, name = null) {
    const i = this.state.watchlist.findIndex((w) => w.id === id);
    if (i >= 0) this.state.watchlist.splice(i, 1);
    else this.state.watchlist.push({ id, name, addedAt: new Date().toISOString(), note: null });
    this.save();
    return this.watchlistIds();
  }

  setWatchNote(id, note) {
    const w = this.state.watchlist.find((x) => x.id === id);
    if (w) { w.note = note; this.save(); }
    return w || null;
  }

  // --- alerts ---------------------------------------------------------------
  get alerts() { return this.state.alerts; }

  addAlert({ opportunityId = null, kind = 'apy_above', threshold, scope = null, label = null }) {
    const alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      opportunityId, kind, threshold, scope, label,
      active: true, createdAt: new Date().toISOString(), lastFired: null,
    };
    this.state.alerts.push(alert);
    this.save();
    return alert;
  }

  removeAlert(id) {
    const before = this.state.alerts.length;
    this.state.alerts = this.state.alerts.filter((a) => a.id !== id);
    this.save();
    return before !== this.state.alerts.length;
  }

  /**
   * Evaluate alerts against a freshly scored list.
   * `apy_above` / `apy_below` watch a specific opportunity; `new_above` fires when
   * ANY opportunity matching the alert's scope crosses the threshold, which is how
   * the user finds out about a rate they did not already know existed.
   */
  evaluateAlerts(list) {
    const fired = [];
    const byId = new Map(list.map((o) => [o.id, o]));
    for (const a of this.state.alerts) {
      if (!a.active) continue;
      if (a.kind === 'apy_above' || a.kind === 'apy_below') {
        const o = byId.get(a.opportunityId);
        const v = o?.apy?.total;
        if (!Number.isFinite(v)) continue;
        const hit = a.kind === 'apy_above' ? v >= a.threshold : v <= a.threshold;
        if (hit) fired.push({ alert: a, opportunity: o, message: `${o.name} is at ${v.toFixed(2)}% (${a.kind === 'apy_above' ? 'above' : 'below'} ${a.threshold}%)` });
      } else if (a.kind === 'new_above') {
        const { applyQuery } = require('./filters');
        const scope = a.scope || {};
        const hits = applyQuery(list, { ...scope, minApy: a.threshold, limit: 5 });
        for (const o of hits) {
          fired.push({ alert: a, opportunity: o, message: `${o.name} pays ${(o.apy?.total ?? 0).toFixed(2)}%, above your ${a.threshold}% alert` });
        }
      }
    }
    const now = new Date().toISOString();
    for (const f of fired) f.alert.lastFired = now;
    if (fired.length) this.save();
    return fired;
  }

  // --- dismissals -----------------------------------------------------------
  dismiss(id) {
    if (!this.state.dismissed.includes(id)) { this.state.dismissed.push(id); this.save(); }
    return this.state.dismissed;
  }

  undismiss(id) {
    this.state.dismissed = this.state.dismissed.filter((d) => d !== id);
    this.save();
    return this.state.dismissed;
  }

  export() { return structuredClone(this.state); }

  import(json) {
    this.state = mergeDeep(structuredClone(DEFAULT_STATE), json || {});
    this.save();
    return this.state;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_STATE, mergeDeep };
