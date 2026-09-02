'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadAdapters } = require('../src/sources');
const { aggregate } = require('../src/core/aggregate');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const T = require('../src/core/tracks');
const { EVENT_INFO } = require('../src/core/catalyst');
const { applyQuery } = require('../src/core/filters');
const { REFERENCE_AMOUNT } = require('../src/core/score');

/**
 * Cross-source audit.
 *
 * Each adapter has its own tests written by whoever built it. This file is the
 * independent pass over ALL of them at once: the invariants that must hold no
 * matter which source produced a row, checked against the real bundled dataset
 * rather than a fixture.
 *
 * It exists because it is the class of check that finds the bugs unit tests miss
 * — a source that quietly puts a decimal where a percent belongs, or marks a
 * growth stock as income, or ships an event whose date parses to nonsense. Those
 * only show up when everything is loaded together.
 */

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
let adapters;
let result;
let rows;
let events;

before(async () => {
  const loaded = loadAdapters();
  adapters = loaded.adapters;
  assert.deepStrictEqual(loaded.problems, [], `adapters failed to load: ${JSON.stringify(loaded.problems)}`);
  result = await aggregate(adapters, {
    offline: true,
    seedDir: SEED_DIR,
    settings: {
      enabledSources: adapters.map((a) => a.id),
      riskAppetite: 45,
      tax: { federalOrdinary: 24, state: 'TX', inflation: 2.6 },
      budget: 10000,
      movementHorizonDays: 30,
    },
  });
  rows = result.opportunities;
  events = result.events;
});

/* ------------------------------------------------------------ every source */

describe('all sources load and contribute', () => {
  test('the dataset is large, valid and fully scored', () => {
    assert.ok(rows.length >= 500, `expected 500+ rows, got ${rows.length}`);
    assert.strictEqual(result.meta.invalidDropped, 0, JSON.stringify(result.meta.invalidSample));
    for (const o of rows) {
      assert.deepStrictEqual(schema.validate(o), [], `${o.id} is invalid`);
      assert.ok(o.scores, `${o.id} unscored`);
      assert.ok(o.rating, `${o.id} unrated`);
      assert.ok(T.GRADE.some((g) => g.key === o.rating.grade), `${o.id} has grade "${o.rating.grade}"`);
    }
  });

  test('every enabled source produced rows or events', () => {
    for (const h of result.health) {
      if (h.status === C.SOURCE_STATUS.DISABLED) continue;
      assert.ok((h.count || 0) + (h.eventCount || 0) > 0, `${h.label} contributed nothing`);
    }
  });

  test('every seed file on disk is valid JSON with the shape its adapter expects', () => {
    for (const f of fs.readdirSync(SEED_DIR).filter((x) => x.endsWith('.json'))) {
      const raw = fs.readFileSync(path.join(SEED_DIR, f), 'utf8');
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, `${f} is not valid JSON`);
      const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.events || [];
      assert.ok(Array.isArray(items), `${f} has no items or events array`);
      assert.ok(items.length > 0, `${f} is empty`);
    }
  });
});

/* --------------------------------------------------- the units are correct */

describe('units and magnitudes', () => {
  test('rates are percentages, never decimals', () => {
    // The single most likely adapter bug: 4.5% arriving as 0.045.
    const suspects = rows.filter((o) => {
      const v = o.apy?.total;
      return Number.isFinite(v) && v > 0 && v < 0.05;
    });
    assert.deepStrictEqual(suspects.map((o) => `${o.source}:${o.id}=${o.apy.total}`), []);
  });

  test('no row claims an impossible rate or return', () => {
    for (const o of rows) {
      const v = o.apy?.total;
      if (Number.isFinite(v)) assert.ok(v > -100 && v < 5000, `${o.id} claims ${v}% yield`);
      const e = o.expected?.annualReturn;
      if (Number.isFinite(e)) assert.ok(e > -100 && e < 500, `${o.id} expects ${e}%`);
    }
  });

  test('probabilities are fractions and volatilities are percentages', () => {
    for (const o of rows) {
      const p = o.expected?.probabilityOfLoss;
      if (p !== null && p !== undefined) assert.ok(p >= 0 && p <= 1, `${o.id} probabilityOfLoss ${p} is not a fraction`);
      assert.ok(o.confidence >= 0 && o.confidence <= 1, `${o.id} confidence ${o.confidence}`);
      const vol = o.risk?.volatility;
      if (Number.isFinite(vol)) assert.ok(vol >= 0 && vol < 600, `${o.id} volatility ${vol} is implausible as a percent`);
      const dd = o.risk?.maxDrawdown;
      if (Number.isFinite(dd)) assert.ok(dd >= 0 && dd <= 100, `${o.id} maxDrawdown ${dd} must be a positive percent`);
    }
  });

  test('prices and minimums are positive where present', () => {
    for (const o of rows) {
      if (Number.isFinite(o.price)) assert.ok(o.price > 0, `${o.id} price ${o.price}`);
      if (Number.isFinite(o.minInvestment)) assert.ok(o.minInvestment >= 0, `${o.id} min ${o.minInvestment}`);
      if (Number.isFinite(o.tvl)) assert.ok(o.tvl >= 0, `${o.id} tvl ${o.tvl}`);
    }
  });
});

/* ------------------------------------------------------- tracks and rating */

describe('track assignment is honest', () => {
  test('nothing without a yield sits on the income track', () => {
    const wrong = rows.filter((o) => o.track === T.TRACK.INCOME
      && !Number.isFinite(o.apy?.total) && !Number.isFinite(o.expected?.annualReturn));
    assert.deepStrictEqual(wrong.map((o) => `${o.source}:${o.id}`), []);
  });

  test('a fund or stock with a token dividend is never an income holding', () => {
    // A savings account paying 0.4% is still an income product — badly, but the
    // return is entirely its yield. The distinction only bites for funds and
    // equities, where a small dividend is incidental to a price-driven return.
    const priceDriven = ['etf', 'dividend_equity', 'cef'];
    const wrong = rows.filter((o) => o.track === T.TRACK.INCOME
      && priceDriven.includes(o.assetClass)
      && Number.isFinite(o.apy?.total) && o.apy.total < 1.5);
    assert.deepStrictEqual(wrong.map((o) => `${o.name}=${o.apy.total}%`), []);
  });

  test('spot crypto pays nothing and says so', () => {
    const spot = rows.filter((o) => o.source === 'crypto');
    assert.ok(spot.length > 20, 'expected a crypto universe');
    for (const o of spot) {
      assert.strictEqual(o.apy?.total, null, `${o.name} claims a yield for holding a coin`);
      assert.notStrictEqual(o.track, T.TRACK.INCOME);
    }
  });

  test('both tracks are well populated and every row is reachable', () => {
    const t = result.meta.byTrack;
    assert.ok(t.income > 100 && t.movement > 100, JSON.stringify(t));
    const reachable = new Set([
      ...applyQuery(rows, { track: 'income', hideTraps: false, includeSpeculative: true, limit: 1e5 }).map((o) => o.id),
      ...applyQuery(rows, { track: 'movement', hideTraps: false, includeSpeculative: true, limit: 1e5 }).map((o) => o.id),
    ]);
    const orphans = rows.filter((o) => !reachable.has(o.id));
    assert.deepStrictEqual(orphans.map((o) => `${o.id} (track=${o.track})`), [], 'rows invisible in both tracks');
  });
});

describe('ratings are internally consistent', () => {
  test('a better grade never accompanies a worse risk score', () => {
    const order = T.GRADE.map((g) => g.key);
    for (const o of rows) {
      const expected = T.grade(o.risk.score).key;
      assert.strictEqual(o.rating.grade, expected, `${o.id} risk ${o.risk.score} graded ${o.rating.grade}, expected ${expected}`);
      assert.ok(order.includes(o.rating.grade));
    }
  });

  test('every axis is in range and explains itself', () => {
    for (const o of rows) {
      for (const meta of T.AXES) {
        const ax = o.rating.axes[meta.key];
        assert.ok(ax, `${o.id} missing axis ${meta.key}`);
        if (ax.value !== null) assert.ok(ax.value >= 0 && ax.value <= 5, `${o.id} ${meta.key}=${ax.value}`);
        assert.ok(typeof ax.why === 'string' && ax.why.length > 3, `${o.id} ${meta.key} has no explanation`);
      }
    }
  });

  test('insured principal always rates 5, and nothing uninsured does', () => {
    for (const o of rows) {
      const insured = ['us_gov', 'fdic', 'ncua'].includes(o.risk?.insurance);
      if (insured) assert.strictEqual(o.rating.axes.principal.value, 5, `${o.name} is insured but rates ${o.rating.axes.principal.value}`);
      else assert.ok(o.rating.axes.principal.value < 5, `${o.name} is uninsured but rates full principal safety`);
    }
  });

  test('the payout axis is not applicable exactly on pure movement rows', () => {
    for (const o of rows) {
      const na = o.rating.axes.payout.value === null;
      assert.strictEqual(na, o.track === T.TRACK.MOVEMENT, `${o.id} track=${o.track} payout na=${na}`);
    }
  });
});

/* ------------------------------------------------------------------ events */

describe('events are well formed', () => {
  test('every event has a real kind, a parseable date and correct tense', () => {
    assert.ok(events.length > 50, `expected a populated calendar, got ${events.length}`);
    const now = Date.now();
    for (const e of events) {
      assert.ok(EVENT_INFO[e.kind], `unknown event kind "${e.kind}"`);
      assert.ok(Number.isFinite(e.dateMs) && Math.abs(e.dateMs) < 8.64e15, `${e.kind} has an unusable date`);
      assert.doesNotThrow(() => new Date(e.dateMs).toISOString(), `${e.kind} date throws on format`);
      assert.strictEqual(e.past, e.dateMs < now, `${e.kind} tense is wrong`);
      assert.ok(['confirmed', 'estimated'].includes(e.certainty));
      assert.ok(e.label && e.text, `${e.kind} has no description`);
    }
  });

  test('events reach the rows they are about, and not the ones they are not', () => {
    const withEvents = rows.filter((o) => (o.events || []).length);
    assert.ok(withEvents.length > 50, `only ${withEvents.length} rows received events`);
    for (const o of rows) {
      for (const e of o.events || []) {
        // A symbol-scoped event must never land on a different symbol.
        if (e.scope === 'symbol' && e.symbol && o.symbol) {
          assert.strictEqual(String(e.symbol).toUpperCase(), String(o.symbol).toUpperCase(),
            `${e.kind} for ${e.symbol} attached to ${o.symbol}`);
        }
      }
      // A pure income row has no business hearing about options expiry.
      if (o.track === T.TRACK.INCOME) {
        assert.ok(!(o.events || []).some((e) => e.scope === 'market'),
          `${o.name} is income-only but received a market-wide event`);
      }
    }
  });

  test('a catalyst is never a distant generic event', () => {
    for (const o of rows) {
      const e = o.movement?.catalyst?.event;
      if (!e) continue;
      if (e.scope !== 'symbol') {
        assert.ok(e.daysAway <= 45, `${o.name} calls a generic ${e.kind} ${Math.round(e.daysAway)} days out its catalyst`);
      }
      assert.ok(e.daysAway >= 0, `${o.name} has a past event as its next catalyst`);
    }
  });
});

/* ---------------------------------------------------------------- movement */

describe('movement reads are sane', () => {
  test('measured rows have real statistics, unmeasured ones claim nothing', () => {
    const movers = rows.filter((o) => o.movement);
    assert.ok(movers.length > 100, `only ${movers.length} movement reads`);
    for (const o of movers) {
      if (o.movement.unmeasured) {
        assert.strictEqual(o.movement.heat, null, `${o.id} is unmeasured but reports heat`);
        assert.strictEqual(o.movement.setup, null, `${o.id} is unmeasured but claims a setup`);
      } else {
        assert.ok(o.movement.heat >= 0 && o.movement.heat <= 100, `${o.id} heat ${o.movement.heat}`);
        assert.ok(Object.values(T.SETUP).includes(o.movement.setup), `${o.id} setup "${o.movement.setup}"`);
        assert.ok(['up', 'down', 'none'].includes(o.movement.lean));
        assert.ok(o.movement.clarity <= 0.85, `${o.id} clarity ${o.movement.clarity} exceeds the cap`);
      }
    }
  });

  test('heat is not clustered at a single value', () => {
    const heats = rows.map((o) => o.movement?.heat).filter(Number.isFinite);
    assert.ok(heats.length > 50);
    const distinct = new Set(heats.map((h) => Math.round(h / 5)));
    assert.ok(distinct.size >= 4, `heat has only ${distinct.size} distinct bands — the score is not discriminating`);
  });

  test('a low-volatility bond fund is never read as coiled or breaking out', () => {
    const calm = rows.filter((o) => o.movement && !o.movement.unmeasured
      && Number.isFinite(o.risk?.volatility) && o.risk.volatility < 7);
    for (const o of calm) {
      assert.ok(!['breaking_out', 'breaking_down'].includes(o.movement.setup),
        `${o.name} at ${o.risk.volatility}% volatility is read as ${o.movement.setup}`);
    }
  });

  test('an expected-move band is ordered and plausible', () => {
    for (const o of rows) {
      const m = o.movement?.move;
      if (!m) continue;
      assert.ok(m.outer > m.typical, `${o.id} outer band is not wider than typical`);
      assert.ok(m.typical > 0 && m.typical < 200, `${o.id} implausible move ${m.typical}%`);
    }
  });
});

/* ------------------------------------------------------------- actionable */

describe('every row is actionable and honest', () => {
  test('everything says how to buy it and where it came from', () => {
    const missing = rows.filter((o) => !o.accessNotes || !o.url);
    assert.deepStrictEqual(missing.map((o) => `${o.source}:${o.id}`), []);
  });

  test('anything paying far above risk-free carries a warning', () => {
    const rf = result.meta.riskFree;
    const unflagged = rows.filter((o) => Number.isFinite(o.apy?.total)
      && o.apy.total > rf * 4
      && (o.trapFlags || []).length === 0
      && o.rating.grade === 'A+');
    assert.deepStrictEqual(unflagged.map((o) => `${o.name}=${o.apy.total}%`), [],
      'a top-grade row pays multiples of risk-free with no explanation');
  });

  test('a one-time bonus cannot masquerade as a recurring rate', () => {
    const bonuses = rows.filter((o) => o.source === 'bonuses');
    assert.ok(bonuses.length > 10, 'expected a bonus dataset');
    for (const o of bonuses) {
      assert.strictEqual(o.oneTime, true, `${o.name} is not marked as a one-off`);
      // Two shapes of offer, and only one needs a cap. A fixed-dollar payment
      // ($300 for opening an account) must be capped or it reads as a rate that
      // scales. A rate boost or transfer match applies to the whole balance, so
      // more money genuinely does earn more and a cap would be a lie.
      const scalesWithBalance = /match|boost|percent|rate/i.test(`${o.subType} ${o.name}`);
      if (!scalesWithBalance) {
        assert.ok(Number.isFinite(o.maxInvestment),
          `${o.name} pays a fixed amount but has no cap — more money must not earn more`);
      }
      assert.ok((o.trapFlags || []).length > 0 || /one-off|one-time|once/i.test(`${o.notes} ${(o.requirements || []).join(' ')}`),
        `${o.name} does not disclose that the return is not repeatable`);
      // The property that matters is that an eye-catching headline collapses to
      // something comparable once spread over the money you actually have. A
      // modest bonus can legitimately blend UPWARDS, because the uncapped
      // remainder earns the risk-free rate on top of it — so the test is about
      // the big numbers, which are the ones that distort a ranking.
      if (o.scores.headlineYield > 20) {
        assert.ok(o.scores.blendedYield < o.scores.headlineYield / 3,
          `${o.name} headlines ${o.scores.headlineYield}% and still ranks at ${o.scores.blendedYield}%`);
      }
      if (!o.scores.affordable) {
        assert.ok(o.scores.blendedYield <= 5,
          `${o.name} needs more than the budget but still ranks at ${o.scores.blendedYield}%`);
      }
    }
  });

  test('the default income ranking is not dominated by bonuses or traps', () => {
    const top = applyQuery(rows, { track: 'income', limit: 20 });
    assert.strictEqual(top.filter((o) => o.scores.traps.verdict === 'likely_trap').length, 0);
    assert.ok(top.filter((o) => o.source === 'bonuses').length <= 8,
      `one-time bonuses have taken over the default income view (${top.filter((o) => o.source === 'bonuses').length}/20)`);
  });
  test('every non-income row has a label a human would recognise', () => {
    // The renderer falls back to asset class outside income, where it is
    // useless — 193 unrelated deals all read "Savings / Cash" and 61 unrelated
    // companies all read "Dividend Stocks". So the sub-type label is the one
    // that shows, and a sub-type nobody has named leaks a raw key like
    // "liquid_staking" into the interface. This catches that at the source,
    // before anyone sees it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'render.js'), 'utf8');
    const start = src.indexOf('const SUBTYPE_LABELS');
    const end = src.indexOf('function kindLabel');
    assert.ok(start >= 0 && end > start, 'could not locate the sub-type label map');
    const labelled = new Set([...src.slice(start, end).matchAll(/([a-z_0-9]+):\s*'/g)].map((m) => m[1]));

    const unlabelled = new Map();
    for (const o of rows) {
      const section = o.section || (o.track === 'movement' ? 'movement' : 'income');
      if (section === 'income' || !o.subType) continue;
      if (!labelled.has(o.subType)) unlabelled.set(o.subType, o.name);
    }
    assert.deepStrictEqual([...unlabelled.keys()], [],
      `sub-types with no display label, e.g. ${[...unlabelled.values()][0]}`);
  });

  test('the deals section does not describe everything as cash', () => {
    // Asset class is genuinely 'cash' for all of these and genuinely unhelpful:
    // a 401(k) match, a referral chain and an intro-APR carry have nothing in
    // common beyond being denominated in dollars.
    const deals = rows.filter((o) => o.section === 'deals');
    assert.ok(deals.length > 100, 'expected a deals dataset');
    const withSubType = deals.filter((o) => o.subType);
    assert.strictEqual(withSubType.length, deals.length,
      `${deals.length - withSubType.length} deals rows have no sub-type and would fall back to "cash"`);
    assert.ok(new Set(deals.map((o) => o.subType)).size >= 10,
      'the deals section collapsed to a handful of sub-types');
  });
  test('no chart claims to be a recorded price history when it was drawn', () => {
    // The single most misleading thing a finance app can do is present a drawn
    // curve as a price history, because the two are pixel-identical. Every
    // bundled row charts a shape derived from its own statistics, so every
    // bundled row must say so.
    const charted = rows.filter((o) => Array.isArray(o.series) && o.series.length);
    assert.ok(charted.length > 50, 'expected charts in the bundled dataset');
    for (const o of charted) {
      assert.ok(o.seriesBasis === 'measured' || o.seriesBasis === 'illustrative',
        `${o.name} ships a chart with no stated basis`);
      if (o.seed || o.measured === false) {
        assert.strictEqual(o.seriesBasis, 'illustrative',
          `${o.name} is a bundled row but its chart claims to be recorded closes`);
      }
      assert.ok(o.series.every((n) => Number.isFinite(n) && n > 0),
        `${o.name} has a non-positive or non-finite point in its chart`);
    }
  });
  describe('a one-off never outranks a real investment on a rate it cannot repeat', () => {
    test('no default ranking is led by annualised one-off promotions', () => {
      // The bug this exists to stop: a $300 opening bonus on a $1,000 minimum
      // held 120 days annualises to 122%, and a $50 one to 500%. Ranked on that
      // number they sweep the top of every rate-sorted view and bury every real
      // investment in the app. This has to hold with no budget set, because
      // that is the state the app opens in.
      for (const sortBy of ['dogScore', 'apy', 'afterTax']) {
        const top = applyQuery(rows, { ...C.DEFAULT_QUERY, track: 'all', sortBy, limit: 10 });
        for (const o of top) {
          const shown = o.scores.blendedGross ?? o.apy?.total;
          assert.ok(!Number.isFinite(shown) || shown <= 150,
            `sorted by ${sortBy}, ${o.name} leads the app at ${shown}%`);
        }
      }
    });

    test('every rate on a blended row is blended, so no two columns disagree', () => {
      // The yield column reading 4.03% while the after-tax column beside it
      // read 380% was worse than either number alone.
      const blendedRows = rows.filter((o) => o.scores.blendApplied);
      assert.ok(blendedRows.length > 20, 'expected capped and one-off rows in the dataset');
      for (const o of blendedRows) {
        // A blend can legitimately sit ABOVE the row's own rate: a 3.7% account
        // capped at $2,000 leaves the other $8,000 earning the risk-free rate,
        // which is higher. What it can never do is exceed the better of the
        // two, because that money has to be somewhere.
        const ceiling = Math.max(o.tax?.grossApy ?? -Infinity, C.DEFAULT_SETTINGS?.riskFreeRate ?? 5) + 0.05;
        // `blendedYield` belongs in this list and was missing from it, which is
        // exactly why a defect in that field went unnoticed: it is the one the
        // ranking consumes (basisYield -> mu -> CE -> dogScore) and the one
        // incomeYear1 and income5yr are computed from. The three display
        // columns were checked; the number that decides the order was not.
        for (const k of ['blendedYield', 'blendedGross', 'blendedAfterTax', 'blendedAfterTaxReal']) {
          if (!Number.isFinite(o.scores[k])) continue;
          assert.ok(o.scores[k] <= ceiling,
            `${o.name}: ${k} of ${o.scores[k]}% beats both its own rate and cash`);
        }
        // Tax-equivalent is deliberately grossed UP to the ordinary-income
        // benchmark, so it exceeds the row's own rate whenever the row is
        // sheltered. What it must never do is fall below the after-tax figure
        // it is derived from.
        if (Number.isFinite(o.scores.blendedTaxEquivalent) && Number.isFinite(o.scores.blendedAfterTax)) {
          assert.ok(o.scores.blendedTaxEquivalent >= o.scores.blendedAfterTax - 0.01,
            `${o.name}: tax-equivalent ${o.scores.blendedTaxEquivalent}% is below its own after-tax ${o.scores.blendedAfterTax}%`);
        }
        // After tax can never beat gross on the same basis — including on a
        // losing row, where tax must not be allowed to refund the loss.
        if (Number.isFinite(o.scores.blendedGross) && Number.isFinite(o.scores.blendedAfterTax)) {
          assert.ok(o.scores.blendedAfterTax <= o.scores.blendedGross + 0.01,
            `${o.name} keeps more after tax (${o.scores.blendedAfterTax}%) than before it (${o.scores.blendedGross}%)`);
        }
      }
    });

    test('a top grade never claims insurance the row does not have', () => {
      // The grade band carried one blanket sentence, and A+ said "Backed by the
      // US government or federally insured. You get your money back short of a
      // systemic failure." True of a T-bill. Not true of a government money
      // market fund, which is SIPC-covered — that protects against the BROKER
      // failing, not the fund losing money — and which can break the buck, as
      // one did in 2008. 175 of the 355 A and A+ rows are exactly that, and
      // every one told the reader their money was insured.
      const guaranteed = ['us_gov', 'fdic', 'ncua'];
      for (const o of rows) {
        const detail = o.rating?.gradeDetail || '';
        if (!/federally insured|Backed by the US government/i.test(detail)) continue;
        assert.ok(guaranteed.includes(o.risk?.insurance),
          `${o.name} is graded ${o.rating.grade} with insurance "${o.risk?.insurance}" and told to expect `
          + 'a federal guarantee it does not have');
      }
      // And the uninsured top grades still say something, rather than nothing.
      const topUninsured = rows.filter((o) => ['A+', 'A'].includes(o.rating?.grade)
        && !guaranteed.includes(o.risk?.insurance));
      assert.ok(topUninsured.length > 50, 'expected uninsured rows at the top grades');
      for (const o of topUninsured) {
        assert.match(o.rating.gradeDetail, /uninsured/i,
          `${o.name} is uninsured at grade ${o.rating.grade} and does not say so`);
      }
    });

    test('the drawdown a row records is the drawdown it reports', () => {
      // schema.js stores it at `risk.maxDrawdown`. Three separate readers took
      // it from the top level, where it has never existed — so "Worst on
      // record" silently never rendered on any of the 353 rows that carry one,
      // every movement row fell back to a generic risk sentence, and the
      // squeeze detector reported distance-from-high as a missing input.
      const E = require('../src/core/expectations');
      const V = require('../src/core/verdict');
      const withDD = rows.filter((o) => Number.isFinite(o.risk?.maxDrawdown) && o.risk.maxDrawdown > 0);
      assert.ok(withDD.length > 100, `expected recorded drawdowns, got ${withDD.length}`);
      assert.strictEqual(rows.filter((o) => Number.isFinite(o.maxDrawdown)).length, 0,
        'a row is carrying a top-level maxDrawdown again — the schema puts it under risk');

      const movement = withDD.filter((o) => o.section === 'movement');
      assert.ok(movement.length > 50);
      for (const o of movement.slice(0, 40)) {
        const m = E.movementOutcomes(o, { horizonDays: 30 });
        assert.ok(Number.isFinite(m?.worstOnRecord),
          `${o.name} records a ${o.risk.maxDrawdown}% drawdown and reports no worst-on-record`);
        // Either it names the real drawdown, or a stronger branch fired first
        // (a row that can go to zero gets told so, which is more useful). What
        // it must never be is the contentless fallback that exists for rows
        // with no drawdown on record.
        assert.doesNotMatch(V.verdictFor(o).risk?.text || '', /the price can fall as easily as it rises/,
          `${o.name} gives the no-drawdown-on-record sentence despite recording a ${o.risk.maxDrawdown}% drawdown`);
      }
    });

    test('a term filter cannot return something locked indefinitely', () => {
      // "No stated term" splits two ways: a savings account has none and you
      // can have the money this afternoon; an employer match has none and is
      // locked until you retire. Both read as open-ended, so dragging the term
      // range to zero returned sixteen 401(k) matches under a heading meaning
      // the opposite.
      const { applyQuery } = require('../src/core/filters');
      const indefinite = (list) => list.filter((o) => o.liquidity === 'locked' && !Number.isFinite(o.term?.days));
      assert.ok(indefinite(rows).length > 0, 'expected indefinitely-locked rows in the dataset');

      for (const q of [{ termMinDays: 0, termMaxDays: 0 }, { termMinDays: 0, termMaxDays: 30 },
        { termMaxDays: 365 }, { termPreset: 'liquid' }]) {
        const out = applyQuery(rows, { ...q, hideTraps: false, includeSpeculative: true, limit: 1e5 });
        assert.strictEqual(indefinite(out).length, 0,
          `${JSON.stringify(q)} returned ${indefinite(out).length} indefinitely-locked rows`);
      }
      // And with no term filter at all they are still there.
      const all = applyQuery(rows, { hideTraps: false, includeSpeculative: true, limit: 1e5 });
      assert.ok(indefinite(all).length > 0, 'the guard is hiding rows when nothing was filtered');
    });

    test('doubting a number never makes a losing row look better', () => {
      // The trap and confidence haircuts multiply the expected return by a
      // fraction, which discounts a POSITIVE return for the chance it is not
      // real and shrinks a NEGATIVE one toward zero. So distrust became a
      // bonus: the same 2.00% account read mu -1.05 at full confidence and
      // -0.58 at a confidence of 0.1, and on the "after tax and inflation"
      // basis 293 of 854 rows had their real loss shrunk — by different amounts
      // each, so the ordering among them ran backwards on trust.
      const { scoreOne, BASIS } = require('../src/core/score');
      const base = {
        id: 'x', name: 'A losing account', assetClass: 'cash', yieldKind: 'administered',
        liquidity: 'instant', apy: { total: 2.0 }, taxTreatment: 'ordinary',
        risk: { insurance: 'fdic' }, term: { days: null },
      };
      const opts = {
        riskFree: 3.8, appetite: 45, amount: REFERENCE_AMOUNT,
        taxProfile: { federalOrdinary: 24, state: 'TX', inflation: 2.6 },
        basis: BASIS.AFTER_TAX_REAL,
      };
      const scores = [1.0, 0.5, 0.1].map((confidence) => scoreOne({ ...base, confidence }, opts));
      for (const s of scores) {
        assert.ok(s.basisYield < 0, 'this test needs a genuinely losing row');
        assert.ok(s.adjustedYield <= s.basisYield + 1e-9,
          `a haircut improved a loss: ${s.basisYield}% became ${s.adjustedYield}%`);
      }
      const dogScores = scores.map((s) => s.dogScore);
      assert.strictEqual(new Set(dogScores).size, 1,
        `trusting the same losing number less changed its score: ${dogScores.join(' vs ')}`);

      // And across the whole dataset on every basis.
      for (const basis of [BASIS.GROSS, BASIS.AFTER_TAX, BASIS.AFTER_TAX_REAL]) {
        let improved = 0;
        for (const o of rows) {
          const s = scoreOne(o, { ...opts, basis });
          if (Number.isFinite(s.basisYield) && s.basisYield < 0 && s.adjustedYield > s.basisYield + 1e-9) improved += 1;
        }
        assert.strictEqual(improved, 0, `${improved} losing rows were improved by their haircuts on ${basis}`);
      }
    });

    test('a one-off is worth its payment over five years, not one year of it', () => {
      // `blended` un-annualises with a term capped at one year, so income5yr on
      // a five-year one-off reported a fifth of itself — the same $59-for-$300
      // defect that was fixed for oneTimeDollars, still on screen underneath a
      // note saying $300, and in the CSV export.
      const long = rows.filter((o) => o.oneTime && o.term?.days > 400
        && Number.isFinite(o.scores?.oneTimeDollars) && Number.isFinite(o.scores?.income5yr));
      assert.ok(long.length >= 3, `expected multi-year one-offs, got ${long.length}`);
      for (const o of long) {
        assert.ok(o.scores.income5yr >= o.scores.oneTimeDollars - 1,
          `${o.name}: the note says ${o.scores.oneTimeDollars} once and "over 5 years" says ${o.scores.income5yr}`);
        assert.ok(o.scores.income5yr > o.scores.incomeYear1,
          `${o.name}: five years is not more than one`);
      }
    });

    test('return per unit of risk is computed on the blended figure', () => {
      // Every other rate this block reports goes through blend(). Sharpe did
      // not, so a $300 checking bonus entered at its 500% annualised rate over
      // a near-zero volatility and came out at 4962 — top of the "Return per
      // unit of risk" sort, which is exactly the ordering the blending exists
      // to prevent, and 100x what the same row's own panel leads with.
      const withSharpe = rows.filter((o) => Number.isFinite(o.scores?.sharpe));
      assert.ok(withSharpe.length > 50, 'expected Sharpe ratios in the dataset');
      for (const o of withSharpe) {
        const rate = o.scores.blendedGross;
        if (!Number.isFinite(rate)) continue;
        // Sharpe is (rate - riskFree) / sigma. Whatever sigma is, the numerator
        // must be the blended rate, so a row can never post a Sharpe that
        // implies a return it does not claim anywhere on its own panel.
        const implied = o.scores.sharpe * (o.risk?.volatility ?? 0) / 100;
        if (!Number.isFinite(implied)) continue;
        assert.ok(implied <= Math.abs(rate) + 5,
          `${o.name}: a Sharpe of ${o.scores.sharpe} implies a return of ${implied.toFixed(1)}% `
          + `from a row whose own blended rate is ${rate}%`);
      }
    });

    test('the ranked figure is the basis it says it is', () => {
      // The leftover a cap excludes is credited at cash, and which VERSION of
      // cash depends on the basis being ranked. That variant used to be picked
      // by comparing the chosen rate's VALUE against each basis — and
      // `grossApy === taxEquivalentYield` is an arithmetic identity for an
      // ordinary-treatment row in a taxable account, so the headline basis fell
      // through to the tax-equivalent arm and credited the remainder at a
      // grossed-up rate above every cash rate in the app. Invisible under the
      // default Texas profile, where no state tax collapses the two together.
      const { scoreOne } = require('../src/core/score');
      const profiles = [
        { federalOrdinary: 37, federalLtcg: 20, state: 'CA', stateRate: 9.3, inflation: 2.6 },
        { federalOrdinary: 24, federalLtcg: 15, state: 'TX', inflation: 2.6 },
        { federalOrdinary: 32, federalLtcg: 15, state: 'NY', stateRate: 6.85, inflation: 0 },
      ];
      const bases = { gross: 'blendedGross', afterTax: 'blendedAfterTax', afterTaxReal: 'blendedAfterTaxReal' };
      const treatments = ['ordinary', 'treasury', 'qualified_dividend', 'muni_federal_exempt',
        'muni_triple_exempt', 'return_of_capital', 'tax_deferred', 'capital_gain_long'];

      for (const taxProfile of profiles) {
        for (const [basis, column] of Object.entries(bases)) {
          for (const taxTreatment of treatments) {
            for (const rate of [6.17, 0, -1.5, 12]) {
              const s = scoreOne(
                { id: 'x', name: 'Capped account', apy: { total: rate }, taxTreatment,
                  maxInvestment: 1000, assetClass: 'cash', liquidity: 'instant', risk: { insurance: 'fdic' } },
                { riskFree: 3.8, amount: 10000, budget: 10000, basis, taxProfile },
              );
              if (!Number.isFinite(s.blendedYield) || !Number.isFinite(s[column])) continue;
              assert.ok(Math.abs(s.blendedYield - s[column]) < 0.001,
                `${taxTreatment} at ${rate}% on the ${basis} basis: the ranking uses ${s.blendedYield}% `
                + `while the ${column} column shows ${s[column]}% — the ranked figure is not the basis it claims`);
            }
          }
        }
      }
    });

    test('the money a cap excludes is taxed and deflated like the rest of it', () => {
      // `blend` mixes the row's rate with what the leftover earns in cash, and
      // the leftover was credited at the raw nominal rate on every basis. So
      // "after your tax" contained untaxed interest and "after tax and
      // inflation" contained interest that had been neither taxed nor deflated.
      // The cap term is usually the larger of the two, so the adjustments were
      // very nearly cancelled: a capped 6.17% account read 3.71% after
      // inflation where the honest figure is 0.37%.
      //
      // The check is a ratio rather than a level, because the failure was not
      // that the number was wrong by a little — it was that the adjustment had
      // essentially stopped happening.
      const capped = rows.filter((o) => o.scores?.blendApplied
        && !o.oneTime
        && o.scores.deployable < o.scores.basisAmount * 0.9
        && Number.isFinite(o.scores.blendedGross) && o.scores.blendedGross > 1
        && Number.isFinite(o.scores.blendedAfterTaxReal)
        && o.taxTreatment !== 'tax_deferred' && !o.tax?.sheltered);
      assert.ok(capped.length >= 5, `expected capped rows, got ${capped.length}`);

      const inflation = 2.6;   // the audit profile's assumption, below
      for (const o of capped) {
        const gross = o.scores.blendedGross;
        const real = o.scores.blendedAfterTaxReal;
        // Whatever tax rate applies, a positive nominal blend of X% cannot
        // survive inflation intact. Anything above (gross - inflation) means
        // some part of the blend escaped the deflator entirely.
        assert.ok(real <= gross - inflation + 0.35,
          `${o.name}: ${gross.toFixed(2)}% nominal becomes ${real.toFixed(2)}% after `
          + `${inflation}% inflation and tax — some of it was never adjusted`);
      }
    });

    test('a one-off pays what it says it pays, over however long it takes', () => {
      // The headline on a one-off is annualised — $300 on $10,000 held five
      // years is 0.59% a year — and turning it back into dollars needs the whole
      // term as the exponent. It was clamped to one year, so every offer running
      // longer than a year quoted a fraction of itself: Robinhood's $300 read
      // "$59" directly beneath its own notes saying $300.
      //
      // Checked against the row's own declared payout, pro-rated when the
      // reference amount does not cover the deposit the offer requires. That is
      // the only figure in the row that came from the provider rather than from
      // this app's arithmetic, so it is the only honest thing to check against.
      const declared = rows.filter((o) => o.oneTime
        && !o.dollarsUnknown
        && Number.isFinite(o.payout?.amount) && o.payout.amount > 0
        && Number.isFinite(o.minInvestment) && o.minInvestment > 0
        && Number.isFinite(o.scores?.oneTimeDollars));
      assert.ok(declared.length >= 5, `expected one-offs with a declared payout, got ${declared.length}`);

      for (const o of declared) {
        const deployable = Math.min(REFERENCE_AMOUNT, o.maxInvestment > 0 ? o.maxInvestment : REFERENCE_AMOUNT);
        const expected = o.payout.amount * (deployable / o.minInvestment);
        const tol = Math.max(1, expected * 0.05);
        assert.ok(Math.abs(o.scores.oneTimeDollars - expected) <= tol,
          `${o.name} promises ${o.payout.amount} on ${o.minInvestment} but the app computes `
          + `$${o.scores.oneTimeDollars} on $${deployable} (expected about $${Math.round(expected)})`);
      }
    });

    test('a long lock cannot rank as though it paid this year', () => {
      // The same variable that un-annualises the payment also decides how much
      // of the coming year the offer occupies, and those are different
      // questions. Money you cannot touch for five years must rank below the
      // same money paid inside one.
      // Rows the reader cannot afford are excluded: those are correctly
      // replaced by cash in the blend, and cash may well pay more than the
      // offer's own rate. That is the affordability rule doing its job, not a
      // long lock ranking above its headline.
      const long = rows.filter((o) => o.oneTime && o.term?.days > 400
        && o.scores?.affordable !== false
        && Number.isFinite(o.scores?.blendedYield) && Number.isFinite(o.apy?.total));
      assert.ok(long.length >= 3, `expected multi-year one-offs, got ${long.length}`);
      for (const o of long) {
        assert.ok(o.scores.blendedYield <= o.apy.total + 0.01,
          `${o.name} blends to ${o.scores.blendedYield}% from a ${o.apy.total}% headline it cannot pay in one year`);
        // And the headline itself must already be per-year, not the whole
        // multi-year benefit quoted as though it arrived annually.
        assert.ok(o.apy.total < 100,
          `${o.name} quotes ${o.apy.total}% a year for something that takes ${o.term.days} days to pay`);
      }
    });

    test('a row whose dollar size is unknowable prints no dollar figures', () => {
      // An employer match is capped at a share of a salary this app never asks
      // for. The rate is exact; every dollar figure derived from it would be
      // invented.
      const unknowable = rows.filter((o) => o.dollarsUnknown);
      assert.ok(unknowable.length >= 5, 'expected salary-dependent rows');
      for (const o of unknowable) {
        assert.strictEqual(o.scores.incomeYear1, null, `${o.name} quotes year-one dollars it cannot know`);
        assert.strictEqual(o.scores.income5yr, null, `${o.name} quotes five-year dollars it cannot know`);
        assert.strictEqual(o.scores.oneTimeDollars, null, `${o.name} quotes a payment it cannot know`);
        assert.ok(/pay|salary/i.test(o.notes || ''), `${o.name} does not explain why it shows no dollars`);
      }
    });

    test('dollar figures computed on the reference amount are marked as such', () => {
      // Every dollar figure in the app is computed on exactly one number: the
      // amount the reader set, or the stated reference when they set none. A
      // third, undeclared denominator creeping in is how a figure stops meaning
      // anything.
      const withDollars = rows.filter((o) => Number.isFinite(o.scores.incomeYear1));
      assert.ok(withDollars.length > 100, 'expected dollar figures in the dataset');
      for (const o of withDollars) {
        const expected = o.scores.hasBudget ? o.scores.basisAmount : REFERENCE_AMOUNT;
        assert.ok(Number.isFinite(expected) && expected > 0,
          `${o.name} reports dollars against no stated amount at all`);
        assert.strictEqual(o.scores.basisAmount, expected,
          `${o.name} reports dollars on an amount that is neither the budget nor the stated reference`);
        assert.ok(Math.abs(o.scores.incomeYear1 - expected * (o.scores.blendedYield / 100)) < 1,
          `${o.name}: year-one dollars do not follow from its own rate and basis`);
      }
    });
  });
});
