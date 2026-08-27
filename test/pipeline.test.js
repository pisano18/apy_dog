'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { loadAdapters, describeAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const { applyQuery, facets } = require('../src/core/filters');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { Store } = require('../src/core/store');
const { History } = require('../src/core/history');

/**
 * Whole-pipeline checks: registry -> every adapter -> merge -> score -> filter.
 *
 * The unit tests prove each part behaves; this proves they compose, and pins the
 * invariants that must hold across the entire dataset no matter which adapters
 * ship. Anything that can put a nonsensical row in front of someone deciding
 * where to put money belongs here.
 */

let result;
let adapters;

before(async () => {
  const loaded = loadAdapters();
  adapters = loaded.adapters;
  assert.deepStrictEqual(loaded.problems, [], `adapters failed to load: ${JSON.stringify(loaded.problems)}`);
  result = await aggregate(adapters, {
    offline: true,
    settings: { riskAppetite: 45, tax: { federalOrdinary: 24, state: 'TX', inflation: 2.6 }, budget: 10000 },
    seedDir: path.join(__dirname, '..', 'data', 'seed'),
  });
});

describe('registry', () => {
  test('every adapter satisfies the contract and has a unique id', () => {
    assert.ok(adapters.length >= 4, `only ${adapters.length} adapters loaded`);
    const ids = adapters.map((a) => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate adapter ids');
  });

  test('treasury is ordered first, because the risk-free rate comes from it', () => {
    assert.strictEqual(adapters[0].id, 'treasury');
  });

  test('descriptors are complete enough for the settings panel', () => {
    for (const d of describeAdapters(adapters)) {
      assert.ok(d.label && d.label.length > 3, `${d.id} has no label`);
      assert.ok(Array.isArray(d.assetClasses) && d.assetClasses.length, `${d.id} declares no asset classes`);
      for (const cls of d.assetClasses) {
        assert.ok(Object.values(C.ASSET_CLASS).includes(cls), `${d.id} declares unknown class ${cls}`);
      }
    }
  });
});

describe('aggregate', () => {
  test('produces a substantial, fully valid dataset offline', () => {
    assert.ok(result.opportunities.length >= 100, `only ${result.opportunities.length} rows`);
    assert.strictEqual(result.meta.invalidDropped, 0, `dropped invalid rows: ${JSON.stringify(result.meta.invalidSample)}`);
    for (const o of result.opportunities) {
      assert.deepStrictEqual(schema.validate(o), [], `${o.id} is invalid`);
    }
  });

  test('takes the risk-free rate from Treasury, not the fallback', () => {
    assert.match(result.meta.riskFreeSource, /treasury/);
    assert.ok(result.meta.riskFree > 0 && result.meta.riskFree < 15, `implausible risk-free ${result.meta.riskFree}`);
  });

  test('every row is scored, and every score is internally consistent', () => {
    for (const o of result.opportunities) {
      const s = o.scores;
      assert.ok(s, `${o.id} was not scored`);
      assert.ok(Number.isFinite(s.dogScore) && s.dogScore >= 0 && s.dogScore <= 100, `${o.id} dogScore ${s.dogScore}`);
      assert.ok(Number.isFinite(o.risk.score) && o.risk.score >= 0 && o.risk.score <= 100, `${o.id} risk ${o.risk.score}`);
      assert.ok(Number.isFinite(o.trapScore) && o.trapScore >= 0 && o.trapScore <= 100);
      assert.ok(s.tail.annualProbability >= 0 && s.tail.annualProbability <= 1);
      assert.ok(o.confidence >= 0 && o.confidence <= 1);
      // After-tax can never exceed gross, and tax rates cannot exceed 100%.
      if (Number.isFinite(o.tax?.afterTaxApy) && Number.isFinite(o.tax?.grossApy) && o.tax.grossApy >= 0) {
        assert.ok(o.tax.afterTaxApy <= o.tax.grossApy + 1e-9, `${o.id}: after-tax ${o.tax.afterTaxApy} > gross ${o.tax.grossApy}`);
      }
      assert.ok(o.tax.effectiveTaxRate >= 0 && o.tax.effectiveTaxRate < 100);
    }
  });

  test('every row tells the user how to actually buy it', () => {
    // A yield you cannot act on is noise, so this is a hard requirement.
    const missing = result.opportunities.filter((o) => !o.accessNotes || !o.url);
    assert.deepStrictEqual(missing.map((o) => o.id), [], 'rows without accessNotes or url');
  });

  test('rates are percentages, not decimals — the classic adapter bug', () => {
    // A real 4.5% must never arrive as 0.045. Nothing legitimate in this dataset
    // yields under 0.05%, so anything that low is a units error.
    const suspects = result.opportunities.filter((o) => {
      const v = o.apy?.total;
      return Number.isFinite(v) && v > 0 && v < 0.05;
    });
    assert.deepStrictEqual(suspects.map((o) => `${o.id}=${o.apy.total}`), []);
  });

  test('no row claims an implausible rate', () => {
    for (const o of result.opportunities) {
      const v = o.apy?.total ?? o.expected?.annualReturn;
      assert.ok(v === null || v === undefined || (v > -100 && v < 5000), `${o.id} claims ${v}%`);
    }
  });

  test('source health accounts for every adapter', () => {
    assert.strictEqual(result.health.length, adapters.length);
    for (const h of result.health) {
      assert.ok(Object.values(C.SOURCE_STATUS).includes(h.status), `${h.id} status ${h.status}`);
      // A disabled source contributing nothing is the correct outcome, not a fault.
      if (h.status !== C.SOURCE_STATUS.DISABLED) {
        assert.ok(h.count > 0, `${h.label} is enabled but contributed nothing`);
      }
    }
    const counted = result.health.reduce((n, h) => n + h.count, 0);
    assert.ok(counted >= result.meta.total, 'health counts should cover the merged total');
  });

  test('modelled estimates are opt-in at the source level', () => {
    // Speculative rows are a different kind of claim, so the source that produces
    // them must not be on by default.
    const spec = adapters.find((a) => a.id === 'speculative');
    assert.ok(spec, 'the speculative source should exist');
    assert.strictEqual(spec.defaultEnabled, false, 'modelled estimates must be opt-in');
  });
});

describe('financial sanity across the whole dataset', () => {
  const find = (pred) => result.opportunities.filter(pred);

  test('nothing government-backed or insured is rated above conservative', () => {
    const wrong = find((o) => ['us_gov', 'fdic', 'ncua'].includes(o.risk?.insurance) && o.risk.score > 22);
    assert.deepStrictEqual(wrong.map((o) => `${o.name}=${o.risk.score}`), []);
  });

  test('nothing uninsured and volatile is rated as a vault', () => {
    const wrong = find((o) => o.assetClass === 'crypto_lp' && o.risk.score < 22);
    assert.deepStrictEqual(wrong.map((o) => o.name), []);
  });

  test('every fixed-term product actually carries a term', () => {
    const wrong = find((o) => o.assetClass === 'cd' && !Number.isFinite(o.term?.days) && o.liquidity === C.LIQUIDITY.LOCKED);
    assert.deepStrictEqual(wrong.map((o) => o.name), []);
  });

  test('anything paying more than 40% is flagged', () => {
    // If a row pays multiples of the risk-free rate and raises no flag at all,
    // the trap detector has a blind spot and someone will get hurt by it.
    const unflagged = find((o) => (o.apy?.total ?? 0) > 40 && (o.trapFlags || []).length === 0);
    assert.deepStrictEqual(unflagged.map((o) => `${o.name}=${o.apy.total}%`), []);
  });

  test('Treasuries are taxed as Treasuries and REITs get 199A', () => {
    for (const o of find((x) => x.source === 'treasury')) {
      assert.strictEqual(o.taxTreatment, C.TAX_TREATMENT.TREASURY, `${o.name} has wrong tax treatment`);
      assert.strictEqual(o.risk.insurance, C.INSURANCE.US_GOV);
    }
    for (const o of find((x) => x.assetClass === 'reit' || x.assetClass === 'bdc')) {
      assert.strictEqual(o.taxTreatment, C.TAX_TREATMENT.SECTION_199A, `${o.name} should get the 199A deduction`);
    }
  });

  test('the top of the default ranking is not dominated by trap rows', () => {
    const top = applyQuery(result.opportunities, { limit: 20 });
    const traps = top.filter((o) => o.scores.traps.verdict === 'likely_trap');
    assert.strictEqual(traps.length, 0, `traps in the default top 20: ${traps.map((t) => t.name)}`);
  });

  test('sorting by raw APY surfaces the high numbers, flags intact', () => {
    const top = applyQuery(result.opportunities, { sortBy: 'apy', hideTraps: false, limit: 5 });
    assert.ok(top[0].apy.total >= top[4].apy.total, 'not sorted descending');
    // The point of the app: the highest number is still shown, but labelled.
    if (top[0].apy.total > 40) {
      assert.ok(top[0].trapFlags.length > 0, 'the highest APY in the app carries no warning');
    }
  });

  test('speculative rows never carry an apy and never leak into a yield sort', () => {
    for (const o of find((x) => x.yieldKind === C.YIELD_KIND.EXPECTED)) {
      assert.strictEqual(o.apy?.total, null, `${o.name} presents a modelled estimate as a yield`);
      assert.ok(Number.isFinite(o.expected?.annualReturn));
      assert.ok(o.confidence <= 0.5, `${o.name} claims ${o.confidence} confidence for an estimate`);
    }
    const yieldSort = applyQuery(result.opportunities, { sortBy: 'apy', hideTraps: false, limit: 500 });
    assert.strictEqual(yieldSort.filter((o) => o.yieldKind === C.YIELD_KIND.EXPECTED).length, 0);
  });
});

describe('query layer over the real dataset', () => {
  test('facets never claim more matches than exist', () => {
    const f = facets(result.opportunities, {});
    assert.strictEqual(f.total, result.opportunities.length);
    for (const [k, n] of Object.entries(f.byAssetClass)) {
      assert.ok(n <= f.total, `${k} facet ${n} exceeds total`);
    }
  });

  test('the insured-only filter returns only insured things', () => {
    for (const o of applyQuery(result.opportunities, { insuredOnly: true })) {
      assert.ok(['fdic', 'ncua', 'us_gov'].includes(o.risk.insurance), `${o.name} is not insured`);
    }
  });

  test('an affordability filter never returns something you cannot afford', () => {
    for (const o of applyQuery(result.opportunities, { minInvestmentMax: 500 })) {
      assert.ok(!Number.isFinite(o.minInvestment) || o.minInvestment <= 500, `${o.name} needs ${o.minInvestment}`);
    }
  });

  test('a no-lockup filter never returns something locked up', () => {
    for (const o of applyQuery(result.opportunities, { termPreset: 'liquid' })) {
      assert.notStrictEqual(o.liquidity, C.LIQUIDITY.LOCKED, `${o.name} is locked`);
    }
  });

  test('every sort order runs without throwing and returns the full set', () => {
    const { SORTERS } = require('../src/core/score');
    for (const key of Object.keys(SORTERS)) {
      const rows = applyQuery(result.opportunities, { sortBy: key, hideTraps: false, includeSpeculative: true });
      assert.strictEqual(rows.length, result.opportunities.length, `sort ${key} lost rows`);
    }
  });
});

describe('persistence round trip', () => {
  test('settings, watchlist and history survive a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apy-dog-test-'));
    const store = new Store(dir);
    store.updateSettings({ tax: { state: 'CA' }, riskAppetite: 80 });
    const sample = result.opportunities[0];
    store.toggleWatch(sample.id, sample.name);
    store.addAlert({ opportunityId: sample.id, kind: 'apy_below', threshold: 1 });

    const history = new History(dir);
    history.record(result.opportunities.slice(0, 10), Date.now() - 20 * 86400000);
    history.record(result.opportunities.slice(0, 10));

    const reopened = new Store(dir);
    assert.strictEqual(reopened.settings.tax.state, 'CA');
    assert.strictEqual(reopened.settings.riskAppetite, 80);
    assert.strictEqual(reopened.settings.tax.federalOrdinary, 24, 'defaults must survive a partial update');
    assert.deepStrictEqual(reopened.watchlistIds(), [sample.id]);
    assert.strictEqual(reopened.alerts.length, 1);
    assert.ok(new History(dir).stats().points >= 20);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an alert fires when its condition is met', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apy-dog-test-'));
    const store = new Store(dir);
    store.addAlert({ kind: 'new_above', threshold: 6, scope: { assetClasses: ['cash'], hideTraps: false } });
    const fired = store.evaluateAlerts(result.opportunities);
    assert.ok(fired.length > 0, 'a 6% cash alert should match something in the seed data');
    assert.ok(fired.every((f) => f.opportunity.apy.total >= 6));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
