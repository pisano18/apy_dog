'use strict';

const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * INCOME FUNDS — covered-call ETFs, bond ETFs, REITs, BDCs, preferreds and CEFs.
 *
 * This is where the double-digit headline numbers live, and where most of them
 * are not what they look like. A 12% covered-call ETF is selling upside; a 14%
 * mortgage REIT is running 8x repo leverage; a 19% CLO-equity CEF is handing
 * back a chunk of your own capital. So this adapter deliberately spends more
 * effort computing RISK INPUTS (realised volatility, max drawdown, structural
 * leverage) than it does on the yield itself, because risk.js and traps.js are
 * what stop this category from dominating the table for the wrong reasons.
 *
 * DATA SOURCE: the Yahoo Finance chart endpoint, and only that one. quoteSummary
 * and v7/quote now demand a crumb plus cookie and answer 401 without them. The
 * chart endpoint is unauthenticated and carries everything we need — meta price,
 * a 2-year adjusted close series, and the dividend event stream:
 *
 *   /v8/finance/chart/<SYM>?range=2y&interval=1d&events=div|split
 *
 * Fallbacks: query2 (same shape), then Stooq daily CSV. Stooq has prices but no
 * dividend events, so on that path the yield comes from the bundled seed and the
 * row's confidence drops accordingly — a price we measured and a yield we
 * remembered is a weaker claim than one where both are measured.
 *
 * TRAILING vs FORWARD. apy.total is the TRAILING twelve-month yield: what the
 * fund actually paid, divided by what a share costs now. apy.forward is the most
 * recent payment annualised by detected frequency. Forward is the number every
 * fund marketing page leads with, and for a variable payer — which is nearly all
 * of these — it flatters: one fat month becomes a 20% "yield". We keep it,
 * because it is the better estimate for a fund whose payout genuinely stepped up,
 * but we never rank on it.
 *
 * DURATION: bond ETFs get term.days = null on purpose. They have no maturity —
 * you never get par back — so a synthetic term would both lie about the lockup
 * and double-charge the rate risk that measured volatility already captures.
 */

const ID = 'funds';
const LABEL = 'Income ETFs, REITs, BDCs & CEFs';
const DAY = 86400000;

const CHART_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

const chartUrl = (host, symbol) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div%7Csplit`;

const stooqUrl = (symbol) =>
  `https://stooq.com/q/d/l/?s=${encodeURIComponent(String(symbol).toLowerCase())}.us&i=d`;

const quotePage = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

const ACCESS_NOTES =
  'Any US brokerage, commission free. Trades like a stock and settles T+1; one share is the practical minimum, '
  + 'or less wherever fractional shares are supported.';

// Number(null) is 0, which is how a missing yield becomes a confident "0%".
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * Category defaults. Every universe entry may override assetClass, taxTreatment
 * or notes — a Treasury bill ETF and a CLO ETF both live under "ultrashort" but
 * one is state-tax-exempt and the other is not, and that difference is worth
 * real money to the after-tax engine.
 */
const CATEGORIES = {
  covered_call: {
    label: 'Covered-call / option-income ETF',
    assetClass: baseC.ASSET_CLASS.ETF,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Income here is manufactured by selling upside, not earned by the underlying. The fund keeps the option '
      + 'premium and gives up the rally, so in a strong market total return trails the index while the distribution '
      + 'still looks large. Payouts are mostly short-term option gains, taxed as ordinary income.',
  },
  bond_etf: {
    label: 'Bond ETF',
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Coupon income from the underlying bonds. The fund has no maturity date, so unlike a bond you hold to '
      + 'maturity it never returns par: a rate rise is a real price loss until yields come back down.',
  },
  dividend_etf: {
    label: 'Dividend equity ETF',
    assetClass: baseC.ASSET_CLASS.DIVIDEND_EQUITY,
    taxTreatment: baseC.TAX_TREATMENT.QUALIFIED_DIVIDEND,
    note: 'Ordinary company dividends, overwhelmingly qualified, so taxed at long-term capital gains rates. The '
      + 'yield looks small next to the rest of this list precisely because nothing is manufacturing it.',
  },
  reit: {
    label: 'Equity REIT',
    assetClass: baseC.ASSET_CLASS.REIT,
    taxTreatment: baseC.TAX_TREATMENT.SECTION_199A,
    note: 'REITs must distribute 90% of taxable income, which is why the yields are high. Distributions are largely '
      + 'Section 199A ordinary income (20% deduction, not the qualified-dividend rate), so they are worth materially '
      + 'more inside a tax-deferred account.',
  },
  mortgage_reit: {
    label: 'Mortgage REIT',
    assetClass: baseC.ASSET_CLASS.REIT,
    taxTreatment: baseC.TAX_TREATMENT.SECTION_199A,
    note: 'Owns mortgage paper financed with repo borrowing. The yield is a levered spread between short-term funding '
      + 'and long-term mortgage rates: it compresses when the curve flattens and book value falls hard when rates or '
      + 'spreads move. Dividend cuts in this group are routine, not exceptional.',
  },
  bdc: {
    label: 'Business development company',
    assetClass: baseC.ASSET_CLASS.BDC,
    taxTreatment: baseC.TAX_TREATMENT.SECTION_199A,
    note: 'Lends to private middle-market companies at floating rates, funded with roughly one turn of leverage, so '
      + 'the yield tracks SOFR plus a spread. The risk is credit, and non-accruals surface late. Externally managed '
      + 'BDCs also carry a 2-and-20 style fee load that no expense ratio shows you.',
  },
  preferred: {
    label: 'Preferred shares',
    assetClass: baseC.ASSET_CLASS.PREFERRED,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Perpetual preferred stock: bond-like coupons, equity-like subordination, and usually callable at par so '
      + 'the upside is capped. Issuance is dominated by banks and insurers, which makes this a concentrated bet on '
      + 'financials however diversified the fund looks.',
  },
  cef: {
    label: 'Closed-end fund',
    assetClass: baseC.ASSET_CLASS.CEF,
    taxTreatment: baseC.TAX_TREATMENT.MIXED,
    access: 'Use limit orders — closed-end fund spreads are wide and the price is not tied to NAV.',
    note: 'Closed-end funds trade at a premium or discount to NAV and most of them use leverage. A large headline '
      + 'distribution is not evidence of income: part of it can be return of your own capital. Check the fund\'s '
      + 'Section 19a notice and its premium to NAV before buying — neither is available from this price feed.',
  },
  ultrashort: {
    label: 'Ultra-short / cash equivalent',
    assetClass: baseC.ASSET_CLASS.GOVT_BOND,
    taxTreatment: baseC.TAX_TREATMENT.TREASURY,
    note: 'Cash equivalent. Duration is measured in weeks, so the price barely moves and the distribution simply '
      + 'tracks short rates — which also means the yield resets down the moment the Fed cuts.',
  },
  user: {
    label: 'User-added symbol',
    assetClass: baseC.ASSET_CLASS.ETF,
    taxTreatment: baseC.TAX_TREATMENT.MIXED,
    note: 'Added by you. Asset class and tax treatment are assumptions, not lookups — set "category" on the entry in '
      + 'settings to classify it properly.',
  },
};

/**
 * THE UNIVERSE. Edit freely: adding a ticker here is the whole job of extending
 * this source. `leverage` is total assets / net assets, an approximate structural
 * constant maintained by hand — it exists so risk.js can see that a 13% BDC yield
 * is a levered 6% one, and it is not a live figure. `expenseRatio` is the fund's
 * published net ratio and is null for operating companies (REITs, BDCs, mREITs),
 * which report fees inside earnings instead.
 */
const UNIVERSE = {
  covered_call: [
    { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF', issuer: 'J.P. Morgan Asset Management', expenseRatio: 0.35 },
    { symbol: 'JEPQ', name: 'JPMorgan Nasdaq Equity Premium Income ETF', issuer: 'J.P. Morgan Asset Management', expenseRatio: 0.35 },
    { symbol: 'QYLD', name: 'Global X Nasdaq 100 Covered Call ETF', issuer: 'Global X', expenseRatio: 0.61 },
    { symbol: 'XYLD', name: 'Global X S&P 500 Covered Call ETF', issuer: 'Global X', expenseRatio: 0.60 },
    { symbol: 'RYLD', name: 'Global X Russell 2000 Covered Call ETF', issuer: 'Global X', expenseRatio: 0.60 },
    { symbol: 'DIVO', name: 'Amplify CWP Enhanced Dividend Income ETF', issuer: 'Amplify ETFs', expenseRatio: 0.56 },
    { symbol: 'SPYI', name: 'NEOS S&P 500 High Income ETF', issuer: 'NEOS Investments', expenseRatio: 0.68 },
    { symbol: 'QQQI', name: 'NEOS Nasdaq-100 High Income ETF', issuer: 'NEOS Investments', expenseRatio: 0.68 },
    { symbol: 'GPIX', name: 'Goldman Sachs S&P 500 Core Premium Income ETF', issuer: 'Goldman Sachs', expenseRatio: 0.29 },
  ],
  bond_etf: [
    { symbol: 'HYG', name: 'iShares iBoxx $ High Yield Corporate Bond ETF', issuer: 'iShares', expenseRatio: 0.49, creditRating: 'BB-' },
    { symbol: 'JNK', name: 'SPDR Bloomberg High Yield Bond ETF', issuer: 'State Street SPDR', expenseRatio: 0.40, creditRating: 'BB-' },
    { symbol: 'USHY', name: 'iShares Broad USD High Yield Corporate Bond ETF', issuer: 'iShares', expenseRatio: 0.08, creditRating: 'B+' },
    { symbol: 'LQD', name: 'iShares iBoxx $ Investment Grade Corporate Bond ETF', issuer: 'iShares', expenseRatio: 0.14, creditRating: 'BBB+' },
    { symbol: 'VCIT', name: 'Vanguard Intermediate-Term Corporate Bond ETF', issuer: 'Vanguard', expenseRatio: 0.03, creditRating: 'BBB+' },
    { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', issuer: 'Vanguard', expenseRatio: 0.03, creditRating: 'AA' },
    { symbol: 'EMB', name: 'iShares J.P. Morgan USD Emerging Markets Bond ETF', issuer: 'iShares', expenseRatio: 0.39, creditRating: 'BBB-',
      note: 'Emerging-market sovereign and quasi-sovereign debt in dollars. Classified as corporate credit rather than government here '
        + 'because the default risk is real — a US Treasury baseline would badly understate it.' },
    { symbol: 'SRLN', name: 'SPDR Blackstone Senior Loan ETF', issuer: 'State Street SPDR', expenseRatio: 0.70, creditRating: 'B+',
      note: 'Floating-rate senior bank loans. Little duration risk, plenty of credit risk, and the underlying loans settle slowly — '
        + 'which is exactly the mismatch that makes loan funds gap down in a rush for the exit.' },
    { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', issuer: 'iShares', expenseRatio: 0.15,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, taxTreatment: baseC.TAX_TREATMENT.TREASURY, insurance: baseC.INSURANCE.NONE,
      note: 'No credit risk at all, and roughly 16 years of duration — a 1% move in long rates moves this fund about 16%. The measured '
        + 'volatility below is that duration, not default risk.' },
    { symbol: 'IEF', name: 'iShares 7-10 Year Treasury Bond ETF', issuer: 'iShares', expenseRatio: 0.15,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, taxTreatment: baseC.TAX_TREATMENT.TREASURY, insurance: baseC.INSURANCE.NONE },
    { symbol: 'MUB', name: 'iShares National Muni Bond ETF', issuer: 'iShares', expenseRatio: 0.07,
      assetClass: baseC.ASSET_CLASS.MUNI_BOND, taxTreatment: baseC.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT, creditRating: 'AA' },
    { symbol: 'VTEB', name: 'Vanguard Tax-Exempt Bond ETF', issuer: 'Vanguard', expenseRatio: 0.05,
      assetClass: baseC.ASSET_CLASS.MUNI_BOND, taxTreatment: baseC.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT, creditRating: 'AA' },
    { symbol: 'HYD', name: 'VanEck High Yield Muni ETF', issuer: 'VanEck', expenseRatio: 0.32,
      assetClass: baseC.ASSET_CLASS.MUNI_BOND, taxTreatment: baseC.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT, creditRating: 'BB' },
  ],
  dividend_etf: [
    { symbol: 'SCHD', name: 'Schwab U.S. Dividend Equity ETF', issuer: 'Charles Schwab', expenseRatio: 0.06 },
    { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF', issuer: 'Vanguard', expenseRatio: 0.06 },
    { symbol: 'HDV', name: 'iShares Core High Dividend ETF', issuer: 'iShares', expenseRatio: 0.08 },
    { symbol: 'DVY', name: 'iShares Select Dividend ETF', issuer: 'iShares', expenseRatio: 0.38 },
    { symbol: 'SPYD', name: 'SPDR Portfolio S&P 500 High Dividend ETF', issuer: 'State Street SPDR', expenseRatio: 0.07 },
    { symbol: 'DGRO', name: 'iShares Core Dividend Growth ETF', issuer: 'iShares', expenseRatio: 0.08 },
    { symbol: 'SPHD', name: 'Invesco S&P 500 High Dividend Low Volatility ETF', issuer: 'Invesco', expenseRatio: 0.30 },
  ],
  reit: [
    { symbol: 'VNQ', name: 'Vanguard Real Estate ETF', issuer: 'Vanguard', expenseRatio: 0.13 },
    { symbol: 'O', name: 'Realty Income Corporation', issuer: 'Realty Income Corporation' },
    { symbol: 'SPG', name: 'Simon Property Group, Inc.', issuer: 'Simon Property Group, Inc.' },
    { symbol: 'WPC', name: 'W. P. Carey Inc.', issuer: 'W. P. Carey Inc.' },
    { symbol: 'STAG', name: 'STAG Industrial, Inc.', issuer: 'STAG Industrial, Inc.' },
    { symbol: 'NNN', name: 'NNN REIT, Inc.', issuer: 'NNN REIT, Inc.' },
    { symbol: 'EPR', name: 'EPR Properties', issuer: 'EPR Properties',
      note: 'Experiential real estate — cinemas, attractions, eat-and-play. The tenant base is the risk, as the 2020 suspension showed.' },
    { symbol: 'VICI', name: 'VICI Properties Inc.', issuer: 'VICI Properties Inc.' },
    { symbol: 'ADC', name: 'Agree Realty Corporation', issuer: 'Agree Realty Corporation' },
    { symbol: 'MPW', name: 'Medical Properties Trust, Inc.', issuer: 'Medical Properties Trust, Inc.',
      note: 'Hospital landlord with a history of tenant failures and dividend cuts. A high trailing yield here is largely a fallen '
        + 'share price, not a rising payout — check what the dividend actually is now before trusting the trailing figure.' },
  ],
  mortgage_reit: [
    { symbol: 'AGNC', name: 'AGNC Investment Corp.', issuer: 'AGNC Investment Corp.', leverage: 8.0 },
    { symbol: 'NLY', name: 'Annaly Capital Management, Inc.', issuer: 'Annaly Capital Management, Inc.', leverage: 6.5 },
    { symbol: 'STWD', name: 'Starwood Property Trust, Inc.', issuer: 'Starwood Property Trust, Inc.', leverage: 2.4 },
    { symbol: 'ABR', name: 'Arbor Realty Trust, Inc.', issuer: 'Arbor Realty Trust, Inc.', leverage: 3.0 },
    { symbol: 'RITM', name: 'Rithm Capital Corp.', issuer: 'Rithm Capital Corp.', leverage: 3.0 },
    { symbol: 'ARR', name: 'ARMOUR Residential REIT, Inc.', issuer: 'ARMOUR Residential REIT, Inc.', leverage: 8.0,
      note: 'Monthly payer with a long record of dividend cuts and reverse splits. The distribution rate and the total return have '
        + 'pointed in opposite directions for most of this fund\'s life.' },
    { symbol: 'REM', name: 'iShares Mortgage Real Estate ETF', issuer: 'iShares', expenseRatio: 0.48,
      note: 'The ETF itself borrows nothing, but every holding inside it runs several turns of repo leverage, so the leverage is '
        + 'there whether or not it shows on this fund\'s own balance sheet.' },
  ],
  bdc: [
    { symbol: 'ARCC', name: 'Ares Capital Corporation', issuer: 'Ares Capital Corporation', leverage: 2.0 },
    { symbol: 'MAIN', name: 'Main Street Capital Corporation', issuer: 'Main Street Capital Corporation', leverage: 1.8 },
    { symbol: 'OBDC', name: 'Blue Owl Capital Corporation', issuer: 'Blue Owl Capital Corporation', leverage: 2.1 },
    { symbol: 'FSK', name: 'FS KKR Capital Corp.', issuer: 'FS KKR Capital Corp.', leverage: 2.1 },
    { symbol: 'HTGC', name: 'Hercules Capital, Inc.', issuer: 'Hercules Capital, Inc.', leverage: 1.9 },
    { symbol: 'PSEC', name: 'Prospect Capital Corporation', issuer: 'Prospect Capital Corporation', leverage: 1.6,
      note: 'Monthly payer whose distribution has been cut repeatedly and has for years exceeded net investment income. The headline '
        + 'yield is the clearest example in this list of a number that is high because the price fell.' },
    { symbol: 'TSLX', name: 'Sixth Street Specialty Lending, Inc.', issuer: 'Sixth Street Specialty Lending, Inc.', leverage: 2.1 },
    { symbol: 'BXSL', name: 'Blackstone Secured Lending Fund', issuer: 'Blackstone Secured Lending Fund', leverage: 2.1 },
    { symbol: 'BIZD', name: 'VanEck BDC Income ETF', issuer: 'VanEck', expenseRatio: 0.40,
      note: 'The 0.40% management fee is not the cost. Acquired fund fees from the underlying BDCs push the all-in expense past 10%, '
        + 'which is disclosed but never printed on the fact sheet headline.' },
  ],
  preferred: [
    { symbol: 'PFF', name: 'iShares Preferred and Income Securities ETF', issuer: 'iShares', expenseRatio: 0.46 },
    { symbol: 'PGX', name: 'Invesco Preferred ETF', issuer: 'Invesco', expenseRatio: 0.50 },
    { symbol: 'PFFD', name: 'Global X U.S. Preferred ETF', issuer: 'Global X', expenseRatio: 0.23 },
    { symbol: 'PSK', name: 'SPDR ICE Preferred Securities ETF', issuer: 'State Street SPDR', expenseRatio: 0.45 },
    { symbol: 'FPE', name: 'First Trust Preferred Securities and Income ETF', issuer: 'First Trust', expenseRatio: 0.85 },
  ],
  cef: [
    { symbol: 'PDI', name: 'PIMCO Dynamic Income Fund', issuer: 'PIMCO', expenseRatio: 1.90, leverage: 1.40 },
    { symbol: 'PTY', name: 'PIMCO Corporate & Income Opportunity Fund', issuer: 'PIMCO', expenseRatio: 1.80, leverage: 1.40 },
    { symbol: 'GOF', name: 'Guggenheim Strategic Opportunities Fund', issuer: 'Guggenheim Investments', expenseRatio: 1.90, leverage: 1.35 },
    { symbol: 'UTG', name: 'Reaves Utility Income Fund', issuer: 'Reaves Asset Management', expenseRatio: 1.40, leverage: 1.25 },
    { symbol: 'BST', name: 'BlackRock Science and Technology Trust', issuer: 'BlackRock', expenseRatio: 1.05 },
    { symbol: 'ECC', name: 'Eagle Point Credit Company Inc.', issuer: 'Eagle Point Credit Management', expenseRatio: 3.50, leverage: 1.35,
      note: 'Holds CLO equity — the first-loss tranche of leveraged loan pools. That is where the 15-20% headline comes from and also '
        + 'where the principal goes in a default cycle. NAV per share has trended down for years while the payout stayed up.' },
    { symbol: 'OXLC', name: 'Oxford Lane Capital Corp.', issuer: 'Oxford Lane Management', expenseRatio: 3.40, leverage: 1.35,
      note: 'CLO equity again, historically issued into a persistent premium to NAV. Buying above NAV means your distribution is partly '
        + 'financed by the next buyer.' },
    { symbol: 'DNP', name: 'DNP Select Income Fund Inc.', issuer: 'Duff & Phelps', expenseRatio: 1.70, leverage: 1.30,
      note: 'Has traded at a large, durable premium to NAV for decades, and a meaningful share of the monthly payout has been return '
        + 'of capital.' },
  ],
  ultrashort: [
    { symbol: 'SGOV', name: 'iShares 0-3 Month Treasury Bond ETF', issuer: 'iShares', expenseRatio: 0.09, insurance: baseC.INSURANCE.NONE },
    { symbol: 'BIL', name: 'SPDR Bloomberg 1-3 Month T-Bill ETF', issuer: 'State Street SPDR', expenseRatio: 0.1356, insurance: baseC.INSURANCE.NONE },
    { symbol: 'SHV', name: 'iShares Short Treasury Bond ETF', issuer: 'iShares', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'USFR', name: 'WisdomTree Floating Rate Treasury Fund', issuer: 'WisdomTree', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'TFLO', name: 'iShares Treasury Floating Rate Bond ETF', issuer: 'iShares', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'JAAA', name: 'Janus Henderson AAA CLO ETF', issuer: 'Janus Henderson', expenseRatio: 0.21, creditRating: 'AAA',
      assetClass: baseC.ASSET_CLASS.CORP_BOND, taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
      note: 'AAA CLO tranches, not Treasuries: the interest is fully taxable in your state and the paper is structured credit. It has '
        + 'never taken a loss at the AAA level, which is a strong record and not a guarantee.' },
    { symbol: 'ICSH', name: 'iShares Ultra Short-Term Bond ETF', issuer: 'iShares', expenseRatio: 0.08, creditRating: 'A',
      assetClass: baseC.ASSET_CLASS.CORP_BOND, taxTreatment: baseC.TAX_TREATMENT.ORDINARY },
  ],
};

// Stamp each entry with the group it was declared in, so a bare UNIVERSE entry
// is self-describing wherever it travels — buildOpportunity is exported and must
// not silently downgrade a fund to "user-added" just because it was handed the
// raw table instead of a resolved one.
for (const [category, list] of Object.entries(UNIVERSE)) {
  for (const e of list) e.category = category;
}

/** Merge the built-in universe with anything the user added in settings. */
function resolveUniverse(settings = {}) {
  const cfg = settings?.sources?.funds || settings?.funds || {};
  const out = new Map();

  for (const list of Object.values(UNIVERSE)) {
    for (const e of list) out.set(e.symbol, { ...e });
  }

  const extras = [].concat(
    Array.isArray(settings?.extraSymbols) ? settings.extraSymbols : [],
    Array.isArray(cfg.symbols) ? cfg.symbols : [],
  );
  for (const raw of extras) {
    const e = typeof raw === 'string' ? { symbol: raw } : (raw && typeof raw === 'object' ? raw : null);
    const symbol = String(e?.symbol || '').trim().toUpperCase();
    // Ticker-shaped only. A junk string becomes a URL we then wait 20s to fail on.
    if (!symbol || !/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(symbol)) continue;
    const known = out.get(symbol);
    if (known && !e.category) continue;               // we already classify it better than a bare string does
    const category = CATEGORIES[e.category] ? e.category : (known?.category || 'user');
    out.set(symbol, { ...(known || {}), ...e, symbol, category, userAdded: true });
  }

  const exclude = new Set((Array.isArray(cfg.exclude) ? cfg.exclude : []).map((s) => String(s).trim().toUpperCase()));
  return [...out.values()].filter((e) => !exclude.has(e.symbol));
}

// ---------------------------------------------------------------------------
// Pure computation. No network, no clock — everything below is unit tested
// against hand-authored fixtures and closed-form expectations.
// ---------------------------------------------------------------------------

/**
 * Payout frequency from the MEDIAN gap between ex-dates.
 *
 * Median rather than mean because a single year-end special distribution — which
 * quarterly payers do constantly — drags a mean far enough to reclassify the fund
 * and then forward yield is annualised by the wrong multiple.
 */
const FREQUENCIES = [
  { maxDays: 10, periodsPerYear: 52, label: 'weekly' },
  { maxDays: 45, periodsPerYear: 12, label: 'monthly' },
  { maxDays: 135, periodsPerYear: 4, label: 'quarterly' },
  { maxDays: 250, periodsPerYear: 2, label: 'semiannual' },
  { maxDays: Infinity, periodsPerYear: 1, label: 'annual' },
];

function detectFrequency(timestamps) {
  const ts = (Array.isArray(timestamps) ? timestamps : [])
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < ts.length; i += 1) {
    const d = (ts[i] - ts[i - 1]) / DAY;
    if (d > 0.5) gaps.push(d);                        // same-day pairs are one payment split in two records
  }
  if (!gaps.length) return null;

  gaps.sort((a, b) => a - b);
  const mid = gaps.length % 2
    ? gaps[(gaps.length - 1) / 2]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

  const hit = FREQUENCIES.find((f) => mid <= f.maxDays);
  return { periodsPerYear: hit.periodsPerYear, label: hit.label, medianSpacingDays: mid, samples: gaps.length };
}

/**
 * Trailing and forward yield from a dividend stream and a current price.
 *
 * Trailing is what the fund actually paid over the last 365 days on today's
 * price — the honest backward-looking number, and what we rank on. Forward
 * annualises only the most recent payment, which is right for a fund that just
 * raised its rate and flattering nonsense for a variable payer that happened to
 * have one good month.
 */
function computeYield({ dividends = [], price, nowMs = Date.now(), windowDays = 365 } = {}) {
  const out = {
    trailingYield: null, forwardYield: null, periodsPerYear: null, payoutFrequency: null,
    medianSpacingDays: null, dividendCount: 0, trailingSum: null, lastDividend: null,
    partialHistory: false, notes: [],
  };

  const divs = (Array.isArray(dividends) ? dividends : [])
    .map((d) => ({ ts: num(d?.ts), amount: num(d?.amount) }))
    .filter((d) => d.ts !== null && d.amount !== null && d.amount > 0)
    .sort((a, b) => a.ts - b.ts);

  const freq = detectFrequency(divs.map((d) => d.ts));
  if (freq) {
    out.periodsPerYear = freq.periodsPerYear;
    out.payoutFrequency = freq.label;
    out.medianSpacingDays = freq.medianSpacingDays;
  }

  if (!divs.length) {
    out.notes.push('No dividend events in the response, so no yield could be computed.');
    return out;
  }
  const p = num(price);
  if (p === null || p <= 0) {
    out.notes.push('No usable price, so no yield could be computed.');
    return out;
  }

  const cutoff = nowMs - windowDays * DAY;
  const window = divs.filter((d) => d.ts > cutoff && d.ts <= nowMs);
  out.dividendCount = window.length;
  out.trailingSum = window.reduce((s, d) => s + d.amount, 0);
  out.trailingYield = (out.trailingSum / p) * 100;

  const last = divs[divs.length - 1];
  out.lastDividend = last;
  if (out.periodsPerYear) out.forwardYield = ((last.amount * out.periodsPerYear) / p) * 100;

  if (!window.length) {
    out.partialHistory = true;
    out.notes.push('Paid nothing in the last 12 months — the trailing yield of 0% is real, not a data gap.');
  } else if (out.periodsPerYear) {
    // A monthly payer with two prints in a year is a listing that is younger than
    // the window, not a 1.5% fund. Flag it rather than publishing the fraction.
    const expected = Math.max(2, Math.round(out.periodsPerYear * 0.6));
    if (window.length < expected) {
      out.partialHistory = true;
      out.notes.push(`Only ${window.length} distribution${window.length === 1 ? '' : 's'} in the last ${windowDays} days `
        + `for a ${out.payoutFrequency} payer — the trailing figure covers less than a full year and understates the run rate.`);
    }
  }

  return out;
}

/**
 * Annualised volatility of daily log returns, in percent.
 *
 * Uses adjusted close so distributions do not read as price drops — for a fund
 * paying 12% a year that error alone would add several points of phantom vol.
 * Missing bars are bridged rather than treated as zero-return days, which is
 * marginally wrong on the handful of halted sessions and very wrong the other way.
 */
function computeVolatility(values, { periodsPerYear = 252, minReturns = 20 } = {}) {
  const px = (Array.isArray(values) ? values : []).map(num).filter((v) => v !== null && v > 0);
  if (px.length < minReturns + 1) return null;

  const rets = [];
  let discarded = 0;
  for (let i = 1; i < px.length; i += 1) {
    const r = Math.log(px[i] / px[i - 1]);
    // A ±100% log move in an income fund is an unadjusted split, not a market day.
    if (Math.abs(r) > 1) { discarded += 1; continue; }
    rets.push(r);
  }
  if (rets.length < minReturns) return null;

  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
  return Number.isFinite(vol) ? { volatility: vol, returns: rets.length, discarded } : null;
}

/** Worst peak-to-trough decline over the window, as a positive percent. */
function computeMaxDrawdown(values) {
  const px = (Array.isArray(values) ? values : []).map(num).filter((v) => v !== null && v > 0);
  if (px.length < 2) return null;
  let peak = px[0];
  let worst = 0;
  for (const v of px) {
    if (v > peak) peak = v;
    const dd = ((peak - v) / peak) * 100;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/**
 * Yahoo chart payload -> a flat series we can compute on.
 * Returns null (never throws) for anything that is not a usable chart response.
 */
function parseChart(payload) {
  const chart = payload?.chart;
  if (!chart) return null;
  if (chart.error) {
    const e = chart.error;
    return { error: `${e?.code || 'error'}: ${e?.description || 'chart endpoint returned an error'}` };
  }
  const r = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!r) return null;

  const timestamps = Array.isArray(r.timestamp) ? r.timestamp.map(num) : [];
  const quote = Array.isArray(r.indicators?.quote) ? r.indicators.quote[0] : null;
  const adjBlock = Array.isArray(r.indicators?.adjclose) ? r.indicators.adjclose[0] : null;

  const close = Array.isArray(quote?.close) ? quote.close.map(num) : [];
  // adjclose is the one that matters; fall back to raw close so a response that
  // omits the block still yields volatility, just slightly overstated.
  const adjRaw = Array.isArray(adjBlock?.adjclose) ? adjBlock.adjclose.map(num) : [];
  const adj = adjRaw.length ? adjRaw : close;
  const volume = Array.isArray(quote?.volume) ? quote.volume.map(num) : [];

  const dividends = [];
  const divEvents = r.events?.dividends;
  const divList = Array.isArray(divEvents)
    ? divEvents
    : (divEvents && typeof divEvents === 'object' ? Object.entries(divEvents) : []);
  for (const item of divList) {
    // Keyed object -> [unixKey, {amount, date}]; array form -> {amount, date}.
    const [key, rec] = Array.isArray(item) ? item : [null, item];
    const amount = num(rec?.amount);
    const secs = num(rec?.date) ?? num(key);
    if (amount === null || secs === null || amount <= 0) continue;
    dividends.push({ ts: secs * 1000, amount });
  }
  dividends.sort((a, b) => a.ts - b.ts);

  const lastClose = [...close].reverse().find((v) => v !== null && v > 0) ?? null;
  const lastAdj = [...adj].reverse().find((v) => v !== null && v > 0) ?? null;
  const price = num(r.meta?.regularMarketPrice) ?? lastClose;

  const lastTs = [...timestamps].reverse().find((v) => v !== null) ?? null;

  return {
    symbol: r.meta?.symbol ? String(r.meta.symbol) : null,
    currency: r.meta?.currency ? String(r.meta.currency).toUpperCase() : null,
    price,
    priceFromMeta: num(r.meta?.regularMarketPrice) !== null,
    lastClose,
    lastAdj,
    lastTsMs: lastTs === null ? null : lastTs * 1000,
    adj: adj.filter((v) => v !== null && v > 0),
    volume: volume.filter((v) => v !== null && v >= 0),
    adjustedForDividends: adjRaw.length > 0,
    dividends,
  };
}

/** Stooq daily CSV -> the same flat series, minus the dividends it does not carry. */
function parseStooq(csvText, parseCSV = baseHttp.parseCSV) {
  let rows;
  try {
    rows = parseCSV(String(csvText || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;

  const series = [];
  for (const row of rows) {
    const close = num(row?.Close ?? row?.close);
    const ts = Date.parse(`${String(row?.Date ?? row?.date ?? '').trim()}T00:00:00Z`);
    if (close === null || close <= 0 || !Number.isFinite(ts)) continue;
    series.push({ ts, close, volume: num(row?.Volume ?? row?.volume) ?? 0 });
  }
  if (series.length < 2) return null;
  series.sort((a, b) => a.ts - b.ts);

  const last = series[series.length - 1];
  return {
    symbol: null,
    currency: 'USD',
    price: last.close,
    priceFromMeta: false,
    lastClose: last.close,
    lastAdj: last.close,
    lastTsMs: last.ts,
    adj: series.map((s) => s.close),
    volume: series.map((s) => s.volume),
    adjustedForDividends: false,
    dividends: [],
  };
}

/** Median, used for typical daily volume so one frantic session does not set it. */
function median(list) {
  const v = list.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/** Series -> the numbers an opportunity row needs. Pure. */
function analyzeSeries(series, { nowMs = Date.now(), fallbackYield = null } = {}) {
  const stats = {
    price: null, currency: null, trailingYield: null, forwardYield: null,
    payoutFrequency: null, periodsPerYear: null, dividendCount: 0,
    volatility: null, maxDrawdown: null, dollarVolume: null,
    yieldSource: 'measured', partialHistory: false, dataAsOf: null, notes: [],
  };
  if (!series || series.error) {
    if (series?.error) stats.notes.push(series.error);
    return stats;
  }

  stats.price = num(series.price);
  stats.currency = series.currency || 'USD';
  stats.dataAsOf = Number.isFinite(series.lastTsMs) ? new Date(series.lastTsMs).toISOString() : null;

  const vol = computeVolatility(series.adj);
  if (vol) {
    stats.volatility = vol.volatility;
    if (vol.discarded) stats.notes.push(`${vol.discarded} implausible daily move(s) dropped as bad data.`);
    if (!series.adjustedForDividends) {
      stats.notes.push('Price series is not dividend-adjusted, so volatility and drawdown are slightly overstated.');
    }
  }
  stats.maxDrawdown = computeMaxDrawdown(series.adj);

  const y = computeYield({ dividends: series.dividends, price: stats.price, nowMs });
  stats.trailingYield = y.trailingYield;
  stats.forwardYield = y.forwardYield;
  stats.payoutFrequency = y.payoutFrequency;
  stats.periodsPerYear = y.periodsPerYear;
  stats.dividendCount = y.dividendCount;
  stats.partialHistory = y.partialHistory;
  stats.notes.push(...y.notes);

  // Price feed with no dividend stream (the Stooq fallback): a remembered yield
  // on a measured price is still useful, but it is a weaker claim and says so.
  if (stats.trailingYield === null && Number.isFinite(num(fallbackYield))) {
    stats.trailingYield = num(fallbackYield);
    stats.yieldSource = 'seed';
    stats.notes.push('Price is live but the feed carried no dividend events, so the yield is the bundled snapshot figure.');
  }

  const vols = series.volume?.slice(-30) || [];
  const medVol = median(vols);
  if (medVol !== null && stats.price) stats.dollarVolume = medVol * stats.price;

  return stats;
}

/** One universe entry plus its measured stats -> one normalized opportunity. */
function buildOpportunity(entry, stats, { schema = baseSchema, C = baseC, dataAsOf = null, seed = false } = {}) {
  const cat = CATEGORIES[entry?.category] || CATEGORIES.user;
  const symbol = String(entry?.symbol || '').toUpperCase();
  const trailing = num(stats?.trailingYield);
  if (!symbol || trailing === null) return null;      // no headline rate is not an opportunity

  const price = num(stats?.price);
  const assetClass = entry.assetClass || cat.assetClass;
  const taxTreatment = entry.taxTreatment || cat.taxTreatment;

  const notes = [cat.note];
  if (entry.note) notes.push(entry.note);
  if (Number.isFinite(num(stats?.forwardYield)) && Math.abs(stats.forwardYield - trailing) > 1) {
    notes.push(`Headline is the trailing 12-month yield (${trailing.toFixed(2)}%). Annualising the latest payment instead `
      + `gives ${stats.forwardYield.toFixed(2)}% — the gap is the payout changing, not free money.`);
  }
  if (['cef', 'bdc', 'mortgage_reit'].includes(entry.category)) {
    notes.push('Premium/discount to NAV, return-of-capital share and distribution coverage are left blank rather than '
      + 'guessed: the price feed does not carry them. Look them up before treating this yield as income.');
  }
  if (Array.isArray(stats?.notes) && stats.notes.length) notes.push(...stats.notes);

  let confidence;
  if (!seed) {
    if (stats?.yieldSource === 'seed') confidence = 0.45;
    else if (stats?.partialHistory) confidence = 0.5;
    else confidence = 0.88;                            // distributions actually paid, on a live price
  }

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: symbol,
    symbol,
    name: entry.name || symbol,
    provider: entry.issuer || entry.name || null,
    assetClass,
    subType: entry.category,
    region: 'US',
    currency: stats?.currency || 'USD',

    apy: { total: trailing, forward: num(stats?.forwardYield) },
    yieldKind: C.YIELD_KIND.TRAILING,
    payoutFrequency: stats?.payoutFrequency || entry.payoutFrequency || null,

    // Open-ended and exchange traded: no maturity, no lockup, sell any session.
    term: { days: null },
    liquidity: C.LIQUIDITY.DAILY,

    price,
    minInvestment: price,                              // one share
    volume: num(stats?.dollarVolume),

    expenseRatio: num(entry.expenseRatio),
    // Only where defensible. A fabricated ROC share would feed traps.js a lie.
    rocShare: null,
    navPremium: null,
    payoutCoverage: null,

    risk: {
      insurance: entry.insurance || C.INSURANCE.SIPC,
      principalAtRisk: true,
      creditRating: entry.creditRating || null,
      volatility: num(stats?.volatility),
      maxDrawdown: num(stats?.maxDrawdown),
      leverage: num(entry.leverage),
    },

    taxTreatment,
    url: quotePage(symbol),
    notes: notes.filter(Boolean).join(' '),
    accessNotes: cat.access ? `${ACCESS_NOTES} ${cat.access}` : ACCESS_NOTES,
    requirements: ['Brokerage account'],
    dataAsOf: dataAsOf || stats?.dataAsOf || null,
    seed: !!seed,
  };
  if (confidence !== undefined) row.confidence = confidence;

  return schema.normalize(row, { source: ID, seed: !!seed });
}

/**
 * PURE ENTRY POINT: [{ entry, stats }] -> opportunities. Both the live path and
 * the seed path funnel through here so a mapping change cannot drift between them.
 */
function buildAll(rows, opts = {}) {
  const opportunities = [];
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const o = buildOpportunity(row?.entry, row?.stats, opts);
      if (o) opportunities.push(o);
      else skipped.push(String(row?.entry?.symbol || '?'));
    } catch {
      skipped.push(String(row?.entry?.symbol || '?'));  // one bad symbol never takes the source down
    }
  }
  return { opportunities, skipped };
}

// ---------------------------------------------------------------------------
// Network path
// ---------------------------------------------------------------------------

/** Run `worker` over `items` with at most `limit` in flight. Never rejects. */
async function mapLimited(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

const errText = (err) => (err?.status ? `HTTP ${err.status}` : err?.message || String(err));

/**
 * One symbol: Yahoo query1, then query2, then Stooq.
 *
 * The two Yahoo hosts are the same service behind different load balancers, so a
 * failure on one is usually transient and worth exactly one more try. Stooq is a
 * different provider and a genuine degradation — prices only.
 */
async function fetchSymbol(ctx, entry) {
  const http = ctx.http || baseHttp;
  const attempts = [];

  for (const host of CHART_HOSTS) {
    if (ctx.signal?.aborted) return { entry, series: null, attempts, aborted: true };
    try {
      const payload = await http.getJSON(chartUrl(host, entry.symbol), {
        signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 3,
      });
      const series = parseChart(payload);
      if (series && !series.error && (series.price !== null || series.adj?.length)) {
        return { entry, series, via: 'yahoo' };
      }
      attempts.push(`${new URL(host).host}: ${series?.error || 'unusable response shape'}`);
    } catch (err) {
      attempts.push(`${new URL(host).host}: ${errText(err)}`);
    }
  }

  if (ctx.signal?.aborted) return { entry, series: null, attempts, aborted: true };
  try {
    const csv = await http.getText(stooqUrl(entry.symbol), {
      signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 3,
    });
    const series = parseStooq(csv, http.parseCSV);
    if (series) return { entry, series, via: 'stooq', attempts };
    attempts.push('stooq.com: no usable rows');
  } catch (err) {
    attempts.push(`stooq.com: ${errText(err)}`);
  }

  return { entry, series: null, attempts };
}

/** Symbol -> trailing yield from the bundled seed, for the Stooq fallback path. */
function seedYieldIndex(seedDir) {
  const index = new Map();
  try {
    const { items } = contract.readSeed(seedDir, 'funds.json');
    for (const item of items) {
      const sym = String(item?.symbol || '').toUpperCase();
      const y = num(item?.trailingYield);
      if (sym && y !== null) index.set(sym, y);
    }
  } catch { /* the seed is a convenience here, not a requirement */ }
  return index;
}

async function fetchLive(ctx) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const nowMs = ctx.now || Date.now();
  const entries = resolveUniverse(ctx.settings || {});
  const notes = [];
  const warnings = [];

  if (!entries.length) {
    return contract.result({ status: 'failed', warnings: ['Fund universe is empty — every symbol was excluded in settings.'] });
  }

  ctx.log?.(`funds: fetching ${entries.length} symbols from the Yahoo chart endpoint`);
  const fallback = seedYieldIndex(ctx.seedDir);
  const results = await mapLimited(entries, 3, (entry) => fetchSymbol(ctx, entry));

  const rows = [];
  const failed = [];
  let viaStooq = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const res = results[i];
    if (!res || !res.series) {
      failed.push(`${entry.symbol} (${res?.attempts?.[0] || res?.error || 'no response'})`);
      continue;
    }
    const stats = analyzeSeries(res.series, { nowMs, fallbackYield: fallback.get(entry.symbol) ?? null });
    if (res.via === 'stooq') {
      viaStooq += 1;
      stats.notes.unshift('Yahoo was unavailable for this symbol; price came from Stooq.');
    }
    if (num(stats.trailingYield) === null) {
      failed.push(`${entry.symbol} (price ok, no dividend history)`);
      continue;
    }
    rows.push({ entry, stats });
  }

  const built = buildAll(rows, { schema, C, seed: false });

  notes.push(`${built.opportunities.length} of ${entries.length} symbols priced and yielded.`);
  if (viaStooq) notes.push(`${viaStooq} symbol(s) fell back to Stooq for price; their yields come from the bundled snapshot.`);
  if (built.skipped.length) notes.push(`${built.skipped.length} row(s) dropped while mapping: ${built.skipped.slice(0, 10).join(', ')}.`);
  if (failed.length) {
    notes.push(`${failed.length} symbol(s) unavailable this run: ${failed.slice(0, 15).join('; ')}${failed.length > 15 ? '; …' : ''}.`);
  }
  notes.push('Fund AUM, NAV premium and return-of-capital share are not in this feed and are left null rather than guessed.');

  if (!built.opportunities.length) {
    return contract.result({
      status: 'failed',
      notes,
      warnings: ['No fund symbol returned usable price and dividend data.'],
    });
  }

  // Some symbols always fail (delistings, ticker changes); that is a degraded
  // source, not a broken one, and the user should see which ones.
  const status = failed.length || viaStooq ? 'partial' : 'ok';
  if (failed.length > entries.length / 2) {
    warnings.push(`Over half the fund universe failed to load (${failed.length}/${entries.length}) — the price feed is probably blocked or down.`);
  }

  return contract.result({
    opportunities: built.opportunities,
    status,
    notes,
    warnings,
    fetchedAt: new Date(nowMs).toISOString(),
  });
}

async function fetch(ctx) {
  try {
    return await fetchLive(ctx || {});
  } catch (err) {
    return contract.failure(err);
  }
}

// ---------------------------------------------------------------------------
// Seed path
// ---------------------------------------------------------------------------

function loadSeed(ctx) {
  try {
    const schema = ctx?.schema || baseSchema;
    const C = ctx?.C || baseC;
    const { items, meta } = contract.readSeed(ctx?.seedDir, 'funds.json');
    const dataAsOf = meta?.dataAsOf || '2026-08-01';

    // Seed rows carry a symbol; the universe carries everything else, so a fee or
    // classification fix in one place applies to both the offline and live rows.
    const known = new Map();
    for (const list of Object.values(UNIVERSE)) {
      for (const e of list) known.set(e.symbol, e);
    }

    const rows = [];
    let unknown = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const symbol = String(item?.symbol || '').trim().toUpperCase();
      const entry = known.get(symbol);
      if (!entry) { unknown += 1; continue; }
      const trailing = num(item?.trailingYield);
      if (trailing === null) { unknown += 1; continue; }
      rows.push({
        entry,
        stats: {
          price: num(item?.price),
          currency: 'USD',
          trailingYield: trailing,
          forwardYield: num(item?.forwardYield),
          payoutFrequency: item?.payoutFrequency || null,
          volatility: num(item?.volatility),
          maxDrawdown: num(item?.maxDrawdown),
          dollarVolume: null,
          yieldSource: 'seed',
          partialHistory: false,
          notes: [],
        },
      });
    }

    const built = buildAll(rows, { schema, C, dataAsOf, seed: true });
    if (!built.opportunities.length) {
      return contract.result({ status: 'failed', warnings: ['Bundled fund seed is missing or unreadable.'] });
    }

    const notes = [
      `Bundled snapshot of ${built.opportunities.length} income funds as of ${dataAsOf}. Prices and yields are approximate `
      + 'round figures for that date, not quotes — refresh before acting on any of them.',
      'Volatility and drawdown in this snapshot are typical figures for each fund, replaced by measured values on refresh.',
    ];
    if (unknown) notes.push(`${unknown} seed row(s) skipped: not in the universe, or missing a yield.`);
    if (built.skipped.length) notes.push(`${built.skipped.length} seed row(s) dropped while mapping.`);

    return contract.result({ opportunities: built.opportunities, status: 'offline', notes });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Covered-call and bond ETFs, REITs, BDCs, preferreds and closed-end funds, with measured volatility and '
    + 'drawdown so the double-digit distributions can be judged on more than their size.',
  homepage: 'https://finance.yahoo.com',
  assetClasses: [
    baseC.ASSET_CLASS.ETF,
    baseC.ASSET_CLASS.CORP_BOND,
    baseC.ASSET_CLASS.GOVT_BOND,
    baseC.ASSET_CLASS.MUNI_BOND,
    baseC.ASSET_CLASS.DIVIDEND_EQUITY,
    baseC.ASSET_CLASS.REIT,
    baseC.ASSET_CLASS.BDC,
    baseC.ASSET_CLASS.PREFERRED,
    baseC.ASSET_CLASS.CEF,
  ],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 60 * 60 * 1000,          // distributions change monthly at most; prices, hourly is plenty

  fetch,
  loadSeed,

  // Exported for the tests, and for anyone extending the universe.
  UNIVERSE,
  CATEGORIES,
  resolveUniverse,
  detectFrequency,
  computeYield,
  computeVolatility,
  computeMaxDrawdown,
  parseChart,
  parseStooq,
  analyzeSeries,
  buildOpportunity,
  buildAll,
  chartUrl,
  stooqUrl,
};
