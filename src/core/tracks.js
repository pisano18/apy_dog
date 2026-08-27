'use strict';

/**
 * Tracks, grades, setups and severity.
 *
 * The original app had one ranking axis: risk-adjusted yield. That works for a CD
 * and it is actively misleading for a stock. A share of NVDA has a 0.02% dividend
 * yield; ranking it by that number says something true and completely irrelevant,
 * because essentially all of its return comes from price movement that nobody can
 * put a decimal on.
 *
 * So there are two tracks and they answer different questions:
 *
 *   INCOME    "what will pay me, and how reliably?"   -> ranked by after-tax
 *             certainty equivalent, because that number is knowable.
 *
 *   MOVEMENT  "what is about to move, and how hard?"  -> ranked by how wound-up
 *             a thing is and how close its next dated catalyst is. Never given a
 *             fake expected return, because that would be inventing precision.
 *
 * Some things genuinely live in both (a REIT pays 5% and can fall 30%). Those are
 * tagged BOTH and appear in either view rather than being forced into one.
 */

const TRACK = {
  INCOME: 'income',
  MOVEMENT: 'movement',
  BOTH: 'both',
};

const TRACK_LABELS = {
  income: 'Income',
  movement: 'Movement',
  both: 'Income + Movement',
};

/**
 * Safety grade: the headline risk indicator, replacing an opaque 0-100 score.
 *
 * A number like "47.3" tells a person nothing. A grade with a sentence attached
 * tells them exactly what they are being warned about. The grade is explicitly a
 * SAFETY grade, never a quality or recommendation grade — an F here means "you
 * can lose all of this", not "bad investment". Some of the most rewarding things
 * in this app are Fs, and that is the point.
 */
const GRADE = [
  {
    key: 'A+',
    max: 6,
    label: 'A+',
    color: '#2f9e6e',
    headline: 'Principal is guaranteed',
    detail: 'Backed by the US government or federally insured. You get your money back short of a systemic failure.',
  },
  {
    key: 'A',
    max: 14,
    label: 'A',
    color: '#4fb07a',
    headline: 'Principal is protected',
    detail: 'Insured or government-backed, with some rate or timing risk around the edges.',
  },
  {
    key: 'B',
    max: 30,
    label: 'B',
    color: '#8cb84a',
    headline: 'Principal is likely safe',
    detail: 'Investment-grade credit or a diversified fund. You can lose money, but a total loss would be extraordinary.',
  },
  {
    key: 'C',
    max: 48,
    label: 'C',
    color: '#d2b13c',
    headline: 'Real chance of loss',
    detail: 'Market risk you will actually feel. Double-digit drawdowns are normal, not surprising.',
  },
  {
    key: 'D',
    max: 68,
    label: 'D',
    color: '#e08b3c',
    headline: 'Large losses are normal here',
    detail: 'Concentrated, leveraged or highly volatile. Losing half is a realistic outcome in a bad year.',
  },
  {
    key: 'E',
    max: 84,
    label: 'E',
    color: '#dc5f3c',
    headline: 'You can lose most of it',
    detail: 'Speculative. Size this as money you can watch go to a fraction of what you put in.',
  },
  {
    key: 'F',
    max: 101,
    label: 'F',
    color: '#c73434',
    headline: 'You can lose all of it',
    detail: 'Total loss is a live possibility, not a tail. Treat every dollar here as already spent.',
  },
];

function grade(riskScore) {
  const s = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, riskScore)) : 100;
  return GRADE.find((g) => s < g.max) || GRADE[GRADE.length - 1];
}

/**
 * The five axes shown beneath the grade.
 *
 * Each is 0-5 and each answers one plain question, because "risk" is not one
 * thing: a 30-year Treasury and a meme coin are both "risky" for opposite
 * reasons, and a single number hides which reason applies to you.
 */
const AXES = [
  { key: 'principal', label: 'Principal safe', question: 'Can I lose the money I put in?' },
  { key: 'payout', label: 'Payout reliable', question: 'Will the income actually arrive?' },
  { key: 'exit', label: 'Easy to exit', question: 'Can I get my money out when I want it?' },
  { key: 'steady', label: 'Steady', question: 'How bumpy is the ride?' },
  { key: 'known', label: 'Well understood', question: 'How confident are we in these numbers?' },
];

/**
 * Setups: a plain-language read of what a price is currently doing.
 * Deliberately qualitative. "Coiled" is a real, useful observation; "expected
 * return 11.3%" on the same chart is not.
 */
const SETUP = {
  COILED: 'coiled',
  EXPANDING: 'expanding',
  BREAKING_OUT: 'breaking_out',
  BREAKING_DOWN: 'breaking_down',
  DEEP_DRAWDOWN: 'deep_drawdown',
  GRINDING_UP: 'grinding_up',
  GRINDING_DOWN: 'grinding_down',
  RANGE_BOUND: 'range_bound',
  EVENT_PENDING: 'event_pending',
};

const SETUP_INFO = {
  coiled: {
    label: 'Coiled',
    color: '#c9a227',
    text: 'Trading much quieter than its own normal. Compressed ranges tend not to last; when they break they tend to break hard, and this says nothing about which way.',
  },
  expanding: {
    label: 'Expanding',
    color: '#e08b3c',
    text: 'Daily ranges are widening. Something has already started moving and the market has not settled on a price.',
  },
  breaking_out: {
    label: 'Breaking out',
    color: '#3ddc97',
    text: 'Pushing into the top of its recent range. Breakouts continue often enough to matter and fail often enough to hurt.',
  },
  breaking_down: {
    label: 'Breaking down',
    color: '#ff6b6b',
    text: 'Pressing the bottom of its recent range on real volume.',
  },
  deep_drawdown: {
    label: 'Deep drawdown',
    color: '#dc5f3c',
    text: 'Far below its highs. Cheap relative to the past is not the same as cheap, and things this far down are usually down for a reason.',
  },
  grinding_up: {
    label: 'Grinding up',
    color: '#5fb85f',
    text: 'A steady, low-drama uptrend. The least exciting and historically most durable pattern here.',
  },
  grinding_down: {
    label: 'Grinding down',
    color: '#d0705a',
    text: 'A steady bleed. Slow declines end less often than sharp ones.',
  },
  range_bound: {
    label: 'Range-bound',
    color: '#8f9aab',
    text: 'Going sideways within its usual band. Nothing is happening, which is itself information.',
  },
  event_pending: {
    label: 'Event pending',
    color: '#5aa9ff',
    text: 'A dated event is close enough to dominate the next move.',
  },
};

/**
 * Severity: how big a move is plausible before the horizon, as a band.
 * Bands rather than point estimates, because a point estimate on a price is a
 * lie told with decimals.
 */
const SEVERITY = [
  { key: 'quiet', max: 3, label: 'Quiet', color: '#8f9aab', text: 'Unlikely to move much' },
  { key: 'moderate', max: 8, label: 'Moderate', color: '#5fb85f', text: 'Normal-sized move' },
  { key: 'large', max: 15, label: 'Large', color: '#d2b13c', text: 'Big enough to matter' },
  { key: 'violent', max: 30, label: 'Violent', color: '#e08b3c', text: 'Could reprice sharply' },
  { key: 'extreme', max: 1e9, label: 'Extreme', color: '#c73434', text: 'Could move enormously in either direction' },
];

function severity(expectedMovePct) {
  const m = Number.isFinite(expectedMovePct) ? Math.abs(expectedMovePct) : 0;
  return SEVERITY.find((s) => m < s.max) || SEVERITY[SEVERITY.length - 1];
}

/**
 * Signal clarity: how well we can SEE the situation — not how confident we are
 * about which way it resolves.
 *
 * The distinction is the whole point. A confirmed earnings date on a stock with a
 * year of clean price history is a very clear picture, and tells you nothing
 * about direction. Calling that "high conviction" would invite exactly the
 * misreading this app exists to avoid, so the word is not used anywhere.
 */
const CLARITY = [
  { key: 'murky', max: 0.25, label: 'Murky', color: '#8f9aab', text: 'Thin data — treat this read as close to noise.' },
  { key: 'faint', max: 0.45, label: 'Faint', color: '#c9a227', text: 'Some signal, easily wrong.' },
  { key: 'clear', max: 0.65, label: 'Clear', color: '#5fb85f', text: 'The situation is legible. Direction still is not.' },
  { key: 'sharp', max: 1.01, label: 'Sharp', color: '#3ddc97', text: 'Dated catalyst and clean history. Says what is coming, not which way.' },
];

function clarity(score01) {
  const s = Number.isFinite(score01) ? Math.max(0, Math.min(1, score01)) : 0;
  return CLARITY.find((c) => s < c.max) || CLARITY[CLARITY.length - 1];
}

/**
 * Heat tiers.
 *
 * Heat is a 0-100 composite, and 33 versus 24 means nothing to someone seeing it
 * for the first time. Most things, most of the time, genuinely have nothing going
 * on — so the scale is correctly bottom-heavy, and the tier is what makes it
 * readable.
 */
const HEAT = [
  { key: 'quiet', max: 15, label: 'Quiet', color: '#8f9aab', text: 'Nothing much going on.' },
  { key: 'stirring', max: 30, label: 'Stirring', color: '#c9a227', text: 'Something mild is developing.' },
  { key: 'warm', max: 50, label: 'Warm', color: '#e08b3c', text: 'A real setup or a catalyst close enough to matter.' },
  { key: 'hot', max: 70, label: 'Hot', color: '#dc5f3c', text: 'Several things lining up at once.' },
  { key: 'urgent', max: 101, label: 'Urgent', color: '#c73434', text: 'A major dated event, imminent, on something already moving.' },
];

function heatTier(score) {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  return HEAT.find((h) => s < h.max) || HEAT[HEAT.length - 1];
}

/** Directional lean. NONE is the honest default and the most common answer. */
const LEAN = {
  UP: 'up',
  DOWN: 'down',
  NONE: 'none',
};

const LEAN_INFO = {
  up: { label: 'Leans up', arrow: '▲', color: '#3ddc97' },
  down: { label: 'Leans down', arrow: '▼', color: '#ff6b6b' },
  none: { label: 'No lean', arrow: '●', color: '#8f9aab' },
};

module.exports = {
  TRACK, TRACK_LABELS,
  GRADE, grade,
  AXES,
  SETUP, SETUP_INFO,
  SEVERITY, severity,
  CLARITY, clarity,
  HEAT, heatTier,
  LEAN, LEAN_INFO,
};
