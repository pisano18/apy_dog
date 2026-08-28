'use strict';

const { result, failure, readSeed } = require('./_contract');
const catalyst = require('../core/catalyst');
const { xmlTagValues } = require('../core/http');

/**
 * Upcoming Events — the calendar backbone of "what is about to happen".
 *
 * THIS ADAPTER IS SHAPED DIFFERENTLY FROM EVERY OTHER SOURCE. It satisfies the
 * same contract — `fetch` and `loadSeed` both return a SourceResult — but its
 * `opportunities` array is normally EMPTY. The payload is a second array on the
 * result:
 *
 *     res.events         the dated events (the real output)
 *     res.opportunities  []   (always, unless a future revision finds a reason)
 *
 * The aggregator collects `r.events` from every source and attaches them to the
 * rows they can move, which is what turns a static yield table into a forward
 * calendar. Nothing here produces a row of its own, because an FOMC meeting is
 * not something you can buy.
 *
 * Every event is built through core/catalyst.makeEvent(), which owns the
 * canonical shape, the EVENT_KIND vocabulary and — importantly — the guard that
 * stops an out-of-range upstream timestamp throwing RangeError out of
 * toISOString(). Nothing in this file constructs an event object by hand.
 *
 * WHERE THE DATES COME FROM, AND HOW MUCH TO TRUST THEM
 * ----------------------------------------------------
 * The five feeds have genuinely different reliability, and the `certainty` field
 * carries that difference through to the UI rather than flattening it:
 *
 *   opex / index rebalance   COMPUTED. The third Friday of September 2026 is the
 *                            18th, with certainty, forever. Zero network calls.
 *   treasury auctions        PUBLISHED, from TreasuryDirect's own JSON API.
 *   FOMC / CPI / jobs / PPI  PUBLISHED by the Fed and BLS years ahead. Fetched
 *                            opportunistically; the bundled schedule is the
 *                            fallback and says plainly that it was inferred.
 *   earnings                 PUBLISHED by Nasdaq. If Nasdaq is unreachable we
 *                            emit NOTHING live and fall back to the bundled
 *                            pattern-derived dates marked `estimated` — because
 *                            a wrong earnings date is worse than no date, and
 *                            an unlabelled guess is worse still.
 *
 * EFFICIENCY
 * ----------
 * A full refresh of the entire forward calendar costs at most ~14 HTTP calls and
 * usually far fewer: one for every Treasury auction, one for the Fed's RSS, one
 * for a year of BLS releases, zero for options expiry, and up to ten for the
 * earnings calendar — weekends skipped because no company reports on a Saturday,
 * and every day cached for twelve hours because next Tuesday's earnings list
 * does not change hourly.
 */

const ID = 'calendar';
const LABEL = 'Upcoming Events';

const TREASURY_UPCOMING_URL = 'https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json';
const FED_PRESS_RSS_URL = 'https://www.federalreserve.gov/feeds/press_all.xml';
const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const NASDAQ_EARNINGS_URL = 'https://api.nasdaq.com/api/calendar/earnings?date=';
const BLS_SCHEDULE_PAGE = 'https://www.bls.gov/schedule/news_release/';

/**
 * BLS moves its calendar exports around between years. Rather than pin one path
 * and silently lose the whole feed when it changes, try the known shapes in
 * order and use the first that yields events. Costs at most three cheap GETs a
 * day; the alternative costs the user a year of release dates.
 */
const BLS_ICS_CANDIDATES = (year) => [
  `${BLS_SCHEDULE_PAGE}${year}_sched.ics`,
  `${BLS_SCHEDULE_PAGE}bls${year}.ics`,
  'https://www.bls.gov/schedule/schedule.ics',
];

const EARNINGS_DAYS_AHEAD = 14;
const EARNINGS_TTL_MS = 12 * 60 * 60 * 1000;   // the calendar barely changes intraday
const BLS_TTL_MS = 24 * 60 * 60 * 1000;        // an annual schedule; daily is generous
const FED_TTL_MS = 60 * 60 * 1000;

/** How far either side of today the calendar is worth carrying. */
const HORIZON_FORWARD_DAYS = 400;
const LOOKBACK_DAYS = 21;                      // published releases stay "news" this long

const DAY_MS = 86400000;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Pure calendar arithmetic
// ---------------------------------------------------------------------------

/**
 * The nth given weekday of a month, as a UTC-midnight timestamp.
 * month is 1-12, weekday is 0 (Sunday) .. 6 (Saturday). Returns null when the
 * month has no such weekday — Date.UTC will happily accept "February 36th" and
 * hand back a date in March, which is exactly the kind of silent wrong answer a
 * calendar must never produce.
 */
function nthWeekday(year, month, weekday, n) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  const firstTs = Date.UTC(year, month - 1, 1);
  if (!Number.isFinite(firstTs)) return null;
  const firstDow = new Date(firstTs).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  const ts = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(ts) || Math.abs(ts) > 8.64e15) return null;
  if (new Date(ts).getUTCMonth() !== month - 1) return null;   // rolled into next month
  return ts;
}

/**
 * The third Friday of a month, at UTC midnight.
 *
 * This one date carries three separate things: monthly options expiry, quarterly
 * triple witching in March, June, September and December, and the effective date
 * of the S&P index rebalances in those same months. It is pure arithmetic, so it
 * is computed rather than fetched — there is no upstream to be wrong about it.
 *
 * @returns {Date|null}
 */
function thirdFriday(year, month) {
  const ts = nthWeekday(year, month, 5, 3);
  return ts === null ? null : new Date(ts);
}

/**
 * US Eastern daylight time: second Sunday in March to first Sunday in November,
 * switching at 2am local. Every release time in this file is quoted in Eastern
 * because that is how the Fed, BLS and the exchanges quote them, and getting the
 * offset wrong puts a CPI print on the wrong side of a market open.
 */
function isEasternDst(ts) {
  if (!Number.isFinite(ts)) return false;
  const year = new Date(ts).getUTCFullYear();
  const marchSunday = nthWeekday(year, 3, 0, 2);
  const novemberSunday = nthWeekday(year, 11, 0, 1);
  if (marchSunday === null || novemberSunday === null) return false;
  return ts >= marchSunday + 7 * 3600000 && ts < novemberSunday + 6 * 3600000;
}

/** A wall-clock Eastern time as an epoch millisecond value, or null. */
function etTimestamp(year, month, day, hour = 0, minute = 0) {
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const guess = Date.UTC(year, month - 1, day, hour + 4, minute);
  if (!Number.isFinite(guess)) return null;
  const offset = isEasternDst(guess) ? 4 : 5;
  const ts = Date.UTC(year, month - 1, day, hour + offset, minute);
  if (!Number.isFinite(ts) || Math.abs(ts) > 8.64e15) return null;
  return ts;
}

const isoDay = (ts) => (Number.isFinite(ts) && Math.abs(ts) <= 8.64e15
  ? new Date(ts).toISOString().slice(0, 10)
  : null);

/**
 * Identity for de-duplication, keyed per kind because the right notion of
 * "the same event" differs. Two Treasury auctions genuinely happen on the same
 * Monday (13-week and 26-week bills), so the day alone would collapse them;
 * an FOMC decision that arrives from both the bundled schedule and the Fed's
 * own RSS is one event with two titles, so the title cannot be part of the key.
 */
function eventKey(e) {
  if (!e) return 'null';
  const day = isoDay(e.dateMs) || 'nodate';
  if (e.kind === catalyst.EVENT_KIND.EARNINGS) return `earnings|${String(e.symbol || '').toUpperCase()}|${day}`;
  if (e.kind === catalyst.EVENT_KIND.TREASURY_AUCTION) return `auction|${day}|${e.title || ''}`;
  return `${e.kind}|${day}|${String(e.symbol || '').toUpperCase()}`;
}

/**
 * Merge event lists in ascending order of trust: later lists win a collision, so
 * a published date always displaces the bundled estimate it replaces.
 */
function mergeEvents(lists, opts) {
  const { now = Date.now(), forwardDays = HORIZON_FORWARD_DAYS, lookbackDays = LOOKBACK_DAYS } = opts || {};
  const byKey = new Map();
  for (const list of (Array.isArray(lists) ? lists : [])) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || !Number.isFinite(e.dateMs)) continue;
      const days = (e.dateMs - now) / DAY_MS;
      if (days > forwardDays || days < -lookbackDays) continue;
      byKey.set(eventKey(e), e);
    }
  }
  return [...byKey.values()].sort((a, b) => a.dateMs - b.dateMs);
}

// ---------------------------------------------------------------------------
// 1. Treasury auctions — TreasuryDirect TA_WS
// ---------------------------------------------------------------------------

const AUCTION_HOW = 'Bid noncompetitively through TreasuryDirect or through a broker; a noncompetitive bid always fills '
  + 'at the rate the auction sets, so you take the price the market makes rather than naming one.';

function moneyShort(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * PURE PARSER for https://www.treasurydirect.gov/TA_WS/securities/upcoming
 *
 * Upstream is an array of announced securities. Every field arrives as a string,
 * including the amounts, and several are routinely empty — an auction announced
 * before its size is set has no offeringAmount, which is missing information and
 * not a reason to drop the date.
 */
function parseTreasuryUpcoming(payload, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) return { events: [], skipped: 0, seen: 0, unusable: true };

  const events = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      if (!r || typeof r !== 'object') { skipped += 1; continue; }
      const term = str(r.securityTerm);
      const type = str(r.securityType);
      const auctionDate = str(r.auctionDate);
      if (!auctionDate || (!term && !type)) { skipped += 1; continue; }

      // TreasuryDirect quotes a naive local timestamp ("2026-09-08T00:00:00").
      // The auction itself closes at 1:00pm ET, which is the moment that matters
      // to anyone deciding whether they still have time to place a bid.
      const day = auctionDate.slice(0, 10);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
      const ts = m
        ? etTimestamp(Number(m[1]), Number(m[2]), Number(m[3]), 13, 0)
        : Date.parse(auctionDate);
      if (!Number.isFinite(ts)) { skipped += 1; continue; }

      const label = [term, type].filter(Boolean).join(' ');
      const size = moneyShort(r.offeringAmount);
      const issue = str(r.issueDate)?.slice(0, 10);
      const maturity = str(r.maturityDate)?.slice(0, 10);
      const cusip = str(r.cusip);

      const detail = [
        size ? `${size} on offer.` : 'Size not yet announced.',
        issue ? `Settles ${issue}.` : null,
        maturity ? `Matures ${maturity}.` : null,
        AUCTION_HOW,
      ].filter(Boolean).join(' ');

      const e = catalyst.makeEvent({
        kind: catalyst.EVENT_KIND.TREASURY_AUCTION,
        date: ts,
        title: `${label} auction`,
        text: detail,
        certainty: 'confirmed',
        source: 'TreasuryDirect',
        url: 'https://www.treasurydirect.gov/auctions/upcoming/',
        magnitude: num(r.offeringAmount),
        // Deliberately no `symbol`. A CUSIP is not a ticker, and putting one in
        // the field the symbol-matching pass reads would hang a rate-wide event
        // off whatever row happened to collide with it. Auctions reach rows
        // through the `rates` scope instead.
      }, now);
      // makeEvent rejects an unusable date rather than throwing; that is a skip.
      if (!e) { skipped += 1; continue; }
      events.push(cusip ? { ...e, cusip } : e);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, seen: rows.length, unusable: false };
}

// ---------------------------------------------------------------------------
// 2. FOMC — the Fed's press RSS for what already happened
// ---------------------------------------------------------------------------

/**
 * The forward FOMC schedule is published years ahead on fomccalendars.htm, which
 * is a hand-built HTML table that has changed layout more than once; scraping it
 * for dates the Fed already told us about years ago buys nothing and breaks
 * often. So the forward meetings ship in seed and this parser handles only the
 * backward half: the statements and minutes that have actually been released,
 * which is the "news" side of the calendar and is genuinely only knowable live.
 */
const FED_RELEVANT = [
  { re: /FOMC statement/i, title: 'Fed decision published' },
  { re: /minutes of the federal open market committee/i, title: 'FOMC minutes released' },
  { re: /summary of economic projections/i, title: 'Fed projections released' },
];

function firstTag(xml, tag) {
  const vals = xmlTagValues(xml, tag);
  return vals.length ? vals[0] : null;
}

const unwrapCdata = (s) => (typeof s === 'string'
  ? s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/&amp;/g, '&').trim()
  : null);

/** PURE PARSER for the Federal Reserve press-release RSS/Atom feed. */
function parseFedPressRss(xml, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  if (typeof xml !== 'string' || !xml.trim()) return { events: [], skipped: 0, seen: 0, unusable: true };

  let items = xmlTagValues(xml, 'item');
  if (!items.length) items = xmlTagValues(xml, 'entry');   // Atom
  if (!items.length) return { events: [], skipped: 0, seen: 0, unusable: true };

  const events = [];
  let skipped = 0;
  for (const item of items) {
    try {
      const title = unwrapCdata(firstTag(item, 'title'));
      if (!title) { skipped += 1; continue; }
      const match = FED_RELEVANT.find((m) => m.re.test(title));
      if (!match) { skipped += 1; continue; }             // speeches, enforcement, personnel

      const when = unwrapCdata(firstTag(item, 'pubDate'))
        || unwrapCdata(firstTag(item, 'published'))
        || unwrapCdata(firstTag(item, 'updated'));
      const ts = when ? Date.parse(when) : NaN;
      if (!Number.isFinite(ts)) { skipped += 1; continue; }

      const link = unwrapCdata(firstTag(item, 'link')) || FOMC_CALENDAR_URL;
      const e = catalyst.makeEvent({
        kind: catalyst.EVENT_KIND.FOMC,
        date: ts,
        title: match.title,
        text: `${title}. Already published — the reaction is in the price, but the wording sets expectations for the next meeting.`,
        certainty: 'confirmed',
        source: 'federalreserve.gov',
        url: /^https?:/i.test(link) ? link : FOMC_CALENDAR_URL,
      }, now);
      if (!e) { skipped += 1; continue; }
      events.push(e);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, seen: items.length, unusable: false };
}

// ---------------------------------------------------------------------------
// 3. BLS releases — CPI, the jobs report, PPI
// ---------------------------------------------------------------------------

/**
 * Only the three releases that actually move the rate curve are carried. BLS
 * publishes dozens — county wages, union membership, work stoppages — and none
 * of them have ever repriced a bond. Filtering here rather than in the UI keeps
 * the calendar something a person can read.
 */
const BLS_KINDS = [
  { re: /consumer price index/i, kind: catalyst.EVENT_KIND.CPI, hour: 8, minute: 30 },
  { re: /employment situation/i, kind: catalyst.EVENT_KIND.JOBS, hour: 8, minute: 30 },
  { re: /producer price index/i, kind: catalyst.EVENT_KIND.PPI, hour: 8, minute: 30 },
];

/** RFC 5545 line unfolding: a continuation line starts with a space or tab. */
function unfoldIcs(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

/**
 * One ICS DTSTART value to epoch ms.
 * Handles `VALUE=DATE:20260812`, floating `20260812T083000`, and UTC
 * `20260812T123000Z`. A date with no time is assumed to be a release at the
 * given Eastern hour, which is how BLS actually publishes.
 */
function parseIcsDate(value, opts) {
  const { hour = 0, minute = 0 } = opts || {};
  const v = str(value);
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, , z] = m;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  if (!(year >= 1970 && year <= 2200) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hh === undefined) return etTimestamp(year, month, day, hour, minute);
  const H = Number(hh); const M = Number(mm);
  if (H > 23 || M > 59) return null;
  if (z) {
    const ts = Date.UTC(year, month - 1, day, H, M);
    return Number.isFinite(ts) && Math.abs(ts) <= 8.64e15 ? ts : null;
  }
  // BLS quotes everything in Eastern; a floating time is Eastern, not UTC.
  return etTimestamp(year, month, day, H, M);
}

/** PURE PARSER for a BLS release-schedule .ics file. */
function parseBlsIcs(text, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  if (typeof text !== 'string' || !/BEGIN:VEVENT/i.test(text)) {
    return { events: [], skipped: 0, seen: 0, unusable: true };
  }
  const body = unfoldIcs(text);
  const blocks = body.split(/BEGIN:VEVENT/i).slice(1).map((b) => b.split(/END:VEVENT/i)[0]);

  const events = [];
  let skipped = 0;
  for (const block of blocks) {
    try {
      const summary = str(/^SUMMARY(?:;[^:\n]*)?:(.*)$/im.exec(block)?.[1]);
      const dtstartLine = /^DTSTART(;[^:\n]*)?:(.*)$/im.exec(block);
      if (!summary || !dtstartLine) { skipped += 1; continue; }

      const match = BLS_KINDS.find((k) => k.re.test(summary));
      if (!match) { skipped += 1; continue; }

      const ts = parseIcsDate(dtstartLine[2], { hour: match.hour, minute: match.minute });
      if (!Number.isFinite(ts)) { skipped += 1; continue; }

      const e = catalyst.makeEvent({
        kind: match.kind,
        date: ts,
        title: summary.replace(/\s+/g, ' ').trim(),
        certainty: 'confirmed',
        source: 'bls.gov',
        url: 'https://www.bls.gov/schedule/news_release/',
      }, now);
      if (!e) { skipped += 1; continue; }
      events.push(e);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, seen: blocks.length, unusable: false };
}

// ---------------------------------------------------------------------------
// 4. Earnings — Nasdaq's published calendar
// ---------------------------------------------------------------------------

/**
 * Nasdaq's `time` field is a slug, and the distinction is worth carrying: a
 * before-the-open report and an after-the-close report on the same calendar day
 * are a full trading session apart, which is the difference between holding
 * through the print and not.
 */
const EARNINGS_TIME = {
  'time-pre-market': { hour: 7, minute: 0, phrase: 'before the open' },
  'time-after-hours': { hour: 16, minute: 15, phrase: 'after the close' },
  'time-not-supplied': { hour: 12, minute: 0, phrase: 'time of day not published' },
};

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * PURE PARSER for one day of https://api.nasdaq.com/api/calendar/earnings.
 *
 * `dateStr` is the YYYY-MM-DD that was requested, because the payload itself
 * does not reliably repeat it. On a day with no earnings Nasdaq answers with
 * `data: null` and a message rather than an empty array, which is a normal
 * weekend, not a fault.
 */
function parseNasdaqEarnings(payload, dateStr, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return { events: [], skipped: 0, seen: 0, unusable: true };

  const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows
    : Array.isArray(payload?.rows) ? payload.rows
      : Array.isArray(payload?.data) ? payload.data
        : null;
  if (!rows) return { events: [], skipped: 0, seen: 0, unusable: payload?.data !== null };

  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  const events = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      if (!r || typeof r !== 'object') { skipped += 1; continue; }
      const symbol = str(r.symbol)?.toUpperCase();
      if (!symbol || !TICKER_RE.test(symbol)) { skipped += 1; continue; }

      const slot = EARNINGS_TIME[str(r.time)] || EARNINGS_TIME['time-not-supplied'];
      const ts = etTimestamp(year, month, day, slot.hour, slot.minute);
      if (!Number.isFinite(ts)) { skipped += 1; continue; }

      const company = str(r.name) || symbol;
      const forecast = str(r.epsForecast);
      const ests = num(r.noOfEsts);
      const detail = [
        `${company} reports ${slot.phrase}.`,
        forecast ? `Analysts expect ${forecast} a share${ests ? ` (${ests} estimates)` : ''}.` : null,
        'The number matters less than the guidance that comes with it, and neither is predictable from here.',
      ].filter(Boolean).join(' ');

      const e = catalyst.makeEvent({
        kind: catalyst.EVENT_KIND.EARNINGS,
        date: ts,
        symbol,
        title: `${symbol} earnings`,
        text: detail,
        // Nasdaq publishes the calendar the companies have announced. It is a
        // published date, not an inference — which is exactly why we emit
        // nothing at all when Nasdaq is down instead of pattern-matching one.
        certainty: 'confirmed',
        source: 'Nasdaq',
        url: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`,
        magnitude: num(r.marketCap),
      }, now);
      if (!e) { skipped += 1; continue; }
      events.push(e);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, seen: rows.length, unusable: false };
}

// ---------------------------------------------------------------------------
// 5. Options expiry and index rebalance — computed, never fetched
// ---------------------------------------------------------------------------

const QUARTERLY_MONTHS = new Set([3, 6, 9, 12]);

/**
 * Every monthly expiry and every quarterly rebalance in the window, derived from
 * the calendar alone.
 *
 * The index rebalance events deliberately carry no symbol. A rebalance moves the
 * names being added and deleted, and those are not public until S&P announces
 * them; hanging the event on SPY instead would attach a violent event to the one
 * thing it barely touches. With no symbol it shows on the calendar, where it is
 * useful, and attaches to nothing, which is honest.
 */
function calendricalEvents(opts) {
  const { now = Date.now(), months = 13 } = opts || {};
  if (!Number.isFinite(now)) return [];
  const events = [];
  const start = new Date(now);
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth() + 1;

  for (let i = 0; i < Math.max(1, Math.min(36, months)); i += 1) {
    const month = ((m0 - 1 + i) % 12) + 1;
    const year = y0 + Math.floor((m0 - 1 + i) / 12);
    const friday = thirdFriday(year, month);
    if (!friday) continue;

    const quarterly = QUARTERLY_MONTHS.has(month);
    // Options stop trading at the close; index-option settlement is struck at
    // the open, so the whole session is the event.
    const closeTs = etTimestamp(year, month, friday.getUTCDate(), 16, 0);
    if (!Number.isFinite(closeTs)) continue;

    const opex = catalyst.makeEvent({
      kind: catalyst.EVENT_KIND.OPEX,
      date: closeTs,
      title: quarterly ? 'Triple witching' : 'Monthly options expiry',
      text: quarterly
        ? 'Stock options, index options and index futures all expire together. The largest expiry of the quarter: '
          + 'prices tend to be pinned to big strikes into it and to move more freely once it clears.'
        : 'Monthly options expiry. Open interest rolls off and the pinning effect around large strikes releases.',
      certainty: 'confirmed',
      source: 'calendar',
      url: 'https://www.cboe.com/us/options/market_statistics/',
    }, now);
    if (opex) events.push(opex);

    if (quarterly) {
      const rebal = catalyst.makeEvent({
        kind: catalyst.EVENT_KIND.INDEX_REBALANCE,
        date: closeTs,
        title: 'Quarterly index rebalance',
        text: 'S&P index changes take effect at this close, so index funds must trade the adds and deletes whatever '
          + 'the price. Which names are affected is announced roughly a week ahead and is not in this app yet.',
        certainty: 'confirmed',
        source: 'calendar',
        url: 'https://www.spglobal.com/spdji/en/governance/index-announcements/',
      }, now);
      if (rebal) events.push(rebal);
    }
  }
  return events;
}

/**
 * Dates after which a specific action is no longer available to you.
 *
 * These are the deadlines an investment app never lists and a person actually
 * misses — not because they are hard to find, but because nothing puts them
 * next to the thing they gate. The app already carries rows for tax-loss
 * harvesting, IRA contributions, FSA elections and Roth conversions; every one
 * of them has a date after which it is simply gone for that year.
 *
 * All of them are fixed by statute or by convention, so they are computed from
 * the calendar rather than fetched. Where a statutory date falls on a weekend
 * the IRS shifts it to the next business day, which is done here too — being a
 * day wrong about a filing deadline is the one kind of wrong that matters.
 */
const MONEY_DEADLINES = [
  {
    month: 1, day: 15, title: 'Q4 estimated tax payment due',
    text: 'The final estimated payment for the year just ended. Missing it is an underpayment penalty even if '
      + 'you pay the full balance in April — the penalty is for paying late, not for paying short.',
    url: 'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes',
  },
  {
    month: 4, day: 15, title: 'Tax filing deadline — and the last day for last year\'s IRA and HSA',
    text: 'Also the final day to make a prior-year IRA or HSA contribution, which is a whole extra year of '
      + 'tax-advantaged room that disappears at midnight. Q1 estimated payment is due the same day.',
    url: 'https://www.irs.gov/filing/individuals/when-to-file',
  },
  {
    month: 6, day: 15, title: 'Q2 estimated tax payment due',
    text: 'Covers April and May income. Anyone with dividends, interest or realised gains outside a paycheck '
      + 'is expected to pay as they go, and the penalty for not doing so accrues quietly from this date.',
    url: 'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes',
  },
  {
    month: 9, day: 15, title: 'Q3 estimated tax payment due',
    text: 'Covers June through August. The last estimated payment before the year is effectively set, so it is '
      + 'the natural moment to check whether withholding has kept up with a good year in the market.',
    url: 'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes',
  },
  {
    month: 10, day: 15, title: 'Extended filing deadline',
    text: 'The last day for anyone who filed an extension in April. An extension moved the filing date and never '
      + 'moved the payment date, so any balance has been accruing interest since the spring.',
    url: 'https://www.irs.gov/filing/individuals/when-to-file',
  },
  {
    month: 12, day: 31, title: 'Last day to harvest losses, convert to Roth, or take an RMD',
    text: 'The single biggest deadline in the year for anything done inside a taxable account. Tax-loss harvesting, '
      + 'Roth conversions, charitable giving and required minimum distributions all have to settle by the close, '
      + 'and brokerages stop processing well before it. Not shiftable — 31 December is 31 December.',
    url: 'https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs',
    noShift: true,
  },
  {
    month: 12, day: 31, title: 'FSA money is forfeited tonight',
    text: 'Health FSA balances beyond any carryover your plan allows simply vanish. Some plans grant a grace '
      + 'period into March; most do not.',
    url: 'https://www.healthcare.gov/have-job-based-coverage/flexible-spending-accounts/',
    noShift: true,
  },
  {
    month: 12, day: 15, title: 'Last practical day to change this year\'s 401(k) deferral',
    text: 'Payroll needs lead time, so the final paycheck of the year is usually the last chance to top up to the '
      + 'annual limit or to capture the rest of an employer match. The exact cut-off is your payroll provider\'s, '
      + 'not the IRS\'s.',
    url: 'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits',
  },
];

/** IRS convention: a deadline landing on a weekend moves to the next weekday. */
function shiftForWeekend(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function moneyDeadlineEvents(opts) {
  const { now = Date.now(), months = 15 } = opts || {};
  if (!Number.isFinite(now)) return [];
  const events = [];
  const start = new Date(now);
  const y0 = start.getUTCFullYear();

  for (const year of [y0, y0 + 1, y0 + 2]) {
    for (const d of MONEY_DEADLINES) {
      const when = d.noShift
        ? new Date(Date.UTC(year, d.month - 1, d.day))
        : shiftForWeekend(year, d.month, d.day);
      // Midday UTC, and neither 23:59 nor an Eastern time.
      //
      // These are all-day deadlines: what matters is that the DATE survives
      // being formatted in the reader's own timezone, and 23:59 Eastern is
      // already 1 January in London — so "31 December" reached the screen as
      // 1 January, which is the single worst thing a deadline can do. Midday
      // Eastern fixed Europe and still broke at UTC+8. Midday UTC is the only
      // choice that renders as the right calendar date from UTC-11 through
      // UTC+11, which covers everywhere anyone actually is. The text carries
      // the end-of-day meaning; the timestamp only has to survive formatting.
      const ts = Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate(), 12, 0);
      if (!Number.isFinite(ts)) continue;
      const daysOut = (ts - now) / 86400000;
      if (daysOut < -3 || daysOut > months * 31) continue;
      const e = catalyst.makeEvent({
        kind: catalyst.EVENT_KIND.MONEY_DEADLINE,
        date: ts,
        title: d.title,
        text: d.text,
        certainty: 'confirmed',
        source: 'calendar',
        url: d.url,
      }, now);
      if (e) events.push(e);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** Bundled raw descriptors -> canonical events. Never throws. */
function parseSeedEvents(items, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  const events = [];
  let skipped = 0;
  if (!Array.isArray(items)) return { events, skipped: 0, seen: 0 };
  for (const raw of items) {
    try {
      const e = catalyst.makeEvent(raw, now);
      if (!e) { skipped += 1; continue; }
      events.push(e);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped, seen: items.length };
}

// ---------------------------------------------------------------------------
// Attaching events to rows
// ---------------------------------------------------------------------------

/**
 * Asset classes whose price or rate moves when the curve moves. A rate decision
 * is not news for a stablecoin farm; it is the whole story for a 10-year note.
 */
const RATE_SENSITIVE_CLASSES = new Set([
  'govt_bond', 'muni_bond', 'corp_bond', 'cash', 'cd', 'rwa', 'preferred',
]);

/**
 * Broad funds also belong on the rates list. A whole-market or core-bond fund is
 * repriced by a CPI print in a way that a single sector or commodity fund is
 * not, and a target-date fund is mostly a bond fund by the time anyone is close
 * to the target year.
 */
const BROAD_FUND_SUBTYPES = new Set([
  'core_index', 'target_date', 'bond_core', 'dividend_growth', 'factor', 'international',
  'index_proxy', 'bond_etf', 'dividend_etf', 'ultrashort',
]);

function isBroadFund(o) {
  return !!(o && o.subType && BROAD_FUND_SUBTYPES.has(o.subType));
}

/**
 * PURE. Map events onto the rows they can move and return the rows with their
 * `events` array filled in. Input objects are never mutated — an adapter's rows
 * belong to that adapter, and attaching in place would double up if this ever
 * ran twice over the same set.
 *
 * Three routes, from the event's own scope:
 *   symbol   an earnings date lands on that ticker and nowhere else
 *   rates    a Fed decision or CPI print lands on everything rate-sensitive,
 *            plus broad funds
 *   market   an options expiry lands on everything that trades, which is every
 *            row not purely on the income track
 */
function attachEvents(opportunities, events, opts) {
  if (!Array.isArray(opportunities)) return [];
  const now = (opts || {}).now;
  const clock = Number.isFinite(now) ? now : Date.now();

  const usable = (Array.isArray(events) ? events : []).filter((e) => (
    e && typeof e === 'object' && Number.isFinite(e.dateMs)
    // A release from two months ago is not news any more; leaving it attached
    // makes a stale calendar look like a live one.
    && (e.dateMs - clock) / DAY_MS >= -LOOKBACK_DAYS
  ));

  const bySymbol = new Map();
  const rateEvents = [];
  const marketEvents = [];
  for (const e of usable) {
    if (e.scope === 'symbol') {
      const k = e.symbol ? String(e.symbol).toUpperCase() : null;
      if (!k) continue;                        // calendar-only, attaches to nothing
      if (!bySymbol.has(k)) bySymbol.set(k, []);
      bySymbol.get(k).push(e);
    } else if (e.scope === 'rates') rateEvents.push(e);
    else if (e.scope === 'market') marketEvents.push(e);
  }

  return opportunities.map((o) => {
    if (!o || typeof o !== 'object') return o;
    const own = [];
    if (o.symbol) own.push(...(bySymbol.get(String(o.symbol).toUpperCase()) || []));
    if (RATE_SENSITIVE_CLASSES.has(o.assetClass) || isBroadFund(o)) own.push(...rateEvents);
    if (o.track !== 'income') own.push(...marketEvents);
    if (Array.isArray(o.events)) own.push(...o.events.filter(Boolean));

    const seen = new Set();
    const merged = own
      .filter((e) => {
        const k = eventKey(e);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));

    return { ...o, events: merged };
  });
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

/** The next N calendar days as YYYY-MM-DD, weekends dropped. */
function earningsDates(now, days = EARNINGS_DAYS_AHEAD) {
  const out = [];
  if (!Number.isFinite(now)) return out;
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now + i * DAY_MS);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;      // nobody reports on a weekend
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return out;
}

async function cached(ctx, key, ttlMs, producer) {
  if (!ctx.cache?.wrap) return producer();
  const hit = await ctx.cache.wrap(key, ttlMs, producer);
  return hit?.value;
}

async function fetchTreasury(ctx, notes, warnings) {
  try {
    const payload = await ctx.http.getJSON(TREASURY_UPCOMING_URL, { signal: ctx.signal, timeout: 20000 });
    const parsed = parseTreasuryUpcoming(payload, { now: ctx.now });
    if (parsed.unusable) {
      warnings.push('TreasuryDirect returned something that was not a list of securities.');
      return [];
    }
    notes.push(`${parsed.events.length} announced Treasury auctions from TreasuryDirect`
      + `${parsed.skipped ? `, ${parsed.skipped} records unparseable` : ''} (1 request).`);
    return parsed.events;
  } catch (err) {
    warnings.push(`Treasury auction schedule unavailable (${err?.message || err}).`);
    return [];
  }
}

async function fetchFed(ctx, notes, warnings) {
  try {
    const xml = await cached(ctx, 'calendar:fed:press', FED_TTL_MS, () => ctx.http.getText(FED_PRESS_RSS_URL, {
      signal: ctx.signal, timeout: 20000,
    }));
    const parsed = parseFedPressRss(xml, { now: ctx.now });
    if (parsed.unusable) {
      warnings.push('The Federal Reserve press feed did not parse as RSS or Atom.');
      return [];
    }
    notes.push(`${parsed.events.length} Fed releases (statements, minutes, projections) from the press feed; `
      + `${parsed.skipped} unrelated releases ignored.`);
    return parsed.events;
  } catch (err) {
    warnings.push(`Federal Reserve press feed unavailable (${err?.message || err}).`);
    return [];
  }
}

async function fetchBls(ctx, notes, warnings) {
  const year = new Date(ctx.now || Date.now()).getUTCFullYear();
  try {
    const found = await cached(ctx, `calendar:bls:ics:${year}`, BLS_TTL_MS, async () => {
      for (const url of BLS_ICS_CANDIDATES(year)) {
        try {
          const text = await ctx.http.getText(url, { signal: ctx.signal, timeout: 20000, retries: 0 });
          if (parseBlsIcs(text, { now: ctx.now }).events.length) return { url, text };
        } catch { /* try the next shape */ }
      }
      return { url: null, text: null };
    });

    if (!found?.text) {
      notes.push('BLS release calendar not reachable in any published .ics shape — CPI, jobs and PPI dates come from '
        + 'the bundled schedule this run and are marked estimated.');
      return [];
    }
    const parsed = parseBlsIcs(found.text, { now: ctx.now });
    notes.push(`${parsed.events.length} BLS release dates (CPI, jobs, PPI) from ${found.url}; `
      + `${parsed.skipped} other BLS releases ignored.`);
    return parsed.events;
  } catch (err) {
    warnings.push(`BLS release calendar unavailable (${err?.message || err}).`);
    return [];
  }
}

async function fetchEarnings(ctx, notes, warnings) {
  const dates = earningsDates(ctx.now || Date.now(), EARNINGS_DAYS_AHEAD);
  const events = [];
  let failures = 0;
  let requests = 0;

  const results = await Promise.all(dates.map(async (d) => {
    try {
      let missed = false;
      const payload = await cached(ctx, `calendar:nasdaq:earnings:${d}`, EARNINGS_TTL_MS, async () => {
        missed = true;
        return ctx.http.getJSON(`${NASDAQ_EARNINGS_URL}${d}`, {
          signal: ctx.signal,
          timeout: 20000,
          retries: 1,
          // Nasdaq's API 403s anything that does not look like a browser.
          headers: { Accept: 'application/json, text/plain, */*', Referer: 'https://www.nasdaq.com/market-activity/earnings' },
        });
      });
      if (missed) requests += 1;
      return parseNasdaqEarnings(payload, d, { now: ctx.now }).events;
    } catch {
      failures += 1;
      return [];
    }
  }));
  for (const list of results) events.push(...list);

  if (failures === dates.length && dates.length) {
    // A wrong earnings date is worse than no earnings date, so there is no
    // guessing fallback here: the bundled pattern-derived dates take over and
    // they are labelled estimated where they land.
    warnings.push('Nasdaq earnings calendar unreachable — no live earnings dates this run.');
  } else {
    notes.push(`${events.length} earnings dates across the next ${EARNINGS_DAYS_AHEAD} days `
      + `(${dates.length} trading days, ${requests} requests after cache${failures ? `, ${failures} days failed` : ''}).`);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const SEED_FILE = 'calendar.json';

function seedEvents(ctx) {
  const { items, meta } = readSeed(ctx.seedDir, SEED_FILE);
  const parsed = parseSeedEvents(items, { now: ctx.now });
  return { ...parsed, meta };
}

const adapter = {
  id: ID,
  label: LABEL,
  description: 'Dated events — Fed decisions, CPI and jobs prints, Treasury auctions, earnings, options expiry — '
    + 'attached to the rows each one can move. Produces events rather than opportunities.',
  homepage: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  // Not classes this source sells; classes its events land on. The Sources panel
  // reads this to say what the feed touches.
  assetClasses: [
    'govt_bond', 'muni_bond', 'corp_bond', 'cash', 'cd', 'rwa', 'preferred',
    'etf', 'dividend_equity', 'reit', 'bdc', 'cef', 'speculative',
  ],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 6 * 60 * 60 * 1000,

  // Pure surface, exported for tests and for anything else that needs to reason
  // about the calendar without touching the network.
  thirdFriday,
  nthWeekday,
  etTimestamp,
  isEasternDst,
  calendricalEvents,
  parseTreasuryUpcoming,
  parseFedPressRss,
  parseBlsIcs,
  parseIcsDate,
  parseNasdaqEarnings,
  parseSeedEvents,
  mergeEvents,
  eventKey,
  attachEvents,
  RATE_SENSITIVE_CLASSES,
  BROAD_FUND_SUBTYPES,

  async fetch(ctx) {
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const notes = [];
    const warnings = [];

    // The bundled forward schedule is the floor, not the fallback: the Fed and
    // BLS publish these dates years ahead, no live feed hands them over cleanly,
    // and anything the live pass does confirm simply overwrites its estimate.
    let seeded = { events: [], skipped: 0, meta: {} };
    try {
      seeded = seedEvents({ ...ctx, now });
    } catch (err) {
      warnings.push(`Bundled calendar unreadable (${err?.message || err}).`);
    }

    ctx.log?.('building the forward calendar');
    // Both halves, on both paths. The statutory deadlines — the filing date,
    // the four estimated-tax dates, the 401(k) deferral cut-off, the FSA
    // forfeiture date — were added to loadSeed alone, and the bundled calendar
    // file carries none of them. The app shows bundled data for about a second
    // on launch and then refreshes live, and the live fetch always returns
    // events, so the seed path never runs again: every money deadline in the
    // app appeared for one second and then silently vanished for the rest of
    // the session. They are computed from the calendar and need no request, so
    // there was never a reason for the two paths to differ.
    const computed = [...calendricalEvents({ now }), ...moneyDeadlineEvents({ now })];

    const [auctions, fed, bls, earnings] = await Promise.all([
      fetchTreasury(ctx, notes, warnings),
      fetchFed(ctx, notes, warnings),
      fetchBls(ctx, notes, warnings),
      fetchEarnings(ctx, notes, warnings),
    ]);

    // Ascending trust: bundled estimates first, then everything published.
    const events = mergeEvents([seeded.events, computed, bls, fed, auctions, earnings], { now });

    const estimated = events.filter((e) => e.certainty === 'estimated').length;
    const upcoming = events.filter((e) => !e.past).length;
    notes.unshift(`${events.length} events on the calendar, ${upcoming} still ahead. `
      + `${events.length - estimated} carry a published date; ${estimated} are inferred from a schedule pattern and `
      + 'are labelled estimated.');
    notes.push(`${computed.length} expiry and rebalance dates computed from the calendar with no request at all.`);
    if (seeded.skipped) notes.push(`${seeded.skipped} bundled calendar entries were unreadable and were skipped.`);
    notes.push('This source contributes dated events, not buyable rows, which is why it lists no opportunities.');

    const res = result({
      opportunities: [],
      status: warnings.length ? 'partial' : 'ok',
      notes,
      warnings,
      fetchedAt: new Date(now).toISOString(),
    });
    res.events = events;
    return res;
  },

  loadSeed(ctx) {
    try {
      const now = Number.isFinite(ctx?.now) ? ctx.now : Date.now();
      const { events: bundled, skipped, meta } = seedEvents({ ...ctx, now });
      const computed = [...calendricalEvents({ now }), ...moneyDeadlineEvents({ now })];
      const events = mergeEvents([bundled, computed], { now });

      if (!events.length) {
        const res = result({
          status: 'failed',
          warnings: [`seed file data/seed/${SEED_FILE} is missing, unreadable or entirely out of date`],
        });
        res.events = [];
        return res;
      }

      const asOf = meta.dataAsOf || '2026-08-01';
      const estimated = events.filter((e) => e.certainty === 'estimated').length;
      // The expiry dates are computed and would survive on their own, which is
      // exactly why a missing seed file has to be said out loud rather than
      // quietly presented as a bundled calendar.
      const warnings = bundled.length ? [] : [
        `seed file data/seed/${SEED_FILE} is missing or unreadable — only the dates this app computes for `
          + 'itself (options expiry, index rebalances and the statutory money deadlines) are available, with no '
          + 'Fed, BLS, Treasury or earnings schedule behind them',
      ];
      const byKind = {};
      for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`).join(', ');

      const res = result({
        opportunities: [],
        status: 'offline',
        notes: [
          `Bundled forward calendar as of ${asOf}: ${events.length} events (${breakdown}).`,
          `${events.length - estimated} are published or purely calendrical dates; ${estimated} are inferred from the `
            + 'publisher\'s long-standing pattern and are labelled estimated in the UI. Refresh to replace the '
            + 'estimates with published dates.',
          `${computed.length} options-expiry and index-rebalance dates were computed rather than stored — the third `
            + 'Friday of a month is arithmetic, so it cannot go stale.',
          'This source contributes dated events, not buyable rows, which is why it lists no opportunities.',
          skipped ? `${skipped} bundled entries were unreadable and were skipped.` : null,
        ].filter(Boolean),
        warnings,
      });
      res.events = events;
      return res;
    } catch (err) {
      const res = failure(err, { status: 'failed' });
      res.events = [];
      return res;
    }
  },
};

// Exposed for tests: statutory deadlines must be exactly right, and a
// weekend-shift bug is invisible until the one year it matters.
adapter._moneyDeadlineEvents = moneyDeadlineEvents;
adapter._shiftForWeekend = shiftForWeekend;
adapter._MONEY_DEADLINES = MONEY_DEADLINES;

module.exports = adapter;
