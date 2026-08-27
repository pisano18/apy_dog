# 🐕 APY Dog

A desktop app for finding where money can be made — and for seeing what is about to happen to it.

It does two different jobs, because they are genuinely different questions and one table cannot answer both honestly:

**Income** — what will pay me, and how reliably? Ranked by after-tax certainty equivalent, because that number is knowable.

**Movement** — what is about to move, and how hard? Ranked by how wound-up something is and how close its next dated catalyst is. Never given a fake expected return, because no honest model produces one.

---

## Why two tracks

A share of NVDA has roughly a 0.02% dividend yield. Ranking it by that number says something true and completely irrelevant — essentially all of its return comes from price movement that nobody can put a decimal on. The old version of this app did exactly that, and the stock rows were nonsense.

So stocks, crypto and growth funds now live on the Movement track, where the columns are:

| Heat | Setup | Next catalyst | If it moves | Lean | Clarity | Safety |
|---|---|---|---|---|---|---|
| 68 | Coiled | Earnings · 6d | ±7.8% typical | ▼ weak | Sharp | D |

No expected return, no price target, no decimal on anything unknowable. What it tells you is: this is trading much quieter than its own normal, it reports earnings in six days, and a move of about ±8% would be ordinary for it — *which way is not knowable and the app never pretends otherwise*.

Things that are honestly both — a REIT that pays 5% and can fall 30% — appear in either view rather than being forced into one.

---

## What it looks at

| | Covers | Live? |
|---|---|---|
| **SEC company index** | Every US-listed issuer, searchable | Free, no key |
| **Equities & ETFs** | Core index, target-date, sector, factor, dividend, growth — measured with volatility, drawdown, trend and volume | Yahoo, batched |
| **Crypto assets** | Spot markets by cap, with 7-day series | CoinGecko, 250 per call |
| **DeFi** | Thousands of lending, LP and staking pools | DefiLlama |
| **US Treasury** | Full nominal curve and TIPS real curve | Free CSV |
| **Savings, CDs, MMFs** | Curated real institutions, editable | Curated |
| **Bonds, I-Bonds, RWA** | Savings bonds, index proxies, tokenized Treasuries | Curated + DefiLlama |
| **Cash bonuses** | Bank and brokerage opening offers | Curated |
| **Calendar** | FOMC, CPI, jobs, PPI, Treasury auctions, earnings, opex, rebalances | Free |
| **Filings** | SEC EDGAR 8-K, S-1, 13D — what just happened, from the primary source | Free |

**On breadth:** the whole US market is indexed cheaply and a priority subset is fully measured, because ten thousand price fetches per refresh is not a reasonable thing to do to your machine. Rows that are indexed but not measured say **not measured** and sort last — open one and it measures just that one. The app never implies it looked at something it did not.

**On bank bonuses:** a bank paying $300 for a $5,000 deposit held 90 days is a 26% annualised return on FDIC-insured money. That belongs in an app about the highest available APY, and no screener lists it. It is also one-time, capped, and full of hoops — so the row shows the annualised figure, the plain first-year percentage, and the cap, and trips the trap detector rather than sitting at the top looking like a savings account.

---

## Safety, as a grade rather than a number

"Risk: 47.3" tells a person nothing. Every row now carries a grade from **A+** (principal guaranteed) to **F** (you can lose all of it), with a sentence, backed by five axes:

```
Principal safe   ●●●○○   a bad year here looks like roughly -34%
Payout reliable  ●●●○○   backward-looking — this is what it paid, not what it will
Easy to exit     ●●●●●   sellable any trading day
Steady           ●●●○○   bumpy, about 15% a year
Well understood  ●●●●○   refreshed recently
```

Risk is not one thing. A 30-year Treasury and a memecoin are both risky for opposite reasons — one will absolutely pay you back and might swing 20% getting there, the other might cease to exist. Five axes say which danger applies to you.

The grade is a **safety** grade, never a quality one. Some of the most rewarding things here are Fs, and that is the point.

---

## Filters

Every filter is declared once as data, so the interface is a bar of removable pills rather than a permanent wall of switches:

- **Start from** — eight starting points: *Safe income · Highest yield · Best risk-adjusted · No lockup · Retirement core · Happening this week · Coiled up · Biggest expected moves*
- **+ Filter** — a searchable picker over 31 filters, grouped, with movement-only filters hidden while you are looking at income
- **Clear all** — provably resets everything, because it iterates the same declaration

Filters cover return, safety grade and axes, category, what it pays in, term and lockup, entry cost and share price, heat, setup, catalyst window, catalyst kind, signal clarity, and data quality. They combine freely.

---

## Install and run

```bash
git clone https://github.com/pisano18/apy_dog.git
cd apy_dog
npm install
npm start
```

Build a real double-clickable app:

```bash
npm run dist        # current platform
npm run dist:mac    # .dmg
npm run dist:win    # .exe
npm run dist:linux  # AppImage / .deb
```

Headless, same pipeline:

```bash
node scripts/scan.js --sort apy --limit 40
node scripts/scan.js --min-apy 6 --insured --max-days 365
node scripts/scan.js --json > today.json
npm run probe       # which upstream feeds are reachable, and still the right shape
```

---

## What it will not do

It will not tell you which way anything is going. Heat means something is unusually likely to happen soon, which is as often a reason to stay away as to buy. Expected-move bands are arithmetic on past volatility, not forecasts. The direction lean returns **none** for most things most of the time, because that is the honest answer.

Timing the market is not possible. Knowing that a coiled stock reports on Tuesday, that CPI lands Thursday, and that a token unlock hits on the third is just a calendar — and that is what this surfaces.

---

## Privacy

Everything stays on your machine. No accounts, no telemetry, nothing phones home. Your tax bracket, watchlist and rate history live in a JSON file in your user data directory. The only outbound requests go to the public feeds listed above.

The UI runs fully sandboxed with no Node integration and a strict CSP; all network and disk access happens in the main process behind an explicitly-enumerated IPC bridge.

---

## Not financial advice

APY Dog finds and ranks. It does not know your circumstances and cannot tell you what to buy.

Every rate comes from a public feed or a bundled snapshot and can be wrong, stale, or unavailable to you. Verify with the provider before moving money. Safety grades, heat scores and warning flags are this app's computed opinion from what each source publishes — a starting point for your own thinking, not a verdict.

---

## Layout

```
electron/          main process (network, disk, IPC) + sandboxed preload bridge
src/core/          schema · tracks · rating · risk · tail · tax · traps · score
                   catalyst · movement · filters · aggregate · history · store · export
src/sources/       one adapter per feed, auto-discovered, contract in _contract.js
src/ui/            index.html · styles.css · format.js · filters-def.js · render.js · app.js
data/seed/         bundled offline snapshots
scripts/           scan.js (headless) · probe.js (feed diagnostics) · make-icon.js
test/              node --test
```

Adding a data source is one file in `src/sources/` satisfying `_contract.js`. Adding a filter is one entry in `src/ui/filters-def.js`.

```bash
npm test          # unit + whole-pipeline invariants
npm run smoke     # boots the real app headlessly, exercises every view, screenshots each
```

MIT.
