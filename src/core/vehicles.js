'use strict';

const K = require('./opportunity-kinds');

/**
 * What you would actually buy.
 *
 * A screener that says "NVDA, volatility 45%, earnings in six days" has told you
 * about a situation and nothing about how to act on it. The same view can usually
 * be expressed several ways, and which one is available depends on how much
 * capital you have — that gating is the part everyone leaves out.
 *
 * The clearest case: you want income from a stock that pays no dividend. There
 * is exactly one way to do it, a covered call, and it requires a hundred shares.
 * At $180 a share that is $18,000. Telling someone about the strategy without
 * telling them the ticket size wastes their time, so every vehicle here carries
 * what it costs to enter and whether they can currently reach it.
 *
 * Nothing here is a recommendation. It is a list of the mechanisms that exist,
 * what each is for, and what each costs to open.
 */

const CONTRACT_SIZE = 100;   // one US equity option controls 100 shares

/** Options need a liquid, optionable underlying. Most listed equities qualify. */
function likelyOptionable(o) {
  if (!o.symbol) return false;
  if (!['etf', 'dividend_equity', 'reit', 'bdc', 'cef', 'preferred', 'speculative'].includes(o.assetClass)) return false;
  // A thin or tiny listing usually has no usable options market even if a chain
  // technically exists — the spreads make it untradeable.
  if (Number.isFinite(o.tvl) && o.tvl < 3e8) return false;
  if (Number.isFinite(o.volume) && o.volume < 2e5) return false;
  return true;
}

function money(v) {
  if (!Number.isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString()}`;
}

/**
 * @param {object} o        a scored opportunity
 * @param {object} opts     { budget: number|null }
 * @returns {object[]}      vehicles, most accessible first
 */
function vehiclesFor(o, { budget = null } = {}) {
  const out = [];
  const hasBudget = Number.isFinite(budget) && budget > 0;
  const price = Number.isFinite(o.price) && o.price > 0 ? o.price : null;

  const add = (v) => {
    const needed = v.capitalNeeded ?? null;
    const viable = !hasBudget || needed === null ? null : needed <= budget;
    out.push({ ...v, capitalNeeded: needed, viable });
  };

  // --- deposits and direct products ---------------------------------------
  if (['cash', 'cd'].includes(o.assetClass)) {
    add({
      key: K.VEHICLE.DEPOSIT,
      label: 'Open the account',
      goal: 'Earn the rate',
      what: 'Money goes in, the rate accrues, the balance is insured to the stated limit.',
      requires: (o.requirements || []).length ? o.requirements : ['Identity verification'],
      capitalNeeded: Number.isFinite(o.minInvestment) ? o.minInvestment : 0,
    });
    return out;
  }

  if (o.section === K.SECTION.DEALS) {
    add({
      key: K.VEHICLE.DIRECT,
      label: 'Take the offer',
      goal: 'Collect the bonus',
      what: o.accessNotes || 'Follow the provider process.',
      requires: o.requirements || [],
      capitalNeeded: Number.isFinite(o.minInvestment) ? o.minInvestment : 0,
    });
    return out;
  }

  // --- Treasuries: two genuinely different routes ---------------------------
  if (o.assetClass === 'govt_bond' && ['bill', 'note', 'bond', 'tips'].includes(o.subType)) {
    add({
      key: K.VEHICLE.AUCTION,
      label: 'Buy at auction',
      goal: 'Lock the rate, hold to maturity',
      what: 'Non-competitive bid through TreasuryDirect or a brokerage. You get the auction rate, no commission, no market risk if held to maturity.',
      requires: ['A TreasuryDirect account or a brokerage that forwards auction bids'],
      capitalNeeded: 100,
    });
    add({
      key: K.VEHICLE.DIRECT,
      label: 'Buy on the secondary market',
      goal: 'Choose an exact maturity date',
      what: 'Existing issues through a brokerage bond desk. Lets you pick a precise date rather than waiting for the next auction, at the cost of a bid-ask spread.',
      requires: ['A brokerage with a bond desk'],
      capitalNeeded: 1000,
    });
    add({
      key: K.VEHICLE.ETF,
      label: 'Hold a Treasury fund instead',
      goal: 'Same exposure, no maturity to manage',
      what: 'A fund rolls the ladder for you and stays liquid, but it never matures, so you carry price risk indefinitely rather than getting par back on a date.',
      requires: ['Any brokerage'],
      capitalNeeded: 50,
    });
    return out;
  }

  // --- on-chain -------------------------------------------------------------
  if (['crypto_lending', 'crypto_lp', 'crypto_staking'].includes(o.assetClass)) {
    add({
      key: K.VEHICLE.ON_CHAIN,
      label: 'Supply it on-chain',
      goal: 'Earn the pool rate',
      what: `Self-custody wallet, bridge or buy the asset on ${o.chain || 'the chain'}, approve and deposit. Gas is a real cost on small positions.`,
      requires: ['Self-custody wallet', `Gas on ${o.chain || 'the chain'}`, 'Comfort with smart-contract risk'],
      capitalNeeded: 500,
    });
    return out;
  }

  // --- listed equities and funds -------------------------------------------
  if (price) {
    add({
      key: K.VEHICLE.SHARES,
      label: 'Buy shares',
      goal: 'Own it outright',
      what: `${money(price)} per share. No expiry, no leverage, no assignment risk.`,
      requires: ['Any brokerage'],
      capitalNeeded: price,
    });

    // Fractional matters exactly when the share price is the obstacle.
    if (price > 100) {
      add({
        key: K.VEHICLE.FRACTIONAL,
        label: 'Buy a fraction of a share',
        goal: 'Own it with less capital',
        what: `At ${money(price)} a share, fractional buying lets you take a position of any size. Most large brokerages support it; some do not, and fractional shares can complicate transfers.`,
        requires: ['A brokerage that supports fractional shares'],
        capitalNeeded: 1,
      });
    }
  }

  if (likelyOptionable(o) && price) {
    const contract = price * CONTRACT_SIZE;
    // "Pays nothing" has to mean nothing. A 0.4% dividend is negligible but it
    // is not zero, and saying otherwise about a real company is just wrong.
    const y = o.apy?.total;
    const payingNothing = !Number.isFinite(y) || y < 0.15;
    const payingLittle = Number.isFinite(y) && y >= 0.15 && y < 1.5;

    // The case worth being loud about: the only way to generate cash from a
    // stock that pays no dividend is to sell an option against it.
    add({
      key: K.VEHICLE.COVERED_CALL,
      label: 'Sell a covered call',
      goal: payingNothing ? 'Manufacture income from something that pays none'
        : payingLittle ? 'Turn a token dividend into real income'
          : 'Add income on top of the dividend',
      what: `Own ${CONTRACT_SIZE} shares (${money(contract)}) and sell a call against them. You collect the premium now and cap your upside at the strike. `
        + (payingNothing
          ? 'This is the only way to get cash out of a holding that pays no dividend.'
          : payingLittle
            ? `Its ${y.toFixed(2)}% dividend is close to nothing; premium is where the income would actually come from.`
            : 'Stacks on top of what it already distributes.'),
      requires: [`${CONTRACT_SIZE} shares — ${money(contract)}`, 'Options approval level 1 at most brokers'],
      capitalNeeded: contract,
    });

    add({
      key: K.VEHICLE.CASH_SECURED_PUT,
      label: 'Sell a cash-secured put',
      goal: 'Get paid to wait for a lower price',
      what: `Set aside roughly ${money(contract)} and sell a put below the current price. You keep the premium if it never gets there, and buy the shares at your strike if it does. Only sensible on something you would genuinely be happy to own.`,
      requires: [`Cash collateral of about ${money(contract)}`, 'Options approval level 2 at most brokers'],
      capitalNeeded: contract,
    });

    add({
      key: K.VEHICLE.LEAPS,
      label: 'Buy a long-dated call',
      goal: 'Exposure for a fraction of the capital',
      what: 'A call a year or more out costs a fraction of the shares and gives similar directional exposure, but it decays and can expire worthless. Losing 100% of a call is ordinary; losing 100% of a share is not.',
      requires: ['Options approval level 2', 'Tolerance for total loss of the premium'],
      capitalNeeded: Math.round(contract * 0.15),
    });

    if (Number.isFinite(o.risk?.volatility) && o.risk.volatility > 35) {
      add({
        key: K.VEHICLE.PROTECTIVE_PUT,
        label: 'Buy a protective put',
        goal: 'Own it with a floor under it',
        what: `At ${o.risk.volatility.toFixed(0)}% volatility the downside is real. A put sets a floor for a known cost, which is insurance and priced like it.`,
        requires: [`${CONTRACT_SIZE} shares plus the premium`, 'Options approval level 1'],
        capitalNeeded: Math.round(contract * 1.05),
      });
    }
  }

  // --- spot crypto ----------------------------------------------------------
  if (o.source === 'crypto') {
    add({
      key: K.VEHICLE.DIRECT,
      label: 'Buy on an exchange',
      goal: 'Own the asset',
      what: 'A major exchange for the large caps; smaller assets may be on-chain only. Custody is your problem either way.',
      requires: ['An exchange account', 'Somewhere to keep the keys'],
      capitalNeeded: 10,
    });
    if (/^(BTC|ETH)$/i.test(o.symbol || '')) {
      add({
        key: K.VEHICLE.ETF,
        label: 'Hold a spot ETF instead',
        goal: 'Same exposure inside a brokerage account',
        what: 'A spot ETF gives the price exposure in a normal brokerage or retirement account, with no keys to lose. You pay a management fee and you cannot move it on-chain.',
        requires: ['Any brokerage'],
        capitalNeeded: 50,
      });
    }
  }

  return out;
}

/**
 * The one-line answer to "so what do I do about this", used on the row.
 * Prefers whatever the person can currently afford.
 */
function primaryVehicle(vehicles, { budget = null } = {}) {
  if (!vehicles?.length) return null;
  const affordable = vehicles.filter((v) => v.viable !== false);
  return (affordable[0] || vehicles[0]);
}

/**
 * Strategies that exist but are out of reach at the current budget. Worth
 * surfacing rather than hiding: knowing a covered call needs $18,000 is useful
 * information, and silently omitting it just makes the app look incomplete.
 */
function outOfReach(vehicles) {
  return (vehicles || []).filter((v) => v.viable === false);
}

module.exports = { vehiclesFor, primaryVehicle, outOfReach, likelyOptionable, CONTRACT_SIZE };
