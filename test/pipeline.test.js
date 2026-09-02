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
      // dogScore is a risk-adjusted YIELD rank, so it exists exactly when there
      // is a rate to rank. A pure movement row — a non-paying stock, or an
      // index-tier row nobody has measured — honestly has none, and inventing
      // one would be the bug this asserts against. Those rank on Heat instead.
      const rateless = (o.apy?.total ?? o.expected?.annualReturn ?? null) === null;
      if (rateless) {
        assert.strictEqual(s.dogScore, null, `${o.id} has no rate but was given a yield rank of ${s.dogScore}`);
        assert.strictEqual(o.track, 'movement', `${o.id} carries no rate but is not a movement row`);
      } else {
        assert.ok(Number.isFinite(s.dogScore) && s.dogScore >= 0 && s.dogScore <= 100, `${o.id} dogScore ${s.dogScore}`);
      }
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
      // A disabled source contributing nothing is the correct outcome, not a
      // fault, and an events-only source contributes events rather than rows.
      if (h.status !== C.SOURCE_STATUS.DISABLED) {
        const contributed = (h.count || 0) + (h.eventCount || 0);
        assert.ok(contributed > 0, `${h.label} is enabled but contributed nothing`);
      }
    }
    const counted = result.health.reduce((n, h) => n + h.count, 0);
    assert.ok(counted >= result.meta.total, 'health counts should cover the merged total');
  });

  test('modelled estimates are opt-in at the query level, not hidden behind a setting', () => {
    // The safety property that matters is that a yield search never returns a
    // modelled estimate. That is enforced by the query default, so the source
    // itself can ship enabled and the "High upside" view works out of the box.
    const spec = adapters.find((a) => a.id === 'speculative');
    assert.ok(spec, 'the speculative source should exist');
    assert.strictEqual(require('../src/core/filters').DEFAULT_QUERY.includeSpeculative, false);
    assert.strictEqual(require('../src/core/filters').DEFAULT_QUERY.onlySpeculative, false);
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

/**
 * Refreshing one source must not multiply another's events.
 *
 * The app refreshes each source on its own cadence, so almost every refresh
 * after launch is a partial one, and the events belonging to sources that were
 * not refreshed are carried forward. That carry-forward filtered on `e.source`,
 * which reads like the adapter id and is not — adapters put human provenance
 * there ("Treasury auction cycle", "BLS release pattern"). So refreshing the
 * calendar recognised only the events tagged literally 'calendar' and carried
 * the rest forward while the fresh fetch re-emitted them as well. The events
 * list grew every hour the app stayed open.
 */
describe('partial refresh', () => {
  let adapters;
  before(() => { adapters = loadAdapters().adapters; });

  test('refreshing one source repeatedly does not grow the event list', async () => {
    let state = await aggregate(adapters, { offline: true });
    const initial = state.events.length;
    assert.ok(initial > 100, `expected a populated calendar, got ${initial}`);

    for (let i = 0; i < 3; i += 1) {
      state = await aggregate(adapters, { offline: true, only: ['calendar'], previous: state });
      assert.strictEqual(state.events.length, initial,
        `event count moved to ${state.events.length} on refresh ${i + 1} — events are being duplicated`);
    }
  });

  test('a source that was not refreshed keeps its events', async () => {
    const first = await aggregate(adapters, { offline: true });
    const filingsBefore = first.events.filter((e) => e.adapterId === 'filings').length;
    assert.ok(filingsBefore > 0, 'expected filing events to carry across');

    const second = await aggregate(adapters, { offline: true, only: ['calendar'], previous: first });
    assert.strictEqual(second.events.filter((e) => e.adapterId === 'filings').length, filingsBefore,
      'refreshing the calendar dropped the filings events instead of carrying them');
  });

  test('every event knows which adapter produced it', () => {
    // The provenance string an adapter writes is for the reader. The adapter id
    // is for the pipeline, and confusing the two is what caused the duplication.
    return aggregate(adapters, { offline: true }).then((r) => {
      const ids = new Set(adapters.map((a) => a.id));
      for (const e of r.events) {
        assert.ok(ids.has(e.adapterId), `an event is tagged "${e.adapterId}", which is not an adapter`);
      }
    });
  });
});

/**
 * The statutory deadlines have to survive going online.
 *
 * They were added to the seed path only. The app shows bundled data for about a
 * second on launch and then refreshes live, and the calendar's live fetch always
 * returns events, so the seed path never ran again: the filing date, the four
 * estimated-tax dates, the 401(k) deferral cut-off and the FSA forfeiture date
 * appeared for one second and vanished for the rest of the session.
 */
describe('money deadlines', () => {
  test('both the bundled and the live calendar carry them', async () => {
    const calendar = require('../src/sources/calendar');
    const ctx = {
      now: Date.now(),
      seedDir: require('node:path').join(__dirname, '..', 'data', 'seed'),
      schema: require('../src/core/schema'),
      C: require('../src/core/constants'),
      cache: { get: () => null, set: () => {} },
      // No network in the test environment: every fetch fails and the adapter
      // still has to produce its computed events, which is exactly the path the
      // app takes when a feed is down.
      http: { getJson: async () => { throw new Error('offline'); }, getText: async () => { throw new Error('offline'); } },
      log: () => {},
      settings: {},
    };
    const seeded = calendar.loadSeed(ctx);
    const live = await calendar.fetch(ctx);
    const count = (res) => (res.events || []).filter((e) => e.kind === 'money_deadline').length;
    assert.ok(count(seeded) > 0, 'the bundled calendar lost its money deadlines');
    assert.strictEqual(count(live), count(seeded),
      'the live calendar drops the money deadlines the bundled one has');
  });
});

/**
 * The risk-free rate has to survive a refresh that did not ask about it.
 *
 * Sources refresh on their own cadences — crypto every four minutes, Treasury
 * every hour — so almost every refresh after launch is a partial one that does
 * not include Treasury. Each of those recomputed the rate from scratch, found
 * no Treasury result and dropped to the 4.00% fallback, and the whole table was
 * then re-scored against a number nobody had measured, roughly fourteen times
 * an hour. It moves the blend, the certainty-equivalent, the dogScore and every
 * dollar figure in the app.
 */
describe('the measured risk-free rate', () => {
  let adapters;
  before(() => { adapters = loadAdapters().adapters; });

  test('survives every refresh that does not include Treasury', async () => {
    let state = await aggregate(adapters, { offline: true });
    const measured = state.meta.riskFree;
    assert.strictEqual(state.meta.riskFreeSource, 'treasury', 'the baseline run did not measure a rate');

    for (const source of ['crypto', 'equities', 'deals', 'defillama', 'savings', 'crypto']) {
      state = await aggregate(adapters, { offline: true, only: [source], previous: state });
      assert.strictEqual(state.meta.riskFree, measured,
        `refreshing ${source} changed the risk-free rate to ${state.meta.riskFree}`);
      assert.match(state.meta.riskFreeSource, /^treasury \(carried\)$/,
        `the source label degraded to "${state.meta.riskFreeSource}"`);
    }

    // And refreshing Treasury itself measures it again rather than carrying.
    state = await aggregate(adapters, { offline: true, only: ['treasury'], previous: state });
    assert.strictEqual(state.meta.riskFreeSource, 'treasury');
  });

  test('a first run with no history still falls back honestly', async () => {
    const only = await aggregate(adapters, { offline: true, only: ['crypto'], previous: null });
    assert.strictEqual(only.meta.riskFreeSource, 'fallback',
      'with nothing measured and nothing carried, it must say it is guessing');
  });

  test('and the plan reads the same rate the table does', () => {
    // electron/main.js read `meta.riskFreeRate`, which nothing in the pipeline
    // has ever produced, so the plan quoted the 4.00% fallback while the table
    // beside it used the measured rate.
    const fs2 = require('node:fs');
    const src = fs2.readFileSync(require('node:path').join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert.ok(!/meta\?\.riskFreeRate/.test(src),
      'main.js is reading meta.riskFreeRate again, a key the pipeline does not emit');
  });
});
