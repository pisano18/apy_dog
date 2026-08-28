'use strict';

/**
 * Plain-English definitions for everything this app puts on screen.
 *
 * The rule for every entry: explain it to someone who has never bought
 * anything, without using another piece of jargon to do it. If a definition
 * needs a second term, that term gets its own entry and is linked, never
 * assumed.
 *
 * `what` is the one-line answer. `why` is why it is on screen at all, which is
 * usually the part that actually helps — knowing that "duration 16" means
 * "a 1% rate rise costs about 16%" is worth more than the formal definition.
 * `catch` is what people get wrong about it, and it is the reason this file
 * exists rather than a link to Investopedia.
 */

(function () {
  const G = {
    // ── the money numbers ──────────────────────────────────────────────────
    apy: {
      term: 'APY (annual percentage yield)',
      what: 'What something pays over a year, as a percentage of what you put in, assuming you leave it alone.',
      why: 'It is the closest thing to a common unit across a savings account, a bond and a fund.',
      catch: 'It only means what it says for things that actually repeat every year. A $300 sign-up bonus '
        + 'expressed as an annual rate can read 122%, which is arithmetically true and completely misleading — '
        + 'you collect it once. This app shows those as what they really pay instead.',
      see: ['blended', 'oneOff'],
    },
    afterTax: {
      term: 'After tax',
      what: 'What is left of the yield once your tax bracket takes its share.',
      why: 'Two things advertising the same rate can leave you with very different amounts. A Treasury escapes '
        + 'state tax; a savings account does not.',
      catch: 'It uses the bracket you set in Settings. Wrong bracket, wrong number — it is the single setting '
        + 'that most changes the ranking.',
      see: ['taxEquivalent', 'real'],
    },
    taxEquivalent: {
      term: 'Tax-equivalent yield',
      what: 'What a fully taxable thing would have to pay to leave you as well off as this one does.',
      why: 'It is how you compare a tax-free municipal bond against an ordinary savings account without doing '
        + 'the arithmetic in your head. A 4% muni can beat a 5.5% savings account.',
      catch: 'Only meaningful if the tax treatment shown is actually yours.',
      see: ['afterTax'],
    },
    real: {
      term: 'Real return (after inflation)',
      what: 'What is left after both tax and the fall in what money buys.',
      why: 'It answers the only question that matters in the end: will I be able to buy more later than I can now.',
      catch: 'A 4% account in 3% inflation is a 1% gain before tax and often a loss after it. Safe is not the '
        + 'same as unharmed.',
      see: ['afterTax'],
    },
    blended: {
      term: 'Blended yield',
      what: 'What an offer is worth spread across all the money you have, rather than only the slice it accepts.',
      why: 'An account paying 6% but capped at $1,000 does not pay you 6%. If you have $10,000, it pays 6% on a '
        + 'tenth of it and whatever else you can find on the rest.',
      catch: 'This is the number the ranking uses, because it is the one that decides which row is better for you. '
        + 'The headline rate is still shown, because it is a real fact about the product.',
      see: ['apy', 'reference'],
    },
    reference: {
      term: 'The reference amount (the * mark)',
      what: 'When you have not said how much you have, capped offers are ranked against a stated $10,000 so they '
        + 'can be compared at all. Figures computed that way carry a *.',
      why: 'Without some denominator, a $50 bonus on a $50 minimum ranks above every real investment in the app.',
      catch: 'It is an assumption, which is why it is marked. Type your own amount into the "I have" box and '
        + 'every figure recomputes on it.',
      see: ['blended'],
    },
    oneOff: {
      term: 'One-off',
      what: 'Pays once and never again. Sign-up bonuses, referrals, most tax moves.',
      why: 'These are frequently the highest return per dollar in the whole app, and they are always capped.',
      catch: 'They do not compound and you cannot repeat them, so a five-year projection on one is just the '
        + 'same single payment.',
      see: ['blended'],
    },
    incomeYear1: {
      term: 'Income year 1',
      what: 'Actual dollars in the first year, on your amount.',
      why: 'Percentages hide size. 9% of $500 is $45.',
      catch: 'Marked with a * when computed on the reference amount rather than yours.',
      see: ['reference'],
    },

    // ── risk ────────────────────────────────────────────────────────────────
    safetyGrade: {
      term: 'Safety grade (A+ to F)',
      what: 'How likely you are to get your money back. A+ is government-guaranteed; F means you can lose all of it.',
      why: '"Risk: 47.3" tells nobody anything. A letter with a sentence behind it does.',
      catch: 'It is a SAFETY grade, never a quality one. Some of the most rewarding things here are Fs, and that '
        + 'is the point — it tells you what you are risking, not whether to do it.',
      see: ['principalSafe', 'payoutReliable', 'easyExit', 'steady', 'wellUnderstood'],
    },
    principalSafe: {
      term: 'Principal safe',
      what: 'Whether the money you put in can fall.',
      why: 'A guaranteed deposit and a stock fund are different in kind, not in degree.',
      catch: 'Insurance covers the institution failing. It never covers the price going down.',
      see: ['safetyGrade'],
    },
    payoutReliable: {
      term: 'Payout reliable',
      what: 'How much the rate itself can change or stop.',
      why: 'A CD contracts its rate for the term. A savings account can cut tomorrow. A dividend can be cancelled.',
      catch: 'Backward-looking. It describes what has been paid, not what will be.',
      see: ['safetyGrade'],
    },
    easyExit: {
      term: 'Easy to exit',
      what: 'How quickly you can get out at a fair price.',
      why: 'The thing that turns a bad year into a permanent loss is being forced to sell at the wrong time.',
      catch: 'Thin things are easy to buy and hard to sell, which is not obvious until you try.',
      see: ['liquidity', 'safetyGrade'],
    },
    steady: {
      term: 'Steady',
      what: 'How bumpy the ride is, even when the destination is fine.',
      why: 'A 30-year Treasury pays you back for certain and can swing 20% getting there.',
      catch: 'Low volatility is not low risk. Some of the worst blow-ups were extremely steady right up until '
        + 'they were not.',
      see: ['volatility', 'safetyGrade'],
    },
    wellUnderstood: {
      term: 'Well understood',
      what: 'How much this app actually knows about this row, versus how much is estimated.',
      why: 'A measured row and a bundled snapshot deserve different amounts of trust.',
      catch: 'A confident-looking number from an unrefreshed snapshot is the most dangerous thing on the page.',
      see: ['snapshot', 'safetyGrade'],
    },
    drawdown: {
      term: 'Max drawdown',
      what: 'The worst peak-to-trough fall on record.',
      why: 'It is the number that tells you whether you could have held on.',
      catch: 'The worst so far is not the worst possible.',
      see: ['volatility'],
    },
    volatility: {
      term: 'Volatility',
      what: 'How much something moves around, as a yearly percentage.',
      why: 'It sets how large a normal move is, which is what the expected-move band is built from.',
      catch: 'It says nothing about direction. High volatility means big moves, not bad ones.',
      see: ['expectedMove', 'coil'],
    },
    duration: {
      term: 'Duration',
      what: 'Roughly how much a bond falls if interest rates rise by 1%.',
      why: 'A duration of 16 means a 1% rate rise costs about 16% of the price — on something usually called safe.',
      catch: 'It is not the same as the years to maturity. A 30-year bond has a duration nearer 16 than 30.',
      see: ['principalSafe'],
    },
    liquidity: {
      term: 'Liquidity',
      what: 'How fast you can turn it back into spendable money.',
      why: 'Instant, daily, notice period, or locked until a date. It decides what you can use for emergencies.',
      catch: 'A fund you can sell any day is liquid. The price you get on a bad day is a separate question.',
      see: ['easyExit'],
    },
    trap: {
      term: 'Trap flags',
      what: 'Things this app noticed that usually mean an advertised rate is not what it looks like.',
      why: 'Teaser rates that revert, balance caps, rates far above every peer, unverifiable insurance claims.',
      catch: 'A flag is a reason to read carefully, not proof of a scam. Some flagged rows are genuinely good.',
      see: ['safetyGrade'],
    },

    // ── movement ────────────────────────────────────────────────────────────
    pressure: {
      term: 'Pressure',
      what: 'How many pre-move conditions are firing at once, 0 to 100.',
      why: 'It ranks what is most likely to do something soon. It is not a probability and never a direction.',
      catch: 'Only the detectors that actually beat their base rate contribute. On the last real measurement that '
        + 'was one of them — "stretched", at 1.43x — while compression and tight range failed outright and were '
        + 'given zero weight. So this number rests on less than it looks like it does. Until you run '
        + '"npm run backtest" on your own machine it rests on nothing measured at all.',
      see: ['coil', 'calibration', 'lean', 'baseRate'],
    },
    coil: {
      term: 'Compression (coil)',
      what: 'Trading much more quietly than it normally does.',
      why: 'It is in this app because "a coiled stock is about to explode" is one of the most widely repeated '
        + 'ideas in trading, and it was worth actually checking.',
      catch: 'It was checked and it does not work. Across 101 symbols over five years, out of sample, it was '
        + 'followed by a large move LESS often than average — 0.74 times the base rate, on both definitions of '
        + '"large". It is not secretly a reverse signal either; the numbers are simply uninformative. It now '
        + 'carries zero weight. What the same data DID show is the opposite: volatility persists rather than '
        + 'mean-reverts, which is why "stretched" works and this does not.',
      see: ['volatility', 'pressure', 'baseRate', 'lift'],
    },
    quietAccumulation: {
      term: 'Quiet accumulation',
      what: 'Volume much higher than usual while the price barely moves.',
      why: 'Size changing hands without moving the tape is what building a position looks like before it is news.',
      catch: 'Measured on 101 symbols over five years and it did not work — 0.63 times the base rate for '
        + 'predicting a large move. The likely reason is in the idea itself: someone building a position and '
        + 'someone unloading one look identical from outside, and they precede opposite outcomes, so this '
        + 'averages two opposite things together. It carries zero weight.',
      see: ['pressure', 'baseRate', 'lift'],
    },
    squeeze: {
      term: 'Short squeeze',
      what: 'When many people have borrowed and sold shares they must eventually buy back, and there are few '
        + 'shares available to buy.',
      why: 'The only genuinely directional setup here, because it is arithmetic rather than sentiment: a short '
        + 'position is an obligation to buy, and forced buying into a thin market can only push one way.',
      catch: 'The ingredients being present does not mean it will happen — most heavily shorted stocks are '
        + 'heavily shorted for good reasons and simply keep falling.',
      see: ['shortInterest', 'daysToCover', 'float', 'borrowFee'],
    },
    shortInterest: {
      term: 'Short interest (% of float)',
      what: 'What share of the freely tradable stock has been borrowed and sold by people betting it falls.',
      why: 'Above about 20% is high. Above 100% means more shares are sold short than actually exist to trade.',
      catch: 'Published on a delay, usually twice a month, so it is always somewhat stale.',
      see: ['squeeze', 'float'],
    },
    daysToCover: {
      term: 'Days to cover',
      what: 'How many days of normal trading it would take for all the short sellers to buy back.',
      why: 'It measures how stuck they are. Ten days of buying cannot happen calmly.',
      catch: 'Volume rises during a squeeze, so the real number shrinks exactly when it matters.',
      see: ['squeeze'],
    },
    borrowFee: {
      term: 'Borrow fee',
      what: 'The annual cost of borrowing shares in order to short them.',
      why: 'A normal fee is under 1%. A fee of 50% means shares are genuinely scarce and shorts are bleeding.',
      catch: 'A high fee makes shorts more likely to give up, and also means someone is still willing to pay it.',
      see: ['squeeze'],
    },
    float: {
      term: 'Float',
      what: 'The number of shares actually available to trade, excluding those locked up by insiders.',
      why: 'A small float means the same amount of buying moves the price much further.',
      catch: 'Companies issue more shares into strength, which is the standard way a squeeze ends.',
      see: ['squeeze'],
    },
    expectedMove: {
      term: 'Expected move',
      what: 'How big a move would be ordinary for this thing over the window shown.',
      why: 'It sets expectations. ±4% on one stock is a quiet week; on another it is a crisis.',
      catch: 'Arithmetic on past volatility, not a forecast, and not a limit. Bigger moves happen.',
      see: ['volatility'],
    },
    lean: {
      term: 'Lean',
      what: 'A direction, only where there is a mechanical reason for one.',
      why: 'Forced buying by short sellers has a direction. Scheduled token supply has a direction. Almost '
        + 'nothing else does.',
      catch: 'It reads "none" most of the time, on purpose. That is the honest answer, not a missing feature.',
      see: ['squeeze', 'unlock'],
    },
    clarity: {
      term: 'Clarity',
      what: 'How trustworthy the reading on this row is.',
      why: 'A conclusion from three months of thin data deserves less weight than one from three years.',
      catch: 'Sharp does not mean right. It means the input was good.',
      see: ['snapshot'],
    },
    unlock: {
      term: 'Token unlock',
      what: 'A scheduled date when previously locked crypto becomes sellable.',
      why: 'It is sellers arriving on a schedule everyone can read months ahead.',
      catch: 'Widely known unlocks are often partly priced in already.',
      see: ['lean'],
    },
    catalyst: {
      term: 'Catalyst',
      what: 'A dated event that tends to move things — earnings, an inflation print, a rate decision.',
      why: 'It is why a move happens on a particular Tuesday rather than eventually.',
      catch: 'Everyone can see the date. What nobody knows is the reaction.',
      see: ['expectedMove'],
    },

    // ── the evidence layer ──────────────────────────────────────────────────
    baseRate: {
      term: 'Base rate',
      what: 'How often the thing happens anyway, with no signal at all.',
      why: 'It is the only number that makes a hit rate mean anything. A signal that is right 40% of the time is '
        + 'worthless if the event happens 40% of the time regardless.',
      catch: 'Most impressive-sounding backtests are impressive only because nobody showed you this.',
      see: ['lift', 'calibration'],
    },
    lift: {
      term: 'Lift',
      what: 'How much better than the base rate a signal does. Lift 1.5 means half again as often as chance.',
      why: 'It is the actual measure of whether a detector knows anything.',
      catch: 'Lift on the data you tuned on is meaningless. Only out-of-sample lift counts.',
      see: ['baseRate', 'calibration'],
    },
    calibration: {
      term: 'Calibrated / uncalibrated',
      what: 'Whether the numbers have been checked against what actually happened afterwards.',
      why: 'Until they have, a reading of "72" is a ranking position wearing the costume of a probability.',
      catch: 'Run "npm run backtest" to measure it on real history. Signals that fail get zero weight rather '
        + 'than being quietly kept because they sounded plausible.',
      see: ['baseRate', 'lift', 'pressure'],
    },
    snapshot: {
      term: 'Snapshot',
      what: 'This row came from the data bundled with the app, not from a live fetch.',
      why: 'It means the app works offline and is never empty.',
      catch: 'It is a starting point, not a quote. Refresh before acting on any of it.',
      see: ['wellUnderstood'],
    },
    illustrative: {
      term: 'Drawn, not recorded (dashed charts)',
      what: 'A chart shape derived from the row\'s own statistics rather than from real recorded prices.',
      why: 'It shows the character of the thing when no price history has been fetched.',
      catch: 'A drawn curve and a real price history look identical on screen, and only one is evidence. That is '
        + 'why these are dashed and dimmed. Refresh replaces them with real closes.',
      see: ['snapshot'],
    },

    // ── doing something about it ────────────────────────────────────────────
    effort: {
      term: 'Effort',
      what: 'How much work it takes: click once, light setup, hoops, needs other people, ongoing.',
      why: 'A 12% yield you click once for and a $1,500 referral needing five friends are not comparable, and a '
        + 'percentage hides the difference.',
      catch: '"Needs other people" is the one to watch. You do not control whether it pays.',
      see: ['valuePerHour'],
    },
    valuePerHour: {
      term: 'Value per hour',
      what: 'What the offer pays divided by the time it takes.',
      why: 'It is the comparison that actually decides whether a bounded offer is worth doing. $1,500 for four '
        + 'hours of chasing friends is worth less per hour than $300 for one transfer.',
      catch: 'Only meaningful for one-off offers, not for things that pay a rate.',
      see: ['effort', 'oneOff'],
    },
    reach: {
      term: 'Reach (how well known)',
      what: 'Whether lots of people know about this or almost nobody does.',
      why: 'Obscure is genuinely informative in both directions: uncrowded, and also less scrutinised.',
      catch: 'An obscure deal is often better because nobody has taken it. An obscure pool is often worse '
        + 'because nobody has audited it. Shown, never scored.',
      see: [],
    },
    coveredCall: {
      term: 'Covered call',
      what: 'You own 100 shares and sell someone the right to buy them from you at a set price, for cash today.',
      why: 'It turns a share you already hold into something that pays income.',
      catch: 'You keep the cash and give up the upside above that price. Needs 100 shares — often far more '
        + 'capital than people expect.',
      see: ['cashSecuredPut'],
    },
    cashSecuredPut: {
      term: 'Cash-secured put',
      what: 'You set aside cash and sell someone the right to sell you 100 shares at a lower price, for cash today.',
      why: 'You get paid to wait for a price you would have been happy to buy at anyway.',
      catch: 'If it falls far below that price you still buy at the higher one. Only sensible on something you '
        + 'genuinely want to own.',
      see: ['coveredCall'],
    },
    leaps: {
      term: 'LEAPS',
      what: 'A long-dated option, usually a year or more out.',
      why: 'It gives exposure to an expensive share for a fraction of the cost.',
      catch: 'It expires. Being right late is identical to being wrong.',
      see: [],
    },
    certaintyEquivalent: {
      term: 'Certainty equivalent',
      what: 'The guaranteed return that would make you as happy as this risky one.',
      why: 'It is how the app compares a certain 5% with a risky 12% in a single number.',
      catch: 'It depends on your risk appetite setting. Move that slider and the ranking genuinely changes.',
      see: ['safetyGrade'],
    },
  };

  // Index by both key and lowercased term, so a lookup can be by either.
  const BY_TERM = {};
  for (const [k, v] of Object.entries(G)) {
    BY_TERM[k.toLowerCase()] = { key: k, ...v };
    BY_TERM[v.term.toLowerCase()] = { key: k, ...v };
  }

  window.GLOSSARY = G;
  window.glossaryLookup = (k) => (k ? BY_TERM[String(k).toLowerCase()] || null : null);
  window.glossarySearch = (q) => {
    const t = String(q || '').trim().toLowerCase();
    const all = Object.entries(G).map(([key, v]) => ({ key, ...v }));
    if (!t) return all;
    return all.filter((e) => `${e.term} ${e.what} ${e.why} ${e.catch}`.toLowerCase().includes(t));
  };
}());
