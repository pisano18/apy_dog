'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The measured weights, if anybody has measured them.
 *
 * Written by scripts/backtest.js after a run against real price history. Until
 * that has happened this returns null, and every pressure reading in the app is
 * labelled uncalibrated — because a number like "72" carries an authority it
 * has not earned until something has checked it against what actually happened
 * next.
 *
 * Deliberately not bundled with the app. A calibration file that shipped would
 * be a backtest against data chosen after the fact, on a universe picked by
 * somebody who already knew how it turned out.
 */

const FILE = path.join(__dirname, '..', '..', 'data', 'calibration.json');

let cached;
let cachedAt = 0;

function loadCalibration({ maxAgeMs = 60000, file = FILE } = {}) {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < maxAgeMs) return cached;
  cachedAt = now;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A calibration with no validated signal is not a calibration. Loading it
    // would silently zero every weight and turn the pressure column into a
    // column of zeros, which looks like a bug rather than the honest result it
    // is — better to stay openly uncalibrated and say why.
    if (!parsed || !parsed.weights || !Object.values(parsed.weights).some((w) => w > 0)) {
      cached = null;
      return cached;
    }
    cached = parsed;
  } catch {
    cached = null;
  }
  return cached;
}

/** For tests, and for a refresh immediately after a backtest run. */
function clearCalibrationCache() { cached = undefined; cachedAt = 0; }

module.exports = { loadCalibration, clearCalibrationCache, CALIBRATION_FILE: FILE };
