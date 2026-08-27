'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/sources/bonuses');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { detectTraps } = require('../src/core/traps');
const { scoreRisk } = require('../src/core/risk');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const USER_OFFERS = path.join(FIXTURES, 'bonuses-user-offers.json');

const ctx = { schema, C, seedDir: SEED_DIR, settings: {}, now: Date.parse('2026-08-27'), log() {} };
const byId = (rows, id) => rows.find((o) => o.id === `bonuses:${id}`);
const seedRows = () => adapter.loadSeed(ctx).opportunities;

// ---------------------------------------------------------------------------
// The maths, which is the whole reason this source needs to exist
// ---------------------------------------------------------------------------

test('effectiveApy compounds the period return instead of multiplying it', () => {
  // The canonical case: $300 on a $5,000 balance held 90 days is a 6% period
  // return. Multiplying gives 24%; compounding gives 26.66%, and the difference
  // is real money in a ranking that sits next to CDs.
  const apy = adapter.effectiveApy({ bonus: 300, requiredDeposit: 5000, holdDays: 90, ongoingApy: 0 });
  assert.ok(Math.abs(apy - 26.657) < 0.01, `expected ~26.66%, got ${apy}`);
  assert.ok(apy > 24, 'simple multiplication understates a sub-year offer');

  // Exactly one year: annualising must be a no-op, not a fifth of a percent out.
  assert.ok(Math.abs(adapter.effectiveApy({ bonus: 600, requiredDeposit: 10000, holdDays: 365 }) - 6) < 1e-9);

  // The shorter the window the bigger the gap, and the direction must not flip.
  const short = adapter.effectiveApy({ bonus: 300, requiredDeposit: 5000, holdDays: 30 });
  assert.ok(short > 100, `a 6% month annualises past 100%, got ${short}`);
  assert.ok(short > apy, 'the same dollars earned faster must annualise higher');
});

test('effectiveApy adds the account rate on top, because you earn both at once', () => {
  const bare = adapter.effectiveApy({ bonus: 300, requiredDeposit: 5000, holdDays: 90, ongoingApy: 0 });
  const withRate = adapter.effectiveApy({ bonus: 300, requiredDeposit: 5000, holdDays: 90, ongoingApy: 3.8 });
  assert.ok(Math.abs(withRate - (bare + 3.8)) < 1e-9);
  // Omitted is the same as zero — a missing rate must not become NaN.
  assert.equal(adapter.effectiveApy({ bonus: 300, requiredDeposit: 5000, holdDays: 90 }), bare);
});

test('effectiveApy refuses inputs that cannot describe a real offer', () => {
  const bad = [
    undefined,
    {},
    { bonus: 300, requiredDeposit: 0, holdDays: 90 },      // divide by zero
    { bonus: 300, requiredDeposit: -5000, holdDays: 90 },
    { bonus: 300, requiredDeposit: 5000, holdDays: 0 },
    { bonus: 300, requiredDeposit: 5000, holdDays: -90 },
    { bonus: -300, requiredDeposit: 5000, holdDays: 90 },
    { bonus: 'three hundred', requiredDeposit: 5000, holdDays: 90 },
    { bonus: 300, requiredDeposit: 5000, holdDays: 'ninety' },
    { bonus: Infinity, requiredDeposit: 5000, holdDays: 90 },
    { bonus: 300, requiredDeposit: 5000, holdDays: 90, ongoingApy: Infinity },
  ];
  for (const args of bad) assert.equal(adapter.effectiveApy(args), null, JSON.stringify(args));

  // A huge return over a tiny window overflows Math.pow. An Infinity APY is not
  // a small mistake in a yield table, so it must come back as "no answer".
  assert.equal(adapter.effectiveApy({ bonus: 1e6, requiredDeposit: 1, holdDays: 1 }), null);

  // Money written the way a human writes it still parses.
  assert.ok(Math.abs(adapter.effectiveApy({ bonus: '$300', requiredDeposit: '5,000', holdDays: 90 }) - 26.657) < 0.01);
});

test('firstYearReturn is the number people actually experience, and it is far smaller', () => {
  const args = { bonus: 300, requiredDeposit: 5000, holdDays: 90, ongoingApy: 0 };
  assert.equal(adapter.firstYearReturn(args), 6);
  assert.ok(adapter.firstYearReturn(args) < adapter.effectiveApy(args) / 4,
    'the annualised figure must dwarf the first-year one, which is the point of showing both');

  // The account's own rate runs for the whole year alongside the one-off bonus.
  assert.ok(Math.abs(adapter.firstYearReturn({ ...args, ongoingApy: 3.8 }) - 9.8) < 1e-9);

  // The holding period is irrelevant to what year one paid: a five-year clawback
  // is a lockup, and smuggling it into the return would double-count it.
  assert.equal(adapter.firstYearReturn({ bonus: 300, requiredDeposit: 10000, holdDays: 1826 }), 3);

  for (const bad of [undefined, {}, { bonus: 300, requiredDeposit: 0 }, { bonus: -1, requiredDeposit: 100 }, { bonus: 'x', requiredDeposit: 100 }]) {
    assert.equal(adapter.firstYearReturn(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Adapter contract and the bundled dataset
// ---------------------------------------------------------------------------

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'bonuses');
  assert.equal(adapter.label, 'Cash & Account Bonuses');
  assert.deepEqual(adapter.assetClasses, ['cash']);
  assert.equal(adapter.requiresKey, false);
  assert.equal(adapter.requiresNetwork, false, 'there is no API for promotional offers');
});

test('loadSeed returns the bundled snapshot, honestly labelled, and every row validates', () => {
  const rows = seedRows();
  const out = adapter.loadSeed(ctx);
  assert.equal(out.status, 'offline');
  assert.equal(rows.length, 44);
  for (const o of rows) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.source, 'bonuses');
    assert.equal(o.seed, true);
    assert.equal(o.live, false, 'a promotional offer is never a live quote here');
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.ok(o.url, `${o.id} must link the offer page`);
    assert.ok(o.accessNotes, `${o.id} must say how you actually get it`);
    assert.ok(o.provider, `${o.id} must name the institution`);
    assert.ok(o.confidence > 0 && o.confidence <= adapter.CURATED_CONFIDENCE,
      `${o.id} confidence ${o.confidence} must stay under the curated cap`);
  }
  assert.ok(out.warnings.some((w) => /verify|check|before you move any money/i.test(w)),
    'the source must warn that offers change constantly');
});

test('ids are unique, stable and namespaced so a refresh replaces rather than duplicates', () => {
  const ids = seedRows().map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id.startsWith('bonuses:'), id);
  assert.ok(byId(seedRows(), 'chase-total-checking-bonus'));
  assert.ok(byId(seedRows(), 'robinhood-gold-ira-match'));
});

test('covers the four promotion families the app claims to cover', () => {
  const rows = seedRows();
  const count = (sub) => rows.filter((o) => o.subType === sub).length;
  assert.ok(count('checking_bonus') >= 15, 'bank checking bonuses are the bulk of this market');
  assert.ok(count('savings_bonus') >= 5);
  assert.ok(count('credit_union_bonus') >= 5);
  assert.ok(count('brokerage_bonus') >= 5);
  assert.ok(count('ira_transfer_bonus') >= 2);
  assert.ok(count('cash_management_bonus') >= 1);
  // Real institutions, spread across the market rather than five brands.
  assert.ok(new Set(rows.map((o) => o.provider)).size >= 30);
});

test('every row is mapped as a contractual, capped, notice-period cash offer', () => {
  for (const o of seedRows()) {
    assert.equal(o.assetClass, C.ASSET_CLASS.CASH, o.id);
    assert.equal(o.track, 'income', `${o.id}: nothing here moves in price`);
    assert.equal(o.yieldKind, C.YIELD_KIND.CONTRACTUAL, `${o.id}: hit the terms and they owe you the money`);
    // You can withdraw whenever you like; you just forfeit the bonus. That is a
    // notice account, not a locked one.
    assert.equal(o.liquidity, C.LIQUIDITY.NOTICE, o.id);
    assert.equal(o.term.kind, 'lockup', o.id);
    assert.ok(Number.isFinite(o.term.days) && o.term.days > 0, `${o.id} has no holding period`);
    assert.ok(o.term.earlyExitPenalty && /forfeit|repay/i.test(o.term.earlyExitPenalty), o.id);
    assert.equal(o.payoutFrequency, 'one-time', o.id);
    assert.ok(Number.isFinite(o.apy.total) && o.apy.total > 0, o.id);
    // base is what survives the promotion, which is what matters if you stay.
    assert.ok(Number.isFinite(o.apy.base) && o.apy.base <= o.apy.total, o.id);
    // reward is deliberately never set: traps.js reads it as token emissions and
    // would print a sentence about DeFi farms onto a Chase checking account.
    assert.equal(o.apy.reward, null, `${o.id} must not claim an emissions component`);
  }
});

test('the cap is encoded structurally: more money does not earn more', () => {
  const rows = seedRows();
  const fixed = rows.filter((o) => o.subType !== 'ira_transfer_bonus' && o.subType !== 'cash_management_bonus');
  assert.ok(fixed.length >= 35);
  for (const o of fixed) {
    assert.equal(o.minInvestment, o.maxInvestment,
      `${o.id}: a fixed dollar bonus means the required deposit is also the ceiling`);
    assert.ok(o.minInvestment > 0, o.id);
  }
  assert.equal(byId(rows, 'chase-savings-bonus').minInvestment, 15000);
  assert.equal(byId(rows, 'chase-savings-bonus').maxInvestment, 15000);

  // A percentage match is proportional, not capped, and writing a ceiling onto
  // it would be a false statement about the product.
  for (const id of ['robinhood-gold-ira-match', 'webull-ira-transfer-match', 'wealthfront-cash-referral-boost']) {
    const o = byId(rows, id);
    assert.equal(o.maxInvestment, null, `${id} scales with the amount and must not claim a cap`);
    assert.match(o.notes, /proportional rather than capped/);
  }
});

test('every row says the three things that stop 26% reading as a savings account', () => {
  for (const o of seedRows()) {
    // 1. the actual dollar amount, once
    assert.match(o.notes, /^\$[\d,.]+ once, not a rate\./, o.id);
    // 2. the plain first-year percentage, named as such
    assert.match(o.notes, /in year one/, o.id);
    assert.match(o.notes, /is NOT what a year looks like/, o.id);
    // 3. that it does not repeat
    assert.match(o.notes, /Not repeatable and not compoundable/, o.id);
    assert.match(o.accessNotes, /One-time/, o.id);
    // and that the money is taxable, or explicitly is not because it is in an IRA
    assert.match(o.notes, /taxable|1099|tax-deferred|not taxable income this year/i, o.id);
  }
});

test('the notes quote the same first-year figure the maths produces', () => {
  const o = byId(seedRows(), 'chase-savings-bonus');           // $200 on $15,000 for 90 days
  const first = adapter.firstYearReturn({ bonus: 200, requiredDeposit: 15000, ongoingApy: 0.01 });
  assert.ok(Math.abs(first - 1.343) < 0.001, `first-year ${first}`);
  assert.match(o.notes, /1\.34% in year one/);
  assert.ok(Math.abs(o.apy.total - 5.53) < 0.05, `annualised ${o.apy.total}`);
  // The gap between the two numbers is the entire honesty problem this file solves.
  assert.ok(o.apy.total > first * 3);
});

test('a return too large to annualise meaningfully is capped and says so', () => {
  const o = byId(seedRows(), 'fidelity-new-account-bonus');    // $100 for a $50 deposit
  assert.equal(o.apy.total, adapter.MAX_EFFECTIVE_APY);
  assert.match(o.notes, /practically meaningless/);
  assert.match(o.notes, /shown capped at 500%/);
  assert.match(o.notes, /200% first-year/);
  // The uncapped truth is still stated, so the cap is disclosed rather than hidden.
  assert.match(o.notes, /the real figure is 8510%/);
  assert.ok(adapter.loadSeed(ctx).notes.some((n) => /capped at 500%/.test(n)));
});

// ---------------------------------------------------------------------------
// Insurance, risk and traps
// ---------------------------------------------------------------------------

test('insured deposits carry the limit; brokerage transfers are not allowed to imply one', () => {
  const rows = seedRows();
  const insured = rows.filter((o) => [C.INSURANCE.FDIC, C.INSURANCE.NCUA].includes(o.risk.insurance));
  assert.ok(insured.length >= 30);
  for (const o of insured) {
    assert.equal(o.risk.insuredLimit, 250000, o.id);
    assert.equal(o.risk.principalAtRisk, false, o.id);
    const r = scoreRisk(o);
    assert.ok(r.score <= 10, `${o.id} scored ${r.score}; insured principal must stay capped`);
  }
  assert.ok(rows.some((o) => o.risk.insurance === C.INSURANCE.NCUA), 'credit unions belong here too');

  const brokerage = rows.filter((o) => o.risk.insurance === C.INSURANCE.SIPC);
  assert.ok(brokerage.length >= 10);
  for (const o of brokerage) {
    assert.equal(o.risk.insuredLimit, null, `${o.id}: SIPC does not insure against loss, so no limit may be implied`);
    assert.equal(o.risk.principalAtRisk, true, o.id);
    assert.match(o.notes, /SIPC covers the broker failing/, o.id);
  }
});

test('an offer that needs more than the insured limit in one bank says so', () => {
  const o = byId(seedRows(), 'citi-checking-bonus-300k');
  assert.equal(o.minInvestment, 300000);
  assert.match(o.notes, /above the FDIC limit/);
  assert.match(o.notes, /uninsured for the entire holding period/);
});

test('every row trips the trap detector rather than sitting unflagged at the top', () => {
  const rows = seedRows();
  for (const o of rows) {
    const t = detectTraps(o);
    assert.ok(t.flags.includes(C.TRAP_FLAGS.TEASER_RATE),
      `${o.id} must be flagged as promotional — the whole headline reverts once the bonus is paid`);
    assert.ok(t.score > 0, o.id);
  }
  // The promotional sentence is written by the adapter, not trusted to the
  // dataset, so no row can quietly lose the flag by being edited.
  for (const o of rows) assert.ok(o.requirements.includes(adapter.PROMO_REQUIREMENT), o.id);
});

test('the balance cap flag fires from maxInvestment wherever it honestly applies', () => {
  const rows = seedRows();
  const capped = rows.filter((o) => detectTraps(o).flags.includes(C.TRAP_FLAGS.CAPPED_BALANCE));
  // Everything with a fixed dollar bonus at or under the detector's $25k
  // threshold; the large-deposit tiers sit above it and the scaling matches are
  // genuinely uncapped.
  const expected = rows.filter((o) => Number.isFinite(o.maxInvestment) && o.maxInvestment <= 25000);
  assert.deepEqual(capped.map((o) => o.id).sort(), expected.map((o) => o.id).sort());
  assert.ok(capped.length >= 25);
  assert.ok(!capped.some((o) => o.id.includes('robinhood')), 'a proportional match is not a capped balance');

  // The rows the flag cannot reach still state the cap in words, which is the
  // fallback the brief asks for when a flag does not cover the fact.
  for (const o of rows.filter((x) => !capped.includes(x))) {
    assert.match(o.notes, /Not repeatable and not compoundable/, o.id);
  }
});

test('nothing here is ranked as if the money were at risk', () => {
  for (const o of seedRows()) {
    const r = scoreRisk(o);
    assert.ok(r.score <= 42, `${o.id} scored ${r.score}: a cash bonus is not an aggressive holding`);
  }
});

// ---------------------------------------------------------------------------
// The user's own offers file
// ---------------------------------------------------------------------------

test('mergeUserBonuses replaces by id, appends new rows and keeps bundled order', () => {
  const seed = [
    { id: 'a', kind: 'bank_checking', name: 'A bank', bonus: 100 },
    { id: 'b', kind: 'bank_checking', name: 'B bank', bonus: 200 },
  ];
  const user = [
    { id: 'b', bonus: 350 },
    { id: 'c', kind: 'bank_savings', name: 'C bank', bonus: 400 },
  ];
  const merged = adapter.mergeUserBonuses(seed, user);
  assert.deepEqual(merged.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(merged.map((r) => r.origin), ['seed', 'user', 'user']);
  // Field-level: "Chase is $400 now" must not require restaging the whole row.
  assert.equal(merged[1].bonus, 350);
  assert.equal(merged[1].name, 'B bank');
  assert.equal(merged[1].kind, 'bank_checking');
});

test('mergeUserBonuses survives whatever is actually in the file', () => {
  assert.deepEqual(adapter.mergeUserBonuses(null, undefined), []);
  assert.deepEqual(adapter.mergeUserBonuses('nope', 7), []);
  assert.deepEqual(adapter.mergeUserBonuses([[1, 2]], [[3]]), [], 'an array is not an offer');
  const merged = adapter.mergeUserBonuses(
    [{ id: 'a', bonus: 1 }, null, 'junk', { bonus: 2 }],        // no id, no name -> dropped
    [{ id: 'A', bonus: 9 }, { name: 'Named only', bonus: 3 }],  // id match is case-insensitive
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].bonus, 9);
  assert.equal(schema.makeId('bonuses', merged[0].id), 'bonuses:a');
  assert.equal(merged[1].name, 'Named only');
});

test('readUserBonuses: silent when absent, loud when broken', () => {
  assert.deepEqual(adapter.readUserBonuses(null), { items: [], configured: false, warning: null });

  const missing = adapter.readUserBonuses('/nonexistent/dir/user-bonuses.json');
  assert.deepEqual(missing.items, []);
  assert.equal(missing.warning, null, 'no file yet is the normal case, not a problem');

  const real = adapter.readUserBonuses(USER_OFFERS);
  assert.equal(real.items.length, 11);
  assert.equal(real.warning, null);

  const bare = (text) => adapter.readUserBonuses('/whatever.json', () => text);
  assert.deepEqual(bare('[{"id":"x","bonus":1}]').items, [{ id: 'x', bonus: 1 }]);
  assert.match(bare('{ not json').warning, /not valid JSON/);
  assert.match(bare('{"rows":[]}').warning, /no "items" array/);
  const exploded = adapter.readUserBonuses('/whatever.json', () => { throw new Error('EACCES'); });
  assert.match(exploded.warning, /Could not read/);
});

test('the user offers file overrides the bundle end to end, and fetch stays partial', async () => {
  const out = await adapter.fetch({ ...ctx, settings: { userBonusesPath: USER_OFFERS } });

  // Never 'ok': the one check that would earn that — is this offer live today —
  // cannot be made without a human opening the page.
  assert.equal(out.status, 'partial');
  assert.ok(out.warnings.some((w) => /change weekly|verify|before you move any money/i.test(w)));

  // 44 bundled, three of them edited in place, one new credit union added, four
  // malformed rows rejected.
  assert.equal(out.opportunities.length, 45);

  const chase = byId(out.opportunities, 'chase-total-checking-bonus');
  assert.equal(chase.dataAsOf, '2026-08-26');
  assert.equal(chase.seed, false, 'a row the user maintains is not the bundled snapshot');
  assert.equal(chase.live, false, 'and it is still not a quote');
  assert.match(chase.name, /Chase Total Checking/, 'unspecified fields come from the bundled row');
  const expected = adapter.effectiveApy({ bonus: 400, requiredDeposit: 1500, holdDays: 180, ongoingApy: 0.01 });
  assert.equal(chase.apy.total, Math.round(expected * 1e4) / 1e4, 'the row carries the maths, rounded by the schema');
  assert.match(chase.notes, /^\$400 once/);
  // A freshly-dated row is trusted more than the month-old snapshot, up to the cap.
  assert.equal(chase.confidence, adapter.CURATED_CONFIDENCE);
  assert.ok(chase.confidence > byId(out.opportunities, 'bofa-advantage-banking-bonus').confidence);

  // "$200" and "$500" typed the way a human types money.
  const td = byId(out.opportunities, 'td-bank-checking-bonus');
  assert.equal(td.minInvestment, 500);
  assert.match(td.notes, /^\$200 once/);

  const added = byId(out.opportunities, 'first-tech-fcu-checking-bonus');
  assert.equal(added.risk.insurance, C.INSURANCE.NCUA);
  assert.equal(added.term.days, 120);
  assert.deepEqual(schema.validate(added), []);

  for (const junk of ['malformed-no-kind', 'malformed-absurd-ratio', 'malformed-no-link', 'malformed-zero-hold']) {
    assert.ok(!byId(out.opportunities, junk), `${junk} should not have survived`);
  }
  assert.ok(out.notes.some((n) => /4 row\(s\) skipped/.test(n)), out.notes.join(' | '));
  // Four rows carry a user edit (three replacements plus the new credit union),
  // and the count reports rows that survived rather than lines the user typed.
  assert.ok(out.notes.some((n) => /4 from your own offers file, 41 bundled/.test(n)), out.notes.join(' | '));
});

test('an out-of-range date degrades the row instead of throwing RangeError', () => {
  // new Date(1e20).toISOString() throws. A hand-edited file is exactly where a
  // number like that turns up, and it has taken adapters down before.
  const rows = adapter.loadSeed({ ...ctx, settings: { userBonusesPath: USER_OFFERS } }).opportunities;
  const ally = byId(rows, 'ally-savings-bonus');
  assert.ok(ally, 'the row must survive its own bad date');
  assert.equal(ally.dataAsOf, '2026-08-01', 'falls back to the snapshot date');

  assert.equal(adapter.isoDay(1e20, 'fallback'), 'fallback');
  assert.equal(adapter.isoDay('2026-13-45', 'fallback'), 'fallback');
  assert.equal(adapter.isoDay(NaN, 'fallback'), 'fallback');
  assert.equal(adapter.isoDay('', 'fallback'), 'fallback');
  assert.equal(adapter.isoDay(null, 'fallback'), 'fallback');
  assert.equal(adapter.isoDay({}, 'fallback'), 'fallback');
  assert.equal(adapter.isoDay('2026-08-26', 'fallback'), '2026-08-26');
});

// ---------------------------------------------------------------------------
// Defensive behaviour
// ---------------------------------------------------------------------------

test('buildRows rejects the unusable and never throws', () => {
  const ok = { id: 'ok', kind: 'bank_checking', name: 'Fine', bonus: 100, requiredDeposit: 1000, holdDays: 90, url: 'https://x.invalid/', accessNotes: 'open it' };
  const cases = [
    null,
    'a string',
    [1, 2, 3],
    { ...ok, kind: undefined },
    { ...ok, kind: 'sweepstakes' },
    { ...ok, bonus: undefined },
    { ...ok, bonus: 0 },
    { ...ok, bonus: -50 },
    { ...ok, requiredDeposit: 0 },
    { ...ok, holdDays: 0 },
    { ...ok, holdDays: adapter.MAX_HOLD_DAYS + 1 },       // a decade is not a promotion
    { ...ok, bonus: 100000 },                             // ratio far past MAX_BONUS_RATIO
    { ...ok, ongoingApy: 400 },                           // percent/basis point mixup
    { ...ok, ongoingApy: -1 },
    { ...ok, url: '' },                                   // unactionable
    { ...ok, accessNotes: '   ' },
    { id: '', name: '', kind: 'bank_checking', bonus: 1, requiredDeposit: 1, holdDays: 1, url: 'https://x.invalid/', accessNotes: 'a' },
  ];
  const out = adapter.buildRows(cases, ctx);
  assert.equal(out.opportunities.length, 0);
  assert.equal(out.skipped, cases.length);

  // A duplicate id is a skip, not a second row.
  const dupes = adapter.buildRows([ok, { ...ok }], ctx);
  assert.equal(dupes.opportunities.length, 1);
  assert.equal(dupes.skipped, 1);

  // A record that explodes when read takes itself out, not the source.
  const hostile = { get kind() { throw new Error('boom'); } };
  assert.doesNotThrow(() => adapter.buildRows([hostile, ok], ctx));
  assert.equal(adapter.buildRows([hostile, ok], ctx).opportunities.length, 1);
});

test('a stated confidence can lower the ceiling but never raise it', () => {
  const base = { id: 'c', kind: 'bank_checking', name: 'Conf', bonus: 100, requiredDeposit: 1000, holdDays: 90, url: 'https://x.invalid/', accessNotes: 'open it' };
  const high = adapter.buildRows([{ ...base, confidence: 0.99 }], ctx).opportunities[0];
  assert.ok(high.confidence <= adapter.CURATED_CONFIDENCE, `${high.confidence} broke the cap`);
  const low = adapter.buildRows([{ ...base, confidence: 0.2 }], ctx).opportunities[0];
  assert.ok(low.confidence <= 0.2);
  const negative = adapter.buildRows([{ ...base, confidence: -5 }], ctx).opportunities[0];
  assert.ok(negative.confidence >= 0 && negative.confidence <= adapter.CURATED_CONFIDENCE);
});

test('loadSeed never throws, whatever it is handed', () => {
  for (const bad of [undefined, {}, { seedDir: '/nonexistent' }, { seedDir: 12 }, { seedDir: SEED_DIR, settings: { userBonusesPath: 5 } }]) {
    let out;
    assert.doesNotThrow(() => { out = adapter.loadSeed(bad); }, JSON.stringify(bad));
    assert.ok(['offline', 'failed'].includes(out.status));
    assert.ok(Array.isArray(out.opportunities));
  }
  assert.equal(adapter.loadSeed({ seedDir: '/nonexistent', schema, C }).status, 'failed');
});

test('fetch degrades to a failed result instead of throwing', async () => {
  const out = await adapter.fetch({ seedDir: '/nonexistent', schema, C, settings: {}, log() {} });
  assert.equal(out.status, 'failed');
  assert.deepEqual(out.opportunities, []);
  assert.ok(out.warnings.length);
});
