'use strict';

/**
 * Which control was that, and what does it mean?
 *
 * One `change` listener serves the whole window: the Settings panel (s-*) and
 * the Plan view's five questions (p-*) both arrive at it. It used to open with
 *
 *     if (!el.id?.startsWith('s-')) return;
 *
 * and then, forty lines later, branch on `el.id.startsWith('p-')` — code that
 * could never run. Every answer anyone typed into the Plan was dropped on the
 * floor: the plan was always rebuilt from defaults, so it permanently showed an
 * employer-match step to people who had just told it they have no match, and
 * the view's own promise — tell it the handful of things it cannot work out for
 * itself and the sequence becomes yours — was never once kept.
 *
 * The reason nothing caught it is that it lived in the renderer, where nothing
 * is loaded outside a running Electron window. So the routing and the meaning
 * of each control live here instead, as plain functions over an id and a value,
 * and the listener in app.js does nothing but dispatch on what they return.
 */
const INPUTS = {
  /**
   * The plan's questions. Each returns a PARTIAL fact set — one answer — which
   * the caller merges into what it already knows. Returning a whole fact object
   * would mean every control erased the other four.
   */
  plan: {
    // Three states, not two. "" is "I do not know", which is a different answer
    // from "no" and produces a different plan: unknown keeps the match step and
    // labels it an assumption, no removes it.
    'p-match': (v) => ({ employerMatches: v === '' ? null : v === 'yes' }),
    'p-card': (v) => ({ cardBalance: v === '' ? null : Number(v) }),
    'p-spend': (v) => ({ monthlyExpenses: v === '' ? null : Number(v) }),
    'p-hours': (v) => ({ hoursAvailable: Number(v) || 0 }),
    'p-months': (v) => ({ bufferMonths: Number(v) || 0 }),
  },
};

/**
 * @param {string} id       the element's id
 * @param {string} value    its value, as the DOM reports it
 * @returns {{kind:'plan', facts:object} | {kind:'settings'} | {kind:'none'}}
 */
function routeChange(id, value) {
  if (!id) return { kind: 'none' };
  const plan = INPUTS.plan[id];
  if (plan) return { kind: 'plan', facts: plan(value) };
  if (id.startsWith('s-')) return { kind: 'settings' };
  return { kind: 'none' };
}

/** Merge one answer into the answers already given. Never replaces. */
function mergeFacts(existing, facts) {
  return { ...(existing || {}), ...(facts || {}) };
}

const UI_INPUTS = { INPUTS, routeChange, mergeFacts };

if (typeof window !== 'undefined') window.UI_INPUTS = UI_INPUTS;
if (typeof module !== 'undefined' && module.exports) module.exports = UI_INPUTS;
