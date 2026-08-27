# 🐕 APY Dog

A desktop app for finding where money can be made — and for seeing what is about to happen to it.

Not a stock screener with extra tabs. A screener answers "what pays the most", which is one question out of four
that actually matter, and it answers it badly the moment a $300 bank bonus and a 4% CD sit in the same column.

APY Dog is built around the other three:

| | |
|---|---|
| **◆ Income** | Things that pay a rate you can compute. Ranked by after-tax certainty equivalent. |
| **◈ Movement** | Things whose return is price. What is about to move, and how hard. Never given a fake expected return. |
| **★ Deals** | Bounded money — sign-up bonuses, referrals, employer matches, tax elections. Often the highest return per dollar in the app, and always capped. |
| **▣ Calendar** | Dated things that move all of the above. |

---

## Radar: what is worth looking at

The app opens on a digest rather than a table, because eight hundred rows sorted by anything is not navigable —
the crypto tickers alone bury every bank offer in the app.

```
⏳ Closing soon        ◈ Happening this week      ★ Best deals
◆ Best income         ⚡ Least work, real money   ◇ Few people know
```

Two of those cards exist because a sorted table structurally cannot produce them:

**Closing soon.** Expiry is a first-class field, not a note in a description. Anything with a real deadline
carries a countdown, sorts on it and filters on it.

**Few people know.** Obscurity is genuinely informative in both directions — an obscure deal is often better
because it is uncrowded, and an obscure DeFi pool is often worse because nobody has audited it. So it is shown,
never scored.

---

## How much are you working with?

Optional. Leave it empty and everything is rates.

Fill it in and every figure recomputes on your money: a bonus capped at $1,000 stops pretending it scales,
anything whose entry minimum is above your amount is marked out of reach, and dollar figures replace percentages
wherever dollars are the honest unit.

**With no amount set, capped and one-off offers are ranked against a stated $10,000 reference**, and every figure
derived from it is marked with `*` and a link to change it. This is not a detail. A $300 opening bonus on a
$1,000 minimum held 120 days annualises to 122%; a $50 one annualises to 500%. Ranked on that number they sweep
the top of every rate-sorted view and bury every real investment in the app. The raw annualised rate is itself an
assumption — that you could take the offer four times a year, which you cannot — so a visible assumption replaces
a hidden one.

Every rate on a blended row blends the same way: gross, after tax, after inflation, tax-equivalent, and the
sorters that follow them. A yield column reading 4.03% beside an after-tax column reading 380% is worse than
either number alone.

Where the size genuinely cannot be known — an employer match is capped at a share of a salary this app never asks
for — the row reads **rate only** and shows no dollar figure at all.

---

## Movement, not fake precision

A share of NVDA has roughly a 0.02% dividend yield. Ranking it by that number says something true and completely
irrelevant. So price-driven things live on their own track, with their own columns:

| Ticker | Heat | 12mo | Setup | Next catalyst | If it moves | Lean | Clarity | Safety |
|---|---|---|---|---|---|---|---|---|
| CRWD | 31 | ~~~ | Event pending | Earnings · today | ±4.8% typical | ▲ weak | Sharp | C |

No expected return, no price target, no decimal on anything unknowable. What it tells you: this is trading
quieter than its own normal, it reports today, and ±5% would be an ordinary reaction — *which way is not knowable
and the app never pretends otherwise.*

**Charts say where they came from.** A drawn shape and a recorded price history are pixel-identical on screen and
only one of them is evidence. Bundled rows chart a curve derived from the volatility, drawdown and trend printed
beside it, so the picture cannot contradict the numbers — and it renders dashed and dimmed, with a warning under
it in the drawer. Refresh replaces it with real closes.

---

## If a play exists but only as an option, it knows

The same view can often be expressed several ways, and which one is right depends on the account, the capital and
the goal. Every row that supports it carries the vehicles, with the capital each needs:

```
✓ Buy shares            own it outright               needs $180
✓ Fractional shares     own it with any amount        needs $1
✕ Covered call          get paid to cap your upside   needs $18,000
✕ Cash-secured put      get paid to wait for a dip    needs $16,000
```

The ones you cannot afford are shown rather than hidden, because knowing a covered call needs 100 shares is
useful information.

---

## Safety, as a grade rather than a number

"Risk: 47.3" tells a person nothing. Every row carries a grade from **A+** (principal guaranteed) to **F** (you
can lose all of it), with a sentence, backed by five axes:

```
Principal safe   ●●●○○   a bad year here looks like roughly -34%
Payout reliable  ●●●○○   backward-looking — this is what it paid, not what it will
Easy to exit     ●●●●●   sellable any trading day
Steady           ●●●○○   bumpy, about 15% a year
Well understood  ●●●●○   refreshed recently
```

Risk is not one thing. A 30-year Treasury and a memecoin are both risky for opposite reasons — one will
absolutely pay you back and might swing 20% getting there, the other might cease to exist. Five axes say which
danger applies to you.

The grade is a **safety** grade, never a quality one. Some of the most rewarding things here are Fs, and that is
the point.

---

## What it looks at

Thirteen sources, ~850 opportunities and ~250 dated events out of the box, each refreshing on its own cadence —
crypto every minute, Treasury once a day, a curated deposit list once a day — because refreshing everything on
one timer is both slower and less current than refreshing each on its own.

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
| **Deals & referrals** | Referral ladders, card sign-ups, category bonuses, portals, transfer offers, unclaimed funds | Curated |
| **Structural & tax plays** | Employer matches, HSA, backdoor Roth, harvesting, 529 deductions, FSA and commuter elections | Curated |
| **Calendar** | FOMC, CPI, jobs, PPI, Treasury auctions, earnings, opex, rebalances | Free |
| **Filings** | SEC EDGAR 8-K, S-1, 13D — what just happened, from the primary source | Free |

**On breadth:** the whole US market is indexed cheaply and a priority subset is fully measured, because ten
thousand price fetches per refresh is not a reasonable thing to do to your machine. Rows that are indexed but not
measured say **not measured** and sort last — open one and it measures just that one. The app never implies it
looked at something it did not.

**On the things with no ticker:** a 50% employer match is a larger, safer, more certain return than anything else
in this app, and it is invisible to every yield table ever built because there is nothing to buy. Same for the
$1,500 Acorns pays for five funded referrals — and the row says plainly that it is a threshold, so four friends
does not pay four fifths of it.

---

## Filters

Every filter is declared once as data, so the interface is a bar of removable pills rather than a permanent wall
of switches:

- **Start from** — twelve starting points: *Safe income · Highest yield · Best risk-adjusted · No lockup ·
  Retirement core · Happening this week · Coiled up · Biggest expected moves · Closing soon · Free money ·
  No chasing anyone · Few people know*
- **+ Filter** — a searchable picker over 39 filters, grouped, with movement-only filters hidden while you are
  looking at income
- **Clear all** — resets the filters and keeps your place. Section, sort and search are navigation, not filters.

Filters cover return, safety grade and axes, category, what it pays in, term and lockup, **deadline, effort,
obscurity and vehicle**, entry cost and share price, heat, setup, catalyst window, catalyst kind, signal clarity,
and data quality. They combine freely.

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

It will not tell you which way anything is going. Heat means something is unusually likely to happen soon, which
is as often a reason to stay away as to buy. Expected-move bands are arithmetic on past volatility, not
forecasts. The direction lean returns **none** for most things most of the time, because that is the honest
answer.

Timing the market is not possible. Knowing that a coiled stock reports on Tuesday, that CPI lands Thursday, and
that a token unlock hits on the third is just a calendar — and that is what this surfaces.

---

## Privacy

Everything stays on your machine. No accounts, no telemetry, nothing phones home. Your tax bracket, amount,
watchlist and rate history live in a JSON file in your user data directory. The only outbound requests go to the
public feeds listed above.

The UI runs fully sandboxed with no Node integration and a strict CSP; all network and disk access happens in the
main process behind an explicitly-enumerated IPC bridge.

---

## Not financial advice

APY Dog finds and ranks. It does not know your circumstances and cannot tell you what to buy.

Every rate comes from a public feed or a bundled snapshot and can be wrong, stale, or unavailable to you. Verify
with the provider before moving money. Safety grades, heat scores and warning flags are this app's computed
opinion from what each source publishes — a starting point for your own thinking, not a verdict.

Deals move fastest of all: referral tiers and sign-up bonuses change weekly, run at several levels at once, and
are frequently targeted to individual customers. The offer on your own screen is the only one that counts.

---

## Layout

```
electron/          main process (network, disk, IPC, per-source refresh cadence) + sandboxed preload bridge
src/core/          schema · opportunity-kinds · tracks · rating · risk · tail · tax · traps · score
                   vehicles · catalyst · movement · filters · aggregate · history · store · export
src/sources/       one adapter per feed, auto-discovered, contract in _contract.js
src/ui/            index.html · styles.css · format.js · filters-def.js · render.js · app.js
data/seed/         bundled offline snapshots
scripts/           scan.js (headless) · probe.js (feed diagnostics) · make-icon.js
test/              node --test
```

Adding a data source is one file in `src/sources/` satisfying `_contract.js`. Adding a filter is one entry in
`src/ui/filters-def.js`.

```bash
npm test          # unit tests + cross-source audit invariants over the real bundled dataset
npm run smoke     # boots the real app headlessly, exercises every view, screenshots each
```

MIT.
