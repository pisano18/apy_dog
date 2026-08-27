'use strict';

const C = require('./constants');
const T = require('./tracks');

/**
 * The rating shown to a person.
 *
 * risk.js computes an internally-useful 0-100 number. This turns that, plus the
 * underlying facts, into something a human can act on: a safety grade with a
 * sentence, and five axes that each answer one question in plain words.
 *
 * The split matters because "risk" is not one quantity. A 30-year Treasury and a
 * new memecoin are both risky, for opposite reasons — one will absolutely pay you
 * back and might swing 20% on the way, the other might simply cease to exist.
 * Collapsing both into "58" tells you nothing about which danger you are signing
 * up for. Five axes tell you exactly which.
 *
 * Every axis is 0-5 and carries the reason it scored what it did.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pip = (v) => clamp(Math.round(v * 2) / 2, 0, 5);   // half-pip resolution

/** Can I lose the money I put in? */
function principalAxis(o) {
  const ins = o.risk?.insurance;
  const tail = o.scores?.tail?.annualProbability ?? null;

  if (ins === C.INSURANCE.US_GOV) return { value: 5, why: 'Backed by the US government' };
  if (ins === C.INSURANCE.FDIC || ins === C.INSURANCE.NCUA) {
    const limit = o.risk?.insuredLimit;
    return { value: 5, why: `${ins.toUpperCase()} insured${limit ? ` up to $${(limit / 1000).toFixed(0)}k` : ''}` };
  }

  // For everything uninsured, two different things can take your principal, and
  // both belong here: a catastrophe that ends the position, and an ordinary bad
  // year. A broad equity fund will essentially never go to zero, but losing 35%
  // is still losing principal, and a rating that calls that "5/5 safe" because
  // the tail is thin has quietly answered a different question than the one
  // asked. So the tail sets the score and the drawdown potential caps it.
  const vol = o.risk?.volatilityUsed ?? o.risk?.volatility;
  const dd = o.risk?.maxDrawdown;
  // A rough bad-year loss: the worse of what it has actually done and a ~95th
  // percentile down move given its volatility. Returns compound, so the move is
  // lognormal — a naive 1.65 x vol overstates a 50%-vol asset badly (it implies
  // -86% where the real figure is about -58%).
  const badYear = Number.isFinite(vol) ? (1 - Math.exp(-1.65 * (vol / 100))) * 100 : 0;
  const lossPotential = Math.max(Number.isFinite(dd) ? dd : 0, badYear);
  const drawdownCap = lossPotential > 0 ? clamp(5 - lossPotential / 16, 0, 5) : 5;
  const capNote = lossPotential >= 15
    ? `a bad year here looks like roughly -${Math.round(lossPotential)}%`
    : null;

  if (Number.isFinite(tail)) {
    let raw;
    let why;
    if (tail < 0.002) { raw = 4.5; why = 'Severe loss would be extraordinary'; }
    else if (tail < 0.008) { raw = 4; why = 'Diversified enough that a total loss is remote'; }
    else if (tail < 0.02) { raw = 3; why = `Roughly a ${(tail * 100).toFixed(1)}% annual chance of a severe loss`; }
    else if (tail < 0.05) { raw = 2; why = `Roughly a ${(tail * 100).toFixed(0)}% annual chance of a severe loss`; }
    else if (tail < 0.15) { raw = 1; why = `About a ${(tail * 100).toFixed(0)}% annual chance of losing most of it`; }
    else { raw = 0; why = `About a ${(tail * 100).toFixed(0)}% annual chance of near-total loss`; }

    if (drawdownCap < raw && capNote) why = capNote;
    return { value: pip(Math.min(raw, drawdownCap)), why };
  }

  const byClass = {
    govt_bond: 4.5, muni_bond: 4, corp_bond: 3.5, rwa: 3.5, annuity: 4,
    etf: 3.5, preferred: 3, dividend_equity: 2.5, cef: 3, reit: 2.5, bdc: 2,
    p2p_lending: 2, crypto_staking: 1.5, crypto_lending: 1.5, crypto_lp: 1, speculative: 1,
  };
  const fallback = byClass[o.assetClass] ?? 2;
  return {
    value: pip(Math.min(fallback, drawdownCap)),
    why: capNote || 'No guarantee behind it',
  };
}

/** Will the income actually arrive, at the rate advertised? */
function payoutAxis(o) {
  if (o.track === T.TRACK.MOVEMENT) {
    return { value: null, why: 'Not an income holding — return comes from price', na: true };
  }

  const kind = o.yieldKind;
  const flags = o.trapFlags || [];
  let v;
  let why;

  if (kind === C.YIELD_KIND.CONTRACTUAL) { v = 5; why = 'Rate is contractually fixed for the term'; }
  else if (kind === C.YIELD_KIND.MARKET) { v = 4.5; why = 'Set by the market, locked in if you hold to maturity'; }
  else if (kind === C.YIELD_KIND.ADMINISTERED) { v = 3.5; why = 'The provider can change this rate whenever it likes'; }
  else if (kind === C.YIELD_KIND.TRAILING) { v = 2.5; why = 'Backward-looking — this is what it paid, not what it will'; }
  else if (kind === C.YIELD_KIND.FORWARD) { v = 2.5; why = 'Annualised from one recent payment'; }
  else { v = 2; why = 'Floats freely and can fall at any time'; }

  // Specific, known ways a payout breaks.
  if (flags.includes(C.TRAP_FLAGS.REWARD_DOMINANT)) { v -= 1.5; why = 'Mostly token emissions, which get cut'; }
  if (flags.includes(C.TRAP_FLAGS.UNSUSTAINABLE_PAYOUT)) { v -= 1.5; why = 'Earnings do not cover the distribution'; }
  if (flags.includes(C.TRAP_FLAGS.RETURN_OF_CAPITAL)) { v -= 1; why = 'Much of the payout is your own capital returned'; }
  if (flags.includes(C.TRAP_FLAGS.TEASER_RATE)) { v -= 1.5; why = 'Promotional rate that reverts'; }
  if (flags.includes(C.TRAP_FLAGS.APY_SPIKE)) { v -= 1; why = 'Currently spiking well above its own average'; }
  if (flags.includes(C.TRAP_FLAGS.CAPPED_BALANCE)) { v -= 0.5; why = 'Top rate only applies to a small balance'; }

  return { value: pip(v), why };
}

/** Can I get my money out when I want it? */
function exitAxis(o) {
  const liq = o.liquidity;
  const base = {
    instant: 5, daily: 4.5, settled: 4, notice: 2.5, locked: 1.5, illiquid: 0,
  }[liq] ?? 2.5;

  let v = base;
  let why = {
    instant: 'Withdraw any time, no penalty',
    daily: 'Sellable any trading day',
    settled: 'Sellable, settles in a couple of days',
    notice: 'Requires notice or an unbonding period',
    locked: 'Committed until maturity',
    illiquid: 'No reliable way out',
  }[liq] || 'Unclear';

  if (liq === C.LIQUIDITY.LOCKED && Number.isFinite(o.term?.days)) {
    const yrs = o.term.days / 365.25;
    if (yrs > 3) { v -= 1; why = `Locked for ${yrs.toFixed(0)} years`; }
    else if (yrs > 1) { v -= 0.5; why = `Locked for ${yrs.toFixed(1)} years`; }
    if (o.term.earlyExitPenalty) why += ` (${o.term.earlyExitPenalty} to break early)`;
  }

  // Thin markets are only liquid until you actually try to leave.
  if (Number.isFinite(o.tvl)) {
    if (o.tvl < 1e6) { v -= 1.5; why = 'Thin — you may not be able to exit at size'; }
    else if (o.tvl < 1e7) { v -= 0.5; }
  }
  if (Number.isFinite(o.volume) && o.volume > 0 && o.volume < 5e5) {
    v -= 1; why = 'Low daily volume — a real order would move the price';
  }

  return { value: pip(v), why };
}

/** How bumpy is the ride? */
function steadyAxis(o) {
  const vol = o.risk?.volatilityUsed ?? o.risk?.volatility;
  if (!Number.isFinite(vol)) return { value: 2.5, why: 'Volatility unknown' };

  // 0-2% -> 5, 8% -> 4, 16% -> 3, 30% -> 2, 55% -> 1, 90%+ -> 0
  const v = 5 - clamp(5 * (1 - Math.exp(-vol / 32)), 0, 5);
  const assumed = o.risk?.volatilityAssumed;
  const desc = vol < 2 ? 'Essentially no price movement'
    : vol < 8 ? `Mild, about ${vol.toFixed(0)}% a year`
      : vol < 18 ? `Moderate, about ${vol.toFixed(0)}% a year`
        : vol < 35 ? `Bumpy, about ${vol.toFixed(0)}% a year`
          : vol < 60 ? `Very volatile, about ${vol.toFixed(0)}% a year`
            : `Wild, about ${vol.toFixed(0)}% a year`;
  return { value: pip(v), why: assumed ? `${desc} (estimated from its category)` : desc };
}

/** How much do we actually know about these numbers? */
function knownAxis(o) {
  let v = 5 * clamp(o.confidence ?? 0.5, 0, 1);
  const reasons = [];

  if (o.seed) { v -= 1.5; reasons.push('bundled snapshot, not a live quote'); }
  if (o.risk?.volatilityAssumed) { v -= 0.5; reasons.push('volatility estimated'); }
  if ((o.corroboratedBy || []).length) { v += 0.5; reasons.push(`confirmed by ${o.corroboratedBy.length} other source`); }
  if (o.trapFlags?.includes(C.TRAP_FLAGS.STALE_DATA)) { v -= 1; reasons.push('data is stale'); }

  const ageMs = Date.now() - Date.parse(o.dataAsOf || '');
  if (Number.isFinite(ageMs) && ageMs < 2 * C.DAY && !o.seed) { v += 0.5; reasons.push('refreshed recently'); }

  return {
    value: pip(v),
    why: reasons.length ? reasons.join('; ') : 'Sourced directly from the provider',
  };
}

/**
 * Full rating for one opportunity. Expects risk/tail/traps already computed
 * (i.e. call after score.js), because the axes read from them.
 */
function rate(o) {
  const axes = {
    principal: principalAxis(o),
    payout: payoutAxis(o),
    exit: exitAxis(o),
    steady: steadyAxis(o),
    known: knownAxis(o),
  };

  const g = T.grade(o.risk?.score);

  // The single line to show when there is only room for one line. Whichever axis
  // is weakest is the thing most likely to hurt this person, so lead with it.
  const scored = Object.entries(axes).filter(([, a]) => a.value !== null);
  const weakest = scored.sort((a, b) => a[1].value - b[1].value)[0];
  const meta = T.AXES.find((a) => a.key === weakest[0]);
  // If nothing is actually weak, there is no "watch out for this" to report, and
  // manufacturing one from the least-perfect axis would be noise.
  const notable = weakest[1].value <= 3;

  return {
    grade: g.key,
    gradeColor: g.color,
    gradeHeadline: g.headline,
    gradeDetail: g.detail,
    axes,
    weakestAxis: notable ? weakest[0] : null,
    weakestLabel: notable ? meta?.label : null,
    headline: notable ? weakest[1].why : g.headline,
  };
}

module.exports = { rate, principalAxis, payoutAxis, exitAxis, steadyAxis, knownAxis };
