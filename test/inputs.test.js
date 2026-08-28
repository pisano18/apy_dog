'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { routeChange, mergeFacts, INPUTS } = require('../src/ui/inputs');
const { buildPlan, DEFAULT_FACTS } = require('../src/core/plan');
const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');

/**
 * The Plan view's five questions, and the fact that they reach the plan.
 *
 * This file exists because of a one-line guard. The window has a single
 * `change` listener; it opened with `if (!el.id?.startsWith('s-')) return;` and
 * then, forty lines further down, branched on ids beginning `p-`. That branch
 * was unreachable from the day it was written. Every answer given to the Plan
 * view was discarded, `S.planFacts` was never once assigned, and the plan was
 * built from defaults every single time — so it kept telling people to take an
 * employer match they had just said they do not have.
 *
 * Nothing caught it because it was renderer code, and renderer code was only
 * ever executed inside a running Electron window. The routing now lives in a
 * module that loads in plain Node, which is what makes the first three tests
 * below possible at all.
 */

describe('which control was that', () => {
  test('every Plan question routes to the plan', () => {
    for (const id of Object.keys(INPUTS.plan)) {
      assert.strictEqual(routeChange(id, '1').kind, 'plan', `${id} is not reaching the plan`);
    }
  });

  test('settings still route to settings', () => {
    for (const id of ['s-budget', 's-appetite', 's-theme', 's-fedOrd']) {
      assert.strictEqual(routeChange(id, '1').kind, 'settings', `${id} stopped reaching settings`);
    }
  });

  test('anything else is ignored, including an element with no id', () => {
    for (const id of ['', null, undefined, 'q-search', 'f-section']) {
      assert.strictEqual(routeChange(id, 'x').kind, 'none');
    }
  });

  test('the source cannot regain the guard that caused this', () => {
    // A structural check, because the failure mode was not a wrong value — it
    // was a branch that never ran, which no assertion about values can see.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/startsWith\('s-'\)\)\s*return/.test(src),
      "app.js is filtering the change listener on the 's-' prefix again, which makes the Plan controls dead");
  });
});

describe('what each answer means', () => {
  test('an answer merges into the others rather than replacing them', () => {
    let facts = {};
    facts = mergeFacts(facts, routeChange('p-match', 'no').facts);
    facts = mergeFacts(facts, routeChange('p-card', '4200').facts);
    facts = mergeFacts(facts, routeChange('p-hours', '10').facts);
    assert.deepStrictEqual(facts, { employerMatches: false, cardBalance: 4200, hoursAvailable: 10 },
      'a later answer erased an earlier one');
  });

  test('"I do not know" is a third answer, not a no', () => {
    assert.strictEqual(routeChange('p-match', '').facts.employerMatches, null);
    assert.strictEqual(routeChange('p-match', 'no').facts.employerMatches, false);
    assert.strictEqual(routeChange('p-match', 'yes').facts.employerMatches, true);
  });

  test('a cleared number is unknown, not zero', () => {
    // Zero card balance and "I have not told you" produce different plans: one
    // removes the debt step, the other keeps it as an open question.
    assert.strictEqual(routeChange('p-card', '').facts.cardBalance, null);
    assert.strictEqual(routeChange('p-card', '0').facts.cardBalance, 0);
    assert.strictEqual(routeChange('p-spend', '').facts.monthlyExpenses, null);
  });

  test('every fact a control produces is a fact the plan knows about', () => {
    const known = new Set(Object.keys(DEFAULT_FACTS));
    for (const [id, fn] of Object.entries(INPUTS.plan)) {
      for (const key of Object.keys(fn('1'))) {
        assert.ok(known.has(key), `${id} sets "${key}", which buildPlan has never heard of`);
      }
    }
  });
});

describe('and the plan actually changes', () => {
  let rows;
  test('setup', async () => {
    const { adapters } = loadAdapters();
    rows = (await aggregate(adapters, { offline: true })).opportunities;
  });

  test('saying you have no employer match removes the match step', () => {
    let facts = {};
    facts = mergeFacts(facts, routeChange('p-match', 'no').facts);
    const withAnswer = buildPlan(rows, { budget: 25000, facts });
    const withNone = buildPlan(rows, { budget: 25000, facts: {} });
    const matchSteps = (p) => p.steps.filter((s) => s.tier === 'match');
    assert.strictEqual(matchSteps(withAnswer).length, 0,
      'the plan still tells you to take a match you said you do not have');
    assert.ok(matchSteps(withNone).length > 0,
      'without an answer the match step should still be there as an assumption');
  });

  test('a card balance you carry outranks everything below it', () => {
    let facts = {};
    facts = mergeFacts(facts, routeChange('p-card', '6000').facts);
    const p = buildPlan(rows, { budget: 25000, facts });
    const debt = p.steps.findIndex((s) => s.tier === 'debt');
    assert.ok(debt >= 0, 'a $6,000 balance at 25% APR produced no step to clear it');
    const core = p.steps.findIndex((s) => s.tier === 'core');
    if (core >= 0) assert.ok(debt < core, 'the plan puts an investment above a 25% APR balance');
  });

  test('the hours you will spend bound how much hassle it asks for', () => {
    const lazy = buildPlan(rows, { budget: 25000, facts: mergeFacts({}, routeChange('p-hours', '0').facts) });
    const keen = buildPlan(rows, { budget: 25000, facts: mergeFacts({}, routeChange('p-hours', '40').facts) });
    assert.ok(keen.steps.length >= lazy.steps.length,
      'forty hours of willingness produced no more to do than zero');
  });
});
