'use strict';

const { readSignals } = require('./signals');

/**
 * Reading the pre-move detectors on one row.
 *
 * Extracted from the middle of aggregate's row map because two places need it
 * and only one had it. Pressing "Measure this now" gives a row 180 real daily
 * closes and then calls rescore(), which recomputes the rating and the movement
 * read and NOT this — so the freshly measured row kept the stub it was given
 * when it had no history, and the interface went on saying "no price history
 * has been pulled for this row yet" underneath a chart drawn from 180 recorded
 * closes, while two detectors would have fired on it.
 *
 * Same shape as every other bug this codebase has shipped: logic reachable only
 * by running the whole app, living somewhere a second caller could not reach.
 */

/**
 * Why this row cannot be read, in the words the interface will use.
 *
 * Returning null means it can. Saying nothing at all would be worse than saying
 * no — a blank signal column reads as "no setup here" when the truth is "nobody
 * looked".
 */
function whyUnreadable(row, { hasMovement = true } = {}) {
  if (!hasMovement) return null;
  const bars = Array.isArray(row.series) ? row.series.length : 0;
  if (row.seriesBasis === 'illustrative') {
    return 'This row has no recorded price history yet — its chart is drawn from its own statistics, so no signal '
      + 'can honestly be read off it. Refresh to measure it.';
  }
  if (!bars) return 'No price history has been pulled for this row yet. Open it and choose Measure.';
  if (row.seriesInterval !== 'day') {
    return `This row's history is ${row.seriesInterval ? `${row.seriesInterval}ly` : 'of an unstated'} resolution, `
      + 'and every detector here was measured on daily bars. Reading it anyway would report a number that looks '
      + 'like volatility and is not, so nothing is claimed.';
  }
  if (bars < 30) return `Only ${bars} closes on record — the detectors need at least 30 before they say anything.`;
  return null;
}

/**
 * @param {object} row          the opportunity, carrying series/seriesInterval/short interest etc.
 * @param {object} opts         { events, horizonDays, calibration, hasMovement }
 * @returns {object|null}       a signals reading, an unreadable stub, or null for an income row
 */
function readRowSignals(row, { events = [], horizonDays = 30, calibration = null, hasMovement = true } = {}) {
  if (!hasMovement) return null;

  const unreadable = whyUnreadable(row, { hasMovement });
  if (unreadable) {
    // A chart that was drawn rather than recorded cannot support a signal —
    // reading compression off a curve derived from a volatility number and
    // reporting it as evidence about volatility is circular — and neither can
    // one whose bars are not the days the detectors were measured on.
    return { signals: [], fired: [], pressure: null, lean: null, calibrated: false, missing: [], onPriors: [], unreadable };
  }

  try {
    return readSignals(
      { closes: row.series, volumes: row.volumeSeries || [], highs: [], lows: [] },
      row.series.length - 1,
      {
        events,
        horizonDays,
        weights: calibration?.weights || null,
        // The settings the backtest chose, so the app detects with the same
        // configuration that was actually measured rather than the guesses the
        // measurement rejected.
        params: calibration?.chosenParams || null,
        shortPercentFloat: row.shortPercentFloat,
        daysToCover: row.daysToCover,
        borrowFeePct: row.borrowFeePct,
        floatShares: row.floatShares,
        unlockPercentOfFloat: row.unlockPercentOfFloat,
        unlockDaysAway: row.unlockDaysAway,
        priceVsHigh: Number.isFinite(row.maxDrawdown) ? -row.maxDrawdown / 100 : null,
      },
    );
  } catch {
    return null;
  }
}

module.exports = { readRowSignals, whyUnreadable };
