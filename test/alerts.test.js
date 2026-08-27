'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/core/store');

/**
 * The alert engine, which is the only part of this app that has to work while
 * nobody is looking at it.
 *
 * Everything else is wrong in a way you can see. An alert is wrong in a way you
 * find out about a week later, when the window has already shut.
 */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apy-alerts-'));
  return new Store(dir);
}

const DAY = 86400000;
const NOW = Date.parse('2026-08-27T12:00:00Z');

function row(over = {}) {
  return {
    id: 'r1', name: 'A deal', section: 'deals', daysLeft: null, notYetOpen: false,
    startsAt: null, apy: { total: 5 }, scores: { oneTimeDollars: null }, ...over,
  };
}

describe('alerts fire once, not every scan', () => {
  test('a threshold rule speaks once and then stays quiet', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 0 });
    s.addAlert({ opportunityId: 'r1', kind: 'apy_above', threshold: 4 });
    const list = [row({ apy: { total: 6 } })];

    assert.strictEqual(s.evaluateAlerts(list, { now: NOW }).length, 1);
    // This is the bug that made the feature unusable: with live updating on a
    // sixty-second cadence, the old engine fired this same notification every
    // minute forever.
    assert.strictEqual(s.evaluateAlerts(list, { now: NOW + 60000 }).length, 0);
    assert.strictEqual(s.evaluateAlerts(list, { now: NOW + 120000 }).length, 0);
  });

  test('but speaks again once the condition lapses and returns', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 0 });
    s.addAlert({ opportunityId: 'r1', kind: 'apy_above', threshold: 4 });

    assert.strictEqual(s.evaluateAlerts([row({ apy: { total: 6 } })], { now: NOW }).length, 1);
    assert.strictEqual(s.evaluateAlerts([row({ apy: { total: 3 } })], { now: NOW + DAY }).length, 0);
    assert.strictEqual(s.evaluateAlerts([row({ apy: { total: 6 } })], { now: NOW + 2 * DAY }).length, 1,
      'a rate that dipped and recovered is news again');
  });
});

describe('deadlines', () => {
  test('a watched window inside the warning period fires', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 7, watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');

    const fired = s.evaluateAlerts([row({ daysLeft: 3 })], { now: NOW });
    assert.strictEqual(fired.length, 1);
    assert.match(fired[0].message, /closes in 3 days/);
  });

  test('it needs no setup at all — the rule is a default, not a saved alert', () => {
    const s = tmpStore();
    s.toggleWatch('r1', 'A deal');
    assert.strictEqual(s.alerts.length, 0, 'no alert rules were created');
    assert.strictEqual(s.evaluateAlerts([row({ daysLeft: 2 })], { now: NOW }).length, 1);
  });

  test('turning the setting off turns it off', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    assert.strictEqual(s.evaluateAlerts([row({ daysLeft: 1 })], { now: NOW }).length, 0);
  });

  test('the last day is marked critical, so the OS shows it differently', () => {
    const s = tmpStore();
    s.updateSettings({ watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    const fired = s.evaluateAlerts([row({ daysLeft: 0 })], { now: NOW });
    assert.strictEqual(fired[0].urgency, 'critical');
    assert.match(fired[0].message, /closes today/);
  });

  test('an already-closed window is not news', () => {
    const s = tmpStore();
    s.updateSettings({ watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    assert.strictEqual(s.evaluateAlerts([row({ daysLeft: -2 })], { now: NOW }).length, 0);
  });

  test('a deadline warning does not repeat every fifteen minutes for a week', () => {
    const s = tmpStore();
    s.updateSettings({ watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    // The check runs on a timer, so this is the failure mode that matters most:
    // 96 checks a day against a window open for another five.
    let total = 0;
    for (let i = 0; i < 96; i += 1) {
      total += s.evaluateAlerts([row({ daysLeft: 5 })], { now: NOW + i * 900000 }).length;
    }
    assert.strictEqual(total, 1, `fired ${total} times over one day of ticks`);
  });

  test('rows with no deadline are never deadline alerts', () => {
    const s = tmpStore();
    s.updateSettings({ watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    assert.strictEqual(s.evaluateAlerts([row({ daysLeft: null })], { now: NOW }).length, 0);
  });
});

describe('new deals', () => {
  test('the first scan is silent', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 100 });
    // Announcing the whole catalogue the first time the app runs is not news.
    const list = [row({ scores: { oneTimeDollars: 500 } })];
    assert.strictEqual(s.evaluateAlerts(list, { now: NOW }).length, 0);
  });

  test('something that appears later, and clears the bar, is', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 100 });
    s.evaluateAlerts([row({ scores: { oneTimeDollars: 500 } })], { now: NOW });

    const fired = s.evaluateAlerts([
      row({ scores: { oneTimeDollars: 500 } }),
      row({ id: 'r2', name: 'Bank bonus', scores: { oneTimeDollars: 300 } }),
    ], { now: NOW + DAY });
    assert.strictEqual(fired.length, 1);
    assert.match(fired[0].message, /Bank bonus pays about \$300/);
  });

  test('something below the bar is not', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 400 });
    s.evaluateAlerts([row()], { now: NOW });
    const fired = s.evaluateAlerts([
      row(), row({ id: 'r2', name: 'Small', scores: { oneTimeDollars: 25 } }),
    ], { now: NOW + DAY });
    assert.strictEqual(fired.length, 0);
  });

  test('"new" survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apy-alerts-'));
    const a = new Store(dir);
    a.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 100 });
    a.evaluateAlerts([row({ scores: { oneTimeDollars: 500 } })], { now: NOW });

    // Same on-disk state, fresh process. Without persistence every restart
    // re-announces the entire catalogue.
    const b = new Store(dir);
    const fired = b.evaluateAlerts([row({ scores: { oneTimeDollars: 500 } })], { now: NOW + DAY });
    assert.strictEqual(fired.length, 0);
  });

  test('only deals count — a stock appearing is not a deal appearing', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 100 });
    s.evaluateAlerts([row()], { now: NOW });
    const fired = s.evaluateAlerts([
      row(), row({ id: 'r2', name: 'NVDA', section: 'movement', scores: { oneTimeDollars: 9999 } }),
    ], { now: NOW + DAY });
    assert.strictEqual(fired.length, 0);
  });
});

describe('openings', () => {
  test('a window that has just opened is news, once', () => {
    const s = tmpStore();
    s.updateSettings({ watchClosingDays: 0, watchNewDealsWorth: 0 });
    s.toggleWatch('r1', 'A deal');
    s.addAlert({ opportunityId: null, kind: 'opening' });

    const closed = row({ notYetOpen: true, startsAt: new Date(NOW + DAY).toISOString() });
    assert.strictEqual(s.evaluateAlerts([closed], { now: NOW }).length, 0);

    const open = row({ notYetOpen: false, startsAt: new Date(NOW + DAY).toISOString() });
    assert.strictEqual(s.evaluateAlerts([open], { now: NOW + 2 * DAY }).length, 1);
    assert.strictEqual(s.evaluateAlerts([open], { now: NOW + 3 * DAY }).length, 0);
  });
});
