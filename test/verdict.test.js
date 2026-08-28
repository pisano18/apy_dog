'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { verdictFor } = require('../src/core/verdict');
const { expectationsFor } = require('../src/core/expectations');

/**
 * The plain-English read.
 *
 * The property that matters is not that the prose is nice — it is that it can
 * never drift from the numbers beside it, and that it never says something
 * generic enough to be true of everything. "This investment carries risk" is
 * noise wearing the costume of advice, and a sentence that appears on every row
 * is worse than no sentence.
 */

let rows;
before(async () => {
  const { adapters } = loadAdapters();
  const r = await aggregate(adapters, { offline: true });
  rows = r.opportunities;
});

const vf = (o, amount = 10000) => verdictFor(o, {
  amount, riskFree: 4, expectations: expectationsFor(o, { amount }),
});

describe('every row gets a read, and none of them throws', () => {
  test('the whole dataset produces a verdict', () => {
    let made = 0;
    for (const o of rows) {
      const v = vf(o);
      assert.ok(v, `${o.name} produced no verdict`);
      assert.ok(v.headline && v.headline.length > 20, `${o.name} has a stub headline`);
      assert.ok(v.risk && v.risk.text, `${o.name} names no risk`);
      assert.ok(v.bestFor && v.notFor, `${o.name} says who it suits but not who it does not`);
      made += 1;
    }
    assert.strictEqual(made, rows.length);
  });

  test('it survives a row stripped of almost everything', () => {
    assert.doesNotThrow(() => verdictFor({ name: 'x', scores: {} }, {}));
    assert.strictEqual(verdictFor(null, {}), null);
    assert.strictEqual(verdictFor('nonsense', {}), null);
  });
});

describe('nothing generic, because generic is noise', () => {
  test('headlines are not all the same sentence', () => {
    const heads = rows.slice(0, 200).map((o) => vf(o).headline);
    const unique = new Set(heads);
    assert.ok(unique.size > heads.length * 0.5,
      `only ${unique.size} distinct headlines across ${heads.length} rows — the prose is boilerplate`);
  });

  test('a headline carries a real figure or a specific fact', () => {
    for (const o of rows.filter((x) => x.section === 'income').slice(0, 60)) {
      const h = vf(o).headline;
      assert.ok(/\d/.test(h) || h.includes(o.name.slice(0, 12)),
        `"${h}" says nothing specific about ${o.name}`);
    }
  });

  test('the case is drawn from the row, never invented', () => {
    // Every bullet must be traceable: an insured row may claim insurance, an
    // uninsured one may not.
    for (const o of rows.slice(0, 300)) {
      const v = vf(o);
      for (const c of v.theCase) {
        if (/federally insured/.test(c)) {
          assert.ok(['fdic', 'ncua'].includes(String(o.risk?.insurance)),
            `${o.name} claims federal insurance it does not have`);
        }
        if (/closes in/.test(c)) {
          assert.ok(Number.isFinite(o.daysLeft), `${o.name} claims a deadline it does not have`);
        }
      }
    }
  });
});

describe('the risk named is the one that matters', () => {
  test('anything that can go to zero says so, in those words', () => {
    const worst = rows.filter((o) => o.rating?.grade === 'F');
    assert.ok(worst.length > 0);
    for (const o of worst.slice(0, 40)) {
      assert.strictEqual(vf(o).risk.severity, 'high');
      assert.ok(/zero/.test(vf(o).risk.text), `${o.name} is an F and does not mention total loss`);
    }
  });

  test('a guaranteed deposit is not described as if it could collapse', () => {
    const safe = rows.filter((o) => o.rating?.grade === 'A+' && !o.risk?.principalAtRisk);
    assert.ok(safe.length > 3);
    for (const o of safe.slice(0, 30)) {
      const r = vf(o).risk;
      assert.notStrictEqual(r.severity, 'high', `${o.name} is insured and graded A+ but flagged high risk`);
      assert.ok(!/go to zero/.test(r.text));
    }
  });

  test('a flagged trap leads with the flag rather than a generic caution', () => {
    const traps = rows.filter((o) => o.scores?.traps?.verdict === 'likely_trap');
    for (const o of traps.slice(0, 20)) {
      const r = vf(o).risk;
      assert.strictEqual(r.severity, 'high');
      assert.ok(/flag|checks/i.test(r.text), `${o.name} is flagged and the risk text does not say so`);
    }
  });

  test('a one-off names the requirements, not market loss', () => {
    for (const o of rows.filter((x) => x.oneTime && x.section === 'deals').slice(0, 30)) {
      const t = vf(o).risk.text;
      assert.ok(/requirement|other people|sign up|flag|zero/i.test(t),
        `"${t}" is not the real risk of a one-off payment`);
    }
  });
});

describe('it always says who it is NOT for', () => {
  test('every row has both halves, because only one is a sales pitch', () => {
    for (const o of rows.slice(0, 200)) {
      const v = vf(o);
      assert.ok(v.notFor.length > 20, `${o.name} has no "not for"`);
      assert.notStrictEqual(v.bestFor, v.notFor);
    }
  });

  test('risky things are not recommended for an emergency fund', () => {
    for (const o of rows.filter((x) => ['D', 'E', 'F'].includes(x.rating?.grade)).slice(0, 30)) {
      assert.ok(/emergency|forced to sell|lose entirely|small slice/i.test(`${vf(o).bestFor} ${vf(o).notFor}`),
        `${o.name} is a ${o.rating.grade} and its suitability text does not warn anyone off`);
    }
  });
});

describe('what would change the answer', () => {
  test('an unmeasured row says a refresh would change it', () => {
    const un = rows.find((o) => o.measured === false);
    if (un) assert.ok(vf(un).changesIt.some((c) => /Refresh/i.test(c)));
  });

  test('with no amount set, it says so', () => {
    const o = rows.find((x) => x.section === 'income');
    const v = verdictFor(o, { amount: null, riskFree: 4 });
    assert.ok(v.changesIt.some((c) => /how much you have/i.test(c)),
      'a reader with no amount set is not told that it matters');
  });

  test('a capped row explains what happens above the cap', () => {
    const capped = rows.find((o) => Number.isFinite(o.maxInvestment) && o.scores?.blendApplied);
    if (capped) {
      assert.ok(vf(capped).changesIt.some((c) => /cap|pays nothing extra/i.test(c)));
    }
  });
});

describe('the compact form stays usable', () => {
  test('oneLine is short enough for a tooltip and still says something', () => {
    for (const o of rows.slice(0, 100)) {
      const l = vf(o).oneLine;
      assert.ok(l.length > 40 && l.length <= 260, `oneLine is ${l.length} chars for ${o.name}`);
    }
  });
});

describe('the verdict can never contradict the grade beside it', () => {
  test('nothing below grade F is described as able to go to zero', () => {
    // This shipped: an employer match is graded A, is not FDIC insured, and had
    // "the whole position can go to zero" printed under it — because the risk
    // text triggered on "uninsured" as well as on the grade. Treasuries,
    // employer promises and government paper are all uninsured in that narrow
    // sense and none of them goes to zero.
    for (const o of rows) {
      const g = o.rating?.grade;
      if (g === 'F') continue;
      const t = vf(o).risk.text;
      assert.ok(!/go to zero|lose entirely/.test(t),
        `${o.name} is graded ${g} and its risk text claims total loss`);
    }
  });

  test('a high-severity risk never sits on an A or A+ row', () => {
    for (const o of rows.filter((x) => ['A+', 'A'].includes(x.rating?.grade))) {
      const v = vf(o);
      if (o.scores?.traps?.verdict === 'likely_trap') continue;   // a flag legitimately escalates
      assert.notStrictEqual(v.risk.severity, 'high',
        `${o.name} is graded ${o.rating.grade} but flagged high risk`);
    }
  });

  test('a one-off is never compared to cash on an annual basis', () => {
    // "Beats cash by 96.2%" appeared under a 50% employer match you collect
    // once. Setting a one-time return against an annual rate is a category
    // error, however true the subtraction is.
    for (const o of rows.filter((x) => x.oneTime)) {
      for (const c of vf(o).theCase) {
        assert.ok(!/beats cash/.test(c), `${o.name} is a one-off and is compared to cash annually`);
      }
    }
  });

  test('the named risk matches what the thing actually is', () => {
    const bySub = (sub) => rows.find((o) => o.subType === sub);
    const match = bySub('employer_match');
    if (match) {
      assert.match(vf(match).risk.text, /vest/i,
        'an employer match must name vesting, not a minimum balance');
    }
    const ref = rows.find((o) => o.subType === 'referral_bonus');
    if (ref) assert.match(vf(ref).risk.text, /other people/i);
    const taxRule = bySub('tax_rule');
    if (taxRule) assert.match(vf(taxRule).risk.text, /eligib|income limit|deadline/i);
  });

  test('a provider name reads correctly inside a sentence', () => {
    const { providerName } = require('../src/core/verdict');
    assert.strictEqual(providerName({ provider: "Your employer's retirement plan" }), "your employer's retirement plan");
    assert.strictEqual(providerName({ provider: 'JPMorgan Chase Bank, N.A.' }), 'JPMorgan Chase Bank, N.A.');
    assert.strictEqual(providerName({}), null);
    // And a headline that leads with it still starts with a capital.
    const o = rows.find((x) => x.section === 'income' && x.provider);
    assert.match(vf(o).headline, /^[A-Z]/, 'the headline does not start with a capital');
  });
});
