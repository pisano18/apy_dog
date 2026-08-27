'use strict';

const T = require('./tracks');

/**
 * Catalysts and expected moves.
 *
 * You cannot time the market. You can, however, know that a company reports
 * earnings in six days, that the Fed meets in twelve, that a token unlock hits on
 * the third, and roughly how violently this particular asset has historically
 * reacted to that kind of event. That is not prediction, it is a calendar plus
 * arithmetic, and it is genuinely useful in a way a made-up expected return is not.
 *
 * Everything here is expressed as ranges and tiers. There is no function in this
 * file that returns "the price will be X", because no honest one could.
 */

const DAY = 86400000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Event catalogue.
 *
 * `volMultiple` is how much bigger the move around this event tends to be than a
 * normal day for the same asset. These are order-of-magnitude conventions from
 * how these events typically behave, not fitted parameters, and they are shown to
 * the user rather than hidden.
 *
 * `scope` decides who the event applies to: one symbol, an asset class, or
 * everything rate-sensitive.
 */
const EVENT_KIND = {
  EARNINGS: 'earnings',
  GUIDANCE: 'guidance',
  FOMC: 'fomc',
  CPI: 'cpi',
  JOBS: 'jobs',
  PPI: 'ppi',
  GDP: 'gdp',
  PCE: 'pce',
  TREASURY_AUCTION: 'treasury_auction',
  EX_DIVIDEND: 'ex_dividend',
  DISTRIBUTION_DECLARED: 'distribution_declared',
  RATE_RESET: 'rate_reset',
  OPEX: 'opex',
  INDEX_REBALANCE: 'index_rebalance',
  TOKEN_UNLOCK: 'token_unlock',
  HALVING: 'halving',
  PROTOCOL_UPGRADE: 'protocol_upgrade',
  LOCKUP_EXPIRY: 'lockup_expiry',
  FILING_8K: 'filing_8k',
  FILING_S1: 'filing_s1',
  FILING_13D: 'filing_13d',
  MATURITY: 'maturity',
  CALL_DATE: 'call_date',
};

const EVENT_INFO = {
  earnings: { label: 'Earnings', volMultiple: 3.2, scope: 'symbol', forward: true, text: 'Quarterly results. The single largest scheduled move for most individual stocks.' },
  guidance: { label: 'Guidance update', volMultiple: 2.6, scope: 'symbol', forward: true, text: 'Management updating expectations, which often matters more than the reported quarter.' },
  fomc: { label: 'Fed decision', volMultiple: 1.9, scope: 'rates', forward: true, text: 'Rate decision and press conference. Moves every yield in this app, not just stocks.' },
  cpi: { label: 'CPI inflation', volMultiple: 1.8, scope: 'rates', forward: true, text: 'Inflation print. Drives rate expectations, so it reprices bonds and rate-sensitive equities.' },
  pce: { label: 'PCE inflation', volMultiple: 1.5, scope: 'rates', forward: true, text: 'The inflation measure the Fed actually targets.' },
  jobs: { label: 'Jobs report', volMultiple: 1.6, scope: 'rates', forward: true, text: 'Monthly payrolls. Second only to CPI for moving the rate curve.' },
  ppi: { label: 'PPI', volMultiple: 1.25, scope: 'rates', forward: true, text: 'Producer prices — an early read on where CPI is heading.' },
  gdp: { label: 'GDP', volMultiple: 1.2, scope: 'rates', forward: true, text: 'Growth print.' },
  treasury_auction: { label: 'Treasury auction', volMultiple: 1.2, scope: 'rates', forward: true, text: 'New supply priced. A weak auction pushes yields up and bond prices down.' },
  ex_dividend: { label: 'Ex-dividend', volMultiple: 1.0, scope: 'symbol', forward: true, text: 'Own it the day before to receive the payment. The price drops by roughly the dividend that morning — this is mechanical, not a loss.' },
  distribution_declared: { label: 'Distribution declared', volMultiple: 1.4, scope: 'symbol', forward: false, text: 'The fund announced its next payout. A cut is the most common way a high yield stops being high.' },
  rate_reset: { label: 'Rate reset', volMultiple: 1.0, scope: 'symbol', forward: true, text: 'The advertised rate is scheduled to change on this date.' },
  opex: { label: 'Options expiry', volMultiple: 1.3, scope: 'market', forward: true, text: 'Large expiry. Pins prices beforehand and often releases them after.' },
  index_rebalance: { label: 'Index rebalance', volMultiple: 1.4, scope: 'symbol', forward: true, text: 'Forced buying or selling by index funds on a known date.' },
  token_unlock: { label: 'Token unlock', volMultiple: 2.4, scope: 'symbol', forward: true, text: 'Locked supply becomes sellable. Reliably one-directional pressure, and the size is public.' },
  halving: { label: 'Halving', volMultiple: 1.6, scope: 'symbol', forward: true, text: 'Issuance rate halves on a known block. Long-telegraphed, so much of it is priced in.' },
  protocol_upgrade: { label: 'Protocol upgrade', volMultiple: 1.7, scope: 'symbol', forward: true, text: 'A scheduled change to how the network works. Carries execution risk as well as upside.' },
  lockup_expiry: { label: 'Lockup expiry', volMultiple: 2.0, scope: 'symbol', forward: true, text: 'Insiders become free to sell.' },
  filing_8k: { label: '8-K filed', volMultiple: 2.2, scope: 'symbol', forward: false, text: 'A material event the company was legally required to disclose promptly. Something happened.' },
  filing_s1: { label: 'S-1 filed', volMultiple: 1.5, scope: 'symbol', forward: false, text: 'Registration for a new share offering — usually dilutive.' },
  filing_13d: { label: '13D filed', volMultiple: 2.0, scope: 'symbol', forward: false, text: 'Someone took a large activist stake and intends to influence the company.' },
  maturity: { label: 'Matures', volMultiple: 0, scope: 'symbol', forward: true, text: 'Principal is returned on this date.' },
  call_date: { label: 'Call date', volMultiple: 0, scope: 'symbol', forward: true, text: 'The issuer may redeem early from this date, which ends the yield.' },
};

/**
 * Expected move over a horizon, as a band.
 *
 * Two components, added in quadrature because they are independent:
 *
 *   drift  — ordinary movement between now and then. Volatility scales with the
 *            square root of time, so 30% a year is about 4.3% over a fortnight.
 *   jump   — the extra move contributed by a scheduled event, over and above the
 *            normal day that is already counted in the drift term. This is why
 *            the event's multiplier is applied to ONE day rather than to the whole
 *            horizon: earnings is a single-day repricing, not a fortnight of
 *            elevated volatility. Multiplying the horizon instead would claim a
 *            45%-volatility stock moves 18% into a print, when the real figure is
 *            nearer 8%.
 *
 * The band runs from 1 sigma (about two-in-three of outcomes) to 1.65 sigma
 * (about nineteen-in-twenty) — the honest way to say "usually this much,
 * sometimes this much more".
 */
function expectedMove(annualVolPct, days, { volMultiple = 1 } = {}) {
  if (!Number.isFinite(annualVolPct) || annualVolPct <= 0) return null;
  if (!Number.isFinite(days) || days < 0) return null;

  const d = Math.max(days, 0.5);
  const drift = annualVolPct * Math.sqrt(d / 365);
  const dailyVol = annualVolPct / Math.sqrt(365);
  const excess = Math.max((volMultiple || 1) - 1, 0);
  const jump = dailyVol * excess;
  const sigma = Math.sqrt(drift * drift + jump * jump);

  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    typical: r1(sigma),                 // ~68% of outcomes fall inside this
    outer: r1(sigma * 1.65),            // ~90% fall inside this
    sigma: r1(sigma),
    drift: r1(drift),
    eventJump: r1(jump),
    days: d,
    volMultiple,
    label: `±${r1(sigma)}% typical, up to ±${r1(sigma * 1.65)}%`,
  };
}

/** Normalise whatever a source hands us into one event shape. */
function makeEvent(raw, now = Date.now()) {
  if (!raw) return null;
  const kind = String(raw.kind || '').toLowerCase();
  const info = EVENT_INFO[kind];
  if (!info) return null;

  const t = typeof raw.date === 'number' ? raw.date : Date.parse(raw.date);
  if (!Number.isFinite(t)) return null;

  const daysAway = (t - now) / DAY;
  return {
    kind,
    label: info.label,
    scope: info.scope,
    volMultiple: info.volMultiple,
    text: raw.text || info.text,
    title: raw.title || info.label,
    date: new Date(t).toISOString(),
    dateMs: t,
    daysAway: Math.round(daysAway * 10) / 10,
    past: daysAway < 0,
    // A "confirmed" date is published; an "estimated" one is inferred from a
    // pattern (a company that has reported in the first week of February for six
    // years will probably do so again, but that is a guess and is labelled one).
    certainty: raw.certainty === 'estimated' ? 'estimated' : 'confirmed',
    symbol: raw.symbol || null,
    source: raw.source || null,
    url: raw.url || null,
    magnitude: raw.magnitude ?? null,
  };
}

/**
 * The one event that matters most right now.
 *
 * Not simply the nearest: a confirmed earnings date in nine days outranks an
 * ex-dividend date tomorrow, because one can reprice the asset by 8% and the
 * other is a mechanical adjustment. Weight by impact, discount by distance.
 */
function nextCatalyst(events = [], { now = Date.now(), horizonDays = 60 } = {}) {
  const upcoming = events
    .filter((e) => e && !e.past && e.daysAway <= horizonDays)
    .map((e) => {
      // Impact decays with distance — an event 45 days out barely affects today.
      const proximity = Math.exp(-Math.max(e.daysAway, 0) / 21);
      const certaintyWeight = e.certainty === 'confirmed' ? 1 : 0.7;
      return { ...e, weight: (e.volMultiple || 1) * proximity * certaintyWeight };
    })
    .sort((a, b) => b.weight - a.weight);
  return upcoming[0] || null;
}

/** Events that already happened and are still relevant — the "news" side. */
function recentEvents(events = [], { now = Date.now(), lookbackDays = 14 } = {}) {
  return events
    .filter((e) => e && e.past && e.daysAway >= -lookbackDays)
    .sort((a, b) => b.dateMs - a.dateMs);
}

/** "in 6 days" / "tomorrow" / "3 days ago" */
function whenPhrase(daysAway) {
  if (!Number.isFinite(daysAway)) return '';
  const d = Math.round(daysAway);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 0) return d < 14 ? `in ${d} days` : d < 60 ? `in ${Math.round(d / 7)} weeks` : `in ${Math.round(d / 30.44)} months`;
  const a = Math.abs(d);
  return a < 14 ? `${a} days ago` : a < 60 ? `${Math.round(a / 7)} weeks ago` : `${Math.round(a / 30.44)} months ago`;
}

/**
 * The headline sentence for a movement row: what is coming, when, and how much
 * this particular asset could plausibly move because of it.
 */
function describeCatalyst(event, annualVolPct) {
  if (!event) return null;
  const move = expectedMove(annualVolPct, Math.max(event.daysAway, 0.5), { volMultiple: event.volMultiple });
  const sev = move ? T.severity(move.typical) : null;
  return {
    event,
    move,
    severity: sev?.key || null,
    severityLabel: sev?.label || null,
    severityColor: sev?.color || null,
    sentence: move
      ? `${event.label} ${whenPhrase(event.daysAway)} — ${move.label}`
      : `${event.label} ${whenPhrase(event.daysAway)}`,
  };
}

module.exports = {
  EVENT_KIND, EVENT_INFO,
  expectedMove, makeEvent, nextCatalyst, recentEvents, whenPhrase, describeCatalyst,
};
