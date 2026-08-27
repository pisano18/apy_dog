'use strict';

const C = require('./constants');

/**
 * Yield-trap detection.
 *
 * Any screen sorted by "highest APY" is, by construction, a list of the things
 * most likely to be lying to you. The top of an unfiltered yield table is nearly
 * always emissions farms, teaser rates, dying closed-end funds and pools that
 * will be empty next week. This module is the immune system: it labels those
 * before they get ranked, so the sort can still be "highest first" without the
 * result being useless.
 *
 * Returns { score 0-100, flags[], detail[] }. Score is how likely the headline
 * number is to be unearned, NOT how risky the asset is (that is risk.js).
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function detectTraps(o, context = {}) {
  const flags = [];
  const detail = [];
  let score = 0;
  const flag = (key, points, msg) => {
    flags.push(key);
    score += points;
    detail.push({ flag: key, points, message: msg || C.TRAP_FLAG_TEXT[key] });
  };

  const apy = o.apy || {};
  const total = apy.total;

  // --- emissions dependence -------------------------------------------------
  if (Number.isFinite(total) && Number.isFinite(apy.reward) && total > 0) {
    const share = apy.reward / total;
    if (share >= 0.8) flag(C.TRAP_FLAGS.REWARD_DOMINANT, 26, `${(share * 100).toFixed(0)}% of this yield is incentive-token emissions. Base (real) yield is only ${(apy.base ?? 0).toFixed(2)}%.`);
    else if (share >= 0.55) flag(C.TRAP_FLAGS.REWARD_DOMINANT, 13, `${(share * 100).toFixed(0)}% of this yield is token emissions, which get cut.`);
  }

  // --- thin capital ---------------------------------------------------------
  if (Number.isFinite(o.tvl)) {
    if (o.tvl < 250e3) flag(C.TRAP_FLAGS.LOW_TVL, 22, `Only $${(o.tvl / 1e3).toFixed(0)}k is in this. You may not be able to exit at size.`);
    else if (o.tvl < 1e6) flag(C.TRAP_FLAGS.LOW_TVL, 13, `Under $1M total value locked — thin.`);
    else if (o.tvl < 5e6) flag(C.TRAP_FLAGS.LOW_TVL, 5, `Under $5M total value locked.`);
  }

  // --- no track record ------------------------------------------------------
  const age = o.risk?.ageDays;
  if (Number.isFinite(age)) {
    if (age < 14) flag(C.TRAP_FLAGS.BRAND_NEW, 20, `Launched ${Math.round(age)} days ago.`);
    else if (age < 60) flag(C.TRAP_FLAGS.BRAND_NEW, 10, `Only ${Math.round(age)} days old.`);
  }

  // --- spike vs its own history --------------------------------------------
  // A pool paying 90% today that averaged 8% over 30 days is not a 90% pool.
  const mean30 = apy.mean30d;
  if (Number.isFinite(total) && Number.isFinite(mean30) && mean30 > 0.2 && total > 0) {
    const ratio = total / mean30;
    if (ratio > 3) flag(C.TRAP_FLAGS.APY_SPIKE, 22, `Currently ${total.toFixed(1)}% but averaged ${mean30.toFixed(1)}% over 30 days — a ${ratio.toFixed(1)}x spike.`);
    else if (ratio > 1.8) flag(C.TRAP_FLAGS.APY_SPIKE, 11, `Currently ${total.toFixed(1)}% vs a ${mean30.toFixed(1)}% 30-day average.`);
  }

  // --- impermanent loss -----------------------------------------------------
  if (o.ilRisk === 'yes' || o.subType === 'volatile_lp') {
    flag(C.TRAP_FLAGS.IMPERMANENT_LOSS, 12, 'Volatile-pair liquidity pool: if the two assets diverge, divergence loss can exceed everything you earn.');
  }

  // --- unaudited ------------------------------------------------------------
  if (['crypto_staking', 'crypto_lending', 'crypto_lp'].includes(o.assetClass) && o.risk?.auditCount === 0) {
    flag(C.TRAP_FLAGS.UNAUDITED, 10);
  }

  // --- peg dependence -------------------------------------------------------
  if (o.stablecoin && Number.isFinite(total) && total > 15) {
    flag(C.TRAP_FLAGS.DEPEG_EXPOSURE, 14, `A "stable" asset paying ${total.toFixed(1)}% is paying you to hold peg risk. That is the trade.`);
  }

  // --- outlier vs peer group ------------------------------------------------
  // context.peerMedian is the median APY of the same asset class this run.
  if (Number.isFinite(total) && Number.isFinite(context.peerMedian) && context.peerMedian > 0.3) {
    const mult = total / context.peerMedian;
    if (mult > 8) flag(C.TRAP_FLAGS.OUTLIER_VS_PEERS, 20, `Pays ${mult.toFixed(0)}x the median for ${C.ASSET_CLASS_LABELS[o.assetClass] || o.assetClass}.`);
    else if (mult > 4) flag(C.TRAP_FLAGS.OUTLIER_VS_PEERS, 11, `Pays ${mult.toFixed(1)}x the median for its category.`);
  }

  // --- stale ----------------------------------------------------------------
  // Bundled snapshot rows are labelled as such throughout the UI already, so
  // flagging their age here would put a warning on every offline row and drown
  // out the flags that actually distinguish one opportunity from another.
  const ageMs = o.seed ? NaN : Date.now() - Date.parse(o.dataAsOf || '');
  if (Number.isFinite(ageMs)) {
    if (ageMs > 60 * C.DAY) flag(C.TRAP_FLAGS.STALE_DATA, 16, `Rate last confirmed ${Math.round(ageMs / C.DAY)} days ago — verify before acting.`);
    else if (ageMs > 14 * C.DAY) flag(C.TRAP_FLAGS.STALE_DATA, 7, `Rate is ${Math.round(ageMs / C.DAY)} days old.`);
  }

  // --- bank/deposit specific ------------------------------------------------
  if (o.requirements?.some((r) => /intro|promo|teaser|first \d+ months|bonus rate/i.test(String(r)))) {
    flag(C.TRAP_FLAGS.TEASER_RATE, 16);
  }
  if (Number.isFinite(o.maxInvestment) && o.maxInvestment > 0 && o.maxInvestment <= 25000) {
    flag(C.TRAP_FLAGS.CAPPED_BALANCE, 12, `Top rate only applies to the first $${o.maxInvestment.toLocaleString()}.`);
  }

  // --- fund specific --------------------------------------------------------
  if (Number.isFinite(o.rocShare) && o.rocShare > 0.5) {
    flag(C.TRAP_FLAGS.RETURN_OF_CAPITAL, 18, `${(o.rocShare * 100).toFixed(0)}% of the distribution is return of your own capital, not earnings.`);
  }
  if (Number.isFinite(o.navPremium) && o.navPremium > 8) {
    flag(C.TRAP_FLAGS.NAV_PREMIUM, 14, `Trading ${o.navPremium.toFixed(1)}% above net asset value — you are overpaying for the underlying.`);
  }
  if (Number.isFinite(o.risk?.leverage) && o.risk.leverage > 1.4) {
    flag(C.TRAP_FLAGS.LEVERAGED, 10, `${o.risk.leverage.toFixed(2)}x leveraged — the yield is borrowed.`);
  }
  if (Number.isFinite(o.payoutCoverage) && o.payoutCoverage < 0.9) {
    flag(C.TRAP_FLAGS.UNSUSTAINABLE_PAYOUT, 16, `Earnings cover only ${(o.payoutCoverage * 100).toFixed(0)}% of the distribution. Cuts follow.`);
  }

  score = clamp(Math.round(score), 0, 100);
  return {
    score,
    flags,
    detail: detail.sort((a, b) => b.points - a.points),
    verdict: score >= 55 ? 'likely_trap' : score >= 28 ? 'caution' : 'clean',
  };
}

/** Median APY per asset class, used for the peer-outlier test. */
function peerMedians(list) {
  const byClass = new Map();
  for (const o of list) {
    const v = o?.apy?.total;
    if (!Number.isFinite(v)) continue;
    if (!byClass.has(o.assetClass)) byClass.set(o.assetClass, []);
    byClass.get(o.assetClass).push(v);
  }
  const out = {};
  for (const [k, vals] of byClass) {
    vals.sort((a, b) => a - b);
    const m = vals.length % 2
      ? vals[(vals.length - 1) / 2]
      : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    out[k] = m;
  }
  return out;
}

module.exports = { detectTraps, peerMedians };
