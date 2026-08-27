'use strict';

const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');

/**
 * BONDS — savings bonds, credit and muni proxies, and tokenized Treasuries.
 *
 * This source fills the gap between treasury.js (the government curve) and
 * funds.js (equity-income products). Four things live here, for four different
 * reasons:
 *
 * 1. SERIES I AND SERIES EE SAVINGS BONDS. Every yield screener on the internet
 *    omits these, and for a household with under $10k a year to place they are
 *    frequently the best risk-adjusted rate available: government-backed, state
 *    tax exempt, federal tax deferred, and in the I bond's case a rate that
 *    cannot go below zero. They are omitted because they are awkward — no API,
 *    a purchase cap, a hard lockup — not because they are bad.
 *
 * 2. CORPORATE AND MUNICIPAL CREDIT, expressed through index ETFs. No free feed
 *    prices individual CUSIPs honestly, and a screener that invents a corporate
 *    bond quote is worse than one that admits it is showing an index proxy. So
 *    every row here is a real, liquid fund, labelled as a proxy.
 *
 * 3. TOKENIZED TREASURIES (assetClass rwa). Real funds from real issuers that
 *    hold T-bills and settle on-chain. Nearly the T-bill yield with 24/7
 *    transferability, which is genuinely interesting — and issuer plus
 *    smart-contract risk that an actual T-bill does not carry, which is why
 *    every one of these rows is uninsured and says so.
 *
 * 4. TIPS BREAKEVEN CONTEXT. The breakeven is the single number that decides
 *    whether an inflation-linked instrument beats a nominal one, so it is
 *    computed here and surfaced in notes[] rather than left to the user.
 *
 * DURATION AS TERM. Bond ETFs get term.days = effective duration expressed in
 * days. They have no maturity, so there is nothing else honest to put there, and
 * leaving it null would hide the only risk that matters for a bond fund: risk.js
 * derives its price-volatility and rate-sensitivity penalties from term.days.
 * The cost is that the term filter treats these as dated instruments — hence the
 * explicit "not a lockup" line in every proxy row's notes.
 *
 * Overlap with funds.js is deliberately avoided: that adapter carries the broad
 * benchmarks (LQD, HYG, MUB, VTEB), this one carries the maturity buckets and
 * sectors around them, so the two together cover the curve without colliding.
 */

const ID = 'bonds';
const LABEL = 'Bonds, TIPS, I-Bonds & Tokenized RWA';

const POOLS_URL = 'https://yields.llama.fi/pools';
const TD_I_BOND = 'https://www.treasurydirect.gov/savings-bonds/i-bonds/';
const TD_EE_BOND = 'https://www.treasurydirect.gov/savings-bonds/ee-bonds/';
const RWA_URL = 'https://defillama.com/protocols/RWA';
const quotePage = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// The finance that this source exists to get right
// ---------------------------------------------------------------------------

/**
 * The Series I composite rate, in percent.
 *
 *   composite = fixed + 2 x semiannual inflation + (fixed x semiannual inflation)
 *
 * The cross term is not a rounding artefact: the fixed rate is earned on
 * principal that has already been marked up for inflation, so the two compound
 * against each other. Treasury announces both halves every 1 May and 1 Nov and
 * rounds the result to the nearest basis point.
 *
 * The floor at zero is the feature people buy these for. If CPI falls, the
 * inflation component can be negative and drag the composite down, but the
 * composite itself never goes below 0.00% and the redemption value never falls.
 * A TIPS holder in the same deflation takes a real principal markdown.
 */
function compositeIBondRate(fixedRate, semiannualInflationRate) {
  const f = num(fixedRate);
  const s = num(semiannualInflationRate);
  if (f === null || s === null) return null;
  const composite = f + 2 * s + (f * s) / 100;
  return Math.max(0, Math.round(composite * 100) / 100);
}

/**
 * The APY implied by a doubling guarantee, in percent.
 *
 * Series EE bonds are guaranteed to be worth twice their purchase price at
 * exactly 20 years. That guarantee, not the announced coupon, is the real
 * economics of the instrument, and 2^(1/20)-1 is what it is worth.
 */
function doublingApy(years = 20) {
  const y = num(years);
  if (y === null || y <= 0) return null;
  return (Math.pow(2, 1 / y) - 1) * 100;
}

/**
 * Breakeven inflation: the CPI rate at which a TIPS and a nominal Treasury of
 * the same maturity end up in the same place. Above it, inflation-linked wins.
 *
 * Uses the exact Fisher relation rather than the nominal-minus-real rule of
 * thumb, which runs a few basis points hot at these levels. It is a market
 * expectation with a risk premium baked in, not a forecast — worth saying,
 * because people read it as one.
 */
function breakevenInflation(nominalYield, realYield) {
  const n = num(nominalYield);
  const r = num(realYield);
  if (n === null || r === null || r <= -100) return null;
  return ((1 + n / 100) / (1 + r / 100) - 1) * 100;
}

/** Effective duration in years -> days, so it can ride in term.days. */
const durationDays = (years) => {
  const y = num(years);
  return y === null || y < 0 ? null : Math.round(y * 365.25);
};

/** Breakeven pairs -> the sentences the app shows above the inflation-linked rows. */
function breakevenNotes(pairs) {
  const out = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const be = breakevenInflation(p?.nominal, p?.real);
    if (be === null) continue;
    out.push(`${p.tenor || 'Breakeven'} inflation ${be.toFixed(2)}% `
      + `(nominal ${num(p.nominal).toFixed(2)}% vs TIPS real ${num(p.real).toFixed(2)}%): `
      + 'TIPS, I bonds and other inflation-linked holdings only beat nominal Treasuries if CPI averages more than that.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The instruments
// ---------------------------------------------------------------------------

/**
 * Structural facts, maintained by hand because they are constants rather than
 * quotes: effective duration, stated average credit quality, expense ratio,
 * purchase limits and investor eligibility. Rate levels come from the seed file
 * or from a live feed and never from here.
 *
 * `durationYears` is the fund's published effective duration; `creditRating` is
 * its stated average credit quality, in the notation risk.js scores. Both drift
 * slowly and are worth a yearly look. `expenseRatio` is null wherever the
 * issuer's stated fee is not reliably known — a guessed fee would feed the
 * high-fee trap detector a lie.
 */
const INSTRUMENTS = [
  // --- 1. savings bonds ----------------------------------------------------
  {
    key: 'series-i', group: 'savings_bond', kind: 'I',
    name: 'Series I Savings Bond', symbol: 'I BOND',
    issuer: 'U.S. Department of the Treasury', url: TD_I_BOND,
  },
  {
    key: 'series-ee', group: 'savings_bond', kind: 'EE',
    name: 'Series EE Savings Bond (20-year doubling)', symbol: 'EE BOND',
    issuer: 'U.S. Department of the Treasury', url: TD_EE_BOND,
  },

  // --- 2a. corporate credit proxies ---------------------------------------
  { key: 'IGSB', group: 'fund_proxy', category: 'ig_corp', symbol: 'IGSB', name: 'iShares 1-5 Year Investment Grade Corporate Bond ETF', issuer: 'iShares', durationYears: 2.6, creditRating: 'A-', expenseRatio: 0.04 },
  { key: 'IGIB', group: 'fund_proxy', category: 'ig_corp', symbol: 'IGIB', name: 'iShares 5-10 Year Investment Grade Corporate Bond ETF', issuer: 'iShares', durationYears: 6.2, creditRating: 'BBB+', expenseRatio: 0.04 },
  { key: 'USIG', group: 'fund_proxy', category: 'ig_corp', symbol: 'USIG', name: 'iShares Broad USD Investment Grade Corporate Bond ETF', issuer: 'iShares', durationYears: 6.9, creditRating: 'A-', expenseRatio: 0.04 },
  {
    key: 'VCLT', group: 'fund_proxy', category: 'ig_corp', symbol: 'VCLT', name: 'Vanguard Long-Term Corporate Bond ETF', issuer: 'Vanguard',
    durationYears: 12.9, creditRating: 'BBB+', expenseRatio: 0.04,
    note: 'Thirteen years of duration on investment-grade paper: this is a bet on long rates far more than on credit. '
      + 'A one-point rise in yields costs roughly 13% of the price, which is equity-sized damage for a bond fund.',
  },
  {
    key: 'FLOT', group: 'fund_proxy', category: 'floating', symbol: 'FLOT', name: 'iShares Floating Rate Bond ETF', issuer: 'iShares',
    durationYears: 0.1, creditRating: 'A-', expenseRatio: 0.15,
  },
  { key: 'FLRN', group: 'fund_proxy', category: 'floating', symbol: 'FLRN', name: 'SPDR Bloomberg Investment Grade Floating Rate ETF', issuer: 'State Street SPDR', durationYears: 0.1, creditRating: 'A-', expenseRatio: 0.15 },
  { key: 'SPHY', group: 'fund_proxy', category: 'high_yield', symbol: 'SPHY', name: 'SPDR Portfolio High Yield Bond ETF', issuer: 'State Street SPDR', durationYears: 3.2, creditRating: 'B+', expenseRatio: 0.05 },
  { key: 'HYLB', group: 'fund_proxy', category: 'high_yield', symbol: 'HYLB', name: 'Xtrackers USD High Yield Corporate Bond ETF', issuer: 'DWS Xtrackers', durationYears: 3.2, creditRating: 'B+', expenseRatio: 0.05 },
  {
    key: 'SJNK', group: 'fund_proxy', category: 'high_yield', symbol: 'SJNK', name: 'SPDR Bloomberg Short Term High Yield Bond ETF', issuer: 'State Street SPDR',
    durationYears: 1.9, creditRating: 'B+', expenseRatio: 0.40,
    note: 'Short-dated junk. The low duration makes the price look calm between defaults, which is exactly when it is not '
      + 'compensating you for the credit risk you are actually holding.',
  },
  {
    key: 'ANGL', group: 'fund_proxy', category: 'high_yield', symbol: 'ANGL', name: 'VanEck Fallen Angel High Yield Bond ETF', issuer: 'VanEck',
    durationYears: 4.6, creditRating: 'BB', expenseRatio: 0.35,
    note: 'Holds bonds downgraded out of investment grade rather than issued as junk. Better average quality than broad '
      + 'high yield and a longer duration, so it behaves more like a rates fund with credit attached.',
  },
  {
    key: 'BKLN', group: 'fund_proxy', category: 'senior_loan', symbol: 'BKLN', name: 'Invesco Senior Loan ETF', issuer: 'Invesco',
    durationYears: 0.25, creditRating: 'B+', expenseRatio: 0.65,
  },

  // --- 2b. municipal proxies ----------------------------------------------
  { key: 'VTES', group: 'fund_proxy', category: 'muni', symbol: 'VTES', name: 'Vanguard Short-Term Tax-Exempt Bond ETF', issuer: 'Vanguard', durationYears: 1.0, creditRating: 'AA', expenseRatio: 0.07 },
  { key: 'SUB', group: 'fund_proxy', category: 'muni', symbol: 'SUB', name: 'iShares Short-Term National Muni Bond ETF', issuer: 'iShares', durationYears: 1.9, creditRating: 'AA', expenseRatio: 0.07 },
  { key: 'SHM', group: 'fund_proxy', category: 'muni', symbol: 'SHM', name: 'SPDR Nuveen Bloomberg Short Term Municipal Bond ETF', issuer: 'State Street SPDR', durationYears: 2.8, creditRating: 'AA', expenseRatio: 0.20 },
  { key: 'TFI', group: 'fund_proxy', category: 'muni', symbol: 'TFI', name: 'SPDR Nuveen Bloomberg Municipal Bond ETF', issuer: 'State Street SPDR', durationYears: 6.6, creditRating: 'AA-', expenseRatio: 0.23 },
  { key: 'PZA', group: 'fund_proxy', category: 'muni', symbol: 'PZA', name: 'Invesco National AMT-Free Municipal Bond ETF', issuer: 'Invesco', durationYears: 6.9, creditRating: 'AA-', expenseRatio: 0.28 },
  {
    key: 'MLN', group: 'fund_proxy', category: 'muni', symbol: 'MLN', name: 'VanEck Long Muni ETF', issuer: 'VanEck',
    durationYears: 7.7, creditRating: 'A+', expenseRatio: 0.24,
    note: 'The long end of the muni curve, where most of the extra tax-free yield lives and where a rate move does the '
      + 'most damage.',
  },
  { key: 'CMF', group: 'fund_proxy', category: 'muni', symbol: 'CMF', name: 'iShares California Muni Bond ETF', issuer: 'iShares', durationYears: 6.6, creditRating: 'AA-', expenseRatio: 0.08, stateOfIssue: 'CA' },
  { key: 'NYF', group: 'fund_proxy', category: 'muni', symbol: 'NYF', name: 'iShares New York Muni Bond ETF', issuer: 'iShares', durationYears: 6.1, creditRating: 'AA-', expenseRatio: 0.25, stateOfIssue: 'NY' },

  // --- 3. tokenized treasuries --------------------------------------------
  {
    key: 'BUIDL', group: 'rwa', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity Fund',
    issuer: 'BlackRock / Securitize', chain: 'Ethereum', expenseRatio: 0.20, minInvestment: 5000000,
    requirements: ['Securitize onboarding and KYC', 'Qualified purchaser', '$5,000,000 minimum'],
    llama: { symbol: 'BUIDL' },
    note: 'The largest tokenized Treasury fund and effectively the institutional benchmark for the category. The minimum '
      + 'puts it out of retail reach directly; retail exposure to it is second-hand, through products that hold it.',
  },
  {
    key: 'BENJI', group: 'rwa', symbol: 'BENJI', name: 'Franklin OnChain U.S. Government Money Fund (BENJI)',
    issuer: 'Franklin Templeton', chain: 'Stellar', expenseRatio: 0.20,
    requirements: ['Benji app account and KYC', 'US persons only'],
    llama: { symbol: 'BENJI' }, url: 'https://www.franklintempleton.com',
    note: 'A registered 1940-Act government money market fund whose share register happens to live on a blockchain. That '
      + 'makes it the most conventionally regulated thing in this group, and the one an ordinary US investor can actually buy.',
  },
  {
    key: 'USDY', group: 'rwa', symbol: 'USDY', name: 'Ondo U.S. Dollar Yield Token', issuer: 'Ondo Finance',
    chain: 'Ethereum', region: 'Non-US', minInvestment: 500,
    requirements: ['KYC with Ondo', 'Not available to US persons'],
    llama: { project: 'ondo-finance', symbol: 'USDY' }, url: 'https://ondo.finance',
    note: 'A transferable note backed by short Treasuries and bank deposits, structured for non-US investors. The token '
      + 'moves freely between wallets after a lockup at mint, which is what makes it useful as on-chain collateral.',
  },
  {
    key: 'OUSG', group: 'rwa', symbol: 'OUSG', name: 'Ondo Short-Term US Government Treasuries', issuer: 'Ondo Finance',
    chain: 'Ethereum', minInvestment: 100000,
    requirements: ['KYC with Ondo', 'Qualified purchaser'],
    llama: { project: 'ondo-finance', symbol: 'OUSG' }, url: 'https://ondo.finance',
    note: 'Holds tokenized government funds including BUIDL, so it is a wrapper around a wrapper: two sets of fees and two '
      + 'sets of issuer risk between you and the bills.',
  },
  {
    key: 'USYC', group: 'rwa', symbol: 'USYC', name: 'Hashnote US Yield Coin', issuer: 'Hashnote (Circle)',
    chain: 'Ethereum',
    requirements: ['KYC with the issuer', 'Institutional and qualified investors'],
    llama: { symbol: 'USYC' },
    note: 'Backed by short Treasuries and reverse repo, so its yield tracks overnight repo rather than the bill curve — '
      + 'it moves the day the Fed moves, where a bill fund lags by its maturity.',
  },
  {
    key: 'USTB', group: 'rwa', symbol: 'USTB', name: 'Superstate Short Duration U.S. Government Securities Fund',
    issuer: 'Superstate', chain: 'Ethereum', minInvestment: 100000,
    requirements: ['KYC with Superstate', 'Qualified purchaser'],
    llama: { project: 'superstate', symbol: 'USTB' },
  },
  {
    key: 'TBILL', group: 'rwa', symbol: 'TBILL', name: 'OpenEden T-Bill Vault', issuer: 'OpenEden',
    chain: 'Ethereum',
    requirements: ['KYC with OpenEden', 'Not available to US persons'],
    llama: { project: 'openeden', symbol: 'TBILL' },
    note: 'Mint and redeem run against the vault around the clock, with the underlying bill trades settling on the '
      + 'ordinary business-day cycle behind it. That gap is the liquidity promise you are relying on in a rush.',
  },
  {
    key: 'IB01', group: 'rwa', symbol: 'bIB01', name: 'Backed bIB01 (0-1 Year Treasury Bond)', issuer: 'Backed Finance',
    chain: 'Ethereum', region: 'Non-US',
    requirements: ['KYC with Backed', 'Professional investors outside the US'],
    llama: { project: 'backed-finance', symbol: 'BIB01' },
    note: 'A tokenized wrapper around a UCITS Treasury bill ETF rather than around the bills themselves, so the fund '
      + 'structure sits between you and the paper in addition to the token.',
  },
  {
    key: 'WTGXX', group: 'rwa', symbol: 'WTGXX', name: 'WisdomTree Government Money Market Digital Fund',
    issuer: 'WisdomTree', chain: 'Stellar', expenseRatio: 0.25,
    requirements: ['WisdomTree Connect account and KYC', 'US persons only'],
    llama: { symbol: 'WTGXX' }, url: 'https://www.wisdomtree.com',
    note: 'A registered government money market fund with tokenized shares, aimed at US retail through WisdomTree\'s own app.',
  },
];

const INDEX = new Map(INSTRUMENTS.map((e) => [e.key, e]));

/** Category text for the credit and muni proxies. */
const CATEGORIES = {
  ig_corp: {
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Investment-grade corporate credit. The extra yield over a Treasury of the same maturity is the spread, and it '
      + 'is compensation for two things at once: the chance of default, which is small at this rating, and the chance '
      + 'the spread widens, which is not.',
  },
  high_yield: {
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'High yield, which is to say below investment grade. The headline is a yield to worst that assumes nothing '
      + 'defaults; in a real credit cycle a few percent of the portfolio does, and the loss comes out of that number. '
      + 'It also correlates with equities exactly when you wanted it not to.',
  },
  floating: {
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Investment-grade floating-rate notes. Coupons reset off a short-term benchmark every quarter, so the price '
      + 'barely moves when rates do — and the yield falls with them. This is a cash substitute with credit risk, not a '
      + 'way to lock in a rate.',
  },
  senior_loan: {
    assetClass: baseC.ASSET_CLASS.CORP_BOND,
    taxTreatment: baseC.TAX_TREATMENT.ORDINARY,
    note: 'Floating-rate senior secured bank loans to leveraged borrowers. Almost no duration and a great deal of credit '
      + 'risk. The loans themselves settle in weeks, not days, so a fund promising daily liquidity on them is running a '
      + 'mismatch that only shows up when everyone leaves at once.',
  },
  muni: {
    assetClass: baseC.ASSET_CLASS.MUNI_BOND,
    taxTreatment: baseC.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT,
    note: 'Municipal bonds, exempt from federal income tax. The headline yield is therefore not comparable with a taxable '
      + 'one until you gross it up: at a 32% federal bracket a 3.4% muni is worth 5.0% taxable. The app does that '
      + 'conversion for you in the after-tax column.',
  },
};

const ACCESS = {
  savings_bond: 'Buy directly at TreasuryDirect.gov, $25 minimum, no fee and no brokerage involved. The $10,000 annual '
    + 'limit is per Social Security number per calendar year, so a couple can place $20,000 and a new allowance opens '
    + 'every January. These cannot be bought or sold through a broker and have no secondary market.',
  fund_proxy: 'Any US brokerage, commission free, trades and settles like a stock. One share is the practical minimum, '
    + 'or less where fractional shares are supported. Use limit orders on the thinner muni funds.',
  rwa: 'Bought from the issuer after onboarding, not from a brokerage. Every one of these requires KYC, most restrict who '
    + 'may hold them, and redemption to dollars runs on the issuer\'s schedule even where the token itself transfers '
    + 'instantly. Check current eligibility with the issuer before counting on access.',
};

// ---------------------------------------------------------------------------
// Row builders. Both the live path and the seed path funnel through buildAll,
// so a mapping change cannot drift between them.
// ---------------------------------------------------------------------------

/**
 * A single-state muni fund is only triple exempt for a resident of that state.
 * For anyone else the coupon is federal exempt and fully taxable at home, and
 * telling the after-tax engine otherwise would hand a New Yorker a California
 * tax break they do not get.
 */
function muniTreatment(entry, settings, C) {
  if (!entry.stateOfIssue) return C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT;
  const resident = String(settings?.tax?.state || '').trim().toUpperCase();
  return resident === entry.stateOfIssue
    ? C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT
    : C.TAX_TREATMENT.MUNI_FEDERAL_EXEMPT;
}

function buildSavingsBond(entry, quote, { schema, C, dataAsOf, seed, breakevens }) {
  const isI = entry.kind === 'I';

  // The I bond publishes its rate; the EE bond's real rate is the doubling.
  const fixed = num(quote?.fixedRate);
  const semi = num(quote?.semiannualInflation);
  const stated = num(quote?.statedRate);
  const rate = isI ? compositeIBondRate(fixed, semi) : doublingApy(20);
  if (rate === null) return null;

  const notes = [];
  if (isI) {
    notes.push(
      `Composite rate ${rate.toFixed(2)}% = ${fixed.toFixed(2)}% fixed + 2 x ${semi.toFixed(2)}% semiannual inflation `
      + `+ the cross term, because the fixed rate is earned on principal that has already been marked up for inflation.`,
      'Treasury resets both halves every 1 May and 1 Nov. Your own six-month windows run from the month you buy, not from '
      + 'the reset date, so a purchase in late October earns the old composite for six months before the new one starts.',
      'The composite can never print below 0.00% and the redemption value never falls, which is the one thing this has '
      + 'that TIPS do not: in a deflation a TIPS holder takes a real principal markdown and an I bond holder just earns nothing.',
    );
    const short = (Array.isArray(breakevens) ? breakevens : [])[0];
    const real = num(short?.real);
    if (real !== null && fixed !== null) {
      // The fixed rate IS the I bond's real yield, so it is the like-for-like
      // comparison against TIPS. Which way the gap runs decides the advice.
      const gap = real - fixed;
      const tenorLabel = short?.tenor ? `${short.tenor} ` : '';
      notes.push(`Its real return is the ${fixed.toFixed(2)}% fixed rate, and that is what to compare against the `
        + `${real.toFixed(2)}% ${tenorLabel}TIPS real yield`
        + (gap >= 0
          ? `: TIPS pay ${gap.toFixed(2)}pp more real yield, in exchange for price risk, no deflation floor and no purchase cap.`
          : `: the I bond pays ${Math.abs(gap).toFixed(2)}pp more real yield than TIPS, with no price risk and a deflation `
            + 'floor, at the cost of the purchase cap and the lockup.'));
    }
  } else {
    notes.push(
      `Guaranteed to be worth double the purchase price at exactly 20 years, which is a ${rate.toFixed(2)}% APY and the `
      + 'only number here worth ranking on.',
      stated === null
        ? 'The announced coupon rate accrues month to month and is far below that; if it has not doubled the bond by year '
          + '20, Treasury makes a one-time adjustment to make up the difference.'
        : `The announced coupon rate of ${stated.toFixed(2)}% is what accrues month to month, and it is the misleading `
          + 'number: if the coupon has not doubled the bond by year 20, Treasury makes a one-time adjustment to make up '
          + 'the difference.',
      'So this is really a 20-year zero-coupon bond with a floor. Redeem at 19 years and you get the coupon and nothing '
      + 'else; hold past 20 and you keep earning the coupon on the doubled balance.',
    );
  }
  notes.push(
    'Federal tax is deferred until you redeem, and it can be waived entirely if the proceeds pay qualified higher '
    + 'education expenses in the same year, subject to income limits. Interest is always exempt from state and local tax.',
    'The $10,000 shown as a maximum is the annual purchase limit per person, not a balance tier — money above it is not '
    + 'earning a worse rate here, it simply cannot be bought until next January.',
  );

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: entry.key,
    name: entry.name,
    symbol: entry.symbol,
    provider: entry.issuer,
    assetClass: C.ASSET_CLASS.GOVT_BOND,
    subType: 'savings_bond',
    region: 'US',
    currency: 'USD',

    apy: { total: rate },
    // The I bond composite is locked for your next six months and then resets on
    // a published formula, which is administered in the same sense a bank APY is.
    // The EE doubling is a contractual guarantee of the maturity value.
    yieldKind: isI ? C.YIELD_KIND.ADMINISTERED : C.YIELD_KIND.CONTRACTUAL,
    payoutFrequency: 'at redemption',
    compounding: 2,

    // Both are genuinely locked: nothing can be redeemed in the first 12 months
    // at any price. The I bond's term is that lockup; the EE bond's is the 20
    // years the headline rate assumes, because redeeming earlier forfeits it.
    liquidity: C.LIQUIDITY.LOCKED,
    term: {
      days: isI ? 365 : 7305,
      label: isI ? '12 mo lockup' : '20 yr to double',
      earlyExitPenalty: isI
        ? 'Cannot be redeemed at all for 12 months. Redeem before 5 years and you forfeit the last 3 months of interest.'
        : 'Cannot be redeemed at all for 12 months, and before 5 years you forfeit the last 3 months of interest. '
          + 'Redeeming before 20 years forfeits the doubling entirely and leaves you with only the accrued coupon.',
    },

    minInvestment: 25,
    maxInvestment: 10000,

    risk: {
      insurance: C.INSURANCE.US_GOV,
      principalAtRisk: false,
    },

    taxTreatment: C.TAX_TREATMENT.TREASURY,
    url: entry.url,
    notes: notes.filter(Boolean).join(' '),
    accessNotes: ACCESS.savings_bond,
    // Wording matters: traps.js reads requirements for promotional-rate language,
    // and a phrase like "first 12 months" there would libel this as a teaser rate.
    requirements: ['TreasuryDirect account', '$10,000 per person per calendar year', 'No redemption for 12 months after purchase'],
    dataAsOf,
    seed: !!seed,
  };

  return schema.normalize(row, { source: ID, seed: !!seed });
}

function buildFundProxy(entry, quote, { schema, C, dataAsOf, seed, settings }) {
  const cat = CATEGORIES[entry.category];
  const rate = num(quote?.yield);
  if (!cat || rate === null) return null;

  const isMuni = entry.category === 'muni';
  const durDays = durationDays(entry.durationYears);
  const trailing = quote?.basis === 'trailing';

  const notes = [
    'Index proxy, not a bond. No free feed prices individual corporate or municipal CUSIPs honestly, so the asset class '
    + 'is expressed through a real, liquid fund. What you buy is the fund: it has no maturity and never returns par, so '
    + 'a rise in yields is a real loss until they come back down.',
    cat.note,
  ];
  if (entry.note) notes.push(entry.note);
  if (Number.isFinite(entry.durationYears)) {
    notes.push(`The term shown is the fund's ${entry.durationYears.toFixed(1)}-year effective duration expressed in days, `
      + `not a lockup — you can sell any session. It is there so the rate-sensitivity penalty applies: a one-point rise in `
      + `yields costs roughly ${entry.durationYears.toFixed(1)}% of the price.`);
  }
  notes.push(trailing
    ? 'Headline is the trailing twelve months of distributions over the current price. For a bond fund that lags the '
      + 'portfolio\'s current yield whenever rates have moved; the issuer\'s SEC 30-day yield is the better forward number.'
    : 'Headline is the SEC 30-day yield, the standardised net-of-fee figure the issuer publishes — what the portfolio '
      + 'currently earns, not what it paid last year.');
  if (isMuni && entry.stateOfIssue) {
    const treatment = muniTreatment(entry, settings, C);
    notes.push(treatment === C.TAX_TREATMENT.MUNI_TRIPLE_EXEMPT
      ? `Single-state fund: exempt from federal, ${entry.stateOfIssue} state and local tax for you as a ${entry.stateOfIssue} resident. `
        + 'That triple exemption is the entire reason to accept a lower headline than a national fund pays.'
      : `Single-state ${entry.stateOfIssue} fund. Federally exempt for anyone, but the state exemption only applies to `
        + `${entry.stateOfIssue} residents — your settings say you are not one, so this is taxed at home and the after-tax `
        + 'column below reflects that. A national fund almost certainly serves you better.');
  }

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: entry.key,
    symbol: entry.symbol,
    name: entry.name,
    provider: entry.issuer,
    assetClass: cat.assetClass,
    subType: entry.category,
    region: 'US',
    currency: 'USD',

    apy: { total: rate, forward: num(quote?.forwardYield) },
    yieldKind: trailing ? C.YIELD_KIND.TRAILING : C.YIELD_KIND.MARKET,
    payoutFrequency: quote?.payoutFrequency || 'monthly',

    // Duration in term.days. See the header: it is the only honest thing to put
    // there for a perpetual fund, and it is what risk.js prices rate risk from.
    term: { days: durDays, label: Number.isFinite(entry.durationYears) ? `${entry.durationYears.toFixed(1)}yr duration` : null },
    liquidity: C.LIQUIDITY.DAILY,

    price: num(quote?.price),
    minInvestment: num(quote?.price),
    expenseRatio: num(entry.expenseRatio),

    risk: {
      insurance: C.INSURANCE.SIPC,
      principalAtRisk: true,
      creditRating: entry.creditRating || null,
    },

    taxTreatment: isMuni ? muniTreatment(entry, settings, C) : cat.taxTreatment,
    stateOfIssue: entry.stateOfIssue || null,
    url: quotePage(entry.symbol),
    notes: notes.filter(Boolean).join(' '),
    accessNotes: ACCESS.fund_proxy,
    requirements: ['Brokerage account'],
    dataAsOf,
    seed: !!seed,
  };
  // A measured trailing yield on a live price is a strong claim; an issuer's
  // published SEC yield we are relaying is a slightly weaker one.
  if (!seed) row.confidence = trailing ? 0.85 : 0.75;

  return schema.normalize(row, { source: ID, seed: !!seed });
}

function buildRwa(entry, quote, { schema, C, dataAsOf, seed }) {
  const rate = num(quote?.yield);
  if (rate === null) return null;

  const notes = [
    'A tokenized share of a real portfolio of short Treasuries. The yield is the bill yield less the manager\'s fee, so '
    + 'it can only ever land a little under what a T-bill pays; the reason to hold it is that it settles on-chain in '
    + 'minutes, any hour of any day, and can be posted as collateral where a bill cannot.',
    'What you give up is the thing that makes a T-bill a T-bill. This is an issuer\'s fund share wrapped in a smart '
    + 'contract, so you carry that issuer\'s custody and operational risk and the contract\'s code risk on top of it. '
    + 'There is no FDIC or SIPC coverage and the US government does not stand behind the token — the government backs '
    + 'the bills in the fund, which is not the same promise.',
  ];
  if (entry.note) notes.push(entry.note);
  notes.push('Transferability is not redeemability: the token may move 24/7 while converting it back to dollars still '
    + 'runs on the issuer\'s window, and in stress those are the same queue everyone else is in.');

  const row = {
    source: ID,
    sourceLabel: LABEL,
    key: entry.key,
    symbol: entry.symbol,
    name: entry.name,
    provider: entry.issuer,
    assetClass: C.ASSET_CLASS.RWA,
    subType: 'tokenized_treasury',
    chain: entry.chain || null,
    region: entry.region || 'US',
    currency: 'USD',

    apy: { total: rate },
    // Set by the bill market inside the fund, in the same sense a money market
    // fund's 7-day yield is, rather than by emissions or by the issuer's whim.
    yieldKind: C.YIELD_KIND.MARKET,
    payoutFrequency: 'daily accrual',

    term: { days: null },
    liquidity: C.LIQUIDITY.DAILY,
    tvl: num(quote?.tvl),

    minInvestment: num(entry.minInvestment),
    expenseRatio: num(entry.expenseRatio),

    risk: {
      // Deliberate: the underlying is government paper, the wrapper is not.
      insurance: C.INSURANCE.NONE,
      principalAtRisk: true,
    },

    taxTreatment: C.TAX_TREATMENT.ORDINARY,
    url: entry.url || RWA_URL,
    notes: notes.filter(Boolean).join(' '),
    accessNotes: ACCESS.rwa,
    requirements: Array.isArray(entry.requirements) ? entry.requirements : [],
    dataAsOf,
    seed: !!seed,
  };
  if (!seed) row.confidence = 0.7;   // relayed from an aggregator, not from the issuer

  return schema.normalize(row, { source: ID, seed: !!seed });
}

/** One instrument plus its quote -> one normalized opportunity, or null. */
function buildOpportunity(entry, quote, opts = {}) {
  if (!entry || !quote) return null;
  const o = {
    schema: opts.schema || baseSchema,
    C: opts.C || baseC,
    dataAsOf: opts.dataAsOf || null,
    seed: quote.live ? false : opts.seed !== false,
    settings: opts.settings || {},
    breakevens: opts.breakevens || [],
  };
  if (quote.dataAsOf) o.dataAsOf = quote.dataAsOf;
  if (entry.group === 'savings_bond') return buildSavingsBond(entry, quote, o);
  if (entry.group === 'fund_proxy') return buildFundProxy(entry, quote, o);
  if (entry.group === 'rwa') return buildRwa(entry, quote, o);
  return null;
}

/**
 * PURE ENTRY POINT: a Map of key -> quote becomes opportunities.
 * Nothing in here touches the network or the clock.
 */
function buildAll(quotes, opts = {}) {
  const map = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
  const opportunities = [];
  const skipped = [];
  for (const entry of INSTRUMENTS) {
    const quote = map.get(entry.key);
    if (!quote) { skipped.push(entry.key); continue; }
    try {
      const o = buildOpportunity(entry, quote, opts);
      if (o) opportunities.push(o);
      else skipped.push(entry.key);
    } catch {
      skipped.push(entry.key);   // one bad instrument never takes the source down
    }
  }
  return { opportunities, skipped };
}

// ---------------------------------------------------------------------------
// Pure parsers for the live shapes
// ---------------------------------------------------------------------------

const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/**
 * DefiLlama /pools -> quotes for the tokenized-treasury rows.
 *
 * Documented shape: { status, data: [{ pool, chain, project, symbol, tvlUsd,
 * apy, apyBase, apyReward, apyMean30d, ... }] }. We match by token symbol, and
 * additionally by project slug where the symbol is generic enough to collide.
 *
 * Anything above CEILING_APY is discarded rather than shown: a fund that holds
 * Treasury bills does not pay 30%, so that is an upstream data error and
 * publishing it would put a fake number at the top of the table.
 */
const CEILING_APY = 25;

function parseRwaPools(payload, opts = {}) {
  const notes = [];
  const warnings = [];
  const quotes = new Map();

  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : null;
  if (!rows) {
    return { quotes, notes, warnings: ['DefiLlama payload had no data array.'], matched: 0, absurd: 0 };
  }
  const upstreamStatus = str(payload?.status);
  if (upstreamStatus && upstreamStatus !== 'success') warnings.push(`DefiLlama reported status "${upstreamStatus}".`);

  const wanted = INSTRUMENTS.filter((e) => e.group === 'rwa' && e.llama);
  const best = new Map();
  let absurd = 0;

  for (const p of rows) {
    try {
      if (!p || typeof p !== 'object') continue;
      const symbol = str(p.symbol)?.toUpperCase();
      if (!symbol) continue;
      const project = str(p.project)?.toLowerCase() || null;

      for (const entry of wanted) {
        const wantSymbol = String(entry.llama.symbol || entry.symbol).toUpperCase();
        if (symbol !== wantSymbol) continue;
        if (entry.llama.project && project !== entry.llama.project) continue;

        const apy = num(p.apy) ?? num(p.apyBase);
        if (apy === null || apy < 0) continue;
        if (apy > CEILING_APY) { absurd += 1; continue; }

        const tvl = num(p.tvlUsd);
        const cur = best.get(entry.key);
        // Several chains can carry the same token; take the deepest listing.
        if (!cur || (tvl ?? 0) > (cur.tvl ?? 0)) {
          best.set(entry.key, { yield: apy, tvl, live: true, dataAsOf: opts.dataAsOf || null });
        }
      }
    } catch {
      // one malformed pool record is its own blast radius
    }
  }

  for (const [k, v] of best) quotes.set(k, v);
  notes.push(`DefiLlama: ${quotes.size} of ${wanted.length} tokenized Treasury products matched from ${rows.length.toLocaleString()} pools.`);
  if (absurd) notes.push(`${absurd} tokenized listing(s) ignored for an implausible APY above ${CEILING_APY}%.`);
  return { quotes, notes, warnings, matched: quotes.size, absurd };
}

/** Seed items -> quotes, keyed the way buildAll wants them. */
function parseSeedItems(items) {
  const quotes = new Map();
  let skipped = 0;
  for (const item of Array.isArray(items) ? items : []) {
    try {
      const key = str(item?.key);
      if (!key || !INDEX.has(key)) { skipped += 1; continue; }
      const entry = INDEX.get(key);
      const q = { live: false, basis: entry.group === 'fund_proxy' ? 'sec30day' : 'issuer' };
      if (entry.group === 'savings_bond') {
        q.fixedRate = num(item.fixedRate);
        q.semiannualInflation = num(item.semiannualInflation);
        q.statedRate = num(item.statedRate);
        q.resetOn = str(item.resetOn);
        if (entry.kind === 'I' && (q.fixedRate === null || q.semiannualInflation === null)) { skipped += 1; continue; }
      } else {
        q.yield = num(item.yield);
        if (q.yield === null) { skipped += 1; continue; }
        q.tvl = num(item.tvl);
      }
      quotes.set(key, q);
    } catch {
      skipped += 1;
    }
  }
  return { quotes, skipped };
}

// ---------------------------------------------------------------------------
// Network path
// ---------------------------------------------------------------------------

/**
 * Sibling adapters are required lazily and defensively: this source reuses the
 * chart parser from funds.js and the curve parser from treasury.js rather than
 * keeping second copies of either, but a problem in one of them must degrade
 * this source, not stop it from loading.
 */
function sibling(name) {
  try {
    // eslint-disable-next-line global-require
    return require(`./${name}`);
  } catch {
    return null;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. Never rejects. */
async function mapLimited(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try { await worker(items[i]); } catch { /* per-item failure is expected */ }
    }
  });
  await Promise.all(runners);
}

const CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const chartUrl = (host, symbol) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div%7Csplit`;

/** Live distribution yields for the fund proxies, via the funds.js chart parser. */
async function fetchFundQuotes(ctx, notes, warnings) {
  const quotes = new Map();
  const f = sibling('funds');
  if (typeof f?.parseChart !== 'function' || typeof f?.computeYield !== 'function') {
    warnings.push('Fund-proxy quotes need the parsers in funds.js, which did not load.');
    return quotes;
  }
  const http = ctx.http || baseHttp;
  const nowMs = ctx.now || Date.now();
  const entries = INSTRUMENTS.filter((e) => e.group === 'fund_proxy');

  await mapLimited(entries, 4, async (entry) => {
    for (const host of CHART_HOSTS) {
      let payload;
      try {
        payload = await http.getJSON(chartUrl(host, entry.symbol), { signal: ctx.signal, timeout: 20000, retries: 1 });
      } catch {
        continue;                                   // try the mirror before giving up on the symbol
      }
      const series = f.parseChart(payload);
      if (!series || series.error) continue;
      const y = f.computeYield({ dividends: series.dividends, price: series.price, nowMs });
      if (!Number.isFinite(y?.trailingYield)) continue;
      quotes.set(entry.key, {
        basis: 'trailing',
        yield: y.trailingYield,
        forwardYield: y.forwardYield,
        price: series.price,
        payoutFrequency: y.payoutFrequency,
        live: true,
        dataAsOf: series.lastTsMs ? new Date(series.lastTsMs).toISOString() : null,
      });
      return;
    }
  });

  notes.push(`Fund proxies: ${quotes.size} of ${entries.length} refreshed from live prices and distributions.`);
  if (quotes.size < entries.length) {
    warnings.push(`${entries.length - quotes.size} fund proxy row(s) fell back to the bundled snapshot.`);
  }
  return quotes;
}

/** Live tokenized-Treasury yields from DefiLlama. */
async function fetchRwaQuotes(ctx, notes, warnings) {
  const http = ctx.http || baseHttp;
  let payload;
  try {
    ctx.log?.('bonds: fetching yields.llama.fi/pools for tokenized Treasuries');
    payload = await http.getJSON(POOLS_URL, { signal: ctx.signal, timeout: 30000, retries: 1 });
  } catch (err) {
    warnings.push(`Tokenized Treasury yields: ${err?.status ? `HTTP ${err.status}` : err?.message || String(err)}`);
    return new Map();
  }
  const parsed = parseRwaPools(payload, { dataAsOf: new Date(ctx.now || Date.now()).toISOString() });
  notes.push(...parsed.notes);
  warnings.push(...parsed.warnings);
  return parsed.quotes;
}

const BREAKEVEN_TENORS = [
  { tenor: '5-year', days: 1826 },
  { tenor: '10-year', days: 3653 },
];

/**
 * Live breakeven inflation, reusing the Treasury curve parser rather than a
 * second copy of it. Both curves are needed — a breakeven is a difference, so
 * one of them alone is worth nothing here.
 */
async function fetchBreakevens(ctx, notes) {
  const t = sibling('treasury');
  const http = ctx.http || baseHttp;
  if (typeof t?.csvUrl !== 'function' || typeof t?.parseCurveCSV !== 'function') return null;

  const year = new Date(ctx.now || Date.now()).getUTCFullYear();
  const grab = async (type) => {
    for (const y of [year, year - 1]) {
      try {
        const text = await http.getText(t.csvUrl(y, type), { signal: ctx.signal, timeout: 25000, retries: 1 });
        const parsed = t.parseCurveCSV(text, http.parseCSV);
        if (parsed) return parsed;
      } catch { /* fall through to the prior year, then give up quietly */ }
    }
    return null;
  };

  const [nominal, real] = await Promise.all([
    grab('daily_treasury_yield_curve'),
    grab('daily_treasury_real_yield_curve'),
  ]);
  if (!nominal || !real) return null;

  const pick = (curve, days) => curve.tenors.find((x) => Math.abs(x.days - days) <= 20)?.rate ?? null;
  const pairs = [];
  for (const t2 of BREAKEVEN_TENORS) {
    const n = pick(nominal, t2.days);
    const r = pick(real, t2.days);
    if (n !== null && r !== null) pairs.push({ tenor: t2.tenor, nominal: n, real: r });
  }
  if (pairs.length) notes.push(`Breakevens computed from the ${nominal.dateISO.slice(0, 10)} Treasury curves.`);
  return pairs.length ? pairs : null;
}

async function fetchLive(ctx) {
  const notes = [];
  const warnings = [];

  // The bundled snapshot is the floor, not the fallback: savings-bond rates have
  // no machine-readable source at all, so those rows are always the snapshot and
  // anything the network answers for simply overlays the rest.
  const { items, meta } = contract.readSeed(ctx.seedDir, 'bonds.json');
  const seedParsed = parseSeedItems(items);
  const seedAsOf = str(meta?.dataAsOf) || '2026-08-01';

  const [fundQuotes, rwaQuotes, liveBreakevens] = await Promise.all([
    fetchFundQuotes(ctx, notes, warnings),
    fetchRwaQuotes(ctx, notes, warnings),
    fetchBreakevens(ctx, notes),
  ]);

  const quotes = new Map(seedParsed.quotes);
  for (const [k, v] of fundQuotes) quotes.set(k, v);
  for (const [k, v] of rwaQuotes) {
    // DefiLlama gives a rate and a TVL but not the issuer's fee-adjusted detail,
    // so keep the snapshot's TVL when the live record does not carry one.
    const prior = seedParsed.quotes.get(k);
    quotes.set(k, { ...v, tvl: v.tvl ?? prior?.tvl ?? null });
  }

  const breakevens = liveBreakevens || (Array.isArray(meta?.breakeven) ? meta.breakeven : []);
  if (!liveBreakevens && breakevens.length) {
    notes.push(`Treasury curves were unavailable, so breakevens use the ${seedAsOf} snapshot levels.`);
  }

  const built = buildAll(quotes, {
    schema: ctx.schema || baseSchema,
    C: ctx.C || baseC,
    settings: ctx.settings,
    dataAsOf: seedAsOf,
    seed: true,
    breakevens,
  });

  const live = built.opportunities.filter((o) => !o.seed).length;
  notes.push(...breakevenNotes(breakevens));
  notes.push('Series I and Series EE rates come from the bundled snapshot: TreasuryDirect publishes them on a web page '
    + 'with no machine-readable feed. They only change on 1 May and 1 Nov, so the snapshot is right for six months at a time.');
  if (built.skipped.length) notes.push(`${built.skipped.length} instrument(s) had no usable rate: ${built.skipped.join(', ')}.`);

  if (!built.opportunities.length) {
    return contract.result({ status: 'failed', notes, warnings: warnings.length ? warnings : ['No bond rows could be built.'] });
  }
  const status = live === 0 ? 'partial' : (warnings.length ? 'partial' : 'ok');
  return contract.result({ opportunities: built.opportunities, status, notes, warnings });
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
    const { items, meta } = contract.readSeed(ctx?.seedDir, 'bonds.json');
    const dataAsOf = str(meta?.dataAsOf) || '2026-08-01';
    const breakevens = Array.isArray(meta?.breakeven) ? meta.breakeven : [];
    const { quotes, skipped } = parseSeedItems(items);

    const built = buildAll(quotes, {
      schema: ctx?.schema || baseSchema,
      C: ctx?.C || baseC,
      settings: ctx?.settings,
      dataAsOf,
      seed: true,
      breakevens,
    });

    if (!built.opportunities.length) {
      return contract.result({ status: 'failed', warnings: ['Bundled bond seed is missing or unreadable.'] });
    }

    const notes = [`Bundled snapshot of ${built.opportunities.length} bond, savings-bond and tokenized-Treasury rows as of ${dataAsOf}. Refresh for live levels.`];
    notes.push(...breakevenNotes(breakevens));
    if (skipped) notes.push(`${skipped} seed row(s) skipped as unparseable or unknown.`);
    if (built.skipped.length) notes.push(`${built.skipped.length} instrument(s) had no seed rate: ${built.skipped.join(', ')}.`);
    return contract.result({ opportunities: built.opportunities, status: 'offline', notes });
  } catch (err) {
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Series I and EE savings bonds with their real economics, corporate and municipal yields through real index '
    + 'proxies, and tokenized Treasuries — plus the TIPS breakeven that says when inflation-linked wins.',
  homepage: 'https://www.treasurydirect.gov/savings-bonds/',
  assetClasses: [
    baseC.ASSET_CLASS.GOVT_BOND,
    baseC.ASSET_CLASS.CORP_BOND,
    baseC.ASSET_CLASS.MUNI_BOND,
    baseC.ASSET_CLASS.RWA,
  ],
  requiresNetwork: false,          // savings-bond rows are usable with no network at all
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 6 * 60 * 60 * 1000,       // fund distributions move monthly; tokenized yields, daily

  fetch,
  loadSeed,

  // Exported for the tests, and for anyone extending the instrument list.
  compositeIBondRate,
  doublingApy,
  breakevenInflation,
  breakevenNotes,
  durationDays,
  muniTreatment,
  parseRwaPools,
  parseSeedItems,
  buildOpportunity,
  buildAll,
  INSTRUMENTS,
  CATEGORIES,
  chartUrl,
  POOLS_URL,
};
