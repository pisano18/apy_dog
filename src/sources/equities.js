'use strict';

const contract = require('./_contract');
const baseHttp = require('../core/http');
const baseSchema = require('../core/schema');
const baseC = require('../core/constants');
const { analyse } = require('../core/movement');

/**
 * STOCKS & ETFs — the whole US listed market, in two honest tiers.
 *
 * This source exists because "1,400 investments in the world" was never true.
 * There are about ten thousand US-listed issuers and a normal person's actual
 * portfolio — an S&P 500 fund, a target-date fund, a bond fund — was not in the
 * app at all. Both problems are fixed here, but they are fixed by two different
 * mechanisms, and conflating them would be the dishonest way to do it:
 *
 *   INDEX TIER — one HTTP call to the SEC's own ticker file gets every listed
 *     issuer with its name, CIK and exchange. That is identity and nothing else:
 *     no price, no yield, no volatility, no measurement of any kind. These rows
 *     exist so the thing you are looking for is FINDABLE. They carry
 *     measured:false, a null headline, and confidence 0.2, and every part of the
 *     app that reads them can tell they were never measured.
 *
 *   MEASURED TIER — a curated universe of a few hundred liquid, real tickers,
 *     each one actually analysed from a year of daily closes. Grouped by what a
 *     person is trying to do (retirement core, bonds, dividends, sectors,
 *     megacaps, semis, crypto proxies...) rather than by GICS, because "what do
 *     I put my 401k in" and "what is about to move" are different questions and
 *     both were asked.
 *
 * EFFICIENCY. Measuring 400 symbols one at a time is 400 requests; Yahoo's spark
 * endpoint takes many symbols per call, so it is ~10 requests plus one to the
 * SEC. Every run reports its own HTTP call count in notes[] so that claim can be
 * checked rather than believed.
 *
 * WHAT WE REFUSE TO INVENT. The spark endpoint carries prices and nothing else —
 * no dividend stream. So on the batch path a dividend yield is either remembered
 * from the bundled snapshot (and labelled as remembered) or left null. A null
 * yield on a growth stock is the correct answer: essentially all of NVDA's
 * return is price, and printing "0.02%" next to it would be true, useless, and
 * quietly imply the row belongs in an income screen. fetchOne() falls back to the
 * per-symbol chart endpoint, which does carry dividend events, so any row the
 * user actually opens can be measured end to end.
 *
 * NO PRICE TARGETS, NO EXPECTED RETURNS. Everything on the movement side is
 * computed by core/movement.js from the price series: volatility regime, range
 * position, drawdown, trend. That yields "coiled", "deep drawdown", "expanding" —
 * observations, not forecasts. This file never produces a number that claims to
 * know where a stock is going.
 */

const ID = 'equities';
const LABEL = 'Stocks & ETFs';
const DAY = 86400000;
const MAX_TIME = 8.64e15;          // the widest instant Date can represent

/**
 * How many points of price history travel on a row.
 *
 * A year of daily closes is ~250 numbers, and a few hundred measured rows of
 * that is a hundred thousand floats held in memory to draw sparklines a couple
 * of hundred pixels wide. A chart needs the SHAPE, not every tick, so the series
 * is thinned to this before it is stored.
 */
const MAX_SERIES_POINTS = 120;

/**
 * The SEC blocks requests without a descriptive User-Agent naming a contact.
 * That is their published condition of use, not an obstacle to route around.
 */
const SEC_UA = 'APY Dog research tool (contact via github.com/pisano18/apy_dog)';
const SEC_TICKERS_EXCHANGE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

/** Yahoo truncates very long query strings; 40 symbols is comfortably inside it. */
const BATCH_SIZE = 40;

/** How many index-tier rows to emit. The whole file is ~10k issuers. */
const DEFAULT_INDEX_LIMIT = 12000;

const sparkUrl = (host, symbols) =>
  `${host}/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=1y&interval=1d`;

const chartUrl = (host, symbol) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div%7Csplit`;

const quotePage = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

const edgarPage = (cik) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=&dateb=&owner=include&count=40`;

// Number(null) is 0, which is exactly how a missing yield becomes a confident 0%.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/** An epoch that Date can actually represent. Unguarded, one bad bar throws. */
const safeISO = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME ? new Date(ms).toISOString() : null);

// ---------------------------------------------------------------------------
// Groups: what the user is trying to do, not what sector the issuer is in
// ---------------------------------------------------------------------------

const ETF = baseC.ASSET_CLASS.ETF;
const STOCK = baseC.ASSET_CLASS.DIVIDEND_EQUITY;
const TAX = baseC.TAX_TREATMENT;

const FUND_ACCESS = 'Any US brokerage, commission free. Trades like a stock and settles T+1; one share is the '
  + 'practical minimum, or less wherever fractional shares are supported.';
const STOCK_ACCESS = 'Any US brokerage, commission free. Settles T+1; one share is the practical minimum, or less '
  + 'wherever fractional shares are supported.';
const MUTUAL_ACCESS = 'A mutual fund, not an ETF: buy it from the fund company or a brokerage that carries it. '
  + 'Orders fill once a day at the 4pm NAV, never intraday, and many carry an initial minimum.';

const GROUPS = {
  core_index: {
    label: 'Core index fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'The whole-market building block. Owning one of these is owning the market average, which is the outcome '
      + 'most active investors fail to beat after costs.',
  },
  target_date: {
    label: 'Target-date retirement fund',
    assetClass: ETF,
    taxTreatment: TAX.MIXED,
    note: 'A complete portfolio in one holding, which automatically shifts from stocks toward bonds as the target '
      + 'year approaches. Designed to be the only fund someone owns, so pairing it with other funds quietly undoes '
      + 'the glidepath it exists to provide.',
  },
  bond_core: {
    label: 'Core bond fund',
    assetClass: ETF,
    taxTreatment: TAX.ORDINARY,
    note: 'The ballast side of a portfolio. A bond fund has no maturity date, so unlike a bond you hold to maturity '
      + 'it never returns par: a rate rise is a real price loss until yields come back down.',
  },
  dividend_growth: {
    label: 'Dividend fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Companies chosen for paying and raising dividends. Nothing manufactures the yield here, which is why it '
      + 'looks small next to a covered-call fund and why it has historically been far more durable.',
  },
  sector: {
    label: 'Sector fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'One slice of the market. Concentration cuts both ways: sector funds are where the largest index-fund-shaped '
      + 'drawdowns come from.',
  },
  factor: {
    label: 'Style / factor fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Tilts the market toward value, growth, size, momentum or low volatility. The tilts are real and they can '
      + 'underperform the plain index for a decade at a time.',
  },
  international: {
    label: 'International fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Non-US exposure. Carries currency risk on top of market risk, and foreign withholding tax makes these worth '
      + 'more in a taxable account, where the foreign tax credit is claimable, than in an IRA where it is simply lost.',
  },
  commodity: {
    label: 'Commodity fund',
    assetClass: ETF,
    taxTreatment: TAX.MIXED,
    note: 'Owns metal, or futures on something physical. Produces no earnings and no interest, so the entire return is '
      + 'price. Tax treatment is unusual — metal trusts are taxed as collectibles, futures funds issue their own forms.',
  },
  megacap: {
    label: 'Megacap stock',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'The largest US companies. Liquid enough that price is never the problem; concentration is.',
  },
  high_growth: {
    label: 'High-growth stock',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Priced on future growth rather than current earnings, which is why the moves are violent in both directions '
      + 'and why the dividend is usually zero.',
  },
  semis: {
    label: 'Semiconductor',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'The most cyclical corner of technology. Capacity decisions are made years ahead of demand, so this group '
      + 'overshoots in both directions more than almost anything else in the market.',
  },
  biotech: {
    label: 'Healthcare / biotech',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Binary events — trial readouts, approvals, patent cliffs — dominate returns here, and none of them are on a '
      + 'schedule this app can see.',
  },
  energy: {
    label: 'Energy',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Earnings track a commodity price nobody forecasts well. High dividends here are funded by that commodity '
      + 'price, so they rise and fall with it.',
  },
  financials: {
    label: 'Financial',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Levered by construction. Banks earn a spread on borrowed money, which is a fine business until funding '
      + 'costs or credit turn.',
  },
  consumer: {
    label: 'Consumer',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Staples are the defensive end of the market and rarely move much; discretionary names swing with how '
      + 'confident households feel.',
  },
  industrials: {
    label: 'Industrial',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Long order books and heavy fixed costs, so results lag the economy and then amplify it.',
  },
  small_cap: {
    label: 'Small-cap fund',
    assetClass: ETF,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Smaller companies, historically higher returns and unmistakably rougher rides. Small-cap value in '
      + 'particular has gone a decade at a stretch without beating the S&P.',
  },
  crypto_equity: {
    label: 'Crypto-linked equity or trust',
    assetClass: ETF,
    taxTreatment: TAX.CAPITAL_GAIN_LONG,
    note: 'A proxy for a coin price, wrapped in a brokerage account. Spot trusts track the coin closely; miners and '
      + 'treasury companies add leverage, dilution and operating risk on top of it.',
  },
  volatility_adjacent: {
    label: 'Volatility / hedge',
    assetClass: ETF,
    taxTreatment: TAX.MIXED,
    note: 'These are trading instruments, not investments. VIX futures products bleed value structurally when markets '
      + 'are calm, which is most of the time, and are designed to be held for days rather than years.',
  },
  user: {
    label: 'Measured on request',
    assetClass: STOCK,
    taxTreatment: TAX.QUALIFIED_DIVIDEND,
    note: 'Measured on demand from its price history because you opened it.',
  },
};

/**
 * The measured universe: real, liquid tickers only, no penny stocks.
 *
 * Deliberately weighted toward what people actually hold. Roughly a third of
 * this list is boring — index funds, target-date funds, bond funds — because
 * that is roughly what a real portfolio looks like, and a screener that only
 * knows about semiconductors is a toy.
 *
 * `min` is a real mutual-fund initial minimum where one exists; everything else
 * takes one share.
 */
const MEASURED_UNIVERSE = {
  core_index: [
    ['VTI', 'Vanguard Total Stock Market ETF'],
    ['VOO', 'Vanguard S&P 500 ETF'],
    ['SPY', 'SPDR S&P 500 ETF Trust'],
    ['IVV', 'iShares Core S&P 500 ETF'],
    ['QQQ', 'Invesco QQQ Trust'],
    ['QQQM', 'Invesco NASDAQ 100 ETF'],
    ['ITOT', 'iShares Core S&P Total US Stock Market ETF'],
    ['SCHB', 'Schwab US Broad Market ETF'],
    ['SCHX', 'Schwab US Large-Cap ETF'],
    ['SCHG', 'Schwab US Large-Cap Growth ETF'],
    ['SCHV', 'Schwab US Large-Cap Value ETF'],
    ['SPLG', 'SPDR Portfolio S&P 500 ETF'],
    ['SPTM', 'SPDR Portfolio S&P 1500 Composite Stock Market ETF'],
    ['SPMD', 'SPDR Portfolio S&P 400 Mid Cap ETF'],
    ['SPSM', 'SPDR Portfolio S&P 600 Small Cap ETF'],
    ['VXUS', 'Vanguard Total International Stock ETF'],
    ['VT', 'Vanguard Total World Stock ETF'],
    ['IWB', 'iShares Russell 1000 ETF'],
    ['IWM', 'iShares Russell 2000 ETF'],
    ['VTWO', 'Vanguard Russell 2000 ETF'],
    ['IJH', 'iShares Core S&P Mid-Cap ETF'],
    ['IJR', 'iShares Core S&P Small-Cap ETF'],
    ['VO', 'Vanguard Mid-Cap ETF'],
    ['VB', 'Vanguard Small-Cap ETF'],
    ['DIA', 'SPDR Dow Jones Industrial Average ETF Trust'],
    ['RSP', 'Invesco S&P 500 Equal Weight ETF'],
    ['MDY', 'SPDR S&P MidCap 400 ETF Trust'],
    ['VOOG', 'Vanguard S&P 500 Growth ETF'],
    ['VOOV', 'Vanguard S&P 500 Value ETF'],
    ['FXAIX', 'Fidelity 500 Index Fund'],
    ['FSKAX', 'Fidelity Total Market Index Fund'],
    ['FZROX', 'Fidelity ZERO Total Market Index Fund'],
    ['VTSAX', 'Vanguard Total Stock Market Index Fund Admiral', { min: 3000 }],
    ['VFIAX', 'Vanguard 500 Index Fund Admiral', { min: 3000 }],
    ['SWPPX', 'Schwab S&P 500 Index Fund'],
    ['SWTSX', 'Schwab Total Stock Market Index Fund'],
  ],
  target_date: [
    ['VTINX', 'Vanguard Target Retirement Income Fund', { min: 1000 }],
    ['VTWNX', 'Vanguard Target Retirement 2020 Fund', { min: 1000 }],
    ['VTTVX', 'Vanguard Target Retirement 2025 Fund', { min: 1000 }],
    ['VTHRX', 'Vanguard Target Retirement 2030 Fund', { min: 1000 }],
    ['VTTHX', 'Vanguard Target Retirement 2035 Fund', { min: 1000 }],
    ['VFORX', 'Vanguard Target Retirement 2040 Fund', { min: 1000 }],
    ['VTIVX', 'Vanguard Target Retirement 2045 Fund', { min: 1000 }],
    ['VFIFX', 'Vanguard Target Retirement 2050 Fund', { min: 1000 }],
    ['VFFVX', 'Vanguard Target Retirement 2055 Fund', { min: 1000 }],
    ['VTTSX', 'Vanguard Target Retirement 2060 Fund', { min: 1000 }],
    ['VLXVX', 'Vanguard Target Retirement 2065 Fund', { min: 1000 }],
    ['VSVNX', 'Vanguard Target Retirement 2070 Fund', { min: 1000 }],
    ['FXIFX', 'Fidelity Freedom Index 2030 Fund'],
    ['FIHFX', 'Fidelity Freedom Index 2035 Fund'],
    ['FBIFX', 'Fidelity Freedom Index 2040 Fund'],
    ['FIOFX', 'Fidelity Freedom Index 2045 Fund'],
    ['FIPFX', 'Fidelity Freedom Index 2050 Fund'],
    ['FDEWX', 'Fidelity Freedom Index 2055 Fund'],
  ],
  bond_core: [
    ['BND', 'Vanguard Total Bond Market ETF'],
    ['AGG', 'iShares Core US Aggregate Bond ETF'],
    ['BNDX', 'Vanguard Total International Bond ETF'],
    ['BNDW', 'Vanguard Total World Bond ETF'],
    ['IUSB', 'iShares Core Total USD Bond Market ETF'],
    ['SPAB', 'SPDR Portfolio Aggregate Bond ETF'],
    ['SCHZ', 'Schwab US Aggregate Bond ETF'],
    ['VGSH', 'Vanguard Short-Term Treasury ETF'],
    ['VGIT', 'Vanguard Intermediate-Term Treasury ETF'],
    ['VGLT', 'Vanguard Long-Term Treasury ETF'],
    ['SHY', 'iShares 1-3 Year Treasury Bond ETF'],
    ['IEI', 'iShares 3-7 Year Treasury Bond ETF'],
    ['IEF', 'iShares 7-10 Year Treasury Bond ETF'],
    ['TLT', 'iShares 20+ Year Treasury Bond ETF'],
    ['GOVT', 'iShares US Treasury Bond ETF'],
    ['SCHO', 'Schwab Short-Term US Treasury ETF'],
    ['SCHR', 'Schwab Intermediate-Term US Treasury ETF'],
    ['BSV', 'Vanguard Short-Term Bond ETF'],
    ['BIV', 'Vanguard Intermediate-Term Bond ETF'],
    ['BLV', 'Vanguard Long-Term Bond ETF'],
    ['MBB', 'iShares MBS ETF'],
    ['VCSH', 'Vanguard Short-Term Corporate Bond ETF'],
    ['VCIT', 'Vanguard Intermediate-Term Corporate Bond ETF'],
    ['LQD', 'iShares iBoxx $ Investment Grade Corporate Bond ETF'],
    ['IGSB', 'iShares 1-5 Year Investment Grade Corporate Bond ETF'],
    ['TIP', 'iShares TIPS Bond ETF'],
    ['VTIP', 'Vanguard Short-Term Inflation-Protected Securities ETF'],
    ['SCHP', 'Schwab US TIPS ETF'],
    ['STIP', 'iShares 0-5 Year TIPS Bond ETF'],
    ['FXNAX', 'Fidelity US Bond Index Fund'],
    ['VBTLX', 'Vanguard Total Bond Market Index Fund Admiral', { min: 3000 }],
  ],
  dividend_growth: [
    ['SCHD', 'Schwab US Dividend Equity ETF'],
    ['VIG', 'Vanguard Dividend Appreciation ETF'],
    ['DGRO', 'iShares Core Dividend Growth ETF'],
    ['NOBL', 'ProShares S&P 500 Dividend Aristocrats ETF'],
    ['VYM', 'Vanguard High Dividend Yield ETF'],
    ['DVY', 'iShares Select Dividend ETF'],
    ['HDV', 'iShares Core High Dividend ETF'],
    ['SDY', 'SPDR S&P Dividend ETF'],
    ['RDVY', 'First Trust Rising Dividend Achievers ETF'],
    ['FDVV', 'Fidelity High Dividend ETF'],
    ['DGRW', 'WisdomTree US Quality Dividend Growth Fund'],
    ['DLN', 'WisdomTree US LargeCap Dividend Fund'],
    ['PEY', 'Invesco High Yield Equity Dividend Achievers ETF'],
    ['VIGI', 'Vanguard International Dividend Appreciation ETF'],
    ['IDV', 'iShares International Select Dividend ETF'],
  ],
  sector: [
    ['XLK', 'Technology Select Sector SPDR Fund'],
    ['XLE', 'Energy Select Sector SPDR Fund'],
    ['XLF', 'Financial Select Sector SPDR Fund'],
    ['XLV', 'Health Care Select Sector SPDR Fund'],
    ['XLI', 'Industrial Select Sector SPDR Fund'],
    ['XLU', 'Utilities Select Sector SPDR Fund'],
    ['XLP', 'Consumer Staples Select Sector SPDR Fund'],
    ['XLY', 'Consumer Discretionary Select Sector SPDR Fund'],
    ['XLB', 'Materials Select Sector SPDR Fund'],
    ['XLRE', 'Real Estate Select Sector SPDR Fund'],
    ['XLC', 'Communication Services Select Sector SPDR Fund'],
    ['XOP', 'SPDR S&P Oil & Gas Exploration & Production ETF'],
    ['XME', 'SPDR S&P Metals & Mining ETF'],
    ['XRT', 'SPDR S&P Retail ETF'],
    ['XHB', 'SPDR S&P Homebuilders ETF'],
    ['ITB', 'iShares US Home Construction ETF'],
    ['IGV', 'iShares Expanded Tech-Software Sector ETF'],
    ['IYT', 'iShares US Transportation ETF'],
  ],
  factor: [
    ['VTV', 'Vanguard Value ETF'],
    ['VUG', 'Vanguard Growth ETF'],
    ['VOE', 'Vanguard Mid-Cap Value ETF'],
    ['VOT', 'Vanguard Mid-Cap Growth ETF'],
    ['VBR', 'Vanguard Small-Cap Value ETF'],
    ['VBK', 'Vanguard Small-Cap Growth ETF'],
    ['MTUM', 'iShares MSCI USA Momentum Factor ETF'],
    ['QUAL', 'iShares MSCI USA Quality Factor ETF'],
    ['USMV', 'iShares MSCI USA Min Vol Factor ETF'],
    ['VLUE', 'iShares MSCI USA Value Factor ETF'],
    ['SPHQ', 'Invesco S&P 500 Quality ETF'],
    ['SPMO', 'Invesco S&P 500 Momentum ETF'],
    ['IWF', 'iShares Russell 1000 Growth ETF'],
    ['IWD', 'iShares Russell 1000 Value ETF'],
    ['IWP', 'iShares Russell Mid-Cap Growth ETF'],
    ['IWS', 'iShares Russell Mid-Cap Value ETF'],
    ['IVW', 'iShares S&P 500 Growth ETF'],
    ['IVE', 'iShares S&P 500 Value ETF'],
  ],
  international: [
    ['VEA', 'Vanguard FTSE Developed Markets ETF'],
    ['VWO', 'Vanguard FTSE Emerging Markets ETF'],
    ['EFA', 'iShares MSCI EAFE ETF'],
    ['EEM', 'iShares MSCI Emerging Markets ETF'],
    ['IEFA', 'iShares Core MSCI EAFE ETF'],
    ['IEMG', 'iShares Core MSCI Emerging Markets ETF'],
    ['ACWI', 'iShares MSCI ACWI ETF'],
    ['SCHF', 'Schwab International Equity ETF'],
    ['VGK', 'Vanguard FTSE Europe ETF'],
    ['VPL', 'Vanguard FTSE Pacific ETF'],
    ['VSS', 'Vanguard FTSE All-World ex-US Small-Cap ETF'],
    ['FXI', 'iShares China Large-Cap ETF'],
    ['EWJ', 'iShares MSCI Japan ETF'],
    ['EWZ', 'iShares MSCI Brazil ETF'],
    ['EWY', 'iShares MSCI South Korea ETF'],
    ['EWG', 'iShares MSCI Germany ETF'],
    ['EWU', 'iShares MSCI United Kingdom ETF'],
    ['EWC', 'iShares MSCI Canada ETF'],
    ['EWA', 'iShares MSCI Australia ETF'],
    ['EWT', 'iShares MSCI Taiwan ETF'],
    ['EWH', 'iShares MSCI Hong Kong ETF'],
    ['EWL', 'iShares MSCI Switzerland ETF'],
    ['EWQ', 'iShares MSCI France ETF'],
    ['INDA', 'iShares MSCI India ETF'],
  ],
  commodity: [
    ['GLD', 'SPDR Gold Shares'],
    ['GLDM', 'SPDR Gold MiniShares Trust'],
    ['IAU', 'iShares Gold Trust'],
    ['SLV', 'iShares Silver Trust'],
    ['PPLT', 'abrdn Physical Platinum Shares ETF'],
    ['DBC', 'Invesco DB Commodity Index Tracking Fund'],
    ['PDBC', 'Invesco Optimum Yield Diversified Commodity Strategy No K-1 ETF'],
    ['DBA', 'Invesco DB Agriculture Fund'],
    ['USO', 'United States Oil Fund'],
    ['UNG', 'United States Natural Gas Fund'],
    ['CPER', 'United States Copper Index Fund'],
    ['COPX', 'Global X Copper Miners ETF'],
    ['GDX', 'VanEck Gold Miners ETF'],
    ['GDXJ', 'VanEck Junior Gold Miners ETF'],
    ['SIL', 'Global X Silver Miners ETF'],
  ],
  megacap: [
    ['AAPL', 'Apple Inc.'],
    ['MSFT', 'Microsoft Corporation'],
    ['NVDA', 'NVIDIA Corporation'],
    ['AMZN', 'Amazon.com, Inc.'],
    ['GOOGL', 'Alphabet Inc.'],
    ['META', 'Meta Platforms, Inc.'],
    ['TSLA', 'Tesla, Inc.'],
    ['BRK-B', 'Berkshire Hathaway Inc. Class B'],
    ['AVGO', 'Broadcom Inc.'],
    ['JPM', 'JPMorgan Chase & Co.'],
    ['V', 'Visa Inc.'],
    ['MA', 'Mastercard Incorporated'],
    ['UNH', 'UnitedHealth Group Incorporated'],
    ['XOM', 'Exxon Mobil Corporation'],
    ['JNJ', 'Johnson & Johnson'],
    ['WMT', 'Walmart Inc.'],
    ['PG', 'The Procter & Gamble Company'],
    ['HD', 'The Home Depot, Inc.'],
    ['LLY', 'Eli Lilly and Company'],
    ['COST', 'Costco Wholesale Corporation'],
    ['ORCL', 'Oracle Corporation'],
    ['CSCO', 'Cisco Systems, Inc.'],
    ['CRM', 'Salesforce, Inc.'],
    ['ADBE', 'Adobe Inc.'],
    ['NFLX', 'Netflix, Inc.'],
    ['ABT', 'Abbott Laboratories'],
    ['TMO', 'Thermo Fisher Scientific Inc.'],
    ['ACN', 'Accenture plc'],
    ['IBM', 'International Business Machines Corporation'],
    ['INTU', 'Intuit Inc.'],
  ],
  high_growth: [
    ['PLTR', 'Palantir Technologies Inc.'],
    ['CRWD', 'CrowdStrike Holdings, Inc.'],
    ['SNOW', 'Snowflake Inc.'],
    ['DDOG', 'Datadog, Inc.'],
    ['NET', 'Cloudflare, Inc.'],
    ['SHOP', 'Shopify Inc.'],
    ['MELI', 'MercadoLibre, Inc.'],
    ['NOW', 'ServiceNow, Inc.'],
    ['UBER', 'Uber Technologies, Inc.'],
    ['ABNB', 'Airbnb, Inc.'],
    ['TTD', 'The Trade Desk, Inc.'],
    ['PANW', 'Palo Alto Networks, Inc.'],
    ['ANET', 'Arista Networks, Inc.'],
    ['DASH', 'DoorDash, Inc.'],
    ['RBLX', 'Roblox Corporation'],
    ['HOOD', 'Robinhood Markets, Inc.'],
    ['ZS', 'Zscaler, Inc.'],
    ['OKTA', 'Okta, Inc.'],
    ['MDB', 'MongoDB, Inc.'],
    ['TEAM', 'Atlassian Corporation'],
    ['WDAY', 'Workday, Inc.'],
    ['VEEV', 'Veeva Systems Inc.'],
    ['HUBS', 'HubSpot, Inc.'],
    ['TWLO', 'Twilio Inc.'],
  ],
  semis: [
    ['AMD', 'Advanced Micro Devices, Inc.'],
    ['INTC', 'Intel Corporation'],
    ['TSM', 'Taiwan Semiconductor Manufacturing Company Limited'],
    ['MU', 'Micron Technology, Inc.'],
    ['AMAT', 'Applied Materials, Inc.'],
    ['LRCX', 'Lam Research Corporation'],
    ['KLAC', 'KLA Corporation'],
    ['ADI', 'Analog Devices, Inc.'],
    ['TXN', 'Texas Instruments Incorporated'],
    ['QCOM', 'QUALCOMM Incorporated'],
    ['ARM', 'Arm Holdings plc'],
    ['ASML', 'ASML Holding N.V.'],
    ['NXPI', 'NXP Semiconductors N.V.'],
    ['MRVL', 'Marvell Technology, Inc.'],
    ['ON', 'ON Semiconductor Corporation'],
    ['SWKS', 'Skyworks Solutions, Inc.'],
    ['MCHP', 'Microchip Technology Incorporated'],
    ['TER', 'Teradyne, Inc.'],
    ['ENTG', 'Entegris, Inc.'],
    ['SMH', 'VanEck Semiconductor ETF'],
    ['SOXX', 'iShares Semiconductor ETF'],
  ],
  biotech: [
    ['AMGN', 'Amgen Inc.'],
    ['GILD', 'Gilead Sciences, Inc.'],
    ['VRTX', 'Vertex Pharmaceuticals Incorporated'],
    ['REGN', 'Regeneron Pharmaceuticals, Inc.'],
    ['BIIB', 'Biogen Inc.'],
    ['MRNA', 'Moderna, Inc.'],
    ['PFE', 'Pfizer Inc.'],
    ['MRK', 'Merck & Co., Inc.'],
    ['ABBV', 'AbbVie Inc.'],
    ['BMY', 'Bristol-Myers Squibb Company'],
    ['ISRG', 'Intuitive Surgical, Inc.'],
    ['ZTS', 'Zoetis Inc.'],
    ['DXCM', 'DexCom, Inc.'],
    ['ALNY', 'Alnylam Pharmaceuticals, Inc.'],
    ['INCY', 'Incyte Corporation'],
    ['VTRS', 'Viatris Inc.'],
    ['XBI', 'SPDR S&P Biotech ETF'],
    ['IBB', 'iShares Biotechnology ETF'],
  ],
  energy: [
    ['CVX', 'Chevron Corporation'],
    ['COP', 'ConocoPhillips'],
    ['EOG', 'EOG Resources, Inc.'],
    ['SLB', 'Schlumberger Limited'],
    ['OXY', 'Occidental Petroleum Corporation'],
    ['PSX', 'Phillips 66'],
    ['VLO', 'Valero Energy Corporation'],
    ['MPC', 'Marathon Petroleum Corporation'],
    ['KMI', 'Kinder Morgan, Inc.'],
    ['WMB', 'The Williams Companies, Inc.'],
    ['OKE', 'ONEOK, Inc.'],
    ['TRGP', 'Targa Resources Corp.'],
    ['FANG', 'Diamondback Energy, Inc.'],
    ['HES', 'Hess Corporation'],
    ['BKR', 'Baker Hughes Company'],
    ['CTRA', 'Coterra Energy Inc.'],
    ['DVN', 'Devon Energy Corporation'],
    ['HAL', 'Halliburton Company'],
  ],
  financials: [
    ['BAC', 'Bank of America Corporation'],
    ['WFC', 'Wells Fargo & Company'],
    ['GS', 'The Goldman Sachs Group, Inc.'],
    ['MS', 'Morgan Stanley'],
    ['C', 'Citigroup Inc.'],
    ['SCHW', 'The Charles Schwab Corporation'],
    ['BLK', 'BlackRock, Inc.'],
    ['AXP', 'American Express Company'],
    ['SPGI', 'S&P Global Inc.'],
    ['PNC', 'The PNC Financial Services Group, Inc.'],
    ['USB', 'U.S. Bancorp'],
    ['TFC', 'Truist Financial Corporation'],
    ['COF', 'Capital One Financial Corporation'],
    ['BK', 'The Bank of New York Mellon Corporation'],
    ['MET', 'MetLife, Inc.'],
    ['PRU', 'Prudential Financial, Inc.'],
    ['AIG', 'American International Group, Inc.'],
    ['ICE', 'Intercontinental Exchange, Inc.'],
    ['CME', 'CME Group Inc.'],
    ['MMC', 'Marsh & McLennan Companies, Inc.'],
    ['CB', 'Chubb Limited'],
    ['KRE', 'SPDR S&P Regional Banking ETF'],
  ],
  consumer: [
    ['KO', 'The Coca-Cola Company'],
    ['PEP', 'PepsiCo, Inc.'],
    ['MCD', "McDonald's Corporation"],
    ['NKE', 'NIKE, Inc.'],
    ['SBUX', 'Starbucks Corporation'],
    ['TGT', 'Target Corporation'],
    ['LOW', "Lowe's Companies, Inc."],
    ['DIS', 'The Walt Disney Company'],
    ['CMG', 'Chipotle Mexican Grill, Inc.'],
    ['YUM', 'Yum! Brands, Inc.'],
    ['PM', 'Philip Morris International Inc.'],
    ['MO', 'Altria Group, Inc.'],
    ['DG', 'Dollar General Corporation'],
    ['DLTR', 'Dollar Tree, Inc.'],
    ['ROST', 'Ross Stores, Inc.'],
    ['TJX', 'The TJX Companies, Inc.'],
    ['EBAY', 'eBay Inc.'],
    ['KHC', 'The Kraft Heinz Company'],
    ['GIS', 'General Mills, Inc.'],
    ['CL', 'Colgate-Palmolive Company'],
    ['KMB', 'Kimberly-Clark Corporation'],
    ['SYY', 'Sysco Corporation'],
  ],
  industrials: [
    ['CAT', 'Caterpillar Inc.'],
    ['DE', 'Deere & Company'],
    ['HON', 'Honeywell International Inc.'],
    ['UNP', 'Union Pacific Corporation'],
    ['UPS', 'United Parcel Service, Inc.'],
    ['BA', 'The Boeing Company'],
    ['GE', 'GE Aerospace'],
    ['LMT', 'Lockheed Martin Corporation'],
    ['RTX', 'RTX Corporation'],
    ['MMM', '3M Company'],
    ['ETN', 'Eaton Corporation plc'],
    ['EMR', 'Emerson Electric Co.'],
    ['NOC', 'Northrop Grumman Corporation'],
    ['GD', 'General Dynamics Corporation'],
    ['CSX', 'CSX Corporation'],
    ['NSC', 'Norfolk Southern Corporation'],
    ['FDX', 'FedEx Corporation'],
    ['WM', 'Waste Management, Inc.'],
    ['ITW', 'Illinois Tool Works Inc.'],
    ['PH', 'Parker-Hannifin Corporation'],
    ['ROK', 'Rockwell Automation, Inc.'],
    ['TT', 'Trane Technologies plc'],
  ],
  small_cap: [
    ['AVUV', 'Avantis US Small Cap Value ETF'],
    ['IJS', 'iShares S&P Small-Cap 600 Value ETF'],
    ['IJT', 'iShares S&P Small-Cap 600 Growth ETF'],
    ['VIOO', 'Vanguard S&P Small-Cap 600 ETF'],
    ['VIOV', 'Vanguard S&P Small-Cap 600 Value ETF'],
    ['SLYV', 'SPDR S&P 600 Small Cap Value ETF'],
    ['SLYG', 'SPDR S&P 600 Small Cap Growth ETF'],
    ['DFSV', 'Dimensional US Small Cap Value ETF'],
    ['DFAS', 'Dimensional US Small Cap ETF'],
    ['SCHA', 'Schwab US Small-Cap ETF'],
    ['IWN', 'iShares Russell 2000 Value ETF'],
    ['IWO', 'iShares Russell 2000 Growth ETF'],
    ['IJJ', 'iShares S&P Mid-Cap 400 Value ETF'],
    ['PRFZ', 'Invesco RAFI US 1500 Small-Mid ETF'],
  ],
  crypto_equity: [
    ['IBIT', 'iShares Bitcoin Trust ETF'],
    ['FBTC', 'Fidelity Wise Origin Bitcoin Fund'],
    ['BITB', 'Bitwise Bitcoin ETF'],
    ['ARKB', 'ARK 21Shares Bitcoin ETF'],
    ['GBTC', 'Grayscale Bitcoin Trust ETF'],
    ['BITO', 'ProShares Bitcoin Strategy ETF'],
    ['COIN', 'Coinbase Global, Inc.'],
    ['MSTR', 'MicroStrategy Incorporated'],
    ['MARA', 'MARA Holdings, Inc.'],
    ['RIOT', 'Riot Platforms, Inc.'],
    ['CLSK', 'CleanSpark, Inc.'],
    ['CIFR', 'Cipher Mining Inc.'],
    ['WULF', 'TeraWulf Inc.'],
    ['HUT', 'Hut 8 Corp.'],
  ],
  volatility_adjacent: [
    ['VIXY', 'ProShares VIX Short-Term Futures ETF'],
    ['VIXM', 'ProShares VIX Mid-Term Futures ETF'],
    ['UVXY', 'ProShares Ultra VIX Short-Term Futures ETF'],
    ['SVXY', 'ProShares Short VIX Short-Term Futures ETF'],
    ['VXX', 'iPath Series B S&P 500 VIX Short-Term Futures ETN'],
    ['SH', 'ProShares Short S&P500'],
    ['SPLV', 'Invesco S&P 500 Low Volatility ETF'],
    ['SPHB', 'Invesco S&P 500 High Beta ETF'],
    ['BTAL', 'AGF US Market Neutral Anti-Beta Fund'],
    ['TAIL', 'Cambria Tail Risk ETF'],
  ],
};

/** Flatten the universe once, first group wins if a ticker appears twice. */
function universeEntries() {
  const out = [];
  const seen = new Set();
  for (const [group, rows] of Object.entries(MEASURED_UNIVERSE)) {
    for (const row of rows) {
      const symbol = String(row?.[0] || '').toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push({ symbol, name: String(row[1] || symbol), group, ...(row[2] || {}) });
    }
  }
  return out;
}

/**
 * The universe this run will actually measure, after user settings.
 * settings.sources.equities: { groups, excludeSymbols, extraSymbols, measuredLimit }
 */
function resolveUniverse(settings = {}) {
  const cfg = settings?.sources?.equities || settings?.equities || {};
  const wanted = Array.isArray(cfg.groups) && cfg.groups.length ? new Set(cfg.groups) : null;
  const excluded = new Set((cfg.excludeSymbols || []).map((s) => String(s).toUpperCase()));

  let entries = universeEntries()
    .filter((e) => (!wanted || wanted.has(e.group)) && !excluded.has(e.symbol));

  const known = new Set(entries.map((e) => e.symbol));
  for (const s of cfg.extraSymbols || []) {
    const sym = String(s).trim().toUpperCase();
    if (!sym || known.has(sym) || excluded.has(sym)) continue;
    known.add(sym);
    entries.push({ symbol: sym, name: sym, group: 'user' });
  }

  const limit = num(cfg.measuredLimit);
  if (limit !== null && limit > 0 && entries.length > limit) entries = entries.slice(0, Math.floor(limit));
  return entries;
}

// ---------------------------------------------------------------------------
// PURE PARSERS — no network, no clock beyond what is passed in
// ---------------------------------------------------------------------------

/**
 * SEC ticker file -> {cik, ticker, name, exchange}[].
 *
 * The SEC publishes this in two shapes and has changed which is which before:
 *   company_tickers.json           { "0": {cik_str, ticker, title}, ... }
 *   company_tickers_exchange.json  { fields: [...], data: [[...], ...] }
 * A bare array turns up in mirrors. All three are accepted, and anything else
 * degrades to zero rows rather than throwing — an index tier that fails to parse
 * costs the user a search box, not the app.
 */
function parseTickerIndex(payload, opts = {}) {
  const skip = opts.skipSymbols instanceof Set
    ? opts.skipSymbols
    : new Set((opts.skipSymbols || []).map((s) => String(s).toUpperCase()));
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_INDEX_LIMIT;

  const records = [];
  const dropped = { unparseable: 0, noTicker: 0, duplicate: 0, alreadyMeasured: 0 };
  const seen = new Set();

  const push = (cik, ticker, name, exchange) => {
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) { dropped.noTicker += 1; return; }
    if (skip.has(sym)) { dropped.alreadyMeasured += 1; return; }
    if (seen.has(sym)) { dropped.duplicate += 1; return; }
    seen.add(sym);
    const cikNum = num(cik);
    records.push({
      // CIKs are zero-padded to ten digits everywhere in EDGAR; the JSON file
      // ships them as bare integers, so pad here or every link 404s.
      cik: cikNum === null ? null : String(Math.round(cikNum)).padStart(10, '0'),
      ticker: sym,
      name: str(name) || sym,
      exchange: str(exchange),
    });
  };

  try {
    if (payload && Array.isArray(payload.data) && Array.isArray(payload.fields)) {
      // Field order is not guaranteed, so resolve by name rather than position.
      const f = payload.fields.map((x) => String(x || '').toLowerCase());
      const iCik = f.indexOf('cik');
      const iTicker = f.indexOf('ticker');
      const iName = f.findIndex((x) => x === 'name' || x === 'title');
      const iExch = f.indexOf('exchange');
      for (const row of payload.data) {
        if (!Array.isArray(row)) { dropped.unparseable += 1; continue; }
        push(iCik >= 0 ? row[iCik] : null, iTicker >= 0 ? row[iTicker] : null,
          iName >= 0 ? row[iName] : null, iExch >= 0 ? row[iExch] : null);
        if (records.length >= limit) break;
      }
    } else {
      const rows = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' ? Object.values(payload) : []);
      for (const r of rows) {
        if (!r || typeof r !== 'object') { dropped.unparseable += 1; continue; }
        push(r.cik_str ?? r.cik ?? r.CIK, r.ticker ?? r.Ticker, r.title ?? r.name ?? r.Title, r.exchange ?? r.Exchange);
        if (records.length >= limit) break;
      }
    }
  } catch {
    // A shape we have never seen. Report nothing rather than half a list.
    return { records: [], dropped: { ...dropped, unparseable: dropped.unparseable + 1 } };
  }

  return { records, dropped };
}

/**
 * Yahoo spark -> symbol -> {closes, volumes, lastTsMs, previousClose}.
 *
 * Two shapes are in the wild and both are handled: a flat map keyed by symbol,
 * and the older {spark:{result:[{symbol, response:[{timestamp, indicators…}]}]}}
 * envelope. The endpoint carries no volume in either shape, which is why
 * volumes comes back empty and volume anomalies are unavailable on this path.
 */
function parseSpark(payload) {
  const out = new Map();
  const numbers = (a) => (Array.isArray(a) ? a.map(num) : []);

  const take = (symbol, closes, timestamps, prev) => {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    const c = numbers(closes).filter((v) => v !== null && v > 0);
    if (c.length < 20) return;                       // too little to say anything about
    const ts = numbers(timestamps);
    const lastTs = [...ts].reverse().find((v) => v !== null) ?? null;
    out.set(sym, {
      symbol: sym,
      closes: c,
      volumes: [],
      // Spark timestamps are seconds. A corrupt one can land outside the range
      // Date can represent, and toISOString() throws there rather than
      // returning null, so the conversion is guarded downstream.
      lastTsMs: lastTs === null ? null : lastTs * 1000,
      previousClose: num(prev),
    });
  };

  try {
    if (!payload || typeof payload !== 'object') return out;

    const envelope = Array.isArray(payload?.spark?.result) ? payload.spark.result
      : Array.isArray(payload?.result) ? payload.result
        : null;

    if (envelope) {
      for (const r of envelope) {
        if (!r || typeof r !== 'object') continue;
        const resp = Array.isArray(r.response) ? r.response[0] : null;
        if (resp) {
          const quote = Array.isArray(resp.indicators?.quote) ? resp.indicators.quote[0] : null;
          take(r.symbol || resp.meta?.symbol, quote?.close ?? resp.close, resp.timestamp, resp.meta?.chartPreviousClose);
        } else {
          take(r.symbol, r.close, r.timestamp, r.previousClose ?? r.chartPreviousClose);
        }
      }
      return out;
    }

    for (const [key, r] of Object.entries(payload)) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      take(r.symbol || key, r.close, r.timestamp, r.previousClose ?? r.chartPreviousClose);
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Yahoo v8 chart -> one symbol's series, WITH volume and dividend events.
 * This is the fallback and the fetchOne path; it costs one request per symbol,
 * which is exactly why it is not the bulk path.
 */
function parseChart(payload) {
  try {
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
    // Adjusted closes are the right input for volatility and trend; raw close is
    // the honest fallback and only overstates both slightly.
    const adjRaw = Array.isArray(adjBlock?.adjclose) ? adjBlock.adjclose.map(num) : [];
    const adj = adjRaw.length ? adjRaw : close;
    const volume = Array.isArray(quote?.volume) ? quote.volume.map(num) : [];

    const dividends = [];
    const divEvents = r.events?.dividends;
    const divList = Array.isArray(divEvents)
      ? divEvents
      : (divEvents && typeof divEvents === 'object' ? Object.entries(divEvents) : []);
    for (const item of divList) {
      const [key, rec] = Array.isArray(item) ? item : [null, item];
      const amount = num(rec?.amount);
      const secs = num(rec?.date) ?? num(key);
      if (amount === null || secs === null || amount <= 0) continue;
      dividends.push({ ts: secs * 1000, amount });
    }
    dividends.sort((a, b) => a.ts - b.ts);

    const closes = adj.filter((v) => v !== null && v > 0);
    if (closes.length < 20) return null;
    const lastTs = [...timestamps].reverse().find((v) => v !== null) ?? null;

    return {
      symbol: r.meta?.symbol ? String(r.meta.symbol).toUpperCase() : null,
      currency: r.meta?.currency ? String(r.meta.currency).toUpperCase() : null,
      closes,
      volumes: volume.filter((v) => v !== null && v >= 0),
      price: num(r.meta?.regularMarketPrice) ?? closes[closes.length - 1],
      lastTsMs: lastTs === null ? null : lastTs * 1000,
      dividends,
      adjustedForDividends: adjRaw.length > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Trailing twelve-month dividend yield: what it actually paid, over what a share
 * costs now. Backward-looking on purpose — the forward figure every fund page
 * leads with is one payment multiplied up, and for a variable payer that flatters.
 */
function trailingYield(dividends, price, nowMs = Date.now()) {
  if (!Array.isArray(dividends) || !Number.isFinite(price) || price <= 0) return null;
  const cutoff = nowMs - 365 * DAY;
  let sum = 0;
  let count = 0;
  for (const d of dividends) {
    if (!Number.isFinite(d?.ts) || !Number.isFinite(d?.amount) || d.amount <= 0) continue;
    if (d.ts < cutoff || d.ts > nowMs + 7 * DAY) continue;
    sum += d.amount;
    count += 1;
  }
  if (!count) return 0;                                  // a measured zero, not a missing value
  return (sum / price) * 100;
}

/** Deepest peak-to-trough fall in the window, percent. A risk input, not a signal. */
function worstDrawdown(closes) {
  if (!Array.isArray(closes) || closes.length < 5) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    if (!Number.isFinite(c) || c <= 0) continue;
    if (c > peak) peak = c;
    if (peak > 0) {
      const dd = ((peak - c) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return Number.isFinite(worst) ? Math.round(worst * 10) / 10 : null;
}

/**
 * A dividend yield below 0.05% is not income, and carrying it as a number is
 * worse than carrying nothing: it puts a growth stock into an income sort and
 * prints "0.00%" in a rate column, which reads as a measurement of income rather
 * than the absence of any. NVDA's entire return is price. So sub-threshold and
 * absent both come back null, and the row says in words which one it is.
 */
function tidyYield(y) {
  if (!Number.isFinite(y) || y < 0.05) return null;
  return Math.round(y * 1000) / 1000;
}

/**
 * Evenly-spaced thinning of a price series, oldest first, for the chart.
 *
 * The first and last points are kept exactly, because they are the two the eye
 * actually reads: where this started and where it is now. Everything between is
 * sampled at even spacing.
 *
 * Non-finite values are dropped BEFORE the spacing is computed. A feed that
 * returns nulls for market holidays must produce the same shape as one that
 * omits them — if the holes were left in and skipped later, every gap would
 * shift the rest of the chart sideways against its own axis.
 */
function downsample(values, targetPoints = MAX_SERIES_POINTS) {
  if (!Array.isArray(values)) return [];
  const clean = values.filter((v) => Number.isFinite(v));
  const target = Math.floor(Number(targetPoints));
  if (!Number.isFinite(target) || target < 1) return [];
  if (!clean.length) return [];
  if (clean.length <= target) return clean;
  // Both endpoints cannot survive a single-point budget; the latest price is
  // the one worth keeping.
  if (target === 1) return [clean[clean.length - 1]];

  const step = (clean.length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i += 1) out.push(clean[Math.round(i * step)]);
  return out;
}

/**
 * Dollars traded on an ordinary day: median share volume times the price.
 *
 * Median rather than mean because one earnings session can be ten times a normal
 * one, and the questions this answers — can an order get filled, does anyone
 * actually follow this — are about the ordinary day. Only the per-symbol chart
 * endpoint carries volume, so the batch path leaves it null instead of guessing.
 */
function medianDollarVolume(volumes, price) {
  if (!Array.isArray(volumes) || !Number.isFinite(price) || price <= 0) return null;
  const src = volumes.filter((v) => Number.isFinite(v) && v > 0).slice(-90);
  if (src.length < 20) return null;
  const sorted = [...src].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!Number.isFinite(median) || median <= 0) return null;
  return Math.round(median * price);
}

// ---------------------------------------------------------------------------
// Reach: how widely known the thing is
// ---------------------------------------------------------------------------

/** Ordered from most advertised to least. Mirrors REACH in core/opportunity-kinds. */
const REACH_ORDER = ['everyone', 'common', 'niche', 'obscure'];
const reachRank = (k) => {
  const i = REACH_ORDER.indexOf(k);
  return i < 0 ? 1 : i;                     // an unknown label is treated as ordinary
};
/** The more obscure of two reads. Nothing about a row makes it MORE famous. */
const leastKnown = (a, b) => REACH_ORDER[Math.max(reachRank(a), reachRank(b))];

/**
 * Index membership, which is the structural fact this source actually has.
 *
 * A whole-market fund, the default option in most 401k menus, and the thirty
 * largest companies in the country are things a person hears about without
 * looking for them. One slice of the market, a factor tilt, a small-cap screen
 * and a VIX futures product are not: they are the shelf you only reach for once
 * you already follow this. Everything else is an ordinary listed name — findable
 * if you look, advertised to nobody.
 */
const WIDELY_HELD_GROUPS = new Set(['core_index', 'target_date', 'megacap']);
const SPECIALIST_GROUPS = new Set(['sector', 'factor', 'small_cap', 'volatility_adjacent']);

/**
 * What the tape says about how many people are watching. Dollars, not shares —
 * a million shares of a $3 stock and a million shares of Apple are not the same
 * amount of attention.
 */
function reachFromDollarVolume(dv) {
  if (!Number.isFinite(dv) || dv <= 0) return null;
  if (dv >= 2e9) return 'everyone';
  if (dv >= 2e8) return 'common';
  if (dv >= 1e7) return 'niche';
  return 'obscure';
}

/**
 * How widely known a row is, derived rather than listed.
 *
 * Two signals, and the more obscure one wins: sitting in a famous category does
 * not make a thinly traded share class famous, and a heavy tape does not make a
 * sector fund something the general public has heard of.
 *
 * Index-tier rows are the interesting case. They are ten thousand issuers we
 * have not measured, and calling them all obscure would flood the one filter
 * that exists to surface things few people follow. The exchange is the only fact
 * we have about them and it is a real one: the main boards list the companies
 * with an investor-relations department, and everything else — NYSE American,
 * the OTC tiers, a blank field — is where the genuinely unfollowed live.
 */
function classifyReach({ group, measured = true, exchange = null, dollarVolume = null } = {}) {
  if (measured === false) {
    const ex = String(exchange || '').trim().toLowerCase();
    return ex === 'nyse' || ex === 'nasdaq' || ex === 'nyse arca' ? 'common' : 'niche';
  }
  const base = WIDELY_HELD_GROUPS.has(group) ? 'everyone'
    : SPECIALIST_GROUPS.has(group) ? 'niche'
      : 'common';
  const byTape = reachFromDollarVolume(dollarVolume);
  return byTape ? leastKnown(base, byTape) : base;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * INDEX TIER row: identity and nothing else.
 *
 * No price, no yield, no volatility, no movement stats, confidence 0.2 and
 * measured:false. The point is that the row is findable and visibly unmeasured;
 * a number here would be a guess wearing a decimal point.
 */
function buildIndexRow(rec, opts = {}) {
  const schema = opts.schema || baseSchema;
  const C = opts.C || baseC;
  const seed = !!opts.seed;
  if (!rec || !rec.ticker) return null;

  const exch = rec.exchange ? ` on ${rec.exchange}` : '';
  const o = schema.normalize({
    source: ID,
    sourceLabel: LABEL,
    key: `index:${rec.ticker}`,
    name: rec.name,
    symbol: rec.ticker,
    provider: null,
    assetClass: C.ASSET_CLASS.DIVIDEND_EQUITY,
    subType: 'listed_issuer',
    track: 'movement',
    region: 'US',
    currency: 'USD',

    // Deliberately empty. There is no measurement behind this row.
    apy: { total: null },
    yieldKind: C.YIELD_KIND.TRAILING,
    liquidity: C.LIQUIDITY.DAILY,
    measured: false,
    // And deliberately no `series`: no price history has been fetched for this
    // row, so it gets no chart. A sparkline drawn from nothing is the one thing
    // that would make an unmeasured row look measured.
    reach: classifyReach({ measured: false, exchange: rec.exchange }),

    risk: { principalAtRisk: true, insurance: C.INSURANCE.SIPC },
    taxTreatment: C.TAX_TREATMENT.QUALIFIED_DIVIDEND,

    url: rec.cik ? edgarPage(rec.cik) : quotePage(rec.ticker),
    accessNotes: `${STOCK_ACCESS} Nothing about this row has been measured yet — open it to price and analyse it.`,
    notes: `Listed US issuer${exch}${rec.cik ? `, CIK ${rec.cik}` : ''}. Index entry only: this row carries identity, `
      + 'not measurement. No price, yield, volatility or chart read has been fetched for it.',
    requirements: ['Brokerage account'],

    confidence: 0.2,
    dataAsOf: opts.dataAsOf || null,
    seed,
    live: !seed,
    raw: { measured: false, tier: 'index', cik: rec.cik, exchange: rec.exchange },
  }, { source: ID, seed });

  return o;
}

/**
 * MEASURED TIER row.
 *
 * `series` is {closes, volumes, price, lastTsMs, dividends?}. Everything about
 * the chart read comes from core/movement.analyse() — vol, regime, range
 * position, drawdown, trend, volume anomaly — because that is the one place in
 * this app allowed to have an opinion about a price series.
 */
function buildMeasured(entry, series, opts = {}) {
  const schema = opts.schema || baseSchema;
  const C = opts.C || baseC;
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const seed = !!opts.seed;
  const symbol = String(entry?.symbol || '').toUpperCase();
  if (!symbol) return null;

  const group = GROUPS[entry?.group] || GROUPS.user;
  const stats = opts.movementStats || analyse(series?.closes, series?.volumes);
  const price = num(series?.price) ?? num(stats?.lastClose);
  if (price === null || price <= 0) return null;         // no price, no row

  // Yield provenance is part of the claim, so it travels with the row.
  const yieldSource = opts.yieldSource || (series?.dividends ? 'measured' : null);
  const rawYield = opts.yieldPct !== undefined && opts.yieldPct !== null
    ? num(opts.yieldPct)
    : (series?.dividends ? trailingYield(series.dividends, price, nowMs) : null);
  const y = tidyYield(rawYield);
  // A measured zero and a missing number both leave apy null, but they are not
  // the same fact and the row must not blur them.
  const paysNothing = Number.isFinite(rawYield) && rawYield < 0.05;

  const vol = num(stats?.vol);
  const maxDD = num(opts.maxDrawdown) ?? worstDrawdown(series?.closes);
  // The chart. Live this is the closes we already fetched; offline the seed
  // hands over a pre-thinned shape instead, because the bundled snapshot holds
  // statistics rather than a price history.
  const chart = downsample(Array.isArray(opts.series) ? opts.series : series?.closes, MAX_SERIES_POINTS);
  // Volume only exists on the per-symbol chart path. Null everywhere else, so a
  // batch-measured row says "unknown" rather than "thin".
  const dollarVolume = num(opts.dollarVolume) ?? medianDollarVolume(series?.volumes, price);

  const detail = [group.note];
  if (yieldSource === 'remembered') {
    detail.push('Price and chart read are measured; the dividend yield is the bundled snapshot figure, because the '
      + 'batch price endpoint carries no dividend history. Open this row to measure the yield too.');
  } else if (paysNothing) {
    detail.push('Pays no dividend. The entire return is price, which is not something anyone can put a number on in '
      + 'advance, so this row is ranked on what its chart is doing and never on a forecast.');
  } else if (y === null) {
    detail.push('No dividend history was available, so no yield is claimed. This row is here for what its price is '
      + 'doing, not for income.');
  }
  if (Array.isArray(opts.extraNotes)) detail.push(...opts.extraNotes.filter(Boolean));

  const o = schema.normalize({
    source: ID,
    sourceLabel: LABEL,
    key: symbol,
    name: entry.name || symbol,
    symbol,
    provider: null,
    assetClass: group.assetClass,
    subType: entry.group || 'user',
    // Let the schema decide from the yield: a 3.8% bond fund genuinely answers
    // both questions, a 0% growth stock only answers one. Forcing either into a
    // single track would misfile one of them.
    region: 'US',
    currency: series?.currency || 'USD',

    apy: { total: y },
    yieldKind: C.YIELD_KIND.TRAILING,
    liquidity: C.LIQUIDITY.DAILY,
    measured: true,

    price,
    // One share, unless the fund company imposes a real initial minimum.
    minInvestment: num(entry.min) ?? price,
    volume: dollarVolume,

    movementStats: stats || null,
    series: chart.length ? chart : null,
    reach: classifyReach({ group: entry.group, measured: true, dollarVolume }),

    risk: {
      principalAtRisk: true,
      insurance: C.INSURANCE.SIPC,          // custody only; it does not cover market loss
      volatility: vol,
      maxDrawdown: maxDD,
    },

    taxTreatment: group.taxTreatment,
    term: { days: null },                   // a share has no maturity and no lockup

    url: quotePage(symbol),
    accessNotes: entry.min ? MUTUAL_ACCESS : (group.assetClass === C.ASSET_CLASS.ETF ? FUND_ACCESS : STOCK_ACCESS),
    requirements: ['Brokerage account'],
    notes: detail.filter(Boolean).join(' '),

    confidence: measuredConfidence({ stats, yieldSource, y, seed }),
    dataAsOf: opts.dataAsOf || safeISO(series?.lastTsMs) || null,
    seed,
    live: !seed,
    raw: { measured: true, tier: 'measured', group: entry.group, yieldSource },
  }, { source: ID, seed });

  return o;
}

/**
 * How much of this row we actually measured.
 *
 * Price and chart read are the bulk of it; a remembered yield is a genuinely
 * weaker claim than a measured one and a short history is weaker still, so both
 * are priced in rather than waved through.
 */
function measuredConfidence({ stats, yieldSource, y, seed }) {
  let c = 0.7;
  const bars = num(stats?.bars) ?? 0;
  if (bars < 60) c *= 0.7;
  else if (bars < 150) c *= 0.85;
  if (yieldSource === 'remembered') c *= 0.8;
  if (y === null) c *= 0.95;               // no yield claimed is a small gap, not a flaw
  if (seed) c *= 0.7;
  return Math.max(0.05, Math.min(0.95, Number(c.toFixed(3))));
}

// ---------------------------------------------------------------------------
// Live path
// ---------------------------------------------------------------------------

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const errText = (err) => (err?.status ? `HTTP ${err.status}` : err?.message || String(err));

/** Symbol -> remembered trailing yield, for the batch path that has no dividends. */
function seedYieldIndex(seedDir) {
  const index = new Map();
  try {
    const { items } = contract.readSeed(seedDir, 'equities.json');
    for (const item of items) {
      const sym = String(item?.symbol || '').toUpperCase();
      const y = num(item?.trailingYield);
      if (sym && y !== null) index.set(sym, y);
    }
  } catch { /* remembering a yield is a convenience, never a requirement */ }
  return index;
}

/** The SEC index tier. One request, ten thousand rows. */
async function fetchIndexTier(ctx, counter, skipSymbols) {
  const http = ctx.http || baseHttp;
  const headers = { 'User-Agent': SEC_UA, Accept: 'application/json' };
  const attempts = [];

  for (const url of [SEC_TICKERS_EXCHANGE_URL, SEC_TICKERS_URL]) {
    if (ctx.signal?.aborted) break;
    try {
      counter.calls += 1;
      const payload = await http.getJSON(url, { signal: ctx.signal, timeout: 30000, retries: 1, headers });
      const parsed = parseTickerIndex(payload, {
        skipSymbols,
        limit: num(ctx.settings?.sources?.equities?.indexLimit) ?? DEFAULT_INDEX_LIMIT,
      });
      if (parsed.records.length) return { ...parsed, url, attempts };
      attempts.push(`${url}: parsed to zero rows`);
    } catch (err) {
      attempts.push(`${url}: ${errText(err)}`);
    }
  }
  return { records: [], dropped: {}, url: null, attempts };
}

/**
 * The measured tier, in batches.
 *
 * One request per ~40 symbols instead of one per symbol. If the batch endpoint
 * changes shape or dies, each failed batch degrades to the per-symbol chart
 * endpoint funds.js already uses — correct, and roughly forty times as many
 * requests, which is why it is a fallback and is reported as one.
 */
async function fetchMeasuredTier(ctx, entries, counter) {
  const http = ctx.http || baseHttp;
  const batches = chunk(entries.map((e) => e.symbol), BATCH_SIZE);
  const series = new Map();
  const failedBatches = [];
  let hostIndex = 0;

  for (const batch of batches) {
    if (ctx.signal?.aborted) break;
    let got = null;
    const attempts = [];
    // Rotate hosts across batches: they are the same service behind different
    // load balancers, and spreading the run keeps one of them from rate-limiting.
    for (let i = 0; i < YAHOO_HOSTS.length && !got; i += 1) {
      const host = YAHOO_HOSTS[(hostIndex + i) % YAHOO_HOSTS.length];
      try {
        counter.calls += 1;
        const payload = await http.getJSON(sparkUrl(host, batch), {
          signal: ctx.signal, timeout: 25000, retries: 1, concurrency: 2,
        });
        const parsed = parseSpark(payload);
        if (parsed.size) got = parsed;
        else attempts.push(`${new URL(host).host}: unrecognised spark shape`);
      } catch (err) {
        attempts.push(`${new URL(host).host}: ${errText(err)}`);
      }
    }
    hostIndex += 1;

    if (got) {
      for (const [sym, s] of got) series.set(sym, s);
    } else {
      failedBatches.push({ batch, why: attempts[0] || 'no response' });
    }
  }

  // Per-symbol fallback, only for what the batch path could not deliver.
  const missing = entries.map((e) => e.symbol).filter((s) => !series.has(s));
  let viaChart = 0;
  const unavailable = [];
  if (missing.length) {
    const cap = num(ctx.settings?.sources?.equities?.fallbackCap) ?? 120;
    for (const sym of missing.slice(0, Math.max(0, cap))) {
      if (ctx.signal?.aborted) break;
      const s = await fetchChartSeries(ctx, sym, counter);
      if (s) { series.set(sym, s); viaChart += 1; } else unavailable.push(sym);
    }
    unavailable.push(...missing.slice(Math.max(0, cap)));
  }

  return { series, failedBatches, viaChart, unavailable, batchCount: batches.length };
}

/** One symbol from the chart endpoint: prices, volume AND dividends. */
async function fetchChartSeries(ctx, symbol, counter = { calls: 0 }) {
  const http = ctx.http || baseHttp;
  for (const host of YAHOO_HOSTS) {
    if (ctx.signal?.aborted) return null;
    try {
      counter.calls += 1;
      const payload = await http.getJSON(chartUrl(host, symbol), {
        signal: ctx.signal, timeout: 20000, retries: 1, concurrency: 3,
      });
      const s = parseChart(payload);
      if (s && !s.error && s.closes?.length) return s;
    } catch { /* try the other host, then give up on this symbol */ }
  }
  return null;
}

async function fetchLive(ctx) {
  const schema = ctx.schema || baseSchema;
  const C = ctx.C || baseC;
  const nowMs = ctx.now || Date.now();
  const counter = { calls: 0 };
  const notes = [];
  const warnings = [];

  const entries = resolveUniverse(ctx.settings || {});
  if (!entries.length) {
    return contract.result({ status: 'failed', warnings: ['Every symbol in the equities universe was excluded in settings.'] });
  }

  ctx.log?.(`equities: measuring ${entries.length} symbols in batches of ${BATCH_SIZE}`);
  const remembered = seedYieldIndex(ctx.seedDir);
  const measuredRes = await fetchMeasuredTier(ctx, entries, counter);

  const opportunities = [];
  let skipped = 0;
  for (const entry of entries) {
    const s = measuredRes.series.get(entry.symbol);
    if (!s) { skipped += 1; continue; }
    try {
      const hasDividends = Array.isArray(s.dividends);
      const yieldPct = hasDividends ? undefined : (remembered.get(entry.symbol) ?? null);
      const o = buildMeasured(entry, s, {
        schema,
        C,
        now: nowMs,
        yieldPct,
        yieldSource: hasDividends ? 'measured' : (remembered.has(entry.symbol) ? 'remembered' : null),
        dataAsOf: safeISO(s.lastTsMs) || safeISO(nowMs),
      });
      if (o) opportunities.push(o); else skipped += 1;
    } catch {
      // One bad symbol is one bad symbol, never the whole source.
      skipped += 1;
    }
  }

  const measuredSymbols = new Set(opportunities.map((o) => o.symbol));

  // --- index tier -----------------------------------------------------------
  ctx.log?.('equities: fetching the SEC listed-issuer index');
  let indexRows = 0;
  const indexRes = await fetchIndexTier(ctx, counter, measuredSymbols);
  for (const rec of indexRes.records) {
    try {
      const o = buildIndexRow(rec, { schema, C, dataAsOf: safeISO(nowMs) });
      if (o) { opportunities.push(o); indexRows += 1; }
    } catch { /* skip the record, keep the tier */ }
  }

  // --- honest accounting ----------------------------------------------------
  notes.push(`${opportunities.length - indexRows} symbols measured from a year of daily closes; `
    + `${indexRows.toLocaleString()} more listed issuers indexed by name and ticker only.`);
  notes.push(`${counter.calls} HTTP request(s) this run for ${entries.length} measured symbols plus the full SEC index — `
    + `the price feed is batched ${BATCH_SIZE} symbols per call.`);
  notes.push('Index-tier rows carry measured:false, no price and no rate. They are searchable, not analysed; '
    + 'opening one measures it on demand.');
  notes.push('The batch price endpoint returns closes only, so volume anomalies are unavailable for symbols on that '
    + 'path and dividend yields come from the bundled snapshot rather than a live dividend stream.');
  notes.push('No earnings, ex-dividend or index-rebalance dates are fetched here, so movement reads are chart-only. '
    + 'A row with no dated catalyst is not a row with nothing coming.');

  if (indexRes.attempts?.length && !indexRows) {
    warnings.push(`SEC ticker index unavailable (${indexRes.attempts[0]}) — the searchable index tier is missing this run.`);
  }
  if (measuredRes.failedBatches.length) {
    notes.push(`${measuredRes.failedBatches.length} price batch(es) failed and fell back to the per-symbol chart `
      + `endpoint: ${measuredRes.failedBatches[0].why}.`);
  }
  if (measuredRes.viaChart) {
    notes.push(`${measuredRes.viaChart} symbol(s) came from the per-symbol chart endpoint instead of the batch feed.`);
  }
  if (measuredRes.unavailable.length) {
    notes.push(`${measuredRes.unavailable.length} symbol(s) returned no usable price history: `
      + `${measuredRes.unavailable.slice(0, 12).join(', ')}${measuredRes.unavailable.length > 12 ? '; …' : ''}.`);
  }
  if (skipped) notes.push(`${skipped} symbol(s) dropped while mapping (no price, or an unreadable series).`);

  if (!opportunities.length) {
    return contract.result({ status: 'failed', notes, warnings: ['No equity symbol returned usable data.'] });
  }
  if (measuredRes.unavailable.length > entries.length / 2) {
    warnings.push(`Over half the measured universe failed to price (${measuredRes.unavailable.length}/${entries.length}) — `
      + 'the price feed is probably blocked or down.');
  }

  const degraded = warnings.length || measuredRes.failedBatches.length || measuredRes.unavailable.length || !indexRows;
  return contract.result({
    opportunities,
    status: degraded ? 'partial' : 'ok',
    notes,
    warnings,
    fetchedAt: safeISO(nowMs) || new Date().toISOString(),
  });
}

async function fetch(ctx) {
  try {
    return await fetchLive(ctx || {});
  } catch (err) {
    return contract.failure(err);
  }
}

/**
 * Measure one arbitrary ticker on demand.
 *
 * This is how an index-tier row gets promoted: the user opens AAPL, the UI calls
 * this, and the row comes back with a price, a chart read and a measured yield —
 * everything the index tier deliberately did not claim. Uses the per-symbol
 * chart endpoint because that is the one that carries dividend events.
 *
 * Returns a SourceResult so the caller handles it exactly like a refresh.
 */
async function fetchOne(symbol, ctx = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return contract.result({ status: 'failed', warnings: ['No symbol given.'] });

  try {
    const schema = ctx.schema || baseSchema;
    const C = ctx.C || baseC;
    const nowMs = ctx.now || Date.now();
    const counter = { calls: 0 };

    const known = universeEntries().find((e) => e.symbol === sym);
    const entry = known || { symbol: sym, name: ctx.name || sym, group: 'user' };

    const series = await fetchChartSeries(ctx, sym, counter);
    if (!series) {
      return contract.result({
        status: 'failed',
        notes: [`${counter.calls} HTTP request(s).`],
        warnings: [`No usable price history came back for ${sym}.`],
      });
    }

    const o = buildMeasured(entry, series, {
      schema, C, now: nowMs, yieldSource: 'measured', dataAsOf: safeISO(series.lastTsMs) || safeISO(nowMs),
      extraNotes: known ? null : ['Measured on request rather than as part of the standard universe.'],
    });
    if (!o) {
      return contract.result({ status: 'failed', warnings: [`${sym} priced but could not be mapped to a row.`] });
    }

    return contract.result({
      opportunities: [o],
      status: 'ok',
      notes: [
        `${sym} measured on demand: ${o.movementStats?.bars ?? 0} daily closes, ${counter.calls} HTTP request(s).`,
        series.adjustedForDividends ? null : 'Series is not dividend-adjusted, so volatility and drawdown are slightly overstated.',
      ].filter(Boolean),
      fetchedAt: safeISO(nowMs) || new Date().toISOString(),
    });
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
    const { items, meta } = contract.readSeed(ctx?.seedDir, 'equities.json');
    const dataAsOf = meta?.dataAsOf || '2026-08-01';

    // The universe carries classification and minimums; the seed carries only
    // the measured figures, so a fix in one place applies to both paths.
    const known = new Map(universeEntries().map((e) => [e.symbol, e]));

    const opportunities = [];
    let unknown = 0;
    let skipped = 0;

    for (const item of Array.isArray(items) ? items : []) {
      try {
        const symbol = String(item?.symbol || '').trim().toUpperCase();
        const entry = known.get(symbol);
        if (!entry) { unknown += 1; continue; }
        const price = num(item?.price);
        if (price === null || price <= 0) { skipped += 1; continue; }

        const stats = item?.movementStats && typeof item.movementStats === 'object'
          ? { ...item.movementStats, lastClose: num(item.movementStats.lastClose) ?? price }
          : null;

        const o = buildMeasured(entry, { price, closes: [], volumes: [], currency: 'USD' }, {
          schema,
          C,
          now: ctx?.now || Date.now(),
          movementStats: stats,
          // The bundled shape for the chart. It is not a price history — see the
          // seed file's own note on the field — so it is handed over separately
          // and nothing is measured from it.
          series: Array.isArray(item?.series) ? item.series : null,
          yieldPct: num(item?.trailingYield),
          yieldSource: 'seed',
          maxDrawdown: num(item?.maxDrawdown),
          dataAsOf,
          seed: true,
        });
        if (o) opportunities.push(o); else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    // The index tier's offline sample runs through the same parser the live path
    // uses, so the two-tier UI has something real to render and the parser is
    // exercised even when the SEC is unreachable.
    const measuredSymbols = new Set(opportunities.map((o) => o.symbol));
    const indexParsed = parseTickerIndex(meta?.secSample, { skipSymbols: measuredSymbols });
    let indexRows = 0;
    for (const rec of indexParsed.records) {
      try {
        const o = buildIndexRow(rec, { schema, C, dataAsOf, seed: true });
        if (o) { opportunities.push(o); indexRows += 1; }
      } catch { /* skip the record */ }
    }

    if (!opportunities.length) {
      return contract.result({ status: 'failed', warnings: ['Bundled equities seed is missing or unreadable.'] });
    }

    const notes = [
      `Bundled snapshot of ${opportunities.length - indexRows} measured stocks and funds as of ${dataAsOf}. Every ticker `
      + 'and name is real; the prices, yields, volatility and chart statistics are approximate round figures for that '
      + 'date, not quotes. Refresh to replace all of them with measured values.',
      `${indexRows} index-tier rows are included as a sample of the SEC listed-issuer file. Those carry a ticker, a name `
      + 'and a CIK and nothing else — no price and no rate, because none was measured. Live, this tier covers about '
      + '10,000 issuers.',
      'Movement statistics in this snapshot are the same shape core/movement.js produces, so the setup, heat and '
      + 'expected-move bands you see offline are computed by the identical code that runs on refresh.',
    ];
    if (unknown) notes.push(`${unknown} seed row(s) skipped: ticker is not in the measured universe.`);
    if (skipped) notes.push(`${skipped} seed row(s) dropped: no usable price.`);
    if (!indexRows && meta?.secSample) notes.push('The bundled SEC sample did not parse; the index tier is empty offline.');

    return contract.result({ opportunities, status: 'offline', notes });
  } catch (err) {
    // HARD RULE 1: loadSeed never throws.
    return contract.result({ status: 'failed', warnings: [err?.message || String(err)] });
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  id: ID,
  label: LABEL,
  description: 'Every US-listed issuer from the SEC ticker file, searchable by name, with a few hundred liquid '
    + 'tickers — index funds, target-date funds, bond funds, sectors and megacaps — actually measured from a year of '
    + 'daily closes.',
  homepage: 'https://www.sec.gov/files/company_tickers.json',
  assetClasses: [baseC.ASSET_CLASS.ETF, baseC.ASSET_CLASS.DIVIDEND_EQUITY],
  requiresNetwork: true,
  requiresKey: false,
  defaultEnabled: true,
  ttlMs: 60 * 60 * 1000,

  fetch,
  loadSeed,
  fetchOne,

  // Exported for the tests, for the UI's on-demand measure, and for anyone
  // extending the universe.
  MEASURED_UNIVERSE,
  GROUPS,
  BATCH_SIZE,
  universeEntries,
  resolveUniverse,
  parseTickerIndex,
  parseSpark,
  parseChart,
  trailingYield,
  worstDrawdown,
  tidyYield,
  downsample,
  medianDollarVolume,
  classifyReach,
  MAX_SERIES_POINTS,
  buildIndexRow,
  buildMeasured,
  measuredConfidence,
  chunk,
  sparkUrl,
  chartUrl,
  edgarPage,
  SEC_UA,
  SEC_TICKERS_URL,
  SEC_TICKERS_EXCHANGE_URL,
};
