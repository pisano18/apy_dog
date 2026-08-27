'use strict';

/**
 * Canonical vocabularies for APY Dog.
 *
 * Every source adapter must map its native taxonomy onto these values so that a
 * Treasury bill, a DeFi stablecoin pool and a covered-call ETF can sit in the
 * same sorted table without lying to each other.
 */

/** Broad buckets a user actually thinks in. */
const ASSET_CLASS = {
  CASH: 'cash',                 // HYSA, money market, checking bonuses
  CD: 'cd',                     // term deposits, share certificates
  GOVT_BOND: 'govt_bond',       // treasuries, agency, sovereign
  MUNI_BOND: 'muni_bond',       // municipal
  CORP_BOND: 'corp_bond',       // investment grade + high yield
  DIVIDEND_EQUITY: 'dividend_equity',
  REIT: 'reit',
  BDC: 'bdc',                   // business development companies
  CEF: 'cef',                   // closed-end funds
  ETF: 'etf',                   // income ETFs incl. covered call
  PREFERRED: 'preferred',
  CRYPTO_STAKING: 'crypto_staking',
  CRYPTO_LENDING: 'crypto_lending',
  CRYPTO_LP: 'crypto_lp',       // liquidity pools / AMM
  RWA: 'rwa',                   // tokenized treasuries & credit
  P2P_LENDING: 'p2p_lending',
  ANNUITY: 'annuity',
  SPECULATIVE: 'speculative',   // expected-return plays, not contractual yield
};

const ASSET_CLASS_LABELS = {
  cash: 'Savings / Cash',
  cd: 'CDs & Certificates',
  govt_bond: 'Government Bonds',
  muni_bond: 'Municipal Bonds',
  corp_bond: 'Corporate Bonds',
  dividend_equity: 'Dividend Stocks',
  reit: 'REITs',
  bdc: 'BDCs',
  cef: 'Closed-End Funds',
  etf: 'Income ETFs',
  preferred: 'Preferred Shares',
  crypto_staking: 'Crypto Staking',
  crypto_lending: 'Crypto Lending',
  crypto_lp: 'Liquidity Pools',
  rwa: 'Tokenized RWA',
  p2p_lending: 'P2P Lending',
  annuity: 'Annuities',
  speculative: 'Speculative / Upside',
};

/**
 * How the headline number was produced. This matters enormously: a contractual
 * 4.2% CD and a trailing 12-month 48% LP yield are not the same kind of claim,
 * and ranking them naively is how people lose money.
 */
const YIELD_KIND = {
  CONTRACTUAL: 'contractual', // legally fixed for the term (CD, bond held to maturity)
  ADMINISTERED: 'administered', // issuer can change at will (HYSA, savings)
  MARKET: 'market',           // set by market price (bond YTM, MMF 7-day)
  TRAILING: 'trailing',       // backward-looking realised distribution (TTM yield)
  FORWARD: 'forward',         // annualised from the most recent period
  VARIABLE: 'variable',       // floats with utilisation/emissions (DeFi)
  EXPECTED: 'expected',       // modelled, uncertain, NOT a yield (speculative)
};

/** Ordered from most to least trustworthy for tie-breaking. */
const YIELD_KIND_QUALITY = {
  contractual: 1.0,
  market: 0.92,
  administered: 0.85,
  forward: 0.7,
  trailing: 0.62,
  variable: 0.5,
  expected: 0.3,
};

const LIQUIDITY = {
  INSTANT: 'instant',       // withdraw now, no penalty
  DAILY: 'daily',           // T+0/T+1 market or bank transfer
  SETTLED: 'settled',       // T+2 style settlement
  NOTICE: 'notice',         // notice period / unbonding queue
  LOCKED: 'locked',         // locked until maturity, penalty to exit
  ILLIQUID: 'illiquid',     // no reliable exit
};

/** Days of friction, used to penalise scores when the user needs the money back. */
const LIQUIDITY_FRICTION_DAYS = {
  instant: 0, daily: 1, settled: 2, notice: 14, locked: null, illiquid: 365,
};

const INSURANCE = {
  US_GOV: 'us_gov',   // full faith and credit
  FDIC: 'fdic',
  NCUA: 'ncua',
  SIPC: 'sipc',       // custody only — does NOT cover market loss
  PRIVATE: 'private',
  NONE: 'none',
};

const RISK_TIER = [
  { key: 'vault',       label: 'Vault',       max: 8,   color: '#2f9e6e' },
  { key: 'conservative',label: 'Conservative',max: 22,  color: '#5fb85f' },
  { key: 'moderate',    label: 'Moderate',    max: 42,  color: '#d2b13c' },
  { key: 'aggressive',  label: 'Aggressive',  max: 62,  color: '#e08b3c' },
  { key: 'speculative', label: 'Speculative', max: 82,  color: '#dc5f3c' },
  { key: 'degen',       label: 'Degen',       max: 101, color: '#c73434' },
];

/** Tax treatment of the income stream. Drives the after-tax engine. */
const TAX_TREATMENT = {
  ORDINARY: 'ordinary',                 // bank interest, DeFi, most bond coupons
  QUALIFIED_DIVIDEND: 'qualified_dividend',
  TREASURY: 'treasury',                 // federal taxable, state/local exempt
  MUNI_FEDERAL_EXEMPT: 'muni_federal_exempt',
  MUNI_TRIPLE_EXEMPT: 'muni_triple_exempt',
  SECTION_199A: 'section_199a',         // REIT/BDC ordinary w/ 20% deduction
  ROC: 'return_of_capital',             // deferred, reduces basis
  CAPITAL_GAIN_LONG: 'capital_gain_long',
  MIXED: 'mixed',
  TAX_DEFERRED: 'tax_deferred',
};

/** Reasons an eye-catching APY is probably not real money. */
const TRAP_FLAGS = {
  REWARD_DOMINANT: 'reward_dominant',
  LOW_TVL: 'low_tvl',
  BRAND_NEW: 'brand_new',
  APY_SPIKE: 'apy_spike',
  IMPERMANENT_LOSS: 'impermanent_loss',
  UNAUDITED: 'unaudited',
  OUTLIER_VS_PEERS: 'outlier_vs_peers',
  STALE_DATA: 'stale_data',
  TEASER_RATE: 'teaser_rate',
  CAPPED_BALANCE: 'capped_balance',
  RETURN_OF_CAPITAL: 'destructive_roc',
  LEVERAGED: 'leveraged',
  NAV_PREMIUM: 'nav_premium',
  YIELD_FROM_PRINCIPAL: 'yield_from_principal',
  UNSUSTAINABLE_PAYOUT: 'unsustainable_payout',
  DEPEG_EXPOSURE: 'depeg_exposure',
  CAPPED_UPSIDE: 'capped_upside',
  HIGH_FEES: 'high_fees',
};

const TRAP_FLAG_TEXT = {
  reward_dominant: 'Most of this yield is incentive-token emissions, not real revenue. Emissions get cut.',
  low_tvl: 'Very little capital is actually in this. Small pools move fast and exit badly.',
  brand_new: 'Launched recently — no track record, elevated rug and exploit odds.',
  apy_spike: 'Current rate is far above its own recent average. You are looking at a spike, not a run rate.',
  impermanent_loss: 'Liquidity pool with a volatile pair — divergence loss can exceed the yield.',
  unaudited: 'No published audit for this protocol.',
  outlier_vs_peers: 'Pays wildly more than comparable options. Something explains that, and it is usually risk.',
  stale_data: 'Rate has not refreshed recently — may be out of date.',
  teaser_rate: 'Promotional rate that reverts after an intro window.',
  capped_balance: 'Top rate only applies up to a balance cap; money above it earns far less.',
  destructive_roc: 'A large share of the distribution is return of your own capital, not earnings.',
  leveraged: 'Uses leverage — gains and losses are both amplified.',
  nav_premium: 'Trading above net asset value; you are paying more than the assets are worth.',
  yield_from_principal: 'Payout appears to exceed what the underlying actually earns.',
  unsustainable_payout: 'Distribution is not covered by income and has a history of cuts.',
  depeg_exposure: 'Depends on a peg holding. Pegs break.',
  capped_upside: 'The distribution is funded by selling away your upside. In a rising market this lags badly.',
  high_fees: 'The fee takes a large bite out of what you actually keep.',
};

const SOURCE_STATUS = {
  OK: 'ok', PARTIAL: 'partial', FAILED: 'failed', OFFLINE: 'offline', DISABLED: 'disabled',
};

const DAY = 86400000;
const TERM = {
  OPEN: null,
  presets: [
    { key: 'any', label: 'Any length', min: null, max: null },
    { key: 'liquid', label: 'No lockup', min: null, max: 0 },
    { key: 'lt3m', label: 'Under 3 months', min: 1, max: 92 },
    { key: '3to12m', label: '3–12 months', min: 92, max: 366 },
    { key: '1to3y', label: '1–3 years', min: 366, max: 1096 },
    { key: '3to10y', label: '3–10 years', min: 1096, max: 3653 },
    { key: 'gt10y', label: 'Over 10 years', min: 3653, max: null },
  ],
};

function riskTier(score) {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 100;
  return RISK_TIER.find((t) => s < t.max) || RISK_TIER[RISK_TIER.length - 1];
}

module.exports = {
  ASSET_CLASS, ASSET_CLASS_LABELS, YIELD_KIND, YIELD_KIND_QUALITY, LIQUIDITY,
  LIQUIDITY_FRICTION_DAYS, INSURANCE, RISK_TIER, TAX_TREATMENT, TRAP_FLAGS,
  TRAP_FLAG_TEXT, SOURCE_STATUS, TERM, DAY, riskTier,
};
