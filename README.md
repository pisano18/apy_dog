# 🐕 APY Dog

A desktop app that hunts down the highest-yielding investments you can actually buy — and tells you which of them are lying to you.

Sorting the world by APY is easy. The problem is that the top of that list is almost entirely garbage: emissions farms that pay 200% for three weeks, teaser rates capped at $5,000, closed-end funds paying you back your own money and calling it a distribution. APY Dog's job is to find the high numbers **and** separate the real ones from the rest.

---

## What it does

**Finds yield everywhere.** Treasuries and TIPS, savings accounts, CDs, money market funds, I-Bonds, corporate and municipal bonds, REITs, BDCs, covered-call ETFs, closed-end funds, preferreds, DeFi lending, liquidity pools, staking, and tokenized T-bills — in one sortable table.

**Ranks them honestly.** Three things happen before anything reaches the top of the list:

- **Tax.** A 3.70% muni beats a 4.60% savings account if you're in California's top bracket. The app knows this — it computes after-tax, tax-equivalent and inflation-adjusted yields from *your* bracket, and can rank on any of them. Treasuries are state-exempt, REIT dividends get the §199A deduction, qualified dividends get capital-gains rates.
- **Risk, as a certainty equivalent.** Rather than pretend 4.3% guaranteed and 40%-probably are comparable, it computes what guaranteed return would make you equally happy, using mean-variance utility driven by a risk-appetite slider you control. Cautious and aggressive users genuinely get different rankings from the same data — that's the point.
- **Catastrophic risk, separately.** Variance can't see a jump to zero, which is exactly how DeFi positions fail. So the probability of a severe loss event and how much it would take are modelled explicitly and subtracted as expected loss, weighted by loss aversion. Without this, a 3%-volatility stablecoin pool outranks a Treasury bill, which is nonsense.

**Flags the traps.** Yield that's 90% token emissions. Pools with $180k in them. Rates that spiked 6x above their own 30-day average. Distributions that are mostly return of capital. Funds trading above NAV. Promotional rates that revert. Every flag comes with a plain sentence explaining what it means.

**Shows its work.** Every risk score opens into the list of factors that produced it, with points. Every trap flag explains itself. Every tax number shows the arithmetic. If you disagree with a number you can see exactly which assumption to argue with.

**Finds the uncertain upside too.** A separate, opt-in section for things with large expected returns that aren't remotely guaranteed — modelled from momentum, drawdown and volatility, presented with p10/p50/p90 bands and a computed probability of loss. These are never mixed into the yield rankings and never called yields.

---

## Filters

| | |
|---|---|
| **Return** | Min/max APY · compare as headline, after-tax, tax-equivalent, or after inflation |
| **Type** | 18 asset classes, multi-select, with live counts |
| **Length** | Presets (no lockup, under 3mo, 3–12mo, 1–3y, 3–10y, 10y+), exact day ranges, max lockup |
| **Money in** | Most you'd invest (hides anything with a higher minimum) · share price range · minimum pool size / fund AUM |
| **Risk** | Max risk score · risk tier · insured-only · hide likely traps · minimum data confidence |
| **Access** | Instant, daily, T+2, notice period, locked, illiquid |
| **Upside** | Min expected return · max probability of loss |
| **Source** | Per-feed · live-data-only · strict mode (drop rows with missing data) |

Plus free-text search, twelve sort orders, and one-click presets: *Best overall · Max APY · Safe & liquid · Best after tax · Lock a rate · High upside*.

---

## Install and run

```bash
git clone https://github.com/pisano18/apy_dog.git
cd apy_dog
npm install
npm start
```

That opens the app. To build a real double-clickable application:

```bash
npm run dist        # for your current platform
npm run dist:mac    # .dmg
npm run dist:win    # .exe installer
npm run dist:linux  # .AppImage / .deb
```

The result lands in `release/`.

**If something looks wrong, probe the endpoints first:**

```bash
npm run probe
```

That hits every upstream API directly and checks the response still has the shape the adapters expect — so "DefiLlama is down" and "DefiLlama renamed a field" and "your firewall blocks it" are three different, clearly-labelled answers rather than one silent fallback to bundled data. `--verbose` prints a sample record; `--json` is paste-able into a bug report.

There's also a headless mode, same pipeline, no window:

```bash
node scripts/scan.js --sort apy --limit 40
node scripts/scan.js --min-apy 6 --insured --max-days 365
node scripts/scan.js --only-speculative
node scripts/scan.js --json > today.json
```

---

## Where the numbers come from

| Source | Covers | Live? |
|---|---|---|
| **DefiLlama** | Thousands of DeFi pools: lending, LPs, staking, with TVL, base-vs-reward split, 30-day means | Free public API, no key |
| **US Treasury** | Full nominal yield curve (1mo–30yr) and the TIPS real curve, refreshed daily | Free public CSV, no key |
| **Yahoo Finance** | Prices, dividend histories, computed volatility and drawdown for ~120 funds and tickers | Free public endpoint, no key |
| **Savings & CDs** | Curated list of real banks, credit unions and money market funds | **Curated — see below** |
| **Bonds, I-Bonds, RWA** | Series I/EE bonds, bond-fund index proxies, tokenized Treasuries | Curated + DefiLlama |
| **High Upside** | ~45 liquid tickers run through an expected-return model with p10/p50/p90 bands | Yahoo Finance |

211 opportunities ship in the bundled snapshot across all sixteen asset classes, so the app is useful the moment it opens and stays useful with no network at all.

**About deposit rates.** No free public API publishes retail savings and CD rates — the FDIC publishes which institutions are insured, not what they pay. So those ship as a curated list with an honest "as of" date, and the app labels every one as a snapshot rather than a quote. Sources → *Edit my rates file* opens a JSON file where you keep your own current rates; they're merged over the bundled ones on every scan.

**Everything is a starting point, not a quote.** Rows sourced from the bundled snapshot are marked `snapshot` in the table and called out in a banner. Refresh pulls live data where a live feed exists.

---

## Privacy

Everything stays on your machine. No accounts, no telemetry, no analytics, nothing phones home. Your tax bracket, your watchlist and your rate history live in a JSON file in your user data directory and go nowhere. The app only makes outbound requests to the public rate APIs listed above.

The UI runs fully sandboxed with no Node integration and a strict CSP; all network and disk access happens in the main process behind a narrow, explicitly-enumerated IPC surface.

---

## Some things worth knowing

**Term means three different things.** A CD's term is a lockup, a Treasury note's is a maturity you can sell before, and a bond fund's "term" is really its duration — a rate-sensitivity figure for a thing you can sell any morning. The app models these separately, so a "1–3 years" filter returns real commitments and never a daily-liquid fund, and duration shows up under risk where it belongs.

**Rate history.** Every scan appends a snapshot of each rate to a local JSONL file. After a few weeks the app can tell you whether that 9% pool has actually been a 9% pool, or whether it was 3% last Tuesday. Watch anything with the ☆ and the table shows its 30-day drift.

**Alerts.** Set a threshold on anything you're watching, or a standing "tell me if anything in this category crosses X%". Fires a native desktop notification on refresh.

**The risk-free rate is real.** It's read from the live 3-month T-bill, not hardcoded, and everything else is scored as a spread over it.

**Corroboration counts.** When two independent sources report the same instrument, they're merged and the confidence goes up.

---

## Not financial advice

APY Dog finds and ranks rates. It does not know your circumstances and it cannot tell you what to buy.

Every rate here comes from a public feed or a bundled snapshot and can be wrong, stale, or unavailable to you. Verify the number with the provider before you move money. Advertised yields aren't promises: variable rates change without notice, trailing yields describe the past, and the High Upside section contains model estimates with wide error bars.

The risk scores and trap flags are this app's own opinion, computed from what each source publishes. They're a starting point for your thinking, not a verdict.

---

## Layout

```
electron/          main process (network, disk, IPC) + sandboxed preload bridge
src/core/          schema · risk · tail · tax · traps · score · filters · aggregate · history · store
src/sources/       one adapter per data source, auto-discovered, contract in _contract.js
src/ui/            renderer: index.html · styles.css · format.js · render.js · app.js
data/seed/         bundled offline snapshots
scripts/scan.js    headless scanner
scripts/probe.js   upstream endpoint diagnostic
scripts/make-icon.js
test/              node --test
```

Adding a data source is one file in `src/sources/` that satisfies `_contract.js`. The registry picks it up automatically.

```bash
npm test          # 231 tests: analytical core, all six adapters, whole-pipeline invariants
npm run smoke     # boots the real app headlessly, exercises every view, screenshots each
npm run probe     # checks each upstream API is reachable and still the right shape
```

The pipeline tests assert things that are easy to break and expensive to get wrong: no row reaching the table without a way to buy it, rates in percent rather than decimals, nothing insured rated above conservative, nothing paying over 40% left unflagged, and modelled estimates never presented as yields or leaking into a yield sort.

MIT.
