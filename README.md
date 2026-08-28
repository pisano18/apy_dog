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
| **◉ Signals** | What is showing the conditions that come before a large move — with the evidence, and with its own hit rate measured against the base rate. |
| **▶ Plan** | What to do first, second, third — with your money and your patience as the constraints. |
| **? Learn** | Every term in the app, in plain English, reachable from wherever the jargon is. |

---

## Signals: what is about to move, and how anyone would know

Direction is not forecastable to any useful degree. Magnitude is a different question — volatility clusters and
mean-reverts, one of the most replicated findings in finance — so unusual quiet genuinely says something about the
size of what comes next while saying nothing about which way.

Seven detectors, each reporting evidence you can argue with rather than a number you have to trust: compression,
quiet accumulation, tight range, extension, squeeze mechanics, catalyst proximity, unlock overhang. Only the two
that are **mechanically** directional get a directional opinion — forced buying by short sellers, and scheduled
token supply. Everything else reads `no direction`, on purpose.

```
78  Example Corp EXMP   D     12.4% would be a normal move · Earnings in 6 days   ▲ leans up
    Compression      ████████░░  Trading at 31% of its own normal volatility.
    Squeeze          ███████░░░  48% of the free float is sold short.
```

### The harness matters more than the detectors

Without it this is a horoscope. A signal that fires before a large move 40% of the time is worth nothing if large
moves happen 40% of the time anyway, so everything is scored against the **base rate** and nothing is reported
without it. Validation requires the *lower bound* of the confidence interval to clear the base rate, a minimum
sample, and survival on a chronological holdout the weight-fitting never saw.

Building it turned up three things that had made the numbers wrong, each of which is the standard way a backtest
invents an edge that is not there:

| Problem | What it did | Fix |
|---|---|---|
| **Overlapping windows** | Forward windows shared 20 of 21 days, so the interval was computed on ~20x more "observations" than there were independent ones. Compression validated on **4 of 12 baskets of pure random walks**. | Score on non-overlapping strides |
| **Multiple comparisons** | Seven detectors at 95% throws a false positive about a third of the time — and it is the false one you believe | Bonferroni correction |
| **The threshold itself** | A fixed 15% bar put the base rate at 43%, so "large move" meant "volatile instrument" — which every volatility detector answers trivially and correctly while telling you nothing | A multiple of each instrument's *own* baseline, computed point-in-time |

After all three: **zero false validations across twenty independent noise baskets**, while compression still
validates at 1.5x lift out-of-sample on planted regime-switching data — and the detector that was never planted is
honestly reported as failed. Lookahead is prevented structurally and tested by poisoning every bar after the
evaluation point.

```bash
npm run doctor              # what this machine can reach, and what each feed says when it refuses
npm run backtest            # 5y of real daily history, out of sample
npm run backtest --years 10 --horizon 42
```

**Run `npm run doctor` first if anything looks wrong.** It checks every feed and prints the HTTP status and the
server's own words for each, with advice keyed to the pattern of failures — it tells a corporate proxy apart from a
rate limit apart from a provider's bot gate, and says when a failure is expected and harmless. Yahoo requires a
browser User-Agent plus a cookie and a crumb token; Stooq serves a JavaScript challenge to non-browser clients. The
app tries Yahoo first, falls back to Stooq, and names every failure rather than swallowing it.

Until you run that, the app says **uncalibrated** at the top of the Signals view, every time, and means it: the
ordering is meaningful and the number is not. Once you have, it shows the measured hit rate, base rate, lift and
sample size per detector — and gives failing detectors **zero weight** rather than keeping them because they
sounded plausible.

It also refuses to read a signal off a chart that was drawn rather than recorded. With that guard removed, the top
of the ranking is stablecoins — a drawn low-volatility curve looks like perfect compression.

---

## What to actually expect

Every other figure in the app is a single number, and a single number is a poor description of an uncertain
outcome. Each row now carries a band, with the bad end weighted properly, because that is the end that decides
whether you can hold on.

```
A good year                                    +7.2%      +$1,800
Typical                                        +4.3%      +$1,075
A bad year                                     −9.3%      −$2,325
The bad case that is not supposed to happen   −27.3%      −$6,825
```

It also names **which kind** of uncertainty applies, because conflating them is how people get hurt. A savings
account's uncertainty is in the *rate* — the bad case is earning less than you hoped. A fund's is in the
*principal* — the bad case is having less money than you started with. Putting both in a column headed "yield" is
what makes them look comparable.

Where an outcome genuinely cannot be bounded — a pool that can be drained, an issuer that can vanish — it says the
tail is not a percentile of a distribution and to size the position assuming zero.

---

## It works when you are not looking at it

A deal that closes on Friday is worth nothing to someone who opens the app on Saturday. So closing the window
leaves a tray icon showing what shuts this week, and a deadline check runs every fifteen minutes — reading the
clock, not the feeds, because nothing in the data changes on the morning a window closes.

Two rules are on by default, since a deadline feature nobody enables is not a feature:

- Warn me **7 days** before anything I watch closes
- Tell me when a new deal worth **$200+** appears

Each rule speaks **once** per opportunity and re-arms only when the condition lapses. A test runs 96 timer ticks
across a five-day window and asserts exactly one notification, because the alternative — one every minute — is
how people learn to turn notifications off, taking the one that mattered with them.

The app also updates its own code now, not just its data. A screener frozen at whatever shipped goes stale (dead
endpoints, moved rate tiers, last year's tax numbers) while looking exactly as authoritative as the day it was
built.

---

## Plan: ordering, not ranking

Every other view ranks. Ranking is the wrong shape for the real question, which is not "what pays the most" but
"given this much money and this much patience, what do I do first" — and the answer is frequently not the top row.

A dollar-for-dollar employer match is a 100% return the day you make it. Comparing a 5.4% CD against a 4.9% one
while leaving a match on the table is optimising the wrong decimal by two orders of magnitude, and a sorted table
cannot say so because both are just numbers in one column.

```
1  Take the whole employer match          rate only    A
2  Pay down $3,000 of card balance        $750         A+   guaranteed 25%, tax-free
3  Put the buffer somewhere that pays     $409         A+   $10,500 committed
4  Commuter benefits — closes in 4 days   $1,291       A+   $2,582/hour for the work
5  Chase Ink Business Preferred           $1,030       A+   ⚠ only on spend you already make
```

It allocates **capital and time** down the tiers until one runs out, orders bounded offers by what an hour of
your time earns, and refuses three things: it does not guess the facts it needs (it asks, and lists what it still
does not know), it does not add money your capital earns to money an action saves, and it does not propose a step
without its catch.

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

**On what it does not cover:** no screener sees everything, and one that implies it does is lying by omission.
The Sources view names the blind spots outright — options pricing, prediction markets, private credit and P2P,
individual corporate and municipal bonds, structured notes and annuities, anything non-US, and anything requiring
a job or a business rather than capital. Knowing where it is blind is more useful than a claim of completeness.

**On the things with no ticker:** a 50% employer match is a larger, safer, more certain return than anything else
in this app, and it is invisible to every yield table ever built because there is nothing to buy. Same for the
$1,500 Acorns pays for five funded referrals — and the row says plainly that it is a threshold, so four friends
does not pay four fifths of it.

---

## You should not need to already know the vocabulary

44 entries covering every term the app puts on screen, with one rule: explain it without using another piece of
jargon, and if you need a second term, that term gets its own entry. Each has a plain answer, why it is on screen
at all, and **the catch** — what people get wrong about it, which is usually the part that actually helps.

> **Duration** — Roughly how much a bond falls if interest rates rise by 1%.
> *Why it is here.* A duration of 16 means a 1% rate rise costs about 16% of the price — on something usually
> called safe.
> *The catch.* It is not the same as years to maturity. A 30-year bond has a duration nearer 16 than 30.

Clicking the `?` beside any column header opens the same explanation in place. A help page you have to go and find
is a help page nobody reads.

First run asks four short questions, all skippable. Tax is the one that matters: a Treasury escapes state tax and a
savings account does not, so in a high-tax state a lower headline rate is genuinely the better deal, and an app
that never asks is showing everyone the answer for one person.

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

**It will not tell you which way anything is going, and it will not make you rich.** Nothing that says otherwise
is telling the truth. What it does is narrower and
real: it finds bounded, time-limited money that no screener lists, tells you before the window shuts rather than
after, puts the moves in the order that actually matters, and is honest about the size of each one. A $300 bonus
is $300. A 100% employer match on 3% of your pay is worth exactly 3% of your pay. Those add up to a materially
better year, not a different life, and an app that blurred that line would be the most expensive thing on your
computer.

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
                   signals · backtest · synthetic · calibration · expectations · plan · vehicles
                   catalyst · movement · filters · aggregate · history · store · export
src/sources/       one adapter per feed, auto-discovered, contract in _contract.js
src/ui/            index.html · styles.css · format.js · filters-def.js · render.js · app.js
data/seed/         bundled offline snapshots
scripts/           scan.js (headless) · backtest.js (real-history validation) · doctor.js (feed diagnosis)
                   probe.js · make-icon.js
test/              node --test
```

Adding a data source is one file in `src/sources/` satisfying `_contract.js`. Adding a filter is one entry in
`src/ui/filters-def.js`.

```bash
npm test          # unit tests, cross-source audit invariants, and the statistical null tests
npm run smoke     # boots the real app headlessly, exercises every view, screenshots each
npm run backtest  # validates the signal engine against real price history
```

The test that matters most is the **null**: twenty independent baskets of pure random walks, asserting the harness
reports no edge. Data with no structure by construction is the only place you can be certain what the right answer
is, and a harness that finds an edge there would make every other number it produces worthless. It has already
failed once and caught a real bug.

MIT.
