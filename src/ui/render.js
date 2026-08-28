(function () {
'use strict';

/* Pure-ish render functions: state in, HTML string out. Everything user-facing
   that came from a third-party feed goes through esc() — pool names, fund names
   and filing titles are all attacker-controllable strings. */

const R = {};

/**
 * "in 6 days", "tomorrow", "3 weeks ago".
 *
 * Lives here rather than being assigned onto window during boot in app.js:
 * render.js calls it from four places, so a global defined later in another
 * file is a load-order bug waiting to happen — and it was one, until the view
 * tests ran render.js on its own and it threw.
 */
window.CATALYST_WHEN = (d) => {
  if (!Number.isFinite(d)) return '';
  const n = Math.round(d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 0) return n < 14 ? `in ${n} days` : n < 60 ? `in ${Math.round(n / 7)} weeks` : `in ${Math.round(n / 30.44)} months`;
  const a = Math.abs(n);
  return a < 14 ? `${a} days ago` : a < 60 ? `${Math.round(a / 7)} weeks ago` : `${Math.round(a / 30.44)} months ago`;
};
const { esc } = window.F;

/* ═══════════════════════════════════════════════════════════ small pieces ══ */

/** Rating axis as filled pips. Colour shifts as the axis gets weak. */
function pips(value) {
  if (value === null || value === undefined) return '<span class="pips" title="Not applicable">—</span>';
  const cls = value <= 1.5 ? 'bad' : value <= 3 ? 'warn' : '';
  let out = `<span class="pips ${cls}">`;
  for (let i = 1; i <= 5; i += 1) {
    if (value >= i) out += '<i class="on"></i>';
    else if (value >= i - 0.5) out += '<i class="half"></i>';
    else out += '<i></i>';
  }
  return `${out}</span>`;
}
R.pips = pips;

function gradeChip(rating, big = false) {
  if (!rating) return '';
  return `<span class="grade ${big ? 'lg' : ''}" style="color:${rating.gradeColor};background:${rating.gradeColor}18"
    title="${esc(rating.gradeHeadline)} — ${esc(rating.gradeDetail)}">${esc(rating.grade)}</span>`;
}
R.gradeChip = gradeChip;

function heatBar(m) {
  if (m?.unmeasured) return '<span style="color:var(--text-faint)" title="No price history pulled for this one yet. Open it and choose Measure.">not measured</span>';
  if (!m || !Number.isFinite(m.heat)) return '<span style="color:var(--text-faint)">—</span>';
  const col = m.heatColor || 'var(--text-faint)';
  return `<span class="heat" title="${esc(m.heatLabel || '')} — ${esc(m.heatText || '')} Not a prediction of direction.">
    <span class="v" style="color:${col}">${Math.round(m.heat)}</span>
    <span class="bar"><i style="width:${Math.min(100, m.heat)}%;background:${col}"></i></span>
    <span style="color:${col};font-size:10.5px;font-weight:600">${esc(m.heatLabel || '')}</span>
  </span>`;
}

function setupChip(m) {
  if (m?.unmeasured) return '<span style="color:var(--text-faint);font-size:11.5px">—</span>';
  if (!m?.setupLabel) return '<span style="color:var(--text-faint)">—</span>';
  return `<span class="setup" style="color:${m.setupColor}" title="${esc(m.setupText || '')}">${esc(m.setupLabel)}</span>`;
}

function catalystCell(m) {
  const c = m?.catalyst;
  if (!c?.event) return '<span class="catcell"><span class="none">Nothing scheduled</span></span>';
  const e = c.event;
  const days = Math.max(0, Math.round(e.daysAway));
  return `<span class="catcell">
    <span class="when">
      <span class="kind">${esc(e.label)}</span>
      <span class="days">${days === 0 ? 'today' : days === 1 ? '1d' : `${days}d`}</span>
      ${e.certainty === 'estimated' ? '<span class="est" title="Date inferred from past pattern, not published">est</span>' : ''}
    </span>
    ${c.move ? `<span class="band">${esc(c.move.label)}</span>` : ''}
  </span>`;
}

function leanCell(m) {
  if (!m) return '';
  const info = { up: { a: '▲', c: 'var(--pos)', t: 'Leans up' }, down: { a: '▼', c: 'var(--neg)', t: 'Leans down' }, none: { a: '·', c: 'var(--text-faint)', t: 'No lean — the honest answer for most things' } }[m.lean] || {};
  const bars = m.lean === 'none' ? '' : `<span class="bars">${[0.33, 0.66, 1].map((t) => `<i style="${(m.leanStrength || 0) >= t ? `background:${info.c}` : ''}"></i>`).join('')}</span>`;
  return `<span class="lean" style="color:${info.c}" title="${esc(info.t)}${m.leanReasons?.length ? `: ${esc(m.leanReasons[0])}` : ''}">${info.a}${bars}</span>`;
}

function severityChip(m) {
  if (!m?.severityLabel) return '<span style="color:var(--text-faint)">—</span>';
  return `<span style="color:${m.severityColor};font-weight:600;font-size:11.5px" title="Expected size of the next move, as a band">${esc(m.severityLabel)}</span>`;
}

function badges(o) {
  return [
    o.seed ? '<span class="badge snap" title="Bundled snapshot, not a live quote. Refresh to update.">snapshot</span>' : '',
    o.measured === false ? '<span class="badge snap" title="We have this listed but have not analysed its price. Open it to measure.">not measured</span>' : '',
    o.yieldKind === 'expected' ? '<span class="badge spec" title="A modelled estimate, not a yield">estimate</span>' : '',
    o.subType === 'tips' ? '<span class="badge real" title="A REAL (inflation-adjusted) yield, not nominal">real</span>' : '',
    ['fdic', 'ncua', 'us_gov'].includes(o.risk?.insurance) ? `<span class="badge ins" title="${window.F.insurance(o.risk.insurance)}">insured</span>` : '',
    o.scores?.affordable === false ? `<span class="badge snap" title="Needs ${esc(window.F.money(o.minInvestment))} to enter, more than the amount you set in Settings.">out of reach</span>` : '',
    o.oneTime ? '<span class="badge cryp" title="A one-off payment, not a recurring rate. The ranking uses what it is worth on your budget over one year.">one-off</span>' : '',
    o.denomination === 'crypto' ? `<span class="badge cryp" title="Principal and yield are in ${esc(o.symbol || 'a volatile crypto asset')}, not dollars.">in ${esc((o.symbol || 'crypto').split('-')[0])}</span>` : '',
  ].filter(Boolean).join('');
}

const SUBTYPE_LABELS = {
  megacap: 'Mega-cap', high_growth: 'High growth', semis: 'Semiconductors', biotech: 'Biotech',
  energy: 'Energy', financials: 'Financials', consumer: 'Consumer', industrials: 'Industrials',
  small_cap: 'Small cap', crypto_equity: 'Crypto-linked', volatility_adjacent: 'Volatility-linked',
  core_index: 'Core index', target_date: 'Target date', bond_core: 'Core bonds',
  dividend_growth: 'Dividend growth', sector: 'Sector', factor: 'Factor',
  international: 'International', commodity: 'Commodity', spot: 'Spot',
  covered_call: 'Covered call', bond_etf: 'Bond fund', dividend_etf: 'Dividend fund',
  reit: 'REIT', mortgage_reit: 'Mortgage REIT', bdc: 'BDC', preferred: 'Preferred',
  cef: 'Closed-end fund', ultrashort: 'Ultra-short', index_proxy: 'Index proxy',
  bill: 'Bill', note: 'Note', bond: 'Bond', tips: 'TIPS',

  // Deals. A 401(k) match, a referral chain and a checking bonus are all
  // "cash" by asset class, which is true and useless — it is the same three
  // words on 193 rows that have nothing to do with each other. What actually
  // separates them is the kind of deal.
  signup_bonus: 'Sign-up bonus', checking_bonus: 'Checking bonus',
  savings_bonus: 'Savings bonus', credit_union_bonus: 'Credit union bonus',
  brokerage_bonus: 'Brokerage bonus', ira_transfer_bonus: 'IRA transfer bonus',
  cash_management_bonus: 'Cash account bonus', transfer_bonus: 'Transfer bonus',
  referral_bonus: 'Referral', category_bonus: 'Category bonus',
  cashback_program: 'Cashback', promo_offer: 'Promotion',
  intro_apr_carry: 'Intro-APR carry', unclaimed_funds: 'Unclaimed money',
  employer_match: 'Employer match', tax_rule: 'Tax rule',
  tax_deferral: 'Tax deferral', tax_free_growth: 'Tax-free growth',
  savings_bond: 'Savings bond', issuer_policy: 'Issuer policy',

  listed_issuer: 'Listed company', beaten_down_quality: 'Beaten-down quality',
  stablecoin: 'Stablecoin', liquid_staking: 'Liquid staking',
  wrapped: 'Wrapped asset', tokenized_commodity: 'Tokenized commodity',
};

/**
 * What to call this thing in one short phrase.
 *
 * Asset class is the right answer for income — a reader scanning yields wants
 * to know it is a CD and not a junk bond. It is the wrong answer everywhere
 * else: every deal is "Savings / Cash" and every stock is "Dividend Stocks".
 * Outside income, the sub-type is what distinguishes one row from the next.
 */
function kindLabel(o, classes = {}) {
  const specific = SUBTYPE_LABELS[o.subType];
  const section = o.section || (o.track === 'movement' ? 'movement' : 'income');
  if (specific && section !== 'income') return specific;
  return classes[o.assetClass] || o.assetClass || '';
}

function nameCell(o, classes) {
  // On a row about price movement, "Semiconductors" is a far more useful label
  // than "Dividend Stocks", which is technically true of almost any listed
  // company and tells the reader nothing about what they are looking at.
  const primary = kindLabel(o, classes);
  const meta = [primary, o.provider || o.chain || o.sourceLabel]
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="cell-name">
    <span class="n">${esc(o.name)}${o.symbol && !o.name.includes(o.symbol) ? ` <span style="color:var(--text-faint);font-weight:500">${esc(o.symbol)}</span>` : ''}</span>
    <span class="m"><span class="mt">${meta}</span>${badges(o)}</span>
  </div>`;
}

/**
 * Dollars in year one.
 *
 * With no budget set these are computed on a stated reference amount, and the
 * cell says so on hover rather than presenting a reference as the reader's own
 * money. Rows whose size depends on a salary the app was never told print
 * nothing at all, because the rate is the only honest figure they have.
 */
function incomeCell(o, ctx) {
  const s = o.scores || {};
  if (s.dollarsUnknown) {
    return '<td class="num" style="color:var(--text-faint)" title="The rate is exact; the dollars depend on your pay, '
      + 'which this app does not ask for. Multiply the rate by your own numbers.">rate only</td>';
  }
  if (!Number.isFinite(s.incomeYear1)) return '<td class="num" style="color:var(--text-faint)">—</td>';
  const on = Number.isFinite(s.basisAmount) ? window.F.money(s.basisAmount, { dp: 0 }) : null;
  const ref = !s.hasBudget && on;
  const title = ref
    ? `On a reference ${on}, because no amount is set. Set yours in Settings and every dollar figure here is recomputed on it.`
    : (on ? `On the ${on} you set.` : '');
  return `<td class="num" style="color:${ref ? 'var(--text-dim)' : 'var(--pos)'}" title="${esc(title)}">`
    + `${window.F.money(s.incomeYear1, { dp: 0 })}${ref ? '<span class="refmark">*</span>' : ''}</td>`;
}

function apyCell(o) {
  const spec = o.yieldKind === 'expected';
  // A one-off does not have a yield. Showing its annualised rate as the
  // headline is what put "500.0%" above every real investment in the app: it is
  // arithmetically true, it is what the offer would pay if you could take it
  // four times a year, and you cannot. The number that decides the row's place
  // in the ranking is what it is worth spread over the money it can be taken
  // on, so that is the number the column shows, with the single payment beneath
  // it and the raw rate on hover.
  if (o.scores?.blendApplied && Number.isFinite(o.scores.blendedGross)) {
    const b = o.scores.blendedGross;
    const once = o.scores.oneTimeDollars;
    const raw = o.apy?.total;
    const t = o.oneTime
      ? `Pays ${Number.isFinite(once) ? window.F.money(once, { dp: 0 }) : 'once'} once. `
        + (Number.isFinite(raw) ? `That annualises to ${window.F.pct(raw, 1)} over the qualifying period, ` : '')
        + 'but you collect it a single time — spread over '
        + `${Number.isFinite(o.scores.basisAmount) ? window.F.money(o.scores.basisAmount, { dp: 0 }) : 'the amount shown'}`
        + `${o.scores.hasBudget ? '' : ' (a reference amount, since none is set)'} it is worth ${window.F.pct(b, 2)} in year one.`
      : `Pays ${Number.isFinite(raw) ? window.F.pct(raw, 2) : 'its rate'} but only on `
        + `${Number.isFinite(o.maxInvestment) ? window.F.money(o.maxInvestment, { dp: 0 }) : 'a capped balance'}. `
        + `Across ${Number.isFinite(o.scores.basisAmount) ? window.F.money(o.scores.basisAmount, { dp: 0 }) : 'the amount shown'}`
        + `${o.scores.hasBudget ? '' : ' (a reference amount, since none is set)'}, with the rest at the risk-free rate, `
        + `it comes to ${window.F.pct(b, 2)}.`;
    const foot = o.oneTime && Number.isFinite(once) ? `${window.F.money(once, { dp: 0 })} once`
      : Number.isFinite(raw) ? `${window.F.pct(raw, 2)} on the cap` : '';
    return `<td class="num" title="${esc(t)}"><span class="apy ${b >= 8 ? 'hi' : 'mid'}">${window.F.pct(b, 2)}</span>`
      + `${foot ? `<span class="oncepay">${esc(foot)}</span>` : ''}</td>`;
  }
  const v = spec ? o.expected?.annualReturn : o.apy?.total;
  if (!Number.isFinite(v)) return '<td class="num" style="color:var(--text-faint)">—</td>';
  const cls = spec ? 'spec' : v >= 8 ? 'hi' : 'mid';
  const txt = spec ? `~${window.F.pct(v, 1)}` : window.F.pct(v, 2);
  let split = '';
  const base = o.apy?.base; const rew = o.apy?.reward;
  if (Number.isFinite(base) && Number.isFinite(rew) && base + rew > 0 && rew > 0) {
    const bp = Math.max(0, Math.min(100, (base / (base + rew)) * 100));
    split = `<div class="apysplit" title="${window.F.pct(base, 2)} real revenue + ${window.F.pct(rew, 2)} token emissions"><i class="base" style="width:${bp}%"></i><i class="rew" style="width:${100 - bp}%"></i></div>`;
  }
  return `<td class="num"><span class="apy ${cls}">${txt}</span>${split}</td>`;
}

function trend(change) {
  if (!change || change.direction === 'flat') return '';
  const arrow = change.direction === 'up' ? '▲' : '▼';
  return `<span class="trend ${change.direction}" title="${window.F.pctSigned(change.delta)} over ${change.days} days">${arrow}${Math.abs(change.delta).toFixed(2)}</span>`;
}

/* ══════════════════════════════════════════════════════════════════ tables ══ */

/* Two column sets, because the two tracks answer different questions and forcing
   them into one grid is exactly what made stocks unreadable before. */

R.INCOME_COLUMNS = [
  { key: 'watch', label: '', width: 26 },
  { key: 'name', label: 'Opportunity', sort: 'name' },
  { key: 'apy', label: 'Yield', sort: 'apy', num: true, help: 'apy' },
  { key: 'aftertax', label: 'After tax', sort: 'afterTax', num: true, help: 'afterTax' },
  { key: 'income', label: 'Income yr 1', sort: null, num: true, basisLabel: true, help: 'incomeYear1' },
  { key: 'grade', label: 'Safety', sort: 'grade', help: 'safetyGrade' },
  { key: 'axes', label: 'Principal · Payout · Exit', sort: null, help: 'principalSafe' },
  { key: 'term', label: 'Committed', sort: 'term', help: 'liquidity' },
  { key: 'entry', label: 'Min', sort: 'minInvestment', num: true },
  { key: 'flags', label: 'Flags', sort: 'trap', help: 'trap' },
];

R.MOVEMENT_COLUMNS = [
  { key: 'watch', label: '', width: 26 },
  { key: 'name', label: 'Ticker', sort: 'name' },
  { key: 'heat', label: 'Heat', sort: 'heat', num: true, help: 'pressure' },
  { key: 'chart', label: '12mo', sort: null, width: 84, help: 'illustrative' },
  { key: 'setup', label: 'Setup', sort: null, help: 'coil' },
  { key: 'catalyst', label: 'Next catalyst', sort: 'soonest', help: 'catalyst' },
  { key: 'severity', label: 'If it moves', sort: 'biggestMove', help: 'expectedMove' },
  { key: 'lean', label: 'Lean', sort: null, help: 'lean' },
  { key: 'clarity', label: 'Clarity', sort: 'clarity', help: 'clarity' },
  { key: 'grade', label: 'Safety', sort: 'grade', help: 'safetyGrade' },
  { key: 'price', label: 'Price', sort: 'price', num: true },
];

function incomeRow(o, ctx) {
  const a = o.rating?.axes || {};
  return `
    <td><span class="star ${ctx.watched ? 'on' : ''}" data-act="watch" data-id="${esc(o.id)}">${ctx.watched ? '★' : '☆'}</span></td>
    <td>${nameCell(o, ctx.classes)}</td>
    ${apyCell(o)}
    <td class="num" title="After your tax settings${o.scores?.blendApplied ? ', on the same blended basis as the yield beside it' : ''}">${window.F.pct(o.scores?.blendedAfterTax ?? o.tax?.afterTaxApy, 2)} ${trend(ctx.change)}</td>
    ${incomeCell(o, ctx)}
    <td>${gradeChip(o.rating)}</td>
    <td><span style="display:inline-flex;gap:9px">${pips(a.principal?.value)}${pips(a.payout?.value)}${pips(a.exit?.value)}</span></td>
    <td>${esc(window.F.term(o))}</td>
    <td class="num">${Number.isFinite(o.minInvestment) ? window.F.money(o.minInvestment) : '—'}</td>
    <td><span class="flagcell ${o.scores?.traps?.verdict || 'clean'}" title="${esc((o.trapFlags || []).join(', ') || 'No warning flags')}">${(o.trapFlags || []).length ? `⚑ ${o.trapFlags.length}` : '—'}</span></td>`;
}

function movementRow(o, ctx) {
  const m = o.movement;
  const clarityInfo = { murky: ['Murky', 'var(--text-faint)'], faint: ['Faint', 'var(--warn)'], clear: ['Clear', 'var(--pos)'], sharp: ['Sharp', 'var(--pos)'] }[m?.clarityTier] || ['—', 'var(--text-faint)'];
  return `
    <td><span class="star ${ctx.watched ? 'on' : ''}" data-act="watch" data-id="${esc(o.id)}">${ctx.watched ? '★' : '☆'}</span></td>
    <td>${nameCell(o, ctx.classes)}</td>
    <td class="num">${heatBar(m)}</td>
    <td>${o.series?.length ? R.sparkline(o.series, 74, 24, o.seriesBasis) : '<span class="spark2"></span>'}</td>
    <td>${setupChip(m)}</td>
    <td>${catalystCell(m)}</td>
    <td>${severityChip(m)}</td>
    <td>${leanCell(m)}</td>
    <td><span style="color:${clarityInfo[1]};font-size:11.5px;font-weight:600" title="${esc(m?.clarityText || '')}">${clarityInfo[0]}</span></td>
    <td>${gradeChip(o.rating)}</td>
    <td class="num">${Number.isFinite(o.price) ? window.F.money(o.price, { dp: 2 }) : '—'}</td>`;
}

R.table = (rows, ctx) => {
  const movement = ctx.track === 'movement';
  const cols = movement ? R.MOVEMENT_COLUMNS : R.INCOME_COLUMNS;

  if (!rows.length) {
    const hidden = ctx.facets?.trapsHidden || 0;
    return `<div class="empty">
      <h3>Nothing matches</h3>
      <p>${hidden ? `${hidden} result${hidden === 1 ? ' is' : 's are'} hidden as likely yield traps. ` : ''}
        Try removing a filter above${movement ? ', or lowering the minimum heat' : ', or widening the yield range'}.</p>
      <button class="btn" data-act="clear-filters">Clear all filters</button>
    </div>`;
  }

  const head = cols.map((c) => {
    const sorted = ctx.sortBy === c.sort;
    return `<th class="${c.num ? 'num' : ''} ${sorted ? 'sorted' : ''}" ${c.sort ? `data-sort="${c.sort}"` : ''} ${c.width ? `style="width:${c.width}px"` : ''}>
      ${esc(c.label)}${sorted ? `<span class="arrow">${ctx.sortDir === 'asc' ? '▲' : '▼'}</span>` : ''}${c.help && window.helpChip ? window.helpChip(c.help) : ''}
    </th>`;
  }).join('');

  const body = rows.map((o) => {
    const rowCtx = { ...ctx, watched: ctx.watchlist.includes(o.id), change: ctx.changes?.[o.id] };
    const cls = [
      ctx.selectedId === o.id ? 'selected' : '',
      o.scores?.traps?.verdict === 'likely_trap' ? 'trap' : '',
      o.measured === false ? 'measured-off' : '',
    ].filter(Boolean).join(' ');
    return `<tr data-id="${esc(o.id)}" class="${cls}">${movement ? movementRow(o, rowCtx) : incomeRow(o, rowCtx)}</tr>`;
  }).join('');

  return `<table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
};

/* ════════════════════════════════════════════════════════════════ charts ══ */

/**
 * Price chart from a downsampled series.
 *
 * Deliberately unlabelled on the row and lightly labelled in the drawer. The
 * shape is the information — whether something is grinding up, coiling, or
 * falling off a cliff reads instantly and a grid of axis ticks would only
 * compete with it.
 */
function chartPath(series, w, h, pad = 2) {
  const vals = (series || []).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || Math.abs(max) || 1;
  const x = (i) => pad + (i / (vals.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(vals.length - 1).toFixed(1)},${h}L${x(0).toFixed(1)},${h}Z`;
  return { line, area, min, max, first: vals[0], last: vals[vals.length - 1], up: vals[vals.length - 1] >= vals[0] };
}

/**
 * Where a chart came from, in the words a reader needs.
 *
 * A drawn shape and a recorded price history are pixel-identical on screen, and
 * only one of them is evidence. An offline row charts a curve built to agree
 * with the volatility and drawdown printed beside it — genuinely useful for
 * seeing the shape of a thing, and not something anyone should trade off.
 */
const SERIES_BASIS = {
  measured: { short: '', long: 'Recorded closes from the price feed.' },
  illustrative: {
    short: 'drawn, not recorded',
    long: 'This shape is drawn to match the volatility, drawdown and trend printed on this row — it is not a '
      + 'recorded price history. Refresh to replace it with real closes.',
  },
};

R.sparkline = (series, w = 74, h = 24, basis = null) => {
  const p = chartPath(series, w, h);
  if (!p) return '<span class="spark2"></span>';
  const c = p.up ? 'var(--pos)' : 'var(--neg)';
  const drawn = basis === 'illustrative';
  const title = drawn ? SERIES_BASIS.illustrative.long : '';
  return `<svg class="spark2${drawn ? ' drawn' : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    ${title ? `<title>${esc(title)}</title>` : ''}
    <path d="${p.line}" fill="none" stroke="${c}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"${drawn ? ' stroke-dasharray="3 2"' : ''}/>
  </svg>`;
};

R.chart = (series, { w = 380, h = 132, label = '', basis = null } = {}) => {
  const p = chartPath(series, w, h, 6);
  if (!p) return '<div class="infobox">No price history pulled for this one yet.</div>';
  const c = p.up ? 'var(--pos)' : 'var(--neg)';
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const pct = p.first ? ((p.last - p.first) / Math.abs(p.first)) * 100 : 0;
  return `<div class="chartbox">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${c}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${c}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${p.area}" fill="url(#${id})"/>
      <path d="${p.line}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="chartmeta">
      <span>${esc(window.F.money(p.min, { dp: 2 }))}</span>
      <span style="color:${c}">${window.F.pctSigned(pct, 1)} ${esc(label)}</span>
      <span>${esc(window.F.money(p.max, { dp: 2 }))}</span>
    </div>
    ${basis === 'illustrative' ? `<div class="chartwarn">${esc(SERIES_BASIS.illustrative.long)}</div>` : ''}
  </div>`;
};

/* ═══════════════════════════════════════════════════════════════ presets ══ */

/* Starting points. Each sets a whole query at once, then the user adjusts with
   pills. Named for the question being asked, not the mechanism. */
R.PRESETS = [
  { key: 'safe-income', label: 'Safe income', track: 'income', q: { grades: ['A+', 'A'], sortBy: 'afterTax', hideTraps: true } },
  { key: 'max-yield', label: 'Highest yield', track: 'income', q: { sortBy: 'apy', hideTraps: false } },
  { key: 'best-overall', label: 'Best risk-adjusted', track: 'income', q: { sortBy: 'dogScore', hideTraps: true } },
  { key: 'liquid', label: 'No lockup', track: 'income', q: { termPreset: 'liquid', sortBy: 'afterTax' } },
  { key: 'retirement', label: 'Retirement core', track: 'all', q: { minPrincipalAxis: 3, sortBy: 'dogScore', hideTraps: true, minTvl: 5e8 } },
  { key: 'this-week', label: 'Happening this week', track: 'movement', q: { catalystWithinDays: 7, sortBy: 'heat' } },
  { key: 'coiled', label: 'Coiled up', track: 'movement', q: { setups: ['coiled'], sortBy: 'heat' } },
  { key: 'big-moves', label: 'Biggest expected moves', track: 'movement', q: { severities: ['violent', 'extreme'], sortBy: 'biggestMove' } },
  // The four the app had no starting point for, and the ones a sorted table is
  // worst at: money with a deadline, money nobody has to chase, money that is
  // simply free, and money few people have heard of.
  { key: 'closing-soon', label: 'Closing soon', track: 'all', q: { expiringWithinDays: 30, sortBy: 'closingSoon', hideTraps: false } },
  { key: 'free-money', label: 'Free money', track: 'all', q: { sections: ['deals'], sortBy: 'dogScore', hideTraps: false } },
  { key: 'no-chasing', label: 'No chasing anyone', track: 'all', q: { sections: ['deals'], effortMax: 'light', sortBy: 'dogScore', hideTraps: false } },
  { key: 'obscure', label: 'Few people know', track: 'all', q: { reaches: ['obscure', 'niche'], sortBy: 'dogScore' } },
];

/* ══════════════════════════════════════════════════════ filter bar & menu ══ */

R.filterBar = (query, ctx) => {
  const defs = window.FILTER_DEFS;
  const active = defs.filter((d) => window.filterIsActive(d, query));

  const pillsHtml = active.map((d) => {
    let val;
    try { val = d.format(query, ctx); } catch { val = 'set'; }
    return `<span class="fpill" data-filter="${esc(d.key)}">
      <span class="lbl" data-act="edit-filter" data-key="${esc(d.key)}">${esc(d.label)}</span>
      <span class="val" data-act="edit-filter" data-key="${esc(d.key)}">${esc(String(val))}</span>
      <button class="x" data-act="remove-filter" data-key="${esc(d.key)}" title="Remove this filter">✕</button>
    </span>`;
  }).join('');

  const presets = R.PRESETS.filter((p) => p.track === 'all' || p.track === ctx.track || ctx.track === 'all');

  return `<button class="addfilter" data-act="open-presets" style="border-style:solid;border-color:var(--border)">Start from ▾</button>
    ${pillsHtml}
    <button class="addfilter" data-act="open-filter-menu">+ Filter</button>
    ${active.length ? `<button class="clearall" data-act="clear-filters">Clear all (${active.length})</button>` : ''}
    ${active.length === 0 ? `<span style="color:var(--text-faint);font-size:11.5px;margin-left:2px">Showing everything — ${presets.length} starting points under "Start from"</span>` : ''}`;
};

R.presetMenu = (ctx) => {
  const presets = R.PRESETS.filter((p) => p.track === 'all' || p.track === ctx.track || ctx.track === 'all');
  return `<div class="list" style="padding-top:6px">
    <div class="grp">Starting points</div>
    ${presets.map((p) => `<button class="opt" data-act="pick-preset" data-key="${esc(p.key)}">
      ${esc(p.label)}<span class="d">${esc({ income: 'income track', movement: 'movement track', all: 'both tracks' }[p.track])}</span>
    </button>`).join('')}
  </div>`;
};

R.filterMenu = (query, ctx, search = '') => {
  const defs = window.FILTER_DEFS;
  const needle = search.trim().toLowerCase();
  const relevant = defs.filter((d) => {
    // A movement-only filter is noise while looking at income, and vice versa.
    if (d.track && ctx.track !== 'all' && d.track !== ctx.track) return false;
    if (!needle) return true;
    return `${d.label} ${d.description} ${d.group}`.toLowerCase().includes(needle);
  });

  const groups = {};
  for (const d of relevant) (groups[d.group] = groups[d.group] || []).push(d);

  const body = Object.keys(groups).length
    ? Object.entries(groups).map(([g, list]) => `
        <div class="grp">${esc(g)}</div>
        ${list.map((d) => `<button class="opt ${window.filterIsActive(d, query) ? 'active' : ''}" data-act="pick-filter" data-key="${esc(d.key)}">
          ${esc(d.label)}${window.filterIsActive(d, query) ? ' ✓' : ''}
          <span class="d">${esc(d.description)}</span>
        </button>`).join('')}`).join('')
    : '<div class="empty2">No filter matches that.</div>';

  return `<input class="search" type="text" id="fmenu-search" placeholder="Search filters…" value="${esc(search)}" spellcheck="false" autocomplete="off" />
    <div class="list">${body}</div>`;
};

R.filterEditor = (def, query, ctx) => {
  if (!def) return '';
  const q = query;
  let body = '';

  if (def.type === 'bool') {
    const on = def.defaultOn ? q[def.keys[0]] !== false : q[def.keys[0]] === true;
    body = `<label class="check"><input type="checkbox" data-fkey="${esc(def.keys[0])}" ${on ? 'checked' : ''} /> ${esc(def.label)}</label>`;
  } else if (def.type === 'range') {
    body = `<div class="row">
      <input type="number" data-fkey="${esc(def.keys[0])}" value="${q[def.keys[0]] ?? ''}" placeholder="min" />
      <span style="color:var(--text-faint)">to</span>
      <input type="number" data-fkey="${esc(def.keys[1])}" value="${q[def.keys[1]] ?? ''}" placeholder="max" />
    </div>`;
  } else if (def.type === 'number') {
    const shown = def.decode ? def.decode(q[def.keys[0]]) : q[def.keys[0]];
    body = `<div class="row"><input type="number" data-fkey="${esc(def.keys[0])}" value="${shown ?? ''}" placeholder="any" />
      <span style="color:var(--text-faint)">${esc(def.unit || '')}</span></div>`;
  } else if (def.type === 'select') {
    const opts = def.optionsFrom ? (ctx.options[def.optionsFrom] || []) : (def.options || []);
    body = `<select data-fkey="${esc(def.keys[0])}">
      <option value="">Any</option>
      ${opts.map(([v, l]) => `<option value="${esc(v)}"${String(q[def.keys[0]]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
    </select>`;
  } else if (def.type === 'multi') {
    const opts = def.optionsFrom ? (ctx.options[def.optionsFrom] || []) : (def.options || []);
    const cur = q[def.keys[0]] || [];
    body = `<div class="chips">${opts.map(([v, l, n]) => `
      <button class="chip ${cur.includes(v) ? 'on' : ''}" data-act="toggle-fval" data-fkey="${esc(def.keys[0])}" data-val="${esc(v)}">
        ${esc(l)}${Number.isFinite(n) ? `<span class="n">${n}</span>` : ''}
      </button>`).join('')}</div>`;
  } else {
    body = `<input type="text" data-fkey="${esc(def.keys[0])}" value="${esc(q[def.keys[0]] ?? '')}" />`;
  }

  return `<h5>${esc(def.label)}</h5>
    <div style="font-size:11px;color:var(--text-faint);line-height:1.45;margin-bottom:9px">${esc(def.description)}</div>
    ${body}
    <button class="btn sm done" data-act="close-editor">Done</button>`;
};

/* ══════════════════════════════════════════════════════════════════ events ══ */

R.eventRow = (e, ctx = {}) => {
  const d = new Date(e.dateMs);
  const kind = (window.EVENT_INFO || {})[e.kind] || {};
  return `<div class="evrow ${e.past ? 'past' : ''}" ${e.symbol ? `data-act="goto-symbol" data-val="${esc(e.symbol)}" style="cursor:pointer"` : ''}>
    <div class="date">
      <div class="d">${d.getDate()}</div>
      <div class="m">${d.toLocaleString(undefined, { month: 'short' })}</div>
    </div>
    <div class="body2">
      <div class="t">
        ${esc(e.title || e.label)}
        <span class="evkind">${esc(e.label)}</span>
        ${e.symbol ? `<span style="color:var(--text-faint);font-family:var(--mono);font-size:11px">${esc(e.symbol)}</span>` : ''}
        ${e.certainty === 'estimated' ? '<span class="est" title="Inferred, not published">est</span>' : ''}
      </div>
      <div class="s">${esc(e.text || kind.text || '')}</div>
    </div>
    <div class="away">${esc(window.CATALYST_WHEN ? window.CATALYST_WHEN(e.daysAway) : `${Math.round(e.daysAway)}d`)}</div>
  </div>`;
};

/* ═══════════════════════════════════════════════════════════════════ radar ══ */

/**
 * The landing view.
 *
 * Seven hundred rows sorted by anything is not navigable — the crypto tickers
 * alone bury every bank offer in the app. So the first thing you see is a digest:
 * a handful from each shelf, plus the two things a flat table can never surface,
 * which are what closes soon and what almost nobody knows about.
 *
 * Every card links through to the full filtered list, so this is a way in rather
 * than a wall between you and the data.
 */

function countdownChip(o) {
  if (!Number.isFinite(o.daysLeft)) return '';
  const d = o.daysLeft;
  const col = d <= 7 ? 'var(--neg)' : d <= 31 ? 'var(--warn)' : 'var(--text-faint)';
  const bg = d <= 7 ? 'var(--neg-soft)' : d <= 31 ? 'var(--warn-soft)' : 'var(--panel-3)';
  const txt = d < 0 ? 'closed' : d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
  return `<span class="countdown" style="color:${col};background:${bg}">${txt}</span>`;
}

function radarItem(o, valueFn, subFn) {
  return `<li class="ritem" data-act="goto" data-id="${esc(o.id)}">
    ${o.series?.length ? R.sparkline(o.series, 54, 20, o.seriesBasis) : ''}
    <span class="body">
      <span class="nm">${esc(o.name)}</span>
      <span class="sub">${esc(subFn(o))}</span>
    </span>
    <span class="val">${valueFn(o)}</span>
  </li>`;
}

/**
 * A dated event on the Radar.
 *
 * Most of what is scheduled in any given week belongs to no ticker: a CPI
 * print, an FOMC decision and a Treasury auction move the whole board and
 * cannot be attached to a row. Showing only the catalysts that happen to hang
 * off an equity meant the "what is about to happen" card listed one earnings
 * date while five macro events that week went unmentioned.
 */
function radarEventItem(e) {
  const when = window.CATALYST_WHEN ? window.CATALYST_WHEN(e.daysAway) : `in ${Math.round(e.daysAway)}d`;
  const scope = e.scope === 'symbol' ? (e.symbol || '') : 'Whole market';
  const sub = [scope, e.certainty === 'estimated' ? 'estimated date' : null].filter(Boolean).join(' · ');
  const size = Number.isFinite(e.volMultiple) && e.volMultiple > 1
    ? `<span class="evmag" title="This kind of event has historically moved things about ${e.volMultiple.toFixed(1)}x a normal day.">${e.volMultiple.toFixed(1)}x</span>`
    : '';
  // An event without a row of its own still has somewhere to go: the drawer if
  // we could match it to a holding, the calendar otherwise.
  const act = e.linkId ? `data-act="goto" data-id="${esc(e.linkId)}"` : 'data-act="goto-view" data-val="events"';
  return `<li class="ritem" ${act} title="${esc(e.text || '')}">
    <span class="body">
      <span class="nm">${esc(e.title || e.label)}</span>
      <span class="sub">${esc(sub)}</span>
    </span>
    <span class="val"><span class="evwhen">${esc(when)}</span>${size}</span>
  </li>`;
}

function radarCard({ icon, title, blurb, rows, items, count, query, view, valueFn, subFn, emptyText }) {
  const body = items != null ? items : (rows || []).map((o) => radarItem(o, valueFn, subFn));
  const more = view
    ? `<button class="more" data-act="goto-view" data-val="${esc(view)}">see all →</button>`
    : `<button class="more" data-act="radar-more" data-query='${esc(JSON.stringify(query))}'>see all →</button>`;
  return `<section class="rcard">
    <header>
      <span class="ic">${icon}</span>
      <h3>${esc(title)}</h3>
      <span class="n">${count}</span>
      ${more}
    </header>
    ${blurb ? `<div class="blurb">${esc(blurb)}</div>` : ''}
    <ul>${body.length
    ? body.join('')
    : `<li class="empty3">${esc(emptyText || 'Nothing here right now.')}</li>`}</ul>
  </section>`;
}

R.radar = (data, ctx) => {
  const { cards, meta, budget } = data;
  const money = window.F.money;

  const budgetBar = budget
    ? `<div class="budgetbar">
        <span class="lbl">Working with <b>${money(budget)}</b> — every figure below is what it would earn you.</span>
        <span class="spacer"></span>
        <input type="number" id="radar-budget" value="${budget}" step="1000" />
        <button class="btn sm" data-act="set-budget">Update</button>
        <button class="btn ghost sm" data-act="clear-budget">Clear</button>
      </div>`
    : `<div class="budgetbar unset">
        <span class="lbl"><b>How much are you working with?</b> Optional — without it you get rates, with it you get dollars, and capped offers get ranked on what they are actually worth to you.</span>
        <span class="spacer"></span>
        <input type="number" id="radar-budget" placeholder="e.g. 10000" step="1000" />
        <button class="btn primary sm" data-act="set-budget">Set</button>
      </div>`;

  return `<div class="rwrap">
    <div class="rhead">
      <div>
        <h1>What is worth looking at</h1>
        <div class="sub">${meta.total.toLocaleString()} opportunities · ${meta.upcomingEvents || 0} dated events · scanned ${meta.generatedAt ? window.F.ago(meta.generatedAt) : 'never'}</div>
      </div>
      <span class="spacer"></span>
      <button class="btn" data-act="goto-section" data-val="all">Browse everything →</button>
    </div>
    ${budgetBar}
    <div class="rgrid">${cards.join('')}</div>
  </div>`;
};

R.radarCard = radarCard;
R.countdownChip = countdownChip;

/* ══════════════════════════════════════════════════════════════════ drawer ══ */

function moveBar(move) {
  if (!move) return '';
  const max = move.outer * 1.15;
  const pct = (v) => `${50 + (v / max) * 50}%`;
  return `<div class="movebar">
    <div class="outer" style="left:${pct(-move.outer)};right:${100 - parseFloat(pct(move.outer))}%"></div>
    <div class="inner" style="left:${pct(-move.typical)};right:${100 - parseFloat(pct(move.typical))}%;background:linear-gradient(90deg,var(--neg),var(--warn),var(--pos))"></div>
    <div class="zero"></div>
    <div class="lbl" style="left:${pct(-move.outer)}">−${move.outer}%</div>
    <div class="lbl" style="left:${pct(move.outer)}">+${move.outer}%</div>
  </div>
  <div style="font-size:11px;color:var(--text-faint);line-height:1.5">
    Two-in-three chance it lands within <b style="color:var(--text)">±${move.typical}%</b>;
    about nineteen-in-twenty within <b style="color:var(--text)">±${move.outer}%</b>. Which direction is not knowable.
  </div>`;
}

function sparkline(series, w = 356, h = 46) {
  if (!series || series.length < 2) return '';
  const ys = series.map((s) => s.y);
  const min = Math.min(...ys); const max = Math.max(...ys);
  const span = max - min || 1;
  const pts = series.map((s, i) => {
    const x = (i / (series.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((s.y - min) / span) * (h - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = ys[ys.length - 1] >= ys[0] ? 'var(--pos)' : 'var(--neg)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" />
  </svg>`;
}

R.drawer = (detail, ctx) => {
  if (!detail) return '';
  const o = detail.opportunity;
  const s = o.scores || {};
  const m = o.movement;
  const r = o.rating;
  const watched = ctx.watchlist.includes(o.id);
  const isMovement = o.track !== 'income';
  const hasIncome = o.track !== 'movement' && Number.isFinite(o.apy?.total);

  const axesHtml = window.RATING_AXES.map((meta) => {
    const ax = r?.axes?.[meta.key];
    if (!ax) return '';
    return `<div class="axisrow ${ax.na ? 'na' : ''}">
      <span class="k" title="${esc(meta.question)}">${esc(meta.label)}</span>
      <span>${pips(ax.value)}</span>
      <span class="w">${esc(ax.why)}</span>
    </div>`;
  }).join('');

  return `
  <div class="dhead">
    <div class="top">
      <h2>${esc(o.name)}</h2>
      <button class="btn ghost icon" data-act="watch" data-id="${esc(o.id)}"><span class="star ${watched ? 'on' : ''}">${watched ? '★' : '☆'}</span></button>
      <button class="btn ghost icon" data-act="close-drawer">✕</button>
    </div>
    <div class="sub">
      ${gradeChip(r, false)}
      <span>${esc(kindLabel(o, ctx.classes))}</span>
      ${o.symbol ? `<span>· ${esc(o.symbol)}</span>` : ''}
      ${o.chain ? `<span>· ${esc(o.chain)}</span>` : ''}
      <span>· via ${esc(o.sourceLabel || o.source)}</span>
      ${badges(o)}
    </div>
  </div>

  ${o.series?.length ? `<div class="dsection">
    <h4>Price</h4>
    ${R.chart(o.series, { label: 'over the window shown', basis: o.seriesBasis })}
  </div>` : ''}

  ${Number.isFinite(o.daysLeft) || o.notYetOpen || o.effort !== 'passive' || o.reach !== 'common' ? `<div class="dsection">
    <h4>Getting it</h4>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px">
      ${Number.isFinite(o.daysLeft) ? R.countdownChip(o) : ''}
      ${o.notYetOpen ? `<span class="tag">opens in ${o.daysUntilOpen} days</span>` : ''}
      ${o.effort && o.effort !== 'passive' ? `<span class="tag ${o.effort === 'social' ? 'social' : ''}">${esc((window.EFFORT_INFO?.[o.effort] || {}).label || o.effort)}</span>` : ''}
      ${o.reach && o.reach !== 'common' ? `<span class="tag ${o.reach === 'obscure' ? 'obscure' : ''}">${esc(o.reach)}</span>` : ''}
    </div>
    ${o.effort && window.EFFORT_INFO?.[o.effort] ? `<div class="sectionnote">${esc(window.EFFORT_INFO[o.effort].text)}</div>` : ''}
  </div>` : ''}

  ${isMovement && m ? `<div class="dsection">
    <h4>What is going on</h4>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      ${setupChip(m)}
      ${heatBar(m)}
      ${leanCell(m)}
    </div>
    <div class="infobox">${esc(m.setupText || '')}</div>
    ${m.catalyst?.event ? `<div style="margin-top:12px">
      <div style="font-size:12.5px;font-weight:600;margin-bottom:3px">Next: ${esc(m.catalyst.event.label)} ${esc(window.CATALYST_WHEN(m.catalyst.event.daysAway))}</div>
      <div style="font-size:11.5px;color:var(--text-dim);line-height:1.5">${esc(m.catalyst.event.text || '')}</div>
    </div>` : '<div class="sectionnote" style="margin-top:10px">Nothing scheduled in the next two months.</div>'}
    ${moveBar(m.move)}
    <div class="sectionnote">Signal clarity: <b style="color:var(--text)">${esc(m.clarityTier)}</b> — ${esc(m.clarityText || '')}</div>
  </div>` : ''}

  ${hasIncome ? `<div class="dsection">
    <h4>What it pays</h4>
    <div class="bignum">
      ${s.blendApplied ? `<div class="item lead"><div class="v">${window.F.pct(s.blendedGross, 2)}</div><div class="k">Worth to you, year one</div></div>` : ''}
      <div class="item"><div class="v">${window.F.pct(o.apy?.total, 2)}</div><div class="k">Headline</div></div>
      <div class="item"><div class="v">${window.F.pct(s.blendApplied ? s.blendedAfterTax : o.tax?.afterTaxApy, 2)}</div><div class="k">After your tax</div></div>
      <div class="item"><div class="v">${window.F.pct(s.blendApplied ? s.blendedTaxEquivalent : o.tax?.taxEquivalentYield, 2)}</div><div class="k">Tax-equivalent</div></div>
      <div class="item"><div class="v">${window.F.pct(s.blendApplied ? s.blendedAfterTaxReal : o.tax?.afterTaxRealApy, 2)}</div><div class="k">After inflation</div></div>
    </div>
    ${s.blendNote && !s.dollarsUnknown ? `<div class="blendnote">${esc(s.blendNote)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:18px">
      ${s.dollarsUnknown
    ? `<div style="grid-column:1/-1"><div style="font-size:12.5px;line-height:1.5;color:var(--text-dim)">The rate above is exact. The dollars are not — the cap is a share of your pay, which this app has never been told, so it shows none rather than inventing one. Multiply the rate by your own numbers.</div></div>`
    : `<div><div style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--pos)">${window.F.money(s.incomeYear1, { dp: 0 })}</div><div style="font-size:10px;color:var(--text-faint)">on ${window.F.money(s.basisAmount ?? ctx.budget)}, year 1${s.hasBudget ? '' : ' (reference)'}</div></div>
      <div><div style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--pos)">${window.F.money(s.income5yr, { dp: 0 })}</div><div style="font-size:10px;color:var(--text-faint)">over 5 years</div></div>`}
    </div>
  </div>` : ''}

  ${detail.verdict ? R.verdict(detail.verdict) : ''}

  ${detail.expectations ? R.expectations(detail.expectations) : ''}

  <div class="dsection">
    <h4>Safety — grade ${esc(r?.grade || '?')}</h4>
    <div class="infobox" style="margin-bottom:10px"><b>${esc(r?.gradeHeadline || '')}.</b> ${esc(r?.gradeDetail || '')}</div>
    ${axesHtml}
  </div>

  ${(s.traps?.detail || []).length ? `<div class="dsection">
    <h4>What to watch out for</h4>
    ${s.traps.detail.map((t) => `<div class="warnbox ${t.points >= 15 ? 'severe' : 'mild'}">
      <div class="ttl">${esc(String(t.flag).replace(/_/g, ' '))}</div>${esc(t.message)}
    </div>`).join('')}
  </div>` : ''}

  ${o.denomination === 'crypto' ? `<div class="dsection"><div class="warnbox mild">
    <div class="ttl">Not paid in dollars</div>
    Principal and any yield are denominated in ${esc(o.symbol || 'a volatile crypto asset')}. The price of that asset dominates your actual return.
  </div></div>` : ''}

  ${(m?.upcoming || []).length ? `<div class="dsection">
    <h4>Calendar</h4>
    ${m.upcoming.map((e) => R.eventRow(e)).join('')}
  </div>` : ''}

  ${(m?.recent || []).length ? `<div class="dsection">
    <h4>Recently</h4>
    ${m.recent.map((e) => R.eventRow(e)).join('')}
  </div>` : ''}

  ${(m?.heatParts || []).length ? `<div class="dsection">
    <h4>Why it is on this list</h4>
    ${m.heatParts.map((p) => `<div class="factor"><span class="pts">+${p.points}</span><span class="lbl">${esc(p.label)}</span></div>`).join('')}
  </div>` : ''}

  ${hasIncome ? `<div class="dsection">
    <h4>Terms</h4>
    <dl class="kv">
      <dt>Rate type</dt><dd>${esc(window.F.yieldKind(o.yieldKind))}</dd>
      <dt>Committed for</dt><dd>${esc(window.F.term(o))}${o.term?.maturity ? ` · matures ${window.F.date(o.term.maturity)}` : ''}</dd>
      <dt>Getting out</dt><dd>${esc(window.F.liquidity(o.liquidity))}${o.term?.earlyExitPenalty ? ` · ${esc(o.term.earlyExitPenalty)}` : ''}</dd>
      ${window.F.duration(o) ? `<dt>Rate sensitivity</dt><dd>${esc(window.F.duration(o))} of duration</dd>` : ''}
      <dt>Protection</dt><dd>${esc(window.F.insurance(o.risk?.insurance))}</dd>
      <dt>Tax treatment</dt><dd>${esc(window.F.taxTreatment(o.taxTreatment))}</dd>
      ${Number.isFinite(o.minInvestment) ? `<dt>Minimum</dt><dd>${window.F.money(o.minInvestment, { dp: 2 })}</dd>` : ''}
      ${Number.isFinite(o.maxInvestment) ? `<dt>Cap</dt><dd>${window.F.money(o.maxInvestment)}</dd>` : ''}
      <dt>Rate as of</dt><dd>${window.F.date(o.dataAsOf)} <span style="color:var(--text-faint)">(${window.F.ago(o.dataAsOf)})</span></dd>
    </dl>
    ${(o.requirements || []).length ? `<div class="infobox" style="margin-top:10px"><b>Requirements:</b> ${o.requirements.map(esc).join(' · ')}</div>` : ''}
  </div>` : ''}

  ${detail.series?.length > 1 ? `<div class="dsection"><h4>Rate history you have recorded</h4>${sparkline(detail.series)}</div>` : ''}

  ${o.notes ? `<div class="dsection"><div class="infobox">${esc(o.notes)}</div></div>` : ''}

  ${(o.vehicles || []).length ? `<div class="dsection">
    <h4>How you would play it</h4>
    ${o.vehicles.map((v) => `<div class="vehrow ${v.viable === false ? 'reach-no' : ''}">
      <span class="vmark" style="color:${v.viable === false ? 'var(--text-faint)' : 'var(--pos)'}">${v.viable === false ? '✕' : '✓'}</span>
      <span class="vbody">
        <span class="vtop">
          <span class="vlbl">${esc(v.label)}</span>
          <span class="vgoal">${esc(v.goal)}</span>
          ${Number.isFinite(v.capitalNeeded) ? `<span class="vcap">needs ${esc(window.F.money(v.capitalNeeded))}</span>` : ''}
        </span>
        <span class="vwhat">${esc(v.what)}</span>
        ${(v.requires || []).length ? `<span class="vwhat" style="color:var(--text-faint)">Needs: ${v.requires.map(esc).join(' · ')}</span>` : ''}
      </span>
    </div>`).join('')}
    ${o.vehiclesOutOfReach ? `<div class="sectionnote">${o.vehiclesOutOfReach} of these need more capital than the amount you have set. They are shown rather than hidden, because knowing a covered call needs 100 shares is useful information.</div>` : ''}
  </div>` : ''}

  <div class="dsection">
    <h4>How to buy it</h4>
    <div class="infobox">${esc(o.accessNotes || 'No access notes recorded for this one.')}</div>
    <div style="display:flex;gap:7px;margin-top:11px;flex-wrap:wrap">
      ${o.url ? `<button class="btn sm" data-act="open" data-url="${esc(o.url)}">Open source ↗</button>` : ''}
      ${o.measured === false ? `<button class="btn sm" data-act="measure" data-id="${esc(o.id)}">Measure this now</button>` : ''}
      <button class="btn sm" data-act="alert" data-id="${esc(o.id)}">Alert me</button>
      <button class="btn ghost sm" data-act="dismiss" data-id="${esc(o.id)}">Never show again</button>
    </div>
  </div>`;
};


/* ═══════════════════════════════════════════════════════════════ signals ══ */

const SIGNAL_LABELS = {
  coil: 'Compression', quiet_accumulation: 'Quiet accumulation', range_compression: 'Tight range',
  extension: 'Stretched', squeeze: 'Squeeze mechanics', catalyst: 'Dated catalyst', unlock: 'Token unlock',
};
const SIGNAL_HELP = {
  coil: 'coil', quiet_accumulation: 'quietAccumulation', range_compression: 'coil',
  extension: 'volatility', squeeze: 'squeeze', catalyst: 'catalyst', unlock: 'unlock',
};

/**
 * The signals view, as a pure function of its payload.
 *
 * Kept here rather than in app.js so it can be tested in plain Node without an
 * Electron window. That is not tidiness: the populated layout cannot appear
 * offline — every bundled chart is drawn rather than recorded, and no signal
 * can honestly be read off one — so without this the first time the card
 * rendering ever ran would be on somebody's machine after their first refresh.
 */
R.signalsView = (d) => {
  const cal = d.calibration;
  const c = d.counts;

  const banner = cal
    ? `<div class="calbanner ok">
        <b>Calibrated.</b> Measured on ${cal.universe} symbols over ${cal.years} years, out of sample.
        Base rate ${(cal.baseRate * 100).toFixed(1)}% across ${cal.bars} independent observations.
        Validated: ${cal.validated.length ? cal.validated.map((k) => esc(SIGNAL_LABELS[k] || k)).join(', ') : '<i>none — see the table below</i>'}.
        ${cal.failed.length ? `Failed and given zero weight: ${cal.failed.map((k) => esc(SIGNAL_LABELS[k] || k)).join(', ')}.` : ''}
        <span class="calwhen">Run ${window.F.ago(cal.generatedAt)}</span>
      </div>`
    : `<div class="calbanner warn">
        <b>Uncalibrated — this is a ranking, not a probability.</b>
        Nothing here has been checked against what actually happened next, so the ORDER is meaningful and the
        NUMBER is not. To measure it against real history, quit and run
        <code>npm run backtest</code> — it fetches five years of daily data, scores every detector out of sample
        against the base rate, and gives failing signals zero weight rather than keeping them because they sound
        plausible. ${window.helpChip ? window.helpChip('calibration') : ''}
      </div>`;

  const evidence = (f) => `<li class="sigline">
    <span class="signame">${esc(SIGNAL_LABELS[f.key] || f.key)}${window.helpChip && SIGNAL_HELP[f.key] ? window.helpChip(SIGNAL_HELP[f.key]) : ''}</span>
    <span class="sigbar"><i style="width:${Math.round((f.strength || 0) * 100)}%"></i></span>
    <span class="sigwhy">${(f.evidence || []).map(esc).join(' ')}</span>
  </li>`;

  const card = (o) => `<section class="sigcard" data-act="goto" data-id="${esc(o.id)}">
    <header>
      <span class="pnum" style="--p:${o.pressure}">${o.pressure}</span>
      <span class="sighead">
        <span class="signm">${esc(o.name)}${o.symbol ? ` <b>${esc(o.symbol)}</b>` : ''}</span>
        <span class="sigsub">
          ${o.grade ? `<span class="grade" style="color:${esc(o.gradeColor || 'var(--text-dim)')};background:${esc((o.gradeColor || '#888') + '18')}">${esc(o.grade)}</span>` : ''}
          ${o.expected ? `${esc(window.F.pct(Math.abs(o.expected.typicalPct ?? 0), 1))} would be a normal move` : ''}
          ${o.catalyst ? ` · ${esc(o.catalyst.label)} ${esc(window.CATALYST_WHEN(o.catalyst.daysAway))}` : ''}
        </span>
      </span>
      ${o.series?.length ? window.R.sparkline(o.series, 90, 28, o.seriesBasis) : ''}
      <span class="siglean ${esc(o.lean.direction)}">
        ${o.lean.direction === 'none' ? 'no direction' : o.lean.direction === 'up' ? '▲ leans up' : '▼ leans down'}
      </span>
    </header>
    <ul class="siglines">${o.fired.map(evidence).join('')}</ul>
    ${o.lean.direction === 'none'
    ? `<div class="signote">${esc(o.lean.why)}</div>`
    : `<div class="signote lean">${esc(o.lean.why)}</div>`}
    ${o.missing.length ? `<div class="sigmissing">Not measured for this row: ${o.missing.slice(0, 3).map(esc).join('; ')}.</div>` : ''}
  </section>`;

  return `<div class="wrap">
    <h2>What is about to do something</h2>
    <p class="lead">Direction is not forecastable, and anything claiming otherwise is selling something. Size is a
      different question, and it is the one worth asking — but only the detectors that have actually beaten their
      own base rate get a vote here ${window.helpChip ? window.helpChip('pressure') : ''}. On the last real
      measurement that meant <b>stretched</b> at 1.43x lift, while <b>compression</b> and <b>tight range</b> failed
      outright and were given zero weight: the widely repeated idea that a quiet stock is coiled for a move did not
      survive contact with 101 symbols over five years. Every row shows its evidence so you can disagree with it.</p>

    ${banner}

    ${c.readable === 0 ? `<div class="infobox err" style="margin-top:14px">
      <b>No row has recorded price history yet.</b> ${c.unreadable} rows carry a chart drawn from their own
      statistics rather than real closes, and a compression signal read off a curve generated from a volatility
      number would just be that number handed back as evidence.
      ${window.helpChip ? window.helpChip('illustrative') : ''}
      ${(() => {
    const g = d.diagnosis;
    if (!g) return '';
    if (!g.everScanned || g.offline) {
      return '<div class="diagline">Nothing has been fetched yet this session. Press <b>Refresh</b> in the '
            + 'top right and wait for it to finish.</div>';
    }
    const rows = (g.sources || []).map((sfc) => `<div class="diagline">
          <b>${esc(sfc.label)}</b> — ${esc(sfc.status)}, ${sfc.rows} rows.
          ${sfc.problem ? `<span class="diagerr">${esc(String(sfc.problem).slice(0, 200))}</span>`
    : sfc.status === 'ok' ? 'Answered, but returned no usable price history for these rows.' : ''}
        </div>`).join('');
    return `<div class="diagbox">
          <div class="diagline">A scan DID run${g.scannedAt ? ` ${esc(window.F.ago(g.scannedAt))}` : ''}, so
            pressing Refresh again will not change this. Here is what the price sources actually did:</div>
          ${rows}
          <div class="diagline">Run <code>npm run doctor</code> in the project folder — it names the exact
            HTTP status and what each provider said, which is what this needs to be fixed.</div>
        </div>`;
  })()}
    </div>` : `
      <div class="sigmeta">${c.firing} of ${c.readable} measured rows are firing at least one signal.
        ${c.unreadable ? `${c.unreadable} more have no recorded history yet and are excluded.` : ''}</div>
      <div class="siggrid">${d.rows.map(card).join('')}</div>`}

    ${cal ? `<section style="margin-top:26px"><h3>What was measured</h3>
      <div class="sectionnote">${esc(cal.definition)}. A verdict of <b>failed</b> is a real result: it means the
        detector does not work, and it is given zero weight rather than kept because it sounded plausible.</div>
      <table class="caltable">
        <thead><tr><th>Signal</th><th>Verdict</th><th class="num">Fired</th><th class="num">Hit rate</th>
          <th class="num">Base rate</th><th class="num">Lift ${window.helpChip ? window.helpChip('lift') : ''}</th><th class="num">Weight</th></tr></thead>
        <tbody>${(cal.scores || []).map((sc) => `<tr>
          <td>${esc(SIGNAL_LABELS[sc.key] || sc.key)}</td>
          <td><span class="verdict v-${esc(sc.verdict)}">${esc(sc.verdict)}</span></td>
          <td class="num">${sc.fires}</td>
          <td class="num">${(sc.hitRate * 100).toFixed(1)}%</td>
          <td class="num">${(sc.baseRate * 100).toFixed(1)}%</td>
          <td class="num">${Number.isFinite(sc.lift) ? sc.lift.toFixed(2) : '—'}</td>
          <td class="num">${(cal.weights?.[sc.key] ?? 0).toFixed(2)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </section>` : ''}
  </div>`;
};

R.SIGNAL_LABELS = SIGNAL_LABELS;


/**
 * What to actually expect, as a band rather than a number.
 *
 * A single figure invites you to plan on that figure. The bad end is the one
 * that decides whether you can hold on, so it gets equal billing, and the kind
 * of uncertainty is named — losing rate and losing principal are different
 * things and putting both in a column headed "yield" is what makes them look
 * comparable.
 */
R.expectations = (e) => {
  if (!e) return '';
  const money = window.F.money;
  const pc = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

  const inc = e.income;
  const mv = e.movement;

  const row = (label, key, tone) => {
    const p = inc.pct[key];
    const d = inc.dollars?.[key];
    return `<div class="exprow ${tone}">
      <span class="expl">${esc(label)}</span>
      <span class="expp">${esc(pc(p))}</span>
      <span class="expd">${d === undefined || d === null ? '' : esc(`${d >= 0 ? '+' : '−'}${money(Math.abs(d), { dp: 0 })}`)}</span>
    </div>`;
  };

  return `<div class="dsection">
    <h4>What to expect${window.helpChip ? window.helpChip('expectedMove') : ''}</h4>
    ${inc ? `
      <div class="exphead ${inc.kind === 'principal' ? 'risky' : ''}">${esc(inc.headline)}</div>
      <div class="expband">
        ${row('A good year', 'good', 'good')}
        ${row('Typical', 'typical', 'typ')}
        ${row('A bad year', 'bad', 'bad')}
        ${row('The bad case that is not supposed to happen', 'tail', 'tail')}
      </div>
      ${inc.unbounded ? `<div class="expwarn">${esc(inc.unbounded)}</div>` : ''}
      <div class="expassume">${inc.assumptions.map(esc).join(' ')}</div>` : ''}
    ${mv ? `
      <div class="exphead" style="margin-top:${inc ? '14px' : '0'}">${esc(mv.headline)}</div>
      <div class="expband">
        ${mv.bands.map((b) => `<div class="exprow">
          <span class="expl">${esc(b.label)}</span>
          <span class="expp">±${(b.pct * 100).toFixed(1)}%</span>
          <span class="expd">${esc(b.odds)}</span>
        </div>`).join('')}
        ${Number.isFinite(mv.worstOnRecord) ? `<div class="exprow tail">
          <span class="expl">Worst on record</span>
          <span class="expp">${(mv.worstOnRecord * 100).toFixed(0)}%</span>
          <span class="expd">it has actually happened</span>
        </div>` : ''}
      </div>
      <div class="expassume">${mv.assumptions.map(esc).join(' ')} <b>${esc(mv.direction)}</b></div>` : ''}
  </div>`;
};


/* ═════════════════════════════════════════════════════════════ onboarding ══ */

/**
 * First run.
 *
 * Four questions, all skippable, chosen because each one materially changes
 * what the app shows rather than because a form felt like the done thing. Tax
 * bracket in particular reorders the entire income list — a Treasury and a
 * savings account swap places depending on the state you live in — so an app
 * that never asks is quietly showing everyone the answer for somebody else.
 *
 * The amount is offered and explicitly not required. Most people opening this
 * for the first time do not have a number in mind, and demanding one before
 * showing anything is how a tool loses someone in the first thirty seconds.
 */
R.ONBOARD_STEPS = ['welcome', 'money', 'tax', 'appetite', 'done'];

R.onboard = (step, draft, ctx) => {
  const i = Math.max(0, R.ONBOARD_STEPS.indexOf(step));
  const dots = R.ONBOARD_STEPS.map((k, n) =>
    `<i class="${n === i ? 'on' : n < i ? 'past' : ''}"></i>`).join('');

  const shell = (title, body, { back = true, next = 'Continue', skip = true } = {}) => `
    <div class="obcard">
      <div class="obdots">${dots}</div>
      <h2>${title}</h2>
      ${body}
      <div class="obnav">
        ${back && i > 0 ? '<button class="btn ghost" data-act="ob-back">Back</button>' : '<span></span>'}
        <span class="spacer"></span>
        ${skip ? '<button class="btn ghost" data-act="ob-skip">Skip setup</button>' : ''}
        <button class="btn primary" data-act="ob-next">${esc(next)}</button>
      </div>
    </div>`;

  if (step === 'welcome') {
    return shell('Before you start', `
      <p class="oblead">This finds places to put money and things that are about to move, and it is blunt about
        which of those it can actually know.</p>
      <ul class="oblist">
        <li><b>It will not tell you which way anything is going.</b> Direction is not forecastable and anything
          claiming otherwise is selling something. What it can do is spot the conditions that come before a large
          move, and say how confident it is.</li>
        <li><b>Nothing leaves your machine.</b> No account, no telemetry. Your tax bracket and amount live in a
          file on this computer.</li>
        <li><b>Every number can be wrong.</b> Rates come from public feeds and go stale. Verify with the provider
          before moving money.</li>
      </ul>
      <p class="obnote">Four short questions. All of them skippable, all changeable later in Settings.</p>`,
    { back: false, next: 'Start' });
  }

  if (step === 'money') {
    return shell('How much are you working with?', `
      <p class="oblead">Optional. Without it you get rates; with it you get dollars, and offers with a cap get
        ranked on what they are actually worth to you rather than on a headline they cannot pay on your money.</p>
      <div class="obfield">
        <span class="amtwrap big"><i>$</i><input id="ob-amount" type="text" inputmode="numeric"
          placeholder="leave empty for rates" value="${draft.budget ? Number(draft.budget).toLocaleString() : ''}" /></span>
      </div>
      <p class="obnote">You can change this any time from the box above the list. There is no wrong answer here,
        including no answer.</p>`);
  }

  if (step === 'tax') {
    const states = Object.keys(ctx.constants.STATE_TOP_RATES || {}).sort();
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
    return shell('Where are you taxed?', `
      <p class="oblead">This one genuinely reorders the list. A Treasury escapes state tax and a savings account
        does not, so in a high-tax state a lower headline rate can be the better deal — and an app that never asks
        is showing you somebody else's answer.</p>
      <div class="obgrid">
        <label>State
          <select id="ob-state">${states.map((v) =>
    opt(v, draft.state, `${v} — ${ctx.constants.STATE_TOP_RATES[v]}%`)).join('')}</select></label>
        <label>Federal bracket
          <select id="ob-fed">${(ctx.constants.FEDERAL_ORDINARY_BRACKETS || []).map((b) =>
    opt(b, draft.federalOrdinary, `${b}%`)).join('')}</select></label>
        <label>Account this is for
          <select id="ob-account">
            ${opt('taxable', draft.accountType, 'A normal taxable account')}
            ${opt('traditional', draft.accountType, 'Traditional IRA or 401(k)')}
            ${opt('roth', draft.accountType, 'Roth')}
          </select></label>
      </div>
      <p class="obnote">Not sure of your bracket? The default is the one most people are in. It is a starting
        point, not a commitment.</p>`);
  }

  if (step === 'appetite') {
    return shell('How much can go wrong?', `
      <p class="oblead">This sets how hard the ranking punishes uncertainty. It is not a personality test — it
        changes which row comes first, and the difference is large.</p>
      <div class="obchoices">
        ${[
    { v: 15, t: 'I cannot lose this', d: 'Insured deposits and government paper first. Almost nothing that can fall.' },
    { v: 45, t: 'Careful', d: 'Mostly safe, some things that can wobble if they pay properly for it.' },
    { v: 70, t: 'Comfortable with a bad year', d: 'Funds and credit that can drop meaningfully and usually recover.' },
    { v: 92, t: 'Swing for the fences', d: 'Everything, including things that can go to zero. You accept that.' },
  ].map((c) => `<button class="obchoice ${draft.riskAppetite === c.v ? 'on' : ''}" data-act="ob-appetite" data-val="${c.v}">
          <b>${esc(c.t)}</b><span>${esc(c.d)}</span>
        </button>`).join('')}
      </div>`);
  }

  return shell('That is the setup', `
    <p class="oblead">Four things worth knowing, and then you are done.</p>
    <ul class="oblist">
      <li><b>Learn</b> explains every term in the app in plain English. Anywhere you see a
        <span class="helpq" style="pointer-events:none">?</span>, it opens the same explanation in place.</li>
      <li><b>Signals</b> is what is showing the conditions that come before a large move. It says
        "uncalibrated" until you have measured it against real history, and it means it.</li>
      <li><b>Plan</b> turns the list into an order of operations, which is a different question from what pays most.</li>
      <li><b>Search anything</b> with ${esc(ctx.platform === 'darwin' ? '⌘K' : 'Ctrl+K')} — there are thousands of
        rows and the fastest way to a specific one is to type its name.</li>
    </ul>
    <p class="obnote">Hit <b>Refresh</b> when you are in: everything starts from bundled data until you do.</p>`,
  { next: 'Open it', skip: false });
};


/**
 * One thing with a clock on it.
 *
 * Deliberately renders an expiring offer and a dated deadline identically apart
 * from a type marker: to someone deciding what to do this week the difference
 * between "this bonus ends Friday" and "you cannot harvest losses after
 * Friday" is not worth a separate view.
 */
R.clockItem = (x) => {
  const d = Math.round(x.daysLeft);
  const col = d <= 3 ? 'var(--neg)' : d <= 14 ? 'var(--warn)' : 'var(--text-dim)';
  const bg = d <= 3 ? 'var(--neg-soft)' : d <= 14 ? 'var(--warn-soft)' : 'var(--panel-3)';
  const when = d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `${d} days`;
  const act = x.type === 'event'
    ? 'data-act="goto-view" data-val="events"'
    : `data-act="goto" data-id="${esc(x.id)}"`;
  return `<li class="ritem" ${act}>
    <span class="clocktype ${x.type === 'event' ? 'ev' : 'op'}" title="${x.type === 'event' ? 'A dated deadline' : 'An offer that expires'}">${x.type === 'event' ? '◷' : '★'}</span>
    <span class="body">
      <span class="nm">${esc(x.name)}</span>
      <span class="sub">${esc(x.sub || '')}</span>
    </span>
    <span class="val">
      <span class="countdown" style="color:${col};background:${bg}">${esc(when)}</span>
      ${Number.isFinite(x.value) ? `<span class="u">${esc(window.F.money(x.value, { dp: 0 }))}</span>` : ''}
    </span>
  </li>`;
};


/**
 * The plain read, before any of the panels.
 *
 * Deliberately the first thing in the drawer. Everything below it is true and
 * none of it is an answer — a grade, five axes, a band, some flags — and asking
 * somebody to assemble "is this worth doing and what am I risking" out of six
 * boxes, for every row, is how a tool ends up being used for its sort order
 * only.
 */
R.verdict = (v) => {
  if (!v) return '';
  const tone = { high: 'bad', medium: 'warn', low: 'ok' }[v.risk?.severity] || 'warn';
  return `<div class="dsection verdict">
    <div class="vhead">${esc(v.headline)}</div>
    ${(v.theCase || []).length ? `<ul class="vcase">${v.theCase.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div class="vrisk ${tone}">
      <span class="vlabel">The main risk</span>
      <span>${esc(v.risk?.text || '')}</span>
    </div>
    <div class="vfor">
      <div><span class="vlabel">Best for</span> ${esc(v.bestFor || '')}</div>
      <div><span class="vlabel not">Not for</span> ${esc(v.notFor || '')}</div>
    </div>
    ${(v.changesIt || []).length ? `<div class="vchange">
      <span class="vlabel">What would change this</span>
      <ul>${v.changesIt.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    </div>` : ''}
  </div>`;
};

R.kindLabel = kindLabel;
R.radarEventItem = radarEventItem;

window.R = R;
}());
