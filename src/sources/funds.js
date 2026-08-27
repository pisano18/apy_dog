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
const MAX_TIME = 8.64e15;       // the widest instant Date can represent

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

// Open-end mutual funds are a different purchase entirely and saying "trades
// like a stock" about one is simply wrong: there is no intraday price, the order
// fills at the next close whatever the market does in between, and most carry an
// account minimum that a share price does not tell you about.
const ACCESS_MUTUAL_FUND =
  'An open-end mutual fund, not an ETF. Buy it directly from the fund company or through a brokerage that carries it; '
  + 'orders fill at the next 4pm NAV rather than at a price you can see when you place them, and there is no intraday '
  + 'trading, no bid-ask spread and no limit order. Held in an IRA or 401(k) this is usually the default way to own it.';

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

  // --- the retirement end of the table -------------------------------------
  // These groups exist because the app has to be usable for the ordinary
  // question "where does my long-term money go", not only for the exotic one
  // "what pays 12%". Their yields are small on purpose, and schema.inferTrack
  // puts the low-yield ones on the movement track, which is correct: their
  // return is price, not income, and ranking them on a 1.1% dividend would say
  // something true and completely beside the point.
  core_index: {
    label: 'Broad core index fund',
    assetClass: baseC.ASSET_CLASS.ETF,
    taxTreatment: baseC.TAX_TREATMENT.QUALIFIED_DIVIDEND,
    note: 'A whole-market index fund. The dividend is a by-product, not the reason to own it — essentially all of the '
      + 'long-run return is price. It is in this table as the baseline every income product on the list has to beat on '
      + 'total return, not as a yield.',
  },
  target_date: {
    label: 'Target-date / all-in-one retirement fund',
    assetClass: baseC.ASSET_CLASS.ETF,
    taxTreatment: baseC.TAX_TREATMENT.MIXED,
    accessNotes: ACCESS_MUTUAL_FUND,
    note: 'One fund holding a whole portfolio, shifting from equities toward bonds as the target year approaches. The '
      + 'distribution rises along that glidepath, which is why the near-dated vintages yield more than the far ones — '
      + 'that is the fund changing shape, not a better deal. Payouts mix qualified dividends, ordinary interest and '
      + 'capital gains, so this is a fund to hold inside a retirement account where the mix does not matter.',
  },
  core_bond: {
    label: 'Core / aggregate bond fund',
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'The whole investment-grade bond market in one fund: mostly Treasuries and agency mortgages with a corporate '
      + 'sleeve. Around six years of duration, so a one-point move in yields is worth about six percent of the price in '
      + 'the opposite direction. It never matures, so that loss is only recovered if yields come back.',
  },
  tips: {
    label: 'Inflation-protected Treasury fund',
    assetClass: baseC.ASSET_CLASS.GOVT_BOND,
    taxTreatment: baseC.TAX_TREATMENT.TREASURY,
    note: 'Treasury inflation-protected securities. The distribution jumps around with CPI, so a trailing yield here is '
      + 'a worse guide than usual — what you are buying is the real yield plus whatever inflation turns out to be. Only '
      + 'beats a nominal Treasury if CPI runs above the breakeven, which the bonds source computes. The inflation '
      + 'adjustment is taxed in the year it accrues even though you do not receive it, so these belong in a tax-deferred '
      + 'account far more than most bond funds do.',
  },
  muni_state: {
    label: 'Single-state municipal fund',
    assetClass: baseC.ASSET_CLASS.MUNI_BOND,
    taxTreatment: baseC.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT,
    accessNotes: ACCESS_MUTUAL_FUND,
    note: 'Municipal bonds from one state. Federally exempt for anyone; the state exemption applies only if you live '
      + 'there, and this row deliberately claims only the federal one — overstating it would hand a non-resident a tax '
      + 'break they do not get. If you do live in the state, the real after-tax yield is higher than shown here.',
  },
  intl_income: {
    label: 'International / emerging-market dividend fund',
    assetClass: baseC.ASSET_CLASS.DIVIDEND_EQUITY,
    taxTreatment: baseC.TAX_TREATMENT.QUALIFIED_DIVIDEND,
    note: 'Dividends from companies outside the US, which structurally yield more than US ones because they pay out '
      + 'more of their earnings. Two catches: foreign governments withhold tax at source, recoverable as a foreign tax '
      + 'credit in a taxable account and simply lost inside an IRA; and the distribution moves with the dollar as well '
      + 'as with the dividend.',
  },
  em_debt: {
    label: 'Emerging-market bond fund',
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Sovereign and quasi-sovereign debt from developing countries. Filed as credit rather than government paper '
      + 'because the default risk is real and a Treasury baseline would badly understate it. Local-currency funds add a '
      + 'second, larger risk on top: the currency, which has historically driven more of the return than the coupon.',
  },
  infrastructure: {
    label: 'Utilities & infrastructure income',
    assetClass: baseC.ASSET_CLASS.DIVIDEND_EQUITY,
    taxTreatment: baseC.TAX_TREATMENT.QUALIFIED_DIVIDEND,
    note: 'Regulated utilities, pipelines, toll roads and airports — businesses with contracted or rate-regulated cash '
      + 'flows, which is why they pay out more than the market and move less. They are also long-duration equities: '
      + 'they fall when long rates rise, for the same arithmetic reason a bond does.',
  },
  senior_loan_clo: {
    label: 'Senior loan & CLO fund',
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Floating-rate leveraged loans, or the tranches of the CLOs that hold them. Almost no interest-rate duration '
      + 'and a great deal of credit risk, so the yield falls the moment the Fed cuts and the price falls when defaults '
      + 'rise. The AAA tranche has never taken a loss, which is a strong record and not a guarantee; the BB and equity '
      + 'tranches are where the double-digit numbers and the actual losses both live.',
  },
  money_market_etf: {
    label: 'T-bill / money-market ETF',
    assetClass: baseC.ASSET_CLASS.GOVT_BOND,
    taxTreatment: baseC.TAX_TREATMENT.TREASURY,
    note: 'A single slice of the bill curve in an ETF wrapper — the exchange-traded answer to a money market fund. '
      + 'Interest is exempt from state and local tax, which is worth roughly half a point in a high-tax state, and the '
      + 'yield resets straight down when the Fed cuts. The NAV floats rather than being pinned at $1.00, but at these '
      + 'maturities it barely moves.',
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
    { symbol: 'GPIQ', name: 'Goldman Sachs Nasdaq-100 Core Premium Income ETF', issuer: 'Goldman Sachs', expenseRatio: 0.29 },
    { symbol: 'ISPY', name: 'ProShares S&P 500 High Income ETF', issuer: 'ProShares', expenseRatio: 0.55,
      note: 'Writes daily rather than monthly options, which smooths the premium and gives up slightly less of a single '
        + 'big up-day than a monthly writer does. The trade-off is the same one, just sliced finer.' },
    { symbol: 'PBP', name: 'Invesco S&P 500 BuyWrite ETF', issuer: 'Invesco', expenseRatio: 0.49,
      note: 'The oldest buy-write fund on this list, which makes it the honest long-run record of the strategy: two '
        + 'decades of a large distribution and a total return well behind the index it writes against.' },
    { symbol: 'SVOL', name: 'Simplify Volatility Premium ETF', issuer: 'Simplify Asset Management', expenseRatio: 1.16,
      note: 'Shorts VIX futures rather than writing calls on stocks. The premium is real and the payoff is deliberately '
        + 'asymmetric: it collects steadily and loses a great deal in a volatility spike. February 2018 took products '
        + 'built on this trade to zero in a day; this one is sized to survive that, which is a design choice, not a law.' },
    { symbol: 'FEPI', name: 'REX FANG & Innovation Equity Premium Income ETF', issuer: 'REX Shares', expenseRatio: 0.65,
      note: 'Writes calls on a concentrated basket of big technology names. A 25%-plus distribution on a portfolio of '
        + 'fifteen stocks is option premium on very expensive volatility, not earnings — and the capped upside costs '
        + 'most in exactly the names people buy this for.' },
    { symbol: 'XDTE', name: 'Roundhill S&P 500 0DTE Covered Call Strategy ETF', issuer: 'Roundhill Investments', expenseRatio: 0.95,
      note: 'Sells same-day-expiry calls every morning. The weekly distribution is large and is funded by giving away '
        + 'every intraday rally, so in a trending market the NAV grinds down while the payout stays up.' },
    { symbol: 'YMAX', name: 'YieldMax Universe Fund of Option Income ETFs', issuer: 'YieldMax', expenseRatio: 1.28,
      note: 'A fund of the single-stock option-income funds below, so it carries their fees on top of its own. The '
        + 'headline distribution rate is not a yield: a large share of it is return of your own capital, and the share '
        + 'price has fallen roughly in line with what has been paid out.' },
    { symbol: 'TSLY', name: 'YieldMax TSLA Option Income Strategy ETF', issuer: 'YieldMax', expenseRatio: 1.01,
      note: 'Sells calls against a synthetic long position in one stock. The distribution rate looks enormous because '
        + 'it is computed on a share price that has fallen a long way; total return since launch is a fraction of the '
        + 'distribution rate, and the fund files Section 19a notices showing much of the payout as return of capital. '
        + 'You keep the downside of the single stock and sell away its upside.' },
    { symbol: 'NVDY', name: 'YieldMax NVDA Option Income Strategy ETF', issuer: 'YieldMax', expenseRatio: 0.99,
      note: 'The same structure on a single semiconductor stock. In a year when the underlying doubled, this returned a '
        + 'small fraction of that while paying a distribution rate in the high double digits — which is the clearest '
        + 'possible demonstration that a distribution rate is not a return.' },
    { symbol: 'MSTY', name: 'YieldMax MSTR Option Income Strategy ETF', issuer: 'YieldMax', expenseRatio: 0.99,
      note: 'Option income on the most volatile large-cap in the market, which is why the distribution rate is the '
        + 'highest here. Volatility that high is priced that high for a reason: the same swings that fund the payout '
        + 'take the NAV with them, and the payout is substantially return of capital.' },
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

  // The baseline. Nothing here is bought for its dividend, and that is exactly
  // why it belongs in a yield screener: without it, every 12% distribution on
  // the list has nothing honest to be compared against.
  core_index: [
    { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', issuer: 'Vanguard', expenseRatio: 0.03 },
    { symbol: 'IVV', name: 'iShares Core S&P 500 ETF', issuer: 'iShares', expenseRatio: 0.03 },
    { symbol: 'SPLG', name: 'SPDR Portfolio S&P 500 ETF', issuer: 'State Street SPDR', expenseRatio: 0.02 },
    { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', issuer: 'Vanguard', expenseRatio: 0.03 },
    { symbol: 'ITOT', name: 'iShares Core S&P Total U.S. Stock Market ETF', issuer: 'iShares', expenseRatio: 0.03 },
    { symbol: 'SCHB', name: 'Schwab U.S. Broad Market ETF', issuer: 'Charles Schwab', expenseRatio: 0.03 },
    { symbol: 'SPTM', name: 'SPDR Portfolio S&P 1500 Composite Stock Market ETF', issuer: 'State Street SPDR', expenseRatio: 0.03 },
    { symbol: 'SCHX', name: 'Schwab U.S. Large-Cap ETF', issuer: 'Charles Schwab', expenseRatio: 0.03 },
    { symbol: 'VV', name: 'Vanguard Large-Cap ETF', issuer: 'Vanguard', expenseRatio: 0.04 },
    { symbol: 'QQQM', name: 'Invesco NASDAQ 100 ETF', issuer: 'Invesco', expenseRatio: 0.15,
      note: 'A half-percent dividend on a growth index. Everything this returns is price, which is why it sits on the '
        + 'movement track and not the income one — ranking it on its yield would be arithmetically true and useless.' },
  ],

  // A whole retirement portfolio in one ticker, across all three big glidepaths.
  // The yield rises as the target year approaches because the bond share does.
  target_date: [
    { symbol: 'VTINX', name: 'Vanguard Target Retirement Income Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VTTVX', name: 'Vanguard Target Retirement 2025 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VTHRX', name: 'Vanguard Target Retirement 2030 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VTTHX', name: 'Vanguard Target Retirement 2035 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VFORX', name: 'Vanguard Target Retirement 2040 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VTIVX', name: 'Vanguard Target Retirement 2045 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VFIFX', name: 'Vanguard Target Retirement 2050 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VFFVX', name: 'Vanguard Target Retirement 2055 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VTTSX', name: 'Vanguard Target Retirement 2060 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'VLXVX', name: 'Vanguard Target Retirement 2065 Fund', issuer: 'Vanguard', expenseRatio: 0.08, minInvestment: 1000 },
    { symbol: 'FIKFX', name: 'Fidelity Freedom Index Income Fund', issuer: 'Fidelity Investments', expenseRatio: 0.12 },
    { symbol: 'FXIFX', name: 'Fidelity Freedom Index 2030 Fund', issuer: 'Fidelity Investments', expenseRatio: 0.12 },
    { symbol: 'FBIFX', name: 'Fidelity Freedom Index 2040 Fund', issuer: 'Fidelity Investments', expenseRatio: 0.12 },
    { symbol: 'FIPFX', name: 'Fidelity Freedom Index 2050 Fund', issuer: 'Fidelity Investments', expenseRatio: 0.12 },
    { symbol: 'SWYMX', name: 'Schwab Target 2050 Index Fund', issuer: 'Charles Schwab', expenseRatio: 0.08 },
    { symbol: 'SWYOX', name: 'Schwab Target 2060 Index Fund', issuer: 'Charles Schwab', expenseRatio: 0.08 },
  ],

  core_bond: [
    { symbol: 'AGG', name: 'iShares Core U.S. Aggregate Bond ETF', issuer: 'iShares', expenseRatio: 0.03, creditRating: 'AA' },
    { symbol: 'IUSB', name: 'iShares Core Total USD Bond Market ETF', issuer: 'iShares', expenseRatio: 0.06, creditRating: 'A+' },
    { symbol: 'SPAB', name: 'SPDR Portfolio Aggregate Bond ETF', issuer: 'State Street SPDR', expenseRatio: 0.03, creditRating: 'AA' },
    { symbol: 'SCHZ', name: 'Schwab U.S. Aggregate Bond ETF', issuer: 'Charles Schwab', expenseRatio: 0.03, creditRating: 'AA' },
    { symbol: 'FXNAX', name: 'Fidelity U.S. Bond Index Fund', issuer: 'Fidelity Investments', expenseRatio: 0.025, creditRating: 'AA' },
    { symbol: 'BNDX', name: 'Vanguard Total International Bond ETF', issuer: 'Vanguard', expenseRatio: 0.07, creditRating: 'A+',
      note: 'Foreign investment-grade bonds hedged back to dollars, which removes the currency and leaves the foreign '
        + 'rate cycle. The hedge is what makes the yield look low: it is a US-rate-equivalent yield, not the coupon.' },
  ],

  tips: [
    { symbol: 'TIP', name: 'iShares TIPS Bond ETF', issuer: 'iShares', expenseRatio: 0.18,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+' },
    { symbol: 'SCHP', name: 'Schwab U.S. TIPS ETF', issuer: 'Charles Schwab', expenseRatio: 0.03,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+' },
    { symbol: 'VTIP', name: 'Vanguard Short-Term Inflation-Protected Securities ETF', issuer: 'Vanguard', expenseRatio: 0.03,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+',
      note: 'Short-dated TIPS, so almost all of the return is the inflation accrual and almost none of it is rate risk. '
        + 'The closest listed equivalent to an I bond, minus the purchase cap and minus the deflation floor.' },
    { symbol: 'STIP', name: 'iShares 0-5 Year TIPS Bond ETF', issuer: 'iShares', expenseRatio: 0.03,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+' },
    { symbol: 'TIPX', name: 'SPDR Bloomberg 1-10 Year TIPS ETF', issuer: 'State Street SPDR', expenseRatio: 0.15,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+' },
    { symbol: 'LTPZ', name: 'PIMCO 15+ Year U.S. TIPS Index ETF', issuer: 'PIMCO', expenseRatio: 0.20,
      assetClass: baseC.ASSET_CLASS.GOVT_BOND, insurance: baseC.INSURANCE.NONE, creditRating: 'AA+',
      note: 'Twenty years of real duration. It is inflation-protected and it is still one of the most volatile bond '
        + 'funds in this app: protection against CPI is not protection against real yields moving.' },
  ],

  muni_state: [
    { symbol: 'VCITX', name: 'Vanguard California Long-Term Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.17, minInvestment: 3000, stateOfIssue: 'CA' },
    { symbol: 'VNYTX', name: 'Vanguard New York Long-Term Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.17, minInvestment: 3000, stateOfIssue: 'NY' },
    { symbol: 'VNJTX', name: 'Vanguard New Jersey Long-Term Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.17, minInvestment: 3000, stateOfIssue: 'NJ' },
    { symbol: 'VPAIX', name: 'Vanguard Pennsylvania Long-Term Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.17, minInvestment: 3000, stateOfIssue: 'PA' },
    { symbol: 'VOHIX', name: 'Vanguard Ohio Long-Term Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.17, minInvestment: 3000, stateOfIssue: 'OH' },
    { symbol: 'VMATX', name: 'Vanguard Massachusetts Tax-Exempt Fund', issuer: 'Vanguard', expenseRatio: 0.16, minInvestment: 3000, stateOfIssue: 'MA' },
    { symbol: 'FCTFX', name: 'Fidelity California Municipal Income Fund', issuer: 'Fidelity Investments', expenseRatio: 0.46, stateOfIssue: 'CA' },
    { symbol: 'FTFMX', name: 'Fidelity New York Municipal Income Fund', issuer: 'Fidelity Investments', expenseRatio: 0.46, stateOfIssue: 'NY' },
  ],

  intl_income: [
    { symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', issuer: 'Vanguard', expenseRatio: 0.05 },
    { symbol: 'VEA', name: 'Vanguard FTSE Developed Markets ETF', issuer: 'Vanguard', expenseRatio: 0.03 },
    { symbol: 'VWO', name: 'Vanguard FTSE Emerging Markets ETF', issuer: 'Vanguard', expenseRatio: 0.07 },
    { symbol: 'VYMI', name: 'Vanguard International High Dividend Yield ETF', issuer: 'Vanguard', expenseRatio: 0.17 },
    { symbol: 'IDV', name: 'iShares International Select Dividend ETF', issuer: 'iShares', expenseRatio: 0.51,
      note: 'Concentrated in European and UK financials, energy and telecoms — high payout ratios in cyclical sectors, '
        + 'which is why the distribution has been cut hard in past downturns and why it recovers hard afterwards.' },
    { symbol: 'SCHY', name: 'Schwab International Dividend Equity ETF', issuer: 'Charles Schwab', expenseRatio: 0.14 },
    { symbol: 'DEM', name: 'WisdomTree Emerging Markets High Dividend Fund', issuer: 'WisdomTree', expenseRatio: 0.63 },
    { symbol: 'DVYE', name: 'iShares Emerging Markets Dividend ETF', issuer: 'iShares', expenseRatio: 0.49,
      note: 'The highest dividend yield in this group and the most concentrated. Emerging-market payouts track '
        + 'commodity earnings, so the trailing figure is often a peak that is about to be cut.' },
  ],

  em_debt: [
    { symbol: 'VWOB', name: 'Vanguard Emerging Markets Government Bond ETF', issuer: 'Vanguard', expenseRatio: 0.20, creditRating: 'BB+' },
    { symbol: 'PCY', name: 'Invesco Emerging Markets Sovereign Debt ETF', issuer: 'Invesco', expenseRatio: 0.50, creditRating: 'BB' },
    { symbol: 'EMHY', name: 'iShares J.P. Morgan EM High Yield Bond ETF', issuer: 'iShares', expenseRatio: 0.50, creditRating: 'B+' },
    { symbol: 'EMLC', name: 'VanEck J.P. Morgan EM Local Currency Bond ETF', issuer: 'VanEck', expenseRatio: 0.30, creditRating: 'BBB-',
      note: 'Local-currency debt, which means the dollar decides most of the return. The coupon is high because those '
        + 'currencies are expected to depreciate; sometimes they depreciate by less than that, and sometimes by more.' },
    { symbol: 'EBND', name: 'SPDR Bloomberg Emerging Markets Local Bond ETF', issuer: 'State Street SPDR', expenseRatio: 0.30, creditRating: 'BBB-' },
  ],

  infrastructure: [
    { symbol: 'XLU', name: 'Utilities Select Sector SPDR Fund', issuer: 'State Street SPDR', expenseRatio: 0.08 },
    { symbol: 'VPU', name: 'Vanguard Utilities ETF', issuer: 'Vanguard', expenseRatio: 0.09 },
    { symbol: 'IGF', name: 'iShares Global Infrastructure ETF', issuer: 'iShares', expenseRatio: 0.42 },
    { symbol: 'GII', name: 'SPDR S&P Global Infrastructure ETF', issuer: 'State Street SPDR', expenseRatio: 0.40 },
    { symbol: 'AMLP', name: 'Alerian MLP ETF', issuer: 'ALPS / SS&C', expenseRatio: 0.85,
      taxTreatment: baseC.TAX_TREATMENT.ROC,
      note: 'Pipeline partnerships in a fund that is itself taxed as a C-corporation, so it accrues a deferred tax '
        + 'liability that quietly drags on NAV. Most of the distribution is return of capital: it is not taxed now, it '
        + 'reduces your cost basis instead, and the bill arrives when you sell. Unlike owning the MLPs directly there '
        + 'is no K-1, which is the whole reason this wrapper exists.' },
    { symbol: 'MLPA', name: 'Global X MLP ETF', issuer: 'Global X', expenseRatio: 0.45,
      taxTreatment: baseC.TAX_TREATMENT.ROC,
      note: 'The same C-corporation structure and the same deferred tax drag as AMLP, at roughly half the fee.' },
  ],

  senior_loan_clo: [
    { symbol: 'FTSL', name: 'First Trust Senior Loan Fund', issuer: 'First Trust', expenseRatio: 0.86, creditRating: 'B+' },
    { symbol: 'SEIX', name: 'Virtus Seix Senior Loan ETF', issuer: 'Virtus', expenseRatio: 0.62, creditRating: 'B+' },
    { symbol: 'JBBB', name: 'Janus Henderson B-BBB CLO ETF', issuer: 'Janus Henderson', expenseRatio: 0.49, creditRating: 'BBB-',
      note: 'The mezzanine tranches, which is where the extra three points over a AAA CLO fund come from. These take '
        + 'losses long before the AAAs do, and in a real default cycle they take them all at once.' },
    { symbol: 'CLOA', name: 'BlackRock AAA CLO ETF', issuer: 'BlackRock', expenseRatio: 0.20, creditRating: 'AAA' },
    { symbol: 'ICLO', name: 'Invesco AAA CLO Floating Rate Note ETF', issuer: 'Invesco', expenseRatio: 0.26, creditRating: 'AAA' },
    { symbol: 'AAA', name: 'Alternative Access First Priority CLO Bond ETF', issuer: 'Alternative Access Funds', expenseRatio: 0.25, creditRating: 'AAA' },
    { symbol: 'CLOZ', name: 'Panagram BBB-B CLO ETF', issuer: 'Panagram Structured Asset Management', expenseRatio: 0.50, creditRating: 'BB+',
      note: 'BBB and BB CLO tranches. An eight-plus percent yield on floating-rate paper with no duration is not free: '
        + 'it is the price of standing near the front of the loss queue in a leveraged loan pool.' },
  ],

  money_market_etf: [
    { symbol: 'TBIL', name: 'US Treasury 3 Month Bill ETF', issuer: 'F/m Investments', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'XBIL', name: 'US Treasury 6 Month Bill ETF', issuer: 'F/m Investments', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'OBIL', name: 'US Treasury 12 Month Bill ETF', issuer: 'F/m Investments', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE },
    { symbol: 'CLIP', name: 'Global X 1-3 Month T-Bill ETF', issuer: 'Global X', expenseRatio: 0.07, insurance: baseC.INSURANCE.NONE },
    { symbol: 'GBIL', name: 'Goldman Sachs Access Treasury 0-1 Year ETF', issuer: 'Goldman Sachs', expenseRatio: 0.12, insurance: baseC.INSURANCE.NONE },
    { symbol: 'UTWO', name: 'US Treasury 2 Year Note ETF', issuer: 'F/m Investments', expenseRatio: 0.15, insurance: baseC.INSURANCE.NONE,
      note: 'A single point on the curve rather than a money market: two years of duration means a real price move when '
        + 'rates do. It is here because holding one maturity, rather than a ladder, is how you take a view on cuts.' },
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
function computeYield(opts = {}) {
  const { dividends = [], price, nowMs = Date.now(), windowDays = 365 } = opts || {};
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
  const v = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
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
  // A corrupt bar (a timestamp already in ms, or plain garbage) can land outside
  // the range Date can represent, and new Date(...).toISOString() THROWS there.
  // Unguarded that takes the whole source down over one bad symbol.
  stats.dataAsOf = Number.isFinite(series.lastTsMs) && Math.abs(series.lastTsMs) <= MAX_TIME
    ? new Date(series.lastTsMs).toISOString()
    : null;

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

  const vols = Array.isArray(series.volume) ? series.volume.slice(-30) : [];
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

  const forward = num(stats?.forwardYield);
  const notes = [cat.note];
  if (entry.note) notes.push(entry.note);
  // Compare and format the COERCED figure: a string "12.5" is finite once parsed
  // but has no .toFixed, and throwing here loses the whole row over a note.
  if (forward !== null && Math.abs(forward - trailing) > 1) {
    notes.push(`Headline is the trailing 12-month yield (${trailing.toFixed(2)}%). Annualising the latest payment instead `
      + `gives ${forward.toFixed(2)}% — the gap is the payout changing, not free money.`);
  }
  if (entry.stateOfIssue) {
    // Deliberately not upgraded to MUNI_TRIPLE_EXEMPT for a resident: this
    // adapter has no view of the user's state, and quietly handing a New Yorker
    // a California tax break would overstate the after-tax yield on the row that
    // is hardest to check.
    notes.push(`Single-state ${entry.stateOfIssue} fund. The federal exemption applies to anyone; the ${entry.stateOfIssue} `
      + 'state and local exemption applies only to residents, and the after-tax figure below claims only the federal one. '
      + `If you do live in ${entry.stateOfIssue}, your real after-tax yield is higher than shown.`);
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

    apy: { total: trailing, forward },
    yieldKind: C.YIELD_KIND.TRAILING,
    payoutFrequency: stats?.payoutFrequency || entry.payoutFrequency || null,

    // Open-ended and exchange traded: no maturity, no lockup, sell any session.
    term: { days: null },
    liquidity: C.LIQUIDITY.DAILY,

    price,
    // One share, unless the fund says otherwise. Open-end mutual funds have a
    // real account minimum that the NAV gives no hint of — a $1,000 target-date
    // minimum shown as "$47" is a lie the reader has no way to catch.
    minInvestment: num(entry.minInvestment) ?? price,
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
    stateOfIssue: entry.stateOfIssue || null,
    // Some rows genuinely know their own track better than the yield rule does.
    // Left unset, schema.inferTrack decides from the rate, which is right for
    // nearly everything here.
    track: entry.track || null,
    url: quotePage(symbol),
    notes: notes.filter(Boolean).join(' '),
    // cat.accessNotes REPLACES the default (a mutual fund does not trade like a
    // stock); cat.access only appends a caveat to it.
    accessNotes: cat.accessNotes || (cat.access ? `${ACCESS_NOTES} ${cat.access}` : ACCESS_NOTES),
    requirements: cat.accessNotes
      ? ['Brokerage or fund-company account', ...(num(entry.minInvestment) ? [`$${num(entry.minInvestment).toLocaleString()} minimum initial investment`] : [])]
      : ['Brokerage account'],
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
        signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 6,
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
  // One request per symbol is not a choice: Yahoo publishes no batch endpoint
  // that carries dividend events, and the dividend stream is the entire point of
  // this source. The only lever is how many run at once, and six is where the
  // per-host semaphore in http.js and Yahoo's own tolerance meet — enough to keep
  // a 160-symbol universe inside a reasonable refresh, short of the rate limit.
  const results = await mapLimited(entries, 6, (entry) => fetchSymbol(ctx, entry));

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

  notes.push(`${built.opportunities.length} of ${entries.length} symbols priced and yielded, one request each — `
    + 'Yahoo has no batch endpoint that carries dividend events, so a wider universe costs proportionally more requests. '
    + 'Trim it with settings.sources.funds.exclude if a refresh is taking too long.');
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
