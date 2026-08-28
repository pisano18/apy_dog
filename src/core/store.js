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
  // Live updating refreshes each feed on its own cadence rather than everything
  // on one timer. Turning it off falls back to a single interval.
  liveUpdates: true,
  autoRefreshMinutes: 60,
  refreshOnLaunch: true,
  offlineMode: false,
  maxDefiPools: 8000,
  extraSymbols: [],             // user-added tickers for the fund/speculative scans
  userRatesPath: null,          // filled in at runtime: userData/user-rates.json

  // --- display -------------------------------------------------------------
  // Dark by default. The app is designed dark; following a bright system
  // setting hands people a white wall of numbers they did not ask for.
  theme: 'dark',                // dark | light | system
  density: 'comfortable',
  visibleColumns: null,         // null = the default set
  lastQuery: null,

  // --- watching while you are not looking -----------------------------------
  // A deal that closes on Friday is worthless to someone who opens the app on
  // Saturday. The app therefore keeps running after the window is closed and
  // says something when a window is about to shut. Both are opt-out.
  runInBackground: true,
  startAtLogin: false,
  notify: true,
  // Standing rules that need no setup. Almost nobody creates an alert, so
  // shipping with none meant the deadline machinery never fired for anybody.
  watchClosingDays: 7,          // warn this many days before a watched window shuts
  watchNewDealsWorth: 200,      // and when a deal worth at least this much appears

  // What the user has told the planner about themselves. Everything here is a
  // fact the app cannot derive and refuses to guess.
  planFacts: {},

  // --- first run ------------------------------------------------------------
  // Null rather than false: false would mean "they went through it and set
  // nothing", which is a different state from "they have never seen it".
  onboardedAt: null,

  // --- safety rails --------------------------------------------------------
  acknowledgedDisclaimer: false,
};

const DEFAULT_STATE = {
  settings: DEFAULT_SETTINGS,
  watchlist: [],                // [{ id, name, addedAt, note }]
  alerts: [],                   // [{ id, opportunityId, kind, threshold, active, lastFired }]
  dismissed: [],                // ids the user never wants to see again
  // What each alert has already told you about, so it tells you once rather
  // than every time the scanner runs. Keyed alertId -> { oppId: firedAtISO }.
  alertState: {},
  // Every opportunity id this app has ever shown you, so "new" means new to
  // you rather than new to this process.
  seenIds: [],
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
   *
   * Two things this has to get right that the first version did not.
   *
   * It has to fire ONCE. `lastFired` was written and never read, so with live
   * updating on a sixty-second cadence a single "tell me about anything over
   * 8%" rule produced a desktop notification every minute, forever, which
   * trains a person to turn notifications off — and the one that mattered goes
   * with them. Each rule now remembers which opportunities it has already
   * spoken about and stays quiet until the condition goes false and comes back.
   *
   * And it has to know about deadlines. A rate crossing a threshold is the easy
   * case: the feed tells you. A window closing is a function of the clock, so
   * nothing in the data changes on the day it matters — which is exactly the
   * day you needed to hear about it.
   */
  evaluateAlerts(list, opts = {}) {
    const { now = Date.now(), settings = this.settings } = opts;
    const fired = [];
    const byId = new Map(list.map((o) => [o.id, o]));
    const watched = new Set(this.state.watchlist.map((w) => w.id));
    const state = this.state.alertState || (this.state.alertState = {});

    // "New" has to mean new to the person, not new to this process, or every
    // restart re-announces the whole catalogue.
    const seen = new Set(this.state.seenIds || []);
    const firstRun = seen.size === 0;
    const freshIds = [];
    for (const o of list) if (!seen.has(o.id)) freshIds.push(o.id);

    /** Fire once per (rule, opportunity) until the condition lapses. */
    const emit = (alert, o, message, extra = {}) => {
      const seenFor = state[alert.id] || (state[alert.id] = {});
      const key = o?.id || '_';
      if (seenFor[key]) return;
      seenFor[key] = new Date(now).toISOString();
      fired.push({ alert, opportunity: o, message, ...extra });
    };
    /** Let a rule speak again about this row once it stops being true. */
    const rearm = (alert, id) => {
      const seenFor = state[alert.id];
      if (seenFor && id in seenFor) delete seenFor[id];
    };

    const rules = [...this.state.alerts];

    // Standing rules, so the machinery works for someone who never opened the
    // alerts panel. They are settings rather than saved rules, so turning them
    // off in Settings actually turns them off.
    if (settings.watchClosingDays > 0) {
      rules.push({
        id: '_standing_closing', kind: 'closing', threshold: settings.watchClosingDays,
        scope: { watchlistOnly: true }, active: true, standing: true,
        label: `Anything I watch closing within ${settings.watchClosingDays} days`,
      });
    }
    if (settings.watchNewDealsWorth > 0) {
      rules.push({
        id: '_standing_newdeal', kind: 'new_deal', threshold: settings.watchNewDealsWorth,
        active: true, standing: true,
        label: `New deals worth at least $${settings.watchNewDealsWorth}`,
      });
    }

    for (const a of rules) {
      if (!a.active) continue;

      if (a.kind === 'apy_above' || a.kind === 'apy_below') {
        const o = byId.get(a.opportunityId);
        const v = o?.apy?.total;
        if (!Number.isFinite(v)) continue;
        const hit = a.kind === 'apy_above' ? v >= a.threshold : v <= a.threshold;
        if (hit) {
          emit(a, o, `${o.name} is at ${v.toFixed(2)}% (${a.kind === 'apy_above' ? 'above' : 'below'} ${a.threshold}%)`);
        } else {
          rearm(a, o.id);
        }

      } else if (a.kind === 'new_above') {
        const { applyQuery } = require('./filters');
        const hits = applyQuery(list, { ...(a.scope || {}), minApy: a.threshold, limit: 5, watchlist: [...watched] });
        for (const o of hits) {
          emit(a, o, `${o.name} pays ${(o.apy?.total ?? 0).toFixed(2)}%, above your ${a.threshold}% alert`);
        }

      } else if (a.kind === 'closing') {
        // The one a rate screener structurally cannot do. Note this reads the
        // clock, not the feed: nothing in the data changes on the day a window
        // shuts, which is why it has to be checked on a timer rather than only
        // when a source returns something new.
        const within = Number(a.threshold) > 0 ? Number(a.threshold) : 7;
        const scoped = a.scope?.watchlistOnly
          ? list.filter((o) => watched.has(o.id))
          : (a.opportunityId ? [byId.get(a.opportunityId)].filter(Boolean) : list);
        for (const o of scoped) {
          if (!Number.isFinite(o.daysLeft)) continue;
          if (o.daysLeft < 0 || o.daysLeft > within) { rearm(a, o.id); continue; }
          const when = o.daysLeft <= 0 ? 'today' : o.daysLeft === 1 ? 'tomorrow' : `in ${Math.round(o.daysLeft)} days`;
          emit(a, o, `${o.name} closes ${when}`, { urgency: o.daysLeft <= 1 ? 'critical' : 'normal' });
        }

      } else if (a.kind === 'opening') {
        // The mirror case: something you cannot act on yet, which you can now.
        const scoped = a.opportunityId ? [byId.get(a.opportunityId)].filter(Boolean)
          : list.filter((o) => watched.has(o.id));
        for (const o of scoped) {
          if (o.notYetOpen) { rearm(a, o.id); continue; }
          if (!o.startsAt) continue;
          const opened = Date.parse(o.startsAt);
          if (!Number.isFinite(opened) || now - opened > 7 * 86400000) continue;
          emit(a, o, `${o.name} is open now`);
        }

      } else if (a.kind === 'new_deal') {
        // Silent on the very first scan. Announcing eight hundred rows the
        // first time the app runs is not news, it is a denial of service.
        if (firstRun) continue;
        const worth = Number(a.threshold) > 0 ? Number(a.threshold) : 0;
        for (const id of freshIds) {
          const o = byId.get(id);
          if (!o || o.section !== 'deals') continue;
          const value = o.scores?.oneTimeDollars;
          if (!Number.isFinite(value) || value < worth) continue;
          emit(a, o, `New deal: ${o.name} pays about $${Math.round(value).toLocaleString()}`);
        }
      }
    }

    // Remember every id we have now shown, whether or not it fired anything.
    if (freshIds.length) {
      this.state.seenIds = [...seen, ...freshIds].slice(-20000);
    }

    const nowISO = new Date(now).toISOString();
    for (const f of fired) {
      if (!f.alert.standing) f.alert.lastFired = nowISO;
    }
    if (fired.length || freshIds.length) this.save();
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
