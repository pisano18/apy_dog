(function () {
'use strict';

/* Pure-ish render functions: state in, HTML string out. Everything user-facing
   that came from a third-party feed goes through esc() — pool names, fund names
   and filing titles are all attacker-controllable strings. */

const R = {};
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
  const h = m.heat;
  const col = h >= 70 ? 'var(--neg)' : h >= 45 ? 'var(--brand)' : h >= 25 ? 'var(--warn)' : 'var(--text-faint)';
  return `<span class="heat" title="How much is likely to happen here soon. Not a prediction of direction.">
    <span class="v" style="color:${col}">${Math.round(h)}</span>
    <span class="bar"><i style="width:${Math.min(100, h)}%;background:${col}"></i></span>
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
    o.denomination === 'crypto' ? `<span class="badge cryp" title="Principal and yield are in ${esc(o.symbol || 'a volatile crypto asset')}, not dollars.">in ${esc((o.symbol || 'crypto').split('-')[0])}</span>` : '',
  ].filter(Boolean).join('');
}

function nameCell(o, classes) {
  const meta = [classes[o.assetClass] || o.assetClass, o.provider || o.chain || o.sourceLabel]
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="cell-name">
    <span class="n">${esc(o.name)}${o.symbol && !o.name.includes(o.symbol) ? ` <span style="color:var(--text-faint);font-weight:500">${esc(o.symbol)}</span>` : ''}</span>
    <span class="m"><span class="mt">${meta}</span>${badges(o)}</span>
  </div>`;
}

function apyCell(o) {
  const spec = o.yieldKind === 'expected';
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
  { key: 'apy', label: 'Yield', sort: 'apy', num: true },
  { key: 'aftertax', label: 'After tax', sort: 'afterTax', num: true },
  { key: 'income', label: 'Income yr 1', sort: null, num: true },
  { key: 'grade', label: 'Safety', sort: 'grade' },
  { key: 'axes', label: 'Principal · Payout · Exit', sort: null },
  { key: 'term', label: 'Committed', sort: 'term' },
  { key: 'entry', label: 'Min', sort: 'minInvestment', num: true },
  { key: 'flags', label: 'Flags', sort: 'trap' },
];

R.MOVEMENT_COLUMNS = [
  { key: 'watch', label: '', width: 26 },
  { key: 'name', label: 'Ticker', sort: 'name' },
  { key: 'heat', label: 'Heat', sort: 'heat', num: true },
  { key: 'setup', label: 'Setup', sort: null },
  { key: 'catalyst', label: 'Next catalyst', sort: 'soonest' },
  { key: 'severity', label: 'If it moves', sort: 'biggestMove' },
  { key: 'lean', label: 'Lean', sort: null },
  { key: 'clarity', label: 'Clarity', sort: 'clarity' },
  { key: 'grade', label: 'Safety', sort: 'grade' },
  { key: 'price', label: 'Price', sort: 'price', num: true },
];

function incomeRow(o, ctx) {
  const a = o.rating?.axes || {};
  return `
    <td><span class="star ${ctx.watched ? 'on' : ''}" data-act="watch" data-id="${esc(o.id)}">${ctx.watched ? '★' : '☆'}</span></td>
    <td>${nameCell(o, ctx.classes)}</td>
    ${apyCell(o)}
    <td class="num" title="After your tax settings">${window.F.pct(o.tax?.afterTaxApy, 2)} ${trend(ctx.change)}</td>
    <td class="num" style="color:var(--pos)">${Number.isFinite(o.scores?.incomeYear1) ? window.F.money(o.scores.incomeYear1, { dp: 0 }) : '—'}</td>
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
      ${esc(c.label)}${sorted ? `<span class="arrow">${ctx.sortDir === 'asc' ? '▲' : '▼'}</span>` : ''}
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
      <span>${esc(ctx.classes[o.assetClass] || o.assetClass)}</span>
      ${o.symbol ? `<span>· ${esc(o.symbol)}</span>` : ''}
      ${o.chain ? `<span>· ${esc(o.chain)}</span>` : ''}
      <span>· via ${esc(o.sourceLabel || o.source)}</span>
      ${badges(o)}
    </div>
  </div>

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
      <div class="item"><div class="v">${window.F.pct(o.apy?.total, 2)}</div><div class="k">Headline</div></div>
      <div class="item"><div class="v">${window.F.pct(o.tax?.afterTaxApy, 2)}</div><div class="k">After your tax</div></div>
      <div class="item"><div class="v">${window.F.pct(o.tax?.taxEquivalentYield, 2)}</div><div class="k">Tax-equivalent</div></div>
      <div class="item"><div class="v">${window.F.pct(o.tax?.afterTaxRealApy, 2)}</div><div class="k">After inflation</div></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:18px">
      <div><div style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--pos)">${window.F.money(s.incomeYear1, { dp: 0 })}</div><div style="font-size:10px;color:var(--text-faint)">on ${window.F.money(ctx.budget)}, year 1</div></div>
      <div><div style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--pos)">${window.F.money(s.income5yr, { dp: 0 })}</div><div style="font-size:10px;color:var(--text-faint)">over 5 years</div></div>
    </div>
  </div>` : ''}

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

window.R = R;
}());
