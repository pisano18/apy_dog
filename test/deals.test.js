'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/sources/deals');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const K = require('../src/core/opportunity-kinds');
const { detectTraps } = require('../src/core/traps');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const USER_FILE = path.join(FIXTURES, 'deals-user-offers.json');

const ctx = { schema, C, seedDir: SEED_DIR, settings: {}, now: Date.parse('2026-08-27'), log() {} };
const withUserFile = { ...ctx, settings: { userDealsPath: USER_FILE } };

const seedRows = () => adapter.loadSeed(ctx).opportunities;
const byId = (rows, id) => rows.find((o) => o.id === `deals:${id}`);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// referralValue — the shape of the Acorns case, which is the reason this
// source exists at all
// ---------------------------------------------------------------------------

test('referralValue keeps the number of people, not just the headline dollars', () => {
  const rv = adapter.referralValue({ perReferral: 300, referralsNeeded: 5 });
  assert.equal(rv.gross, 1500);
  assert.equal(rv.total, 1500);
  // The whole point: $1,500 is five separate other people's decisions, and a
  // row that collapses that to one number has hidden the actual work.
  assert.equal(rv.referralsNeeded, 5);
  assert.equal(rv.perReferral, 300);
  assert.equal(rv.capped, false);
});

test('referralValue applies the annual cap and says that it bit', () => {
  const rv = adapter.referralValue({ perReferral: 300, referralsNeeded: 5, cap: 1000 });
  assert.equal(rv.gross, 1500);
  assert.equal(rv.total, 1000, 'the cap is a ceiling on what you can be paid');
  assert.equal(rv.capped, true);

  // A cap above the gross is not a cap that bites, and must not be reported as one.
  const loose = adapter.referralValue({ perReferral: 100, referralsNeeded: 2, cap: 5000 });
  assert.equal(loose.total, 200);
  assert.equal(loose.capped, false);
});

test('referralValue refuses inputs that cannot describe a real programme', () => {
  const bad = [
    undefined,
    {},
    { perReferral: -100 },
    { perReferral: 'twenty five dollars' },
    { perReferral: Infinity },
    { perReferral: 1e9 },                                  // above the sanity ceiling
    { perReferral: 10, referralsNeeded: 0 },
    { perReferral: 10, referralsNeeded: 200 },             // nobody has 200 friends
    { perReferral: 10, referralsNeeded: 'five' },
    { perReferral: 10, cap: 0 },
    { perReferral: 10, cap: -5 },
    { perReferral: 10, cap: 'none' },
  ];
  for (const args of bad) assert.equal(adapter.referralValue(args), null, JSON.stringify(args));

  // Money written the way a human writes it still parses.
  assert.equal(adapter.referralValue({ perReferral: '$1,500' }).total, 1500);
  // An absent count means one friend, not zero.
  assert.equal(adapter.referralValue({ perReferral: 50 }).referralsNeeded, 1);
});

// ---------------------------------------------------------------------------
// spendBonusReturn — the fee is what turns some of these negative
// ---------------------------------------------------------------------------

test('spendBonusReturn is a percentage of the spend, and it is not annualised', () => {
  const sr = adapter.spendBonusReturn({ bonus: 200, spendRequired: 500, windowDays: 90 });
  assert.equal(sr.returnOnSpendPct, 40);
  assert.equal(sr.netReturnOnSpendPct, 40);
  // Compounding a one-off 40% over a 90-day window gives 268%, which describes a
  // world where you collect this every quarter forever. You collect it once.
  assert.ok(sr.returnOnSpendPct < 50, 'a one-off must not be annualised into a rate');
  assert.ok(near(sr.monthlySpend, 500 / (90 / 30.44), 1e-9));
});

test('spendBonusReturn nets the annual fee, and the net is what the app must show', () => {
  const sr = adapter.spendBonusReturn({ bonus: 200, spendRequired: 500, windowDays: 90, annualFee: 95 });
  assert.equal(sr.bonus, 200);
  assert.equal(sr.netBonus, 105, 'a $95 fee against a $200 bonus is a $105 net');
  assert.equal(sr.netReturnOnSpendPct, 21);
  assert.equal(sr.feeEatsBonus, false);
});

test('spendBonusReturn reports a loss when the fee is larger than the bonus', () => {
  // The Amex Platinum shape: an $800 bonus behind an $895 fee is minus $95.
  const sr = adapter.spendBonusReturn({ bonus: 800, spendRequired: 8000, windowDays: 180, annualFee: 895 });
  assert.equal(sr.netBonus, -95);
  assert.equal(sr.feeEatsBonus, true);
  assert.ok(sr.netReturnOnSpendPct < 0, 'the net figure has to be allowed to go negative');
  assert.equal(sr.returnOnSpendPct, 10, 'the gross is still reported, so both numbers are visible');
});

test('spendBonusReturn refuses inputs that cannot describe a real offer', () => {
  const bad = [
    undefined,
    {},
    { bonus: 200, spendRequired: 0, windowDays: 90 },        // divide by zero
    { bonus: 200, spendRequired: -500, windowDays: 90 },
    { bonus: 200, spendRequired: 500, windowDays: 0 },
    { bonus: 200, spendRequired: 500, windowDays: -90 },
    { bonus: 200, spendRequired: 500, windowDays: 3650 },    // a decade is not a window
    { bonus: -200, spendRequired: 500, windowDays: 90 },
    { bonus: 5000, spendRequired: 100, windowDays: 90 },     // 5000% of spend is a typo
    { bonus: 'two hundred', spendRequired: 500, windowDays: 90 },
    { bonus: Infinity, spendRequired: 500, windowDays: 90 },
    { bonus: 200, spendRequired: 500, windowDays: 90, annualFee: 'ninety five' },
    { bonus: 200, spendRequired: 500, windowDays: 90, annualFee: -95 },
  ];
  for (const args of bad) assert.equal(adapter.spendBonusReturn(args), null, JSON.stringify(args));

  // An absent fee means no fee, which is different from an unreadable one.
  assert.equal(adapter.spendBonusReturn({ bonus: 200, spendRequired: 500, windowDays: 90 }).annualFee, 0);
});

// ---------------------------------------------------------------------------
// the rest of the maths
// ---------------------------------------------------------------------------

test('holdBonusApy compounds the period return instead of multiplying it', () => {
  assert.ok(near(adapter.holdBonusApy({ bonus: 500, capital: 50000, holdDays: 365 }), 1, 1e-9),
    'exactly one year must be a no-op');
  // 1% earned in 90 days is 4.12% annualised, not 4.00%.
  const short = adapter.holdBonusApy({ bonus: 250, capital: 25000, holdDays: 90 });
  assert.ok(near(short, 4.1179, 1e-3), `expected ~4.12%, got ${short}`);
  assert.ok(short > 4, 'simple multiplication understates a sub-year offer');

  for (const bad of [undefined, {}, { bonus: 500, capital: 0, holdDays: 365 },
    { bonus: 500, capital: 50000, holdDays: 0 }, { bonus: -1, capital: 100, holdDays: 30 },
    { bonus: 500, capital: 50000, holdDays: 40000 }, { bonus: 'x', capital: 100, holdDays: 30 }]) {
    assert.equal(adapter.holdBonusApy(bad), null, JSON.stringify(bad));
  }
  // A huge bonus on a tiny balance over one day overflows Math.pow to Infinity.
  assert.equal(adapter.holdBonusApy({ bonus: 20000, capital: 1, holdDays: 1 }), null);
});

test('rebateValue reports the increment over the card you would otherwise use', () => {
  const rb = adapter.rebateValue({ rate: 5, baselineRate: 1.5, spendCap: 1500, capPeriod: 'quarter' });
  assert.equal(rb.incrementalRate, 3.5, '5% against a 1.5% card is worth 3.5%, not 5%');
  assert.equal(rb.cappedAnnualSpend, 6000, 'the quarterly cap resets four times a year');
  assert.ok(near(rb.grossAnnual, 210, 1e-9));
  assert.ok(near(rb.netRatePct, 3.5, 1e-9));

  // Spending past the cap earns nothing extra, which is the point of the cap.
  const huge = adapter.rebateValue({ rate: 5, baselineRate: 1.5, spendCap: 1500, capPeriod: 'quarter', referenceSpend: 100000 });
  assert.equal(huge.spendCounted, 6000);
  assert.ok(near(huge.netAnnual, 210, 1e-9));
});

test('rebateValue subtracts a membership fee and reports where it breaks even', () => {
  // Costco Executive: 2% back for an extra $65 a year is a loss below $3,250 of spend.
  const rb = adapter.rebateValue({ rate: 2, spendCap: 62500, capPeriod: 'year', referenceSpend: 5000, membershipFee: 65 });
  assert.equal(rb.grossAnnual, 100);
  assert.equal(rb.netAnnual, 35);
  assert.equal(rb.breakevenSpend, 3250);

  const below = adapter.rebateValue({ rate: 2, referenceSpend: 1000, membershipFee: 65 });
  assert.ok(below.netAnnual < 0, 'below the breakeven the membership is a cost, not a rebate');
});

test('rebateValue refuses a rate with nothing to apply it to', () => {
  for (const bad of [undefined, {}, { rate: 4 }, { rate: 500, referenceSpend: 1000 },
    { rate: 4, referenceSpend: 0 }, { rate: 4, spendCap: 0 }, { rate: -4, referenceSpend: 1000 },
    { rate: 4, referenceSpend: 1000, capPeriod: 'fortnight' }, { rate: 'five', referenceSpend: 1000 },
    { rate: 4, referenceSpend: 1000, membershipFee: 'sixty five' }]) {
    assert.equal(adapter.rebateValue(bad), null, JSON.stringify(bad));
  }
});

test('introCarry annualises the transfer fee, which is the whole trade', () => {
  const ic = adapter.introCarry({ introDays: 540, feePct: 3, parkRate: 4, amount: 10000 });
  assert.ok(near(ic.annualisedFeeCost, 3 * (365 / 540), 1e-9));
  assert.ok(near(ic.netRatePct, 4 - 3 * (365 / 540), 1e-9));
  assert.equal(ic.profitable, true);
  assert.ok(near(ic.periodDollars, 10000 * (ic.netRatePct / 100) * (540 / 365), 1e-9));

  // The same 3% fee over six months costs 6% a year and the trade is underwater.
  const shortWindow = adapter.introCarry({ introDays: 180, feePct: 5, parkRate: 4, amount: 10000 });
  assert.equal(shortWindow.profitable, false);
  assert.ok(shortWindow.netRatePct < 0);

  for (const bad of [undefined, {}, { introDays: 0, feePct: 3, parkRate: 4 },
    { introDays: 5000, feePct: 3, parkRate: 4 }, { introDays: 540, feePct: 30, parkRate: 4 },
    { introDays: 540, feePct: 3, parkRate: 40 }, { introDays: 540, feePct: 3, parkRate: 4, amount: -1 },
    { introDays: 540, feePct: 'three', parkRate: 4 }]) {
    assert.equal(adapter.introCarry(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// dates: the field that decides whether "closing in 6 days" is true
// ---------------------------------------------------------------------------

test('isoDay never throws and never returns a date the app cannot format', () => {
  assert.equal(adapter.isoDay('2026-09-14'), '2026-09-14');
  assert.equal(adapter.isoDay('2026-09-14T12:00:00Z'), '2026-09-14');

  // Everything that is not a date falls back rather than exploding. new
  // Date(x).toISOString() throws RangeError outside +/-8.64e15ms and Date.parse
  // returns NaN on junk; both have taken adapters down here before.
  for (const junk of ['2026-13-45', 'not a date', '', '   ', null, undefined, {}, [], NaN,
    8.7e18, -8.7e18, Infinity, -Infinity]) {
    assert.equal(adapter.isoDay(junk, 'FALLBACK'), 'FALLBACK', JSON.stringify(junk));
  }
  assert.equal(adapter.isoDay(null), null, 'the fallback itself defaults to null');

  // Anything it DOES return must survive being parsed again downstream.
  for (const good of ['2026-09-14', '+275760-09-13T00:00:00.000Z', '1970-01-01']) {
    const out = adapter.isoDay(good, null);
    assert.doesNotThrow(() => String(out));
  }
});

// ---------------------------------------------------------------------------
// adapter contract and the bundled dataset
// ---------------------------------------------------------------------------

test('satisfies the adapter contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'deals');
  assert.equal(adapter.label, 'Referrals, Promos & Rewards');
  assert.deepEqual(adapter.assetClasses, ['cash']);
  assert.equal(adapter.requiresKey, false);
  assert.equal(adapter.requiresNetwork, false, 'no API publishes referral or promo terms');
});

test('loadSeed returns a large, honestly labelled snapshot and every row validates', () => {
  const out = adapter.loadSeed(ctx);
  const rows = out.opportunities;
  assert.equal(out.status, 'offline');
  assert.ok(rows.length >= 85, `expected a broad dataset, got ${rows.length}`);

  for (const o of rows) {
    assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);
    assert.equal(o.source, 'deals');
    assert.equal(o.seed, true);
    assert.equal(o.live, false, 'a promotional offer is never a live quote here');
    assert.equal(o.dataAsOf, '2026-08-01');
    assert.equal(o.section, K.SECTION.DEALS);
    assert.equal(o.track, 'income');
    assert.equal(o.assetClass, C.ASSET_CLASS.CASH);
    assert.equal(o.yieldKind, C.YIELD_KIND.CONTRACTUAL);
    assert.ok(o.url, `${o.id} must link the offer page`);
    assert.ok(o.accessNotes, `${o.id} must say how you actually get it`);
    assert.ok(o.provider, `${o.id} must name who pays`);
    assert.ok(o.confidence > 0 && o.confidence <= adapter.SEED_CONFIDENCE,
      `${o.id} claims ${o.confidence} confidence for a promotional snapshot`);
  }
});

test('every row carries a payout in dollars, and a headline the app can rank', () => {
  for (const o of seedRows()) {
    assert.ok(o.payout && Number.isFinite(o.payout.amount), `${o.id} has no payout amount`);
    assert.equal(o.payout.currency, 'USD');
    assert.ok(o.payout.basis && o.payout.basis.length > 10, `${o.id} does not say what the payout is for`);

    // schema.validate() requires one of these; the source must never rely on
    // the other one having been filled in by accident.
    const headline = o.apy?.total ?? o.expected?.annualReturn;
    assert.ok(Number.isFinite(headline), `${o.id} has no rankable headline`);
  }
});

test('a rate appears only where capital is genuinely committed', () => {
  for (const o of seedRows()) {
    const hasRate = Number.isFinite(o.apy?.total);
    if (hasRate) {
      // An annualised percentage is a claim about money at work. Either real
      // capital is required, or it is borrowed money in an intro-APR carry.
      const committed = Number.isFinite(o.minInvestment) && o.minInvestment > 0;
      const borrowed = o.subType === 'intro_apr_carry';
      assert.ok(committed || borrowed, `${o.id} shows ${o.apy.total}% with no capital behind it`);
      assert.equal(o.expected, null, `${o.id} carries both a rate and an expectation`);
    } else {
      assert.ok(o.expected, `${o.id} has neither a rate nor an expectation`);
      assert.ok(Array.isArray(o.expected.basis) && o.expected.basis.length,
        `${o.id} shows a percentage without saying what it is a percentage of`);
      assert.ok(o.expected.thesis, `${o.id} has no thesis`);
    }
  }
});

test('a percentage with no denominator reads zero rather than being invented', () => {
  const referrals = seedRows().filter((o) => o.subType === 'referral_bonus');
  assert.ok(referrals.length > 20, `expected a broad referral dataset, got ${referrals.length}`);
  for (const o of referrals) {
    assert.equal(o.apy.total, null, `${o.name} presents a referral as a yield`);
    assert.equal(o.expected.annualReturn, 0,
      `${o.name} invented a return on capital for something with no capital`);
    assert.ok(/no capital/i.test(o.expected.basis.join(' ')));
    // And the money is still visible, in the field that exists to hold it.
    assert.ok(o.payout.amount > 0, `${o.name} lost its dollars`);
  }
});

test('referrals are marked as needing other people, and say how many', () => {
  for (const o of seedRows().filter((x) => x.subType === 'referral_bonus')) {
    assert.equal(o.effort, 'social', `${o.name} hides that it depends on other people`);
    assert.equal(o.oneTime, true);
    assert.ok(o.dealMath.referralsNeeded >= 1);
    assert.ok(/other people|friends/i.test(o.requirements.join(' ')),
      `${o.name} does not state the other-people dependency in its requirements`);
    if (o.dealMath.referralsNeeded > 1) {
      assert.ok(new RegExp(`${o.dealMath.referralsNeeded} people`).test(o.notes),
        `${o.name} does not say how many people it takes`);
    }
  }
});

test('the Acorns case is encoded the way the user described it', () => {
  const o = byId(seedRows(), 'acorns-referral-five-friends');
  assert.ok(o, 'the headline Acorns tier must be in the dataset');
  assert.equal(o.payout.amount, 1500);
  assert.equal(o.dealMath.perReferral, 300);
  assert.equal(o.dealMath.referralsNeeded, 5);
  assert.equal(o.effort, 'social');
  assert.equal(o.minInvestment, 0, 'no capital is required to refer somebody');
  assert.equal(o.maxInvestment, 1500, 'the annual programme cap is machine-readable');
  assert.equal(o.dealMath.allOrNothing, true, 'the headline tier is a threshold, not a per-friend rate');
  assert.ok(/does not pay \$1,200/.test(o.notes),
    'the row must say what a partial result does NOT pay');
});

test('card bonuses net the annual fee and cap themselves at the required spend', () => {
  const cards = seedRows().filter((o) => o.subType === 'signup_bonus');
  assert.ok(cards.length > 15, `expected a broad card dataset, got ${cards.length}`);
  for (const o of cards) {
    assert.equal(o.effort, 'hoops');
    assert.equal(o.oneTime, true);
    assert.equal(o.apy.total, null, 'a spend bonus is not a yield');
    assert.equal(o.minInvestment, 0, 'a card bonus needs spend, not capital');
    assert.equal(o.maxInvestment, o.dealMath.spendRequired,
      `${o.name} does not cap itself at the spend that earns it`);
    assert.equal(o.payout.amount, o.dealMath.netBonus, `${o.name} reports the gross rather than the net`);
    assert.ok(near(o.expected.annualReturn, o.dealMath.netReturnOnSpendPct, 1e-3));
    assert.ok(/paid in full|25% APR/i.test(o.requirements.join(' ')),
      `${o.name} does not warn that carrying a balance destroys the bonus`);
  }

  // The fee case, stated in dollars on the row rather than left as a footnote.
  const withFee = cards.filter((o) => o.dealMath.annualFee > 0);
  assert.ok(withFee.length > 5, 'the dataset needs cards with real annual fees');
  for (const o of withFee) {
    assert.ok(o.notes.includes(`$${o.dealMath.annualFee.toLocaleString('en-US')}`),
      `${o.name} does not name its annual fee in the notes`);
  }

  // And at least one where the fee is bigger than the bonus, because that is the
  // case the advertisement never shows.
  const negative = cards.filter((o) => o.payout.amount < 0);
  assert.ok(negative.length >= 1, 'no row demonstrates a fee larger than the bonus');
  for (const o of negative) {
    assert.ok(o.expected.annualReturn < 0, `${o.name} shows a loss as a positive return`);
    assert.ok(/LARGER|loss/i.test(o.notes));
  }
});

test('deadlines and openings are real dates, and the countdown is derived from them', () => {
  const rows = seedRows();
  const dated = rows.filter((o) => o.expiresAt);
  assert.ok(dated.length >= 5, `expected dated offers, got ${dated.length}`);
  for (const o of dated) {
    assert.match(o.expiresAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(o.expiresAt)));
    assert.ok(Number.isFinite(o.daysLeft), `${o.name} has an expiry the app cannot count down`);
  }
  const upcoming = rows.filter((o) => o.startsAt);
  assert.ok(upcoming.length >= 2, 'the dataset must contain windows that have not opened yet');
  for (const o of upcoming) assert.match(o.startsAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('obscurity and effort are spread across the dataset rather than defaulted', () => {
  const rows = seedRows();
  const efforts = new Set(rows.map((o) => o.effort));
  const reaches = new Set(rows.map((o) => o.reach));
  assert.ok(efforts.has('social') && efforts.has('hoops') && efforts.has('ongoing') && efforts.has('light'),
    `effort is not being set deliberately: ${[...efforts]}`);
  assert.ok(reaches.has('obscure') && reaches.has('niche') && reaches.has('everyone'),
    `reach is not being set deliberately: ${[...reaches]}`);
  for (const o of rows) {
    assert.ok(K.EFFORT_INFO[o.effort], `${o.id} has effort "${o.effort}"`);
    assert.ok(K.REACH_INFO[o.reach], `${o.id} has reach "${o.reach}"`);
  }
});

test('every row trips the promotional trap flag, because every row is promotional', () => {
  for (const o of seedRows()) {
    const traps = detectTraps(o, {});
    assert.ok(traps.flags.includes(C.TRAP_FLAGS.TEASER_RATE),
      `${o.name} does not disclose that its terms are promotional and can be withdrawn`);
    // Anything showing a big number has to carry a warning with it — the same
    // invariant the cross-source audit enforces on the whole dataset.
    if (Number.isFinite(o.apy?.total) && o.apy.total > 40) {
      assert.ok(traps.flags.length > 0, `${o.name} pays ${o.apy.total}% with no flag`);
    }
  }
});

test('transfer promotions are the only rows that commit capital, and they say so', () => {
  for (const o of seedRows().filter((x) => x.subType === 'transfer_bonus')) {
    assert.ok(o.minInvestment > 0, `${o.name} is a transfer bonus with nothing to transfer`);
    assert.ok(Number.isFinite(o.apy.total) && o.apy.total > 0);
    assert.equal(o.liquidity, C.LIQUIDITY.NOTICE);
    assert.ok(Number.isFinite(o.term.days) && o.term.days > 0, `${o.name} has no holding period`);
    assert.ok(o.term.earlyExitPenalty, `${o.name} does not say what leaving early costs`);
    assert.ok(o.apy.total <= adapter.MAX_EFFECTIVE_APY);
  }
});

// ---------------------------------------------------------------------------
// hostile input: one bad row must never take the source down
// ---------------------------------------------------------------------------

test('buildRows survives anything and drops what it cannot understand', () => {
  const hostile = [
    null, undefined, 42, 'a string', [], [[]], { }, { kind: 'referral' },
    { id: 'x', kind: 'nope', name: 'Unknown kind', url: 'https://e.invalid', accessNotes: 'n/a' },
    { id: 'y', kind: 'referral', name: 'No link', perReferral: 10, accessNotes: 'n/a' },
    { id: 'z', kind: 'referral', name: 'No access notes', perReferral: 10, url: 'https://e.invalid' },
    { id: 'nan', kind: 'referral', name: 'NaN', perReferral: NaN, url: 'https://e.invalid', accessNotes: 'n/a' },
    { id: 'inf', kind: 'card_signup', name: 'Infinite bonus', bonusCash: Infinity, spendRequired: 500, windowDays: 90, url: 'https://e.invalid', accessNotes: 'n/a' },
    { id: 'deep', kind: 'card_signup', name: 'Nested nonsense', bonusCash: { a: { b: 1 } }, spendRequired: [500], windowDays: 90, url: 'https://e.invalid', accessNotes: 'n/a' },
    { id: 'ok', kind: 'referral', name: 'A good row', perReferral: 25, url: 'https://e.invalid/ok', accessNotes: 'Share the link.' },
  ];
  let built;
  assert.doesNotThrow(() => { built = adapter.buildRows(hostile, { schema, C, dataAsOf: '2026-08-01' }); });
  assert.equal(built.opportunities.length, 1, 'only the one good row may survive');
  assert.equal(built.opportunities[0].name, 'A good row');
  assert.ok(built.skipped >= 12);
  assert.deepEqual(schema.validate(built.opportunities[0]), []);

  // Non-arrays are a shape error, not a crash.
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(adapter.buildRows(junk, { schema, C }).opportunities, []);
  }
});

test('duplicate ids collapse rather than double-count', () => {
  const item = { id: 'dupe', kind: 'referral', name: 'Twice', perReferral: 10, url: 'https://e.invalid', accessNotes: 'n/a' };
  const built = adapter.buildRows([item, { ...item }], { schema, C });
  assert.equal(built.opportunities.length, 1);
  assert.equal(built.skipped, 1);
});

test('loadSeed never throws, even with no seed directory at all', () => {
  for (const badCtx of [undefined, {}, { seedDir: '/nonexistent/path/deals' }, { seedDir: 42 }]) {
    let out;
    assert.doesNotThrow(() => { out = adapter.loadSeed(badCtx); });
    assert.ok(out && Array.isArray(out.opportunities));
    if (!out.opportunities.length) assert.equal(out.status, 'failed');
  }
});

// ---------------------------------------------------------------------------
// the user's own offers
// ---------------------------------------------------------------------------

test('mergeUserDeals replaces field by field and appends new ids in order', () => {
  const seed = [
    { id: 'a', kind: 'referral', perReferral: 10, name: 'A' },
    { id: 'b', kind: 'referral', perReferral: 20, name: 'B' },
  ];
  const user = [
    { id: 'b', perReferral: 99 },
    { id: 'c', kind: 'referral', perReferral: 30, name: 'C' },
  ];
  const merged = adapter.mergeUserDeals(seed, user);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c'], 'bundled order is preserved');
  assert.equal(merged[1].perReferral, 99, 'a matching id replaces field by field');
  assert.equal(merged[1].name, 'B', 'fields the user did not touch survive');
  assert.equal(merged[1].origin, 'user');
  assert.equal(merged[0].origin, 'seed');

  // Junk in either list is ignored rather than merged.
  const dirty = adapter.mergeUserDeals([null, 'x', 42, ...seed], [[], {}, { id: '' }]);
  assert.deepEqual(dirty.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(adapter.mergeUserDeals(null, undefined), []);
});

test('readUserDeals is quiet when absent and loud when broken', () => {
  assert.deepEqual(adapter.readUserDeals(null), { items: [], configured: false, warning: null });

  // A number is a file DESCRIPTOR to fs.readFileSync, which on a pipe blocks the
  // whole app forever. Only a string may be treated as a path.
  const notAPath = adapter.readUserDeals(12);
  assert.equal(notAPath.items.length, 0);
  assert.ok(notAPath.warning.includes('not a path'));

  const missing = adapter.readUserDeals('/nonexistent/deals.json');
  assert.deepEqual(missing.items, []);
  assert.equal(missing.warning, null, 'not having a file is the normal case');

  const unreadable = adapter.readUserDeals('/some/file', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  assert.ok(unreadable.warning.includes('Could not read'));

  const notJson = adapter.readUserDeals('/some/file', () => '{ this is not json');
  assert.ok(notJson.warning.includes('not valid JSON'));

  const noItems = adapter.readUserDeals('/some/file', () => JSON.stringify({ meta: {} }));
  assert.ok(noItems.warning.includes('no usable'));

  const good = adapter.readUserDeals(USER_FILE);
  assert.ok(good.items.length > 5);
  assert.equal(good.warning, null);
});

test('a hand-edited user file overrides the bundle and its damage is contained', () => {
  const rows = adapter.loadSeed(withUserFile).opportunities;
  for (const o of rows) assert.deepEqual(schema.validate(o), [], `${o.id} failed validation`);

  // The override replaced two fields and kept the rest of the row.
  const acorns = byId(rows, 'acorns-referral-five-friends');
  assert.equal(acorns.dealMath.perReferral, 200);
  assert.equal(acorns.payout.amount, 1000, 'the user cap now bites');
  assert.equal(acorns.seed, false, 'a row the user maintains is not a bundled row');
  assert.equal(acorns.dataAsOf, '2026-08-20');
  assert.ok(acorns.confidence <= adapter.CURATED_CONFIDENCE);
  assert.ok(acorns.confidence > adapter.SEED_CONFIDENCE, 'a row the user refreshed is trusted more');

  // Their own row was added.
  assert.ok(byId(rows, 'my-credit-union-referral'), 'a new id must be appended');

  // None of the damage reached the table.
  for (const junk of ['no-kind-at-all', 'unknown-kind', 'no-url', 'no-access-notes',
    'negative-referral', 'absurd-referral', 'too-many-friends', 'words-where-numbers-go',
    'divide-by-zero-card', 'impossible-card-return', 'card-with-no-value', 'unreadable-fee',
    'decade-long-window', 'rebate-with-no-basis', 'rebate-rate-typo', 'transfer-with-no-assets',
    'transfer-forever', 'carry-that-loses-money', 'carry-with-absurd-park-rate']) {
    assert.equal(byId(rows, junk), undefined, `${junk} should have been dropped`);
  }

  // A row whose dates and enums are all broken still lands, with defaults.
  const hell = byId(rows, 'dates-from-hell');
  assert.ok(hell, 'a usable row must survive its own bad metadata');
  assert.equal(hell.expiresAt, null, 'an unparseable expiry is dropped, never guessed');
  assert.equal(hell.startsAt, null);
  assert.equal(hell.daysLeft, null);
  assert.equal(hell.reach, 'common', 'an invented reach falls back');
  assert.equal(hell.effort, 'light', 'an invented effort falls back to the kind default');
  assert.ok(Object.values(C.LIQUIDITY).includes(hell.liquidity));
  assert.deepEqual(hell.series, [1, 3], 'only finite numbers survive into a chart series');
  assert.equal(hell.dataAsOf, '2026-08-01', 'an unparseable dataAsOf falls back to the file date');
});

// ---------------------------------------------------------------------------
// the live path: a feed in this file's own documented shape
// ---------------------------------------------------------------------------

test('parseFeed accepts both documented shapes and refuses everything else', () => {
  const item = { id: 'a', kind: 'referral' };
  assert.deepEqual(adapter.parseFeed([item]).items, [item]);
  assert.deepEqual(adapter.parseFeed({ items: [item] }).items, [item]);
  assert.deepEqual(adapter.parseFeed({ items: [item], meta: { dataAsOf: '2026-08-20' } }).meta, { dataAsOf: '2026-08-20' });
  for (const junk of [null, undefined, 42, 'html', { items: 'nope' }, { items: {} }, {}]) {
    assert.deepEqual(adapter.parseFeed(junk).items, [], JSON.stringify(junk));
  }
  // Junk inside a good envelope is dropped, not passed on.
  assert.deepEqual(adapter.parseFeed({ items: [null, 1, 'x', [], item] }).items, [item]);
});

test('fetch merges a user feed, and a blocked feed degrades instead of failing', async () => {
  const feedItem = {
    id: 'feed-only-referral',
    kind: 'referral',
    name: 'An offer from my own feed',
    provider: 'Somebody',
    perReferral: 40,
    url: 'https://example.invalid/feed',
    accessNotes: 'Documented shape, served over HTTP.',
  };
  const okCtx = {
    ...ctx,
    settings: { dealsFeedUrl: 'https://example.invalid/deals.json' },
    http: { getJSON: async () => ({ items: [feedItem] }) },
  };
  const ok = await adapter.fetch(okCtx);
  assert.equal(ok.status, 'partial', 'an offer we have not opened today is a lead, not a quote');
  assert.ok(byId(ok.opportunities, 'feed-only-referral'), 'the feed row must reach the table');
  assert.ok(ok.warnings.some((w) => /verify|confirm/i.test(w)), 'the verify warning is mandatory');

  // The sandbox case: every external host 403s. The bundle still has to render.
  const blockedCtx = {
    ...ctx,
    settings: { dealsFeedUrl: 'https://example.invalid/deals.json' },
    http: { getJSON: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } },
  };
  const blocked = await adapter.fetch(blockedCtx);
  assert.equal(blocked.status, 'partial');
  assert.ok(blocked.opportunities.length > 50, 'the bundled snapshot must still be there');
  assert.ok(blocked.warnings.some((w) => w.includes('403')), 'the block has to be reported');

  // No feed configured is the normal case and says nothing about a feed.
  const plain = await adapter.fetch(ctx);
  assert.equal(plain.status, 'partial');
  assert.ok(plain.opportunities.length > 50);
  assert.ok(!plain.warnings.some((w) => w.includes('feed')));

  // And an adapter must never throw out of fetch, whatever it is handed.
  for (const badCtx of [undefined, {}, { settings: { dealsFeedUrl: 'x' } }]) {
    const res = await adapter.fetch(badCtx);
    assert.ok(res && Array.isArray(res.opportunities));
  }
});

test('the source states plainly what it is and what it is not', () => {
  const out = adapter.loadSeed(ctx);
  const text = [...out.notes, ...out.warnings].join(' ');
  assert.ok(/verify|confirm/i.test(text), 'the user must be told to check before acting');
  assert.ok(/25% APR|paid in full/i.test(text), 'the credit card warning is not optional');
  assert.ok(/other people/i.test(text), 'the referral dependency must be stated at source level');
  assert.ok(/cents-per-point|cents per point/i.test(text), 'the points valuation is an assumption and must be labelled');
  assert.ok(/no denominator|no rate/i.test(text), 'the missing-rate design has to be explained');
});
