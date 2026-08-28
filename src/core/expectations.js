'use strict';

const C = require('./constants');

/**
 * What to actually expect.
 *
 * Every number elsewhere in this app is a single figure — 5.4%, grade B, heat
 * 31 — and a single figure is a terrible description of an uncertain outcome.
 * "5.4%" invites you to plan on 5.4%. What you should plan on is a range, with
 * the bad end weighted properly, because the bad end is the one that decides
 * whether you can hold on.
 *
 * Two different shapes of uncertainty, and conflating them is how people get
 * hurt:
 *
 *   A savings account's uncertainty is in the RATE. The principal is fine; the
 *   rate might be cut. The bad case is "you earned less than you hoped".
 *
 *   A fund's uncertainty is in the PRINCIPAL. The bad case is "you have less
 *   money than you started with", which is a different thing entirely and is
 *   not made comparable by putting both in a column headed "yield".
 *
 * So this reports a band, labels which kind of uncertainty it is, and states
 * the assumptions in words. Where an outcome genuinely cannot be bounded — a
 * DeFi pool that can be drained, a token that can go to zero — it says so
 * rather than quoting a tidy percentile of a distribution that does not apply.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Annualised volatility as a fraction, from wherever the row actually carries it.
 *
 * Three places hold it depending on which source built the row, and reading
 * only the top-level one silently returned null for every measured row — which
 * meant the band quietly fell back to the coarse grade estimate on exactly the
 * rows where a real measurement existed.
 */
function volatilityOf(o) {
  if (!o || typeof o !== 'object') return null;
  const raw = [o.volatility, o.risk?.volatility, o.movementStats?.vol, o.movement?.stats?.vol]
    .find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return raw === undefined ? null : raw / 100;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Roughly how bad a bad year is, from the safety grade.
 *
 * Grades already encode the app's whole risk read, so deriving the downside
 * from the grade keeps the two from ever disagreeing on screen — which they did
 * when they were computed separately.
 */
const GRADE_DOWNSIDE = {
  'A+': { typicalWorst: 0, tailWorst: 0, note: 'Principal is guaranteed. The only thing that varies is the rate.' },
  A: { typicalWorst: -0.01, tailWorst: -0.03, note: 'Principal is protected, with some rate or timing risk at the edges.' },
  B: { typicalWorst: -0.05, tailWorst: -0.12, note: 'Small losses are possible in a bad year.' },
  C: { typicalWorst: -0.12, tailWorst: -0.30, note: 'A bad year here is a real loss you would feel.' },
  D: { typicalWorst: -0.25, tailWorst: -0.55, note: 'Large losses are a normal part of owning this.' },
  E: { typicalWorst: -0.40, tailWorst: -0.75, note: 'Severe losses are an ordinary outcome, not a disaster scenario.' },
  F: { typicalWorst: -0.60, tailWorst: -1.0, note: 'The whole position can go to zero, and has for things like this.' },
};

/**
 * The range of first-year outcomes on a given amount.
 *
 * `typical` is the middle. `good` and `bad` are roughly the edges of what would
 * be unremarkable. `tail` is the bad case that is not supposed to happen and
 * periodically does — and it is reported precisely because every product that
 * has ever blown up looked fine right until it did.
 */
function incomeOutcomes(o, { amount = null, riskFree = 4 } = {}) {
  const rate = o.scores?.blendedAfterTax ?? o.tax?.afterTaxApy ?? o.apy?.total;
  if (!finite(rate)) return null;

  const grade = o.rating?.grade || 'C';
  const g = GRADE_DOWNSIDE[grade] || GRADE_DOWNSIDE.C;
  const vol = volatilityOf(o);

  // Rate uncertainty: a contractual rate holds, a promotional one reverts, a
  // variable one drifts with policy.
  const contractual = o.yieldKind === C.YIELD_KIND.CONTRACTUAL;
  const rateBand = contractual ? 0 : Math.max(0.15, Math.min(0.5, 1 - (o.confidence ?? 0.5)));

  const principalMoves = !!o.risk?.principalAtRisk;
  // Where a real volatility is known, use it; otherwise fall back on the grade,
  // which is the same read expressed coarsely.
  const downTypical = principalMoves
    ? (vol !== null ? -vol * 0.9 : g.typicalWorst)
    : 0;
  // The tail takes the WORSE of the measured volatility and the grade's floor.
  // Taking the less bad of the two was the bug: on a low-volatility investment
  // graded conservatively it produced a tail shallower than the ordinary bad
  // year, so the row claimed its disaster case was milder than its bad case.
  const downTail = principalMoves
    ? (vol !== null ? Math.min(g.tailWorst, -vol * 2.2) : g.tailWorst)
    : g.tailWorst;

  const pct = {
    good: rate * (1 + rateBand * 0.6) / 100 + (principalMoves ? Math.abs(downTypical) * 0.8 : 0),
    typical: rate / 100,
    bad: rate * (1 - rateBand) / 100 + downTypical,
    tail: rate * (1 - rateBand) / 100 + downTail,
  };

  // The ordering is a promise the interface makes — the rows are literally
  // labelled good/typical/bad/worse — so it is enforced here rather than left
  // to the arithmetic above happening to hold for every combination of inputs.
  pct.good = Math.max(pct.good, pct.typical);
  pct.bad = Math.min(pct.bad, pct.typical);
  pct.tail = Math.min(pct.tail, pct.bad);

  const dollars = finite(amount) && amount > 0
    ? Object.fromEntries(Object.entries(pct).map(([k, v]) => [k, amount * v]))
    : null;

  return {
    kind: principalMoves ? 'principal' : 'rate',
    grade,
    pct,
    dollars,
    amount: finite(amount) && amount > 0 ? amount : null,
    // The sentence that matters more than the numbers.
    headline: principalMoves
      ? `The uncertainty here is in your PRINCIPAL, not just the rate. ${g.note}`
      : `Your principal is not at risk. What varies is the rate${contractual ? ', and this one is contractual for the term' : ' — this one can change'}.`,
    assumptions: [
      contractual ? 'The rate is fixed by contract for the term.'
        : 'The rate can change; the band reflects how much rates like this have moved.',
      principalMoves ? 'The downside band comes from this thing\'s own measured volatility where available, '
        + 'and from its safety grade where not.' : 'No principal risk, so the bad case is a lower rate rather than a loss.',
      finite(amount) && amount > 0 ? `Computed on ${amount.toLocaleString()}.`
        : 'Percentages only — set an amount to see dollars.',
    ],
    unbounded: grade === 'F' || o.risk?.insurance === C.INSURANCE.NONE
      ? 'The worst case here is not a percentile of a distribution. Smart contracts get drained and issuers '
        + 'disappear. Treat the tail number as illustrative and size the position on the assumption it can go to zero.'
      : null,
  };
}

/**
 * What a normal move looks like for something whose return is price.
 *
 * Deliberately expressed as "how often" rather than as a forecast. A person
 * reading "±12%" plans on 12%; a person reading "it moves more than 12% in
 * about one month in five" understands they are looking at a distribution.
 */
function movementOutcomes(o, { horizonDays = 30 } = {}) {
  const vol = volatilityOf(o);
  if (vol === null || vol <= 0) return null;

  const scaled = vol * Math.sqrt(horizonDays / 365);
  const bands = [
    { label: 'An ordinary month', sigma: 1, odds: 'about 2 months in 3' },
    { label: 'A notable move', sigma: 2, odds: 'about 1 month in 20' },
    { label: 'A shock', sigma: 3, odds: 'about 1 month in 100' },
  ].map((b) => ({ ...b, pct: scaled * b.sigma }));

  const worst = finite(o.maxDrawdown) && o.maxDrawdown > 0 ? -o.maxDrawdown / 100 : null;

  return {
    horizonDays,
    annualVol: vol,
    bands,
    worstOnRecord: worst,
    headline: `Over ${horizonDays} days, a move of about ${(scaled * 100).toFixed(1)}% either way would be `
      + 'completely ordinary for this.',
    assumptions: [
      'Arithmetic on past volatility, not a forecast.',
      'The odds assume moves are roughly bell-shaped, which is generous — real markets have fatter tails, '
        + 'so the rare cases happen rather more often than these numbers suggest.',
      worst !== null ? `Its worst recorded fall was ${(Math.abs(worst) * 100).toFixed(0)}%, which is larger than `
        + 'the shock band above. That is the point: the model understates the extremes.' : null,
    ].filter(Boolean),
    direction: 'None of this says which way. A wider band means a bigger move, not a better one.',
  };
}

/** Both, whichever applies, plus the honest caveats. */
function expectationsFor(o, opts = {}) {
  const income = o.section === 'movement' ? null : incomeOutcomes(o, opts);
  const movement = o.section === 'movement' || o.risk?.principalAtRisk
    ? movementOutcomes(o, opts) : null;
  if (!income && !movement) return null;
  return { income, movement };
}

module.exports = { volatilityOf, expectationsFor, incomeOutcomes, movementOutcomes, GRADE_DOWNSIDE };
