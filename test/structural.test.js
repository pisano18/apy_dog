'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/sources/structural');
const contract = require('../src/sources/_contract');
const schema = require('../src/core/schema');
const C = require('../src/core/constants');
const { detectTraps } = require('../src/core/traps');
const { scoreRisk } = require('../src/core/risk');
const { principalAxis } = require('../src/core/rating');
const { STATE_TOP_RATES } = require('../src/core/tax');

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const CORRUPT = path.join(FIXTURES, 'structural-corrupt.json');

const ctxFor = (tax = { federalOrdinary: 24, state: 'TX' }, now = Date.now()) => ({
  schema, C, seedDir: SEED_DIR, settings: { tax }, now, log() {},
});
const seedRows = (tax, now) => adapter.loadSeed(ctxFor(tax, now)).opportunities;
const byId = (rows, id) => rows.find((o) => o.id === `structural:${id}`);
const DAY = 86400000;

// ---------------------------------------------------------------------------
// matchValue — the single most valuable number in the app, and the one people
// compute against the wrong denominator
// ---------------------------------------------------------------------------

test('matchValue keeps the two percentages apart', () => {
  // "50% of the first 6%" on $80,000: you defer $4,800, they add $2,400.
  const v = adapter.matchValue({ salary: 80000, matchPercent: 50, matchLimitPercent: 6 });
  assert.equal(v.employeeContribution, 4800);
  assert.equal(v.employerMatch, 2400);
  // The return is on the money YOU defer. 50%, not 3% (the share of salary) and
  // not 30% (dividing by something else entirely).
  assert.equal(v.returnPct, 50);
  assert.equal(v.cappedByLimit, false);

  const dollarForDollar = adapter.matchValue({ salary: 80000, matchPercent: 100, matchLimitPercent: 3 });
  assert.equal(dollarForDollar.employeeContribution, 2400);
  assert.equal(dollarForDollar.employerMatch, 2400);
  assert.equal(dollarForDollar.returnPct, 100);
});

test('matchValue clamps at the statutory deferral limit and says so', () => {
  // A $600,000 salary with a 6% match limit wants $36,000 deferred, which the
  // annual limit does not allow. Part of the match is simply unreachable.
  const v = adapter.matchValue({ salary: 600000, matchPercent: 50, matchLimitPercent: 6, deferralLimit: 24500 });
  assert.equal(v.employeeContribution, 24500);
  assert.equal(v.employerMatch, 12250);
  assert.equal(v.cappedByLimit, true);

  // Under the limit the clamp must not fire.
  const under = adapter.matchValue({ salary: 100000, matchPercent: 50, matchLimitPercent: 6, deferralLimit: 24500 });
  assert.equal(under.cappedByLimit, false);
  assert.equal(under.employeeContribution, 6000);
});

test('matchValue refuses inputs that cannot describe a real match', () => {
  const bad = [
    undefined, {}, null,
    { salary: 0, matchPercent: 50, matchLimitPercent: 6 },
    { salary: -80000, matchPercent: 50, matchLimitPercent: 6 },
    { salary: 80000, matchPercent: 50, matchLimitPercent: 0 },
    { salary: 80000, matchPercent: -50, matchLimitPercent: 6 },
    { salary: 80000, matchPercent: 50, matchLimitPercent: 600 },   // >100% of pay
    { salary: 80000, matchPercent: 5000, matchLimitPercent: 6 },   // not a match
    { salary: 'eighty thousand', matchPercent: 50, matchLimitPercent: 6 },
    { salary: Infinity, matchPercent: 50, matchLimitPercent: 6 },
    { salary: NaN, matchPercent: 50, matchLimitPercent: 6 },
  ];
  for (const args of bad) assert.equal(adapter.matchValue(args), null, JSON.stringify(args));

  // Money written the way a human writes it still parses.
  const human = adapter.matchValue({ salary: '$80,000', matchPercent: '50%', matchLimitPercent: '6' });
  assert.equal(human.employerMatch, 2400);
});

// ---------------------------------------------------------------------------
// harvestValue — the ordering is statutory and the $3,000 cap is the whole story
// ---------------------------------------------------------------------------

test('harvestValue caps the ordinary-income slice at $3,000 and carries the rest forward', () => {
  const v = adapter.harvestValue({ lossRealised: 10000, federalRate: 24, stateRate: 0 });
  assert.equal(v.againstGains, 0);
  assert.equal(v.againstOrdinary, 3000);
  assert.equal(v.carryforward, 7000);
  assert.equal(v.taxSaved, 720);                 // 3,000 at 24%
  // The honest return on the loss you actually realised is far below the bracket,
  // because most of the loss is stuck in the carryforward.
  assert.equal(v.effectiveRatePct, 7.2);

  // State tax stacks on the ordinary slice.
  const ca = adapter.harvestValue({ lossRealised: 3000, federalRate: 37, stateRate: 13.3 });
  assert.equal(ca.taxSaved, Math.round(3000 * 0.503 * 100) / 100);
  assert.equal(ca.effectiveRatePct, 50.3);
});

test('harvestValue nets against gains first, which is where the uncapped value is', () => {
  const v = adapter.harvestValue({
    lossRealised: 50000, federalRate: 24, stateRate: 5, gainsOffset: 40000, gainsRate: 15,
  });
  assert.equal(v.againstGains, 40000);           // uncapped
  assert.equal(v.againstOrdinary, 3000);         // capped
  assert.equal(v.carryforward, 7000);
  assert.equal(v.taxSaved, 40000 * 0.15 + 3000 * 0.29);

  // With no stated gains rate the offset is valued at the ordinary rate, which is
  // the conservative reading for a short-term position.
  const shortTerm = adapter.harvestValue({ lossRealised: 1000, federalRate: 24, stateRate: 0, gainsOffset: 1000 });
  assert.equal(shortTerm.againstGains, 1000);
  assert.equal(shortTerm.againstOrdinary, 0);
  assert.equal(shortTerm.taxSaved, 240);
});

test('harvestValue refuses junk instead of inventing a refund', () => {
  const bad = [
    undefined, {}, null,
    { lossRealised: -1000, federalRate: 24, stateRate: 0 },
    { lossRealised: 1000, federalRate: -24, stateRate: 0 },
    { lossRealised: 1000, federalRate: 240, stateRate: 0 },
    { lossRealised: 1000, federalRate: 24, stateRate: 900 },
    { lossRealised: 'a lot', federalRate: 24, stateRate: 0 },
    { lossRealised: Infinity, federalRate: 24, stateRate: 0 },
    { lossRealised: 1000, federalRate: 24, stateRate: 0, ordinaryCap: -1 },
    { lossRealised: 1000, federalRate: 24, stateRate: 0, gainsOffset: -5 },
    { lossRealised: 1000, federalRate: 24, stateRate: 0, gainsRate: 500 },
  ];
  for (const args of bad) assert.equal(adapter.harvestValue(args), null, JSON.stringify(args));
  assert.equal(adapter.harvestValue({ lossRealised: 0, federalRate: 24, stateRate: 0 }).effectiveRatePct, 0);
});

// ---------------------------------------------------------------------------
// stateDeductionValue — the cap is why the honest return falls as you contribute
// ---------------------------------------------------------------------------

test('stateDeductionValue returns the state rate up to the cap and nothing above it', () => {
  // Illinois: $10,000 cap, 4.95% flat.
  const atCap = adapter.stateDeductionValue({ contribution: 10000, stateRate: 4.95, cap: 10000 });
  assert.equal(atCap.deducted, 10000);
  assert.equal(atCap.taxSaved, 495);
  assert.equal(atCap.effectiveRatePct, 4.95);
  assert.equal(atCap.cappedOut, false);

  // Twice the cap is half the return, which is the point of computing it.
  const over = adapter.stateDeductionValue({ contribution: 20000, stateRate: 4.95, cap: 10000 });
  assert.equal(over.deducted, 10000);
  assert.equal(over.taxSaved, 495);
  assert.equal(over.effectiveRatePct, 2.475);
  assert.equal(over.cappedOut, true);

  // An uncapped state deducts the lot.
  const uncapped = adapter.stateDeductionValue({ contribution: 20000, stateRate: 4.4, cap: null });
  assert.equal(uncapped.deducted, 20000);
  assert.equal(uncapped.effectiveRatePct, 4.4);

  // A state with no income tax is worth exactly nothing, and must say zero
  // rather than quietly falling back to a federal figure.
  assert.equal(adapter.stateDeductionValue({ contribution: 10000, stateRate: 0, cap: null }).taxSaved, 0);
});

test('stateDeductionValue refuses junk', () => {
  const bad = [
    undefined, {}, null,
    { contribution: -1, stateRate: 5 },
    { contribution: 1000, stateRate: -5 },
    { contribution: 1000, stateRate: 150 },
    { contribution: 1000, stateRate: 5, cap: -1 },
    { contribution: Infinity, stateRate: 5 },
    { contribution: 'ten thousand', stateRate: 5 },
  ];
  for (const args of bad) assert.equal(adapter.stateDeductionValue(args), null, JSON.stringify(args));
});

// ---------------------------------------------------------------------------
// benefitRate — where the user's own settings enter the arithmetic
// ---------------------------------------------------------------------------

test('benefitRate computes from the profile and explains which parts it used', () => {
  const tx = { federalOrdinary: 24, federalLtcg: 15, state: 'TX', stateRate: 0, niitApplies: false };
  const ca = { federalOrdinary: 37, federalLtcg: 20, state: 'CA', stateRate: 13.3, niitApplies: true };

  assert.equal(adapter.benefitRate({ type: 'ordinary' }, tx).rate, 24);
  assert.equal(adapter.benefitRate({ type: 'ordinary' }, ca).rate, 50.3);
  // A payroll election also escapes FICA, which a deduction claimed on a return
  // never recovers.
  assert.equal(adapter.benefitRate({ type: 'ordinary', fica: true }, tx).rate, 31.65);
  assert.equal(adapter.benefitRate({ type: 'ltcg' }, ca).rate, 37.1);   // 20 + 13.3 + 3.8
  assert.equal(adapter.benefitRate({ type: 'bracket_delta', lowerRate: 12 }, tx).rate, 12);
  // A conversion in a year when you are already below the assumed rate is worth
  // nothing, not a negative.
  assert.equal(adapter.benefitRate({ type: 'bracket_delta', lowerRate: 40 }, tx).rate, 0);

  const basis = adapter.benefitRate({ type: 'ordinary' }, ca).basis.join(' ');
  assert.match(basis, /federal/i);
  assert.match(basis, /CA/);
});

test('benefitRate reads the 529 table for the state, including the states that give nothing', () => {
  const at = (state) => adapter.benefitRate({ type: 'state_529' }, {
    federalOrdinary: 24, federalLtcg: 15, state, stateRate: STATE_TOP_RATES[state] ?? 0,
  });

  const il = at('IL');
  assert.equal(il.rate, STATE_TOP_RATES.IL);
  assert.equal(il.maxInvestment, 10000);

  // Indiana gives a credit, which is worth its stated percentage whatever your
  // bracket — quite different from a deduction.
  const ind = at('IN');
  assert.equal(ind.rate, 20);
  assert.equal(ind.maxInvestment, 7500);

  // No income tax means no deduction to have.
  assert.equal(at('TX').rate, 0);
  assert.match(at('TX').basis.join(' '), /no state income tax/i);
  // A state that taxes income and still gives nothing is a different fact, and
  // is stated as such rather than being conflated with the above.
  assert.equal(at('CA').rate, 0);
  assert.match(at('CA').basis.join(' '), /no 529 deduction or credit/i);
  // Unknown state code must not throw or silently inherit another state's rules.
  assert.equal(at('ZZ').rate, 0);

  // Parity states say so, because it decides whether you may hold a better plan.
  assert.match(at('PA').extra, /parity/i);
  assert.match(at('NY').extra, /weighed against/i);
});

test('benefitRate rejects anything it cannot compute', () => {
  const p = { federalOrdinary: 24, federalLtcg: 15, state: 'TX', stateRate: 0 };
  assert.equal(adapter.benefitRate(null, p), null);
  assert.equal(adapter.benefitRate('50%', p), null);
  assert.equal(adapter.benefitRate({ type: 'nonsense' }, p), null);
  assert.equal(adapter.benefitRate({ type: 'fixed', rate: 'lots' }, p), null);
  assert.equal(adapter.benefitRate({ type: 'fixed', rate: -5 }, p), null);
  assert.equal(adapter.benefitRate({ type: 'fixed', rate: 1e6 }, p), null);
  assert.equal(adapter.benefitRate({ type: 'spend_bonus', bonusValue: 500, requiredSpend: 0 }, p), null);
  assert.equal(adapter.benefitRate({ type: 'spend_bonus', bonusValue: 500 }, p), null);
  // A bonus against spending is a rate on the spending, and carries its own cap.
  const sb = adapter.benefitRate({ type: 'spend_bonus', bonusValue: 750, requiredSpend: 5000 }, p);
  assert.equal(sb.rate, 15);
  assert.equal(sb.maxInvestment, 5000);
});

// ---------------------------------------------------------------------------
// Dates. Every deadline here recurs annually, and the RangeError guard is not
// optional — new Date(x).toISOString() has taken adapters down in this codebase.
// ---------------------------------------------------------------------------

test('annual deadlines always resolve into the future, from any point in the year', () => {
  const probes = [
    Date.parse('2026-01-01T00:00:00Z'),
    Date.parse('2026-04-14T23:00:00Z'),
    Date.parse('2026-04-16T00:00:00Z'),
    Date.parse('2026-08-27T12:00:00Z'),
    Date.parse('2026-12-31T22:00:00Z'),
    Date.parse('2026-12-31T23:59:58Z'),
    Date.parse('2027-03-01T00:00:00Z'),
  ];
  for (const now of probes) {
    for (const [m, d] of [[12, 31], [4, 15], [11, 1]]) {
      const iso = adapter.nextAnnual(now, m, d);
      const t = Date.parse(iso);
      assert.ok(Number.isFinite(t), `${m}/${d} from ${new Date(now).toISOString()} gave ${iso}`);
      assert.ok(t > now, `${iso} is not after ${new Date(now).toISOString()}`);
      // ...and it is the NEXT one, not one years away.
      assert.ok(t - now <= 366 * DAY, `${iso} is more than a year after ${new Date(now).toISOString()}`);
    }
  }
});

test('the date helpers refuse to hand out a value that would throw on format', () => {
  // A clock outside representable time, a NaN clock, a string clock: all of these
  // reach an adapter eventually, and none may produce a RangeError.
  for (const now of [NaN, Infinity, -Infinity, 9e15, -9e15, undefined, null]) {
    assert.doesNotThrow(() => {
      const iso = adapter.nextAnnual(now, 12, 31);
      if (iso) new Date(Date.parse(iso)).toISOString();
    }, `nextAnnual blew up on ${String(now)}`);
    assert.doesNotThrow(() => adapter.nextMonthEnd(now));
    assert.doesNotThrow(() => adapter.annualWindow(now, 10, 15, 11, 30));
    assert.doesNotThrow(() => adapter.nextIBondReset(now));
  }
  // Directly: a year past the end of representable time returns null, not a throw.
  assert.equal(adapter.isoAt(400000, 1, 1), null);
  assert.equal(adapter.isoAt(NaN, 1, 1), null);
  assert.ok(Math.abs(Date.parse(adapter.isoAt(2026, 12, 31))) <= 8.64e15);
});

test('a window that is currently open reports a past start and a future end', () => {
  // Early November: open enrollment is open. Taking "the next 15 October" and
  // "the next 30 November" independently would claim it opens next year and
  // closes this month.
  const inside = Date.parse('2026-11-05T00:00:00Z');
  const w = adapter.annualWindow(inside, 10, 15, 11, 30);
  assert.ok(Date.parse(w.startsAt) < inside, 'start should already have passed');
  assert.ok(Date.parse(w.expiresAt) > inside, 'end should still be ahead');

  // Before it opens, both are ahead and in the right order.
  const before = Date.parse('2026-08-27T00:00:00Z');
  const w2 = adapter.annualWindow(before, 10, 15, 11, 30);
  assert.ok(Date.parse(w2.startsAt) > before);
  assert.ok(Date.parse(w2.expiresAt) > Date.parse(w2.startsAt));

  // After it closes, the whole window rolls to next year rather than expiring.
  const after = Date.parse('2026-12-05T00:00:00Z');
  const w3 = adapter.annualWindow(after, 10, 15, 11, 30);
  assert.ok(Date.parse(w3.startsAt) > after);
});

test('the I-bond window closes on the day before a reset, alternating May and November', () => {
  const spring = adapter.nextIBondReset(Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(spring.expiresAt.slice(0, 10), '2026-04-30');
  assert.equal(spring.resetLabel, '1 May');

  const autumn = adapter.nextIBondReset(Date.parse('2026-06-01T00:00:00Z'));
  assert.equal(autumn.expiresAt.slice(0, 10), '2026-10-31');
  assert.equal(autumn.resetLabel, '1 November');

  const rollover = adapter.nextIBondReset(Date.parse('2026-11-15T00:00:00Z'));
  assert.equal(rollover.expiresAt.slice(0, 10), '2027-04-30');
});

test('month end handles 28, 30 and 31 day months without a leap-year table', () => {
  assert.equal(adapter.nextMonthEnd(Date.parse('2026-02-01T00:00:00Z')).slice(0, 10), '2026-02-28');
  assert.equal(adapter.nextMonthEnd(Date.parse('2028-02-01T00:00:00Z')).slice(0, 10), '2028-02-29');
  assert.equal(adapter.nextMonthEnd(Date.parse('2026-04-10T00:00:00Z')).slice(0, 10), '2026-04-30');
  // The last instant of the month has already passed, so it rolls forward.
  assert.equal(adapter.nextMonthEnd(Date.parse('2026-12-31T23:59:59.500Z')).slice(0, 10), '2027-01-31');
});

test('a dated future programme opens and then stops claiming to be upcoming', () => {
  const before = adapter.resolveWindow({ type: 'fixed_start', date: '2027-01-01' }, Date.parse('2026-08-27'));
  assert.ok(before.startsAt);
  assert.match(before.sentence, /does not exist yet/i);

  const after = adapter.resolveWindow({ type: 'fixed_start', date: '2027-01-01' }, Date.parse('2028-01-01'));
  assert.equal(after.startsAt, null, 'a start date in the past must not read as "not yet open"');

  // Junk dates degrade to no window rather than to an exception.
  assert.equal(adapter.resolveWindow({ type: 'fixed_start', date: '2027-13-45' }, Date.now()).startsAt, null);
  assert.equal(adapter.resolveWindow({ type: 'unknown_window' }, Date.now()).expiresAt, null);
  assert.equal(adapter.resolveWindow(null, Date.now()).expiresAt, null);
});

// ---------------------------------------------------------------------------
// The parser, fed deliberately damaged input
// ---------------------------------------------------------------------------

test('a hand-damaged file loses only the damaged rows', () => {
  const raw = JSON.parse(fs.readFileSync(CORRUPT, 'utf8'));
  let built;
  assert.doesNotThrow(() => {
    built = adapter.buildRows(raw.items, { schema, C, taxProfile: { federalOrdinary: 24, state: 'TX' } });
  });

  const ids = built.opportunities.map((o) => o.id);
  // The well-formed rows survive, including the last one — a parser that stopped
  // at the first bad record would never reach it.
  assert.ok(ids.includes('structural:intact-computed-row'), JSON.stringify(ids));
  assert.ok(ids.includes('structural:duplicate-id'));
  assert.equal(built.opportunities.length, 4);
  assert.ok(built.skipped >= 16, `expected the damage to be counted, got ${built.skipped}`);

  // A row whose DATE is unusable keeps the row and drops the date. Losing a
  // whole opportunity because someone typed month 13 would be a worse outcome
  // than showing it without a countdown.
  for (const id of ['poisoned-window', 'overflow-window']) {
    const kept = byId(built.opportunities, id);
    assert.ok(kept, `${id} should survive with no window`);
    assert.equal(kept.startsAt, null);
    assert.equal(kept.expiresAt, null);
    assert.doesNotThrow(() => JSON.stringify(kept));
  }

  // Every specific failure mode is refused rather than half-rendered.
  for (const gone of ['no-kind', 'unknown-kind', 'no-url', 'no-access', 'no-applies-to',
    'no-benefit', 'benefit-not-an-object', 'unknown-benefit-type', 'rate-not-a-number',
    'rate-infinite', 'rate-absurd', 'rate-negative', 'spend-bonus-zero-spend']) {
    assert.ok(!ids.includes(`structural:${gone}`), `${gone} should have been skipped`);
  }

  // A duplicate id keeps the first and drops the second, so an edit cannot
  // silently replace a row with a different one.
  assert.match(byId(built.opportunities, 'duplicate-id').name, /First of two/);

  // The surviving computed row still went through the whole pipeline.
  const ok = byId(built.opportunities, 'intact-computed-row');
  assert.equal(ok.apy.total, 31.65);
  assert.equal(ok.maxInvestment, 3300);
  assert.ok(ok.expiresAt, 'the year-end window still resolved');
  assert.deepEqual(schema.validate(ok), []);
});

test('buildRows survives anything at all being handed to it', () => {
  for (const input of [null, undefined, 'items', 42, {}, [null, undefined, 0, '', false]]) {
    let built;
    assert.doesNotThrow(() => { built = adapter.buildRows(input, { schema, C }); }, JSON.stringify(input));
    assert.deepEqual(built.opportunities, []);
  }
});

test('loadSeed never throws and never returns half a result', () => {
  const missing = adapter.loadSeed({ schema, C, seedDir: '/nonexistent/path/for/a/test', settings: {} });
  assert.equal(missing.status, 'failed');
  assert.deepEqual(missing.opportunities, []);
  assert.ok(missing.warnings.length);

  for (const bad of [undefined, null, {}, { settings: null }, { settings: { tax: 'not an object' } }]) {
    assert.doesNotThrow(() => adapter.loadSeed(bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The bundled dataset
// ---------------------------------------------------------------------------

test('the bundled dataset loads, validates and is the size it claims', () => {
  const res = adapter.loadSeed(ctxFor());
  assert.equal(res.status, 'offline');
  assert.ok(res.opportunities.length >= 40, `expected a broad dataset, got ${res.opportunities.length}`);
  for (const o of res.opportunities) {
    assert.deepEqual(schema.validate(o), [], `${o.id} is invalid`);
    assert.equal(o.source, 'structural');
    assert.equal(o.assetClass, C.ASSET_CLASS.CASH);
    assert.equal(o.section, 'deals');
    assert.equal(o.track, 'income');
    assert.equal(o.seed, true);
    assert.equal(o.live, false);
    assert.ok(o.confidence <= adapter.SEED_CONFIDENCE + 1e-9, `${o.id} confidence ${o.confidence}`);
    assert.ok(o.dataAsOf);
  }
  // The seed file on disk must be shaped the way the audit expects.
  const disk = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'structural.json'), 'utf8'));
  assert.ok(Array.isArray(disk.items) && disk.items.length > 0);
  assert.equal(disk.meta.source, 'structural');
});

test('every row says who it applies to, how to do it and where the rule is written', () => {
  for (const o of seedRows()) {
    assert.ok(o.url, `${o.id} has no link`);
    assert.ok(o.accessNotes && o.accessNotes.length > 40, `${o.id} does not say how to actually do it`);
    // Eligibility is the FIRST requirement on every row. A backdoor Roth is
    // useless below the phase-out and describing it as universal would be a lie,
    // so the "who this is for" line cannot be buried in prose.
    assert.match(o.requirements[0], /^Applies to: /, `${o.id} does not lead with who it applies to`);
    assert.ok(o.requirements.length >= 2, `${o.id} states no conditions at all`);
    assert.ok(o.notes.length > 120, `${o.id} has no real explanation`);
    assert.ok(/verify|confirm|check/i.test(o.notes), `${o.id} does not tell the reader to verify anything`);
  }
});

test('nothing is dated in the past, and everything with a deadline can be counted down', () => {
  const rows = seedRows();
  const dated = rows.filter((o) => o.expiresAt);
  assert.ok(dated.length >= 10, `expected a lot of deadlines, got ${dated.length}`);
  for (const o of rows) {
    if (o.expiresAt) {
      const t = Date.parse(o.expiresAt);
      assert.ok(Number.isFinite(t) && Math.abs(t) <= 8.64e15, `${o.id} has an unusable expiry`);
      assert.doesNotThrow(() => new Date(t).toISOString());
      // An expired row is hidden by the default query, so a recurring statutory
      // deadline that expired once and never came back would silently vanish
      // from the app forever.
      assert.equal(o.expired, false, `${o.id} is already expired`);
      assert.ok(o.daysLeft >= 0 && o.daysLeft <= 400, `${o.id} closes in ${o.daysLeft} days`);
    }
    if (o.startsAt) {
      const t = Date.parse(o.startsAt);
      assert.ok(Number.isFinite(t) && Math.abs(t) <= 8.64e15, `${o.id} has an unusable start`);
    }
    if (o.expiresAt && o.startsAt) {
      assert.ok(Date.parse(o.expiresAt) > Date.parse(o.startsAt), `${o.id} closes before it opens`);
    }
  }

  // The rows that must be dated, are.
  assert.ok(byId(rows, 'tax-loss-harvest-ordinary-income').expiresAt, 'harvesting has a 31 December deadline');
  assert.equal(byId(rows, 'tax-loss-harvest-ordinary-income').expiresAt.slice(5, 10), '12-31');
  assert.equal(byId(rows, 'traditional-ira-deduction').expiresAt.slice(5, 10), '04-15');
  assert.ok(byId(rows, 'savers-match-2027').startsAt, 'a legislated future programme must carry its start date');
});

test('the deadline moves with the clock instead of being frozen into the file', () => {
  // Built in December, the year-end rows are days away. Built in January, they
  // are a year away — same file, different answer, which is the whole point.
  const dec = seedRows(undefined, Date.parse('2026-12-20T00:00:00Z'));
  const harvestDec = dec.find((o) => o.id === 'structural:tax-loss-harvest-ordinary-income');
  assert.equal(harvestDec.expiresAt.slice(0, 10), '2026-12-31');

  const jan = seedRows(undefined, Date.parse('2027-01-05T00:00:00Z'));
  const harvestJan = jan.find((o) => o.id === 'structural:tax-loss-harvest-ordinary-income');
  assert.equal(harvestJan.expiresAt.slice(0, 10), '2027-12-31');

  // And in March, the IRA prior-year window is the April deadline, not December.
  const mar = seedRows(undefined, Date.parse('2027-03-01T00:00:00Z'));
  assert.equal(mar.find((o) => o.id === 'structural:traditional-ira-deduction').expiresAt.slice(0, 10), '2027-04-15');
});

test('effort and reach are honest about what each thing actually takes', () => {
  const rows = seedRows();
  const efforts = new Set(rows.map((o) => o.effort));
  const reaches = new Set(rows.map((o) => o.reach));
  for (const e of efforts) assert.ok(['passive', 'light', 'hoops', 'social', 'ongoing'].includes(e), `bad effort ${e}`);
  for (const r of reaches) assert.ok(['everyone', 'common', 'niche', 'obscure'].includes(r), `bad reach ${r}`);
  // The user asked specifically for things few people know about, so there had
  // better be some, and they had better not all be filed as "everyone knows".
  assert.ok(rows.filter((o) => o.reach === 'obscure').length >= 8, 'no obscure plays at all');
  assert.ok(rows.filter((o) => o.reach === 'everyone').length >= 3);
  // A mega-backdoor Roth is not a five-minute job and must not be sold as one.
  assert.equal(byId(rows, 'mega-backdoor-roth').effort, 'hoops');
  assert.equal(byId(rows, 'backdoor-roth').effort, 'hoops');
});

// ---------------------------------------------------------------------------
// The honesty rules that make this source defensible
// ---------------------------------------------------------------------------

test('an employer match is not government-backed and does not pretend to be', () => {
  const rows = seedRows();
  const match = byId(rows, 'employer-401k-match-50-on-6');
  assert.equal(match.apy.total, 50);
  assert.equal(match.maxInvestment, 24500);

  // It is one company's promise, so it carries no insurance badge...
  assert.equal(match.risk.insurance, C.INSURANCE.NONE);
  // ...and the rating engine must therefore not award full principal safety.
  assert.ok(principalAxis({ ...match, scores: { tail: { annualProbability: 0.0005 } } }).value < 5);

  // Vesting is a condition, not a footnote.
  assert.ok(match.requirements.some((r) => /vest/i.test(r)), 'vesting is not in the requirements');
  assert.match(match.notes, /employer's promise/i);

  // A tax rule, by contrast, is as good as the tax code, and says so.
  const harvest = byId(rows, 'tax-loss-harvest-ordinary-income');
  assert.equal(harvest.risk.insurance, C.INSURANCE.US_GOV);
});

test('every account row separates the guaranteed uplift from the investment inside it', () => {
  const rows = seedRows();
  for (const id of ['employer-401k-match-50-on-6', 'employer-401k-match-100-on-3',
    'hsa-contribution-deduction', 'traditional-ira-deduction', 'roth-ira-tax-free-growth']) {
    const o = byId(rows, id);
    assert.match(o.notes, /separate from whatever you then buy/i,
      `${id} does not distinguish the match or deduction from the investment risk`);
  }
});

test('a rate is always a rate ON something specific, never on a portfolio', () => {
  for (const o of seedRows()) {
    if (o.apy.total === 0) continue;                 // the "worth nothing to you" rows
    assert.match(o.notes, /rate ON|return on the money|as a return on/i,
      `${o.id} does not say what its percentage is a rate on`);
  }
});

test('caps are structural, so more money cannot earn the headline rate', () => {
  const rows = seedRows();
  // The contribution limit is the cap, and it is carried where the scoring engine
  // reads it rather than described in prose.
  assert.equal(byId(rows, 'hsa-contribution-deduction').maxInvestment, 4400);
  assert.equal(byId(rows, 'tax-loss-harvest-ordinary-income').maxInvestment, 3000);
  assert.equal(byId(rows, 'savers-credit').maxInvestment, 2000);
  assert.equal(byId(rows, 'health-fsa').maxInvestment, 3400);

  // Where a thing genuinely is uncapped, it must not be given a fake cap — and it
  // has to say why it is uncapped instead.
  const uncapped = rows.filter((o) => o.maxInvestment === null);
  assert.ok(uncapped.length >= 5, 'everything cannot be capped');
  for (const o of uncapped) {
    assert.ok(/uncapped|not capped|no cap|no limit|not a contribution|Capped by the bracket/i.test(o.notes),
      `${o.id} is uncapped and does not explain why`);
  }
});

test('nothing eye-catching is left without an explanation the app can see', () => {
  // The cross-source audit refuses a top-grade row paying multiples of risk-free
  // with no flag on it. Check the same invariant here, at this source, so a new
  // row cannot quietly break the audit later.
  const riskFree = 4.0;
  for (const o of seedRows()) {
    if (!(o.apy.total > riskFree * 4)) continue;
    const traps = detectTraps(o, { peerMedian: 4 });
    const risk = scoreRisk({ ...o, __riskFree: riskFree });
    assert.ok(traps.flags.length > 0 || risk.score >= 6,
      `${o.id} pays ${o.apy.total}% at risk ${risk.score} with nothing flagged`);
    // ...and never so much that it is hidden as a likely trap.
    assert.ok(traps.verdict !== 'likely_trap', `${o.id} is scored as a likely trap`);
  }
});

test('one-off actions are marked one-off, and ongoing benefits are not', () => {
  const rows = seedRows();
  // A deduction you take this year does not compound at its own rate next year.
  assert.equal(byId(rows, 'tax-loss-harvest-ordinary-income').oneTime, true);
  assert.equal(byId(rows, 'savers-credit').oneTime, true);
  // A tax shelter on a balance genuinely does recur, year after year.
  assert.equal(byId(rows, 'roth-ira-tax-free-growth').oneTime, false);
  assert.equal(byId(rows, 'municipal-bond-exemption').oneTime, false);
  assert.equal(byId(rows, 'ee-bond-twenty-year-doubling').oneTime, false);
});

// ---------------------------------------------------------------------------
// The user's own settings drive the numbers, and the row says so
// ---------------------------------------------------------------------------

test('the same file produces different numbers for different people', () => {
  const tx = seedRows({ federalOrdinary: 24, federalLtcg: 15, state: 'TX' });
  const ca = seedRows({ federalOrdinary: 37, federalLtcg: 20, state: 'CA', niitApplies: true });

  // A pre-tax election is worth your bracket plus payroll tax, so it is worth
  // nearly twice as much to the Californian.
  assert.equal(byId(tx, 'health-fsa').apy.total, 31.65);
  assert.equal(byId(ca, 'health-fsa').apy.total, 57.95);

  // The Treasury state exemption is worth nothing in Texas and real money in
  // California, and the zero is shown rather than hidden.
  assert.equal(byId(tx, 'treasury-state-tax-exemption').apy.total, 0);
  assert.ok(byId(ca, 'treasury-state-tax-exemption').apy.total > 0.5);

  // And the row states which settings produced the figure.
  assert.match(byId(ca, 'health-fsa').notes, /Computed from your tax settings/);
  assert.match(byId(ca, 'health-fsa').notes, /CA/);
});

test('the 529 row is computed for the state and is blunt when there is nothing there', () => {
  const il = byId(seedRows({ federalOrdinary: 24, state: 'IL' }), '529-state-tax-deduction');
  assert.equal(il.apy.total, STATE_TOP_RATES.IL);
  assert.equal(il.maxInvestment, 10000);

  const tx = byId(seedRows({ federalOrdinary: 24, state: 'TX' }), '529-state-tax-deduction');
  assert.equal(tx.apy.total, 0);
  assert.match(tx.notes, /no state income tax/i);

  // Every state code in the table is one the tax module also knows about, or the
  // row would be computed against a rate that does not exist.
  for (const code of Object.keys(adapter.STATE_529)) {
    assert.ok(STATE_TOP_RATES[code] !== undefined, `${code} is not in STATE_TOP_RATES`);
  }
  for (const code of Object.keys(STATE_TOP_RATES)) {
    assert.ok(adapter.STATE_529[code], `${code} has no 529 entry`);
    if (STATE_TOP_RATES[code] === 0) {
      assert.equal(adapter.STATE_529[code].kind, 'no_income_tax',
        `${code} has no income tax but its 529 entry claims a deduction`);
    }
  }
});

test('a missing or nonsensical tax profile falls back instead of failing', () => {
  for (const tax of [undefined, {}, { state: 'ZZ' }, { federalOrdinary: null }, { state: 12 }]) {
    let rows;
    assert.doesNotThrow(() => { rows = seedRows(tax); }, JSON.stringify(tax));
    assert.ok(rows.length >= 40);
    for (const o of rows) assert.deepEqual(schema.validate(o), []);
  }
});

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

test('the adapter satisfies the source contract', () => {
  assert.deepEqual(contract.validateAdapter(adapter), []);
  assert.equal(adapter.id, 'structural');
  assert.equal(adapter.label, 'Structural & Tax Plays');
  assert.equal(adapter.requiresNetwork, false);
  assert.equal(adapter.requiresKey, false);
  assert.deepEqual(adapter.assetClasses, [C.ASSET_CLASS.CASH]);
});

test('fetch has nothing to fetch and is honest about it', async () => {
  const res = await adapter.fetch(ctxFor());
  // Never better than partial: the thing that would make it 'ok' is a human
  // reading their own plan document, which no request can do.
  assert.equal(res.status, 'partial');
  assert.ok(res.opportunities.length >= 40);
  assert.ok(res.warnings.length >= 2);
  assert.ok(res.warnings.some((w) => /tax advice/i.test(w)));
  assert.ok(res.warnings.some((w) => /vesting/i.test(w)));
  assert.ok(res.notes.some((n) => /Computed for a/.test(n)));
});
