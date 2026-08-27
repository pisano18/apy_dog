(function () {
'use strict';

/* App controller. Owns state, wires events, calls into the main process.
   Filtering happens in main (which holds the dataset) but is synchronous and
   cheap there, so every control can re-query on change without feeling laggy. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const { esc } = window.F;

const S = {
  boot: null,
  query: {},
  rows: [],
  facets: null,
  changes: {},
  meta: null,
  health: [],
  events: [],
  watchlist: [],
  selectedId: null,
  detail: null,
  view: 'radar',
  refreshing: false,
  sourcesTotal: 0,
  doneCount: 0,
  editingFilter: null,
  filterSearch: '',
};

/* ---------------------------------------------------------------- helpers -- */

function toast(title, body = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t">${esc(title)}</div>${body ? `<div class="b">${esc(body)}</div>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, kind === 'err' ? 9000 : 5000);
}

function notice(text, actionLabel, onAction) {
  const n = $('#notice');
  $('#notice-text').innerHTML = text;
  const btn = $('#notice-action');
  if (actionLabel) { btn.textContent = actionLabel; btn.hidden = false; btn.onclick = onAction; }
  else btn.hidden = true;
  n.classList.remove('hidden');
}

const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toggleIn(list, val) {
  const i = list.indexOf(val);
  if (i >= 0) list.splice(i, 1); else list.push(val);
  return list;
}

/** Options each multi/select filter draws from, rebuilt as facets change. */
function filterOptions() {
  const f = S.facets || {};
  const c = S.boot.constants;
  const ent = (obj, label) => Object.entries(obj || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => [k, label ? label(k) : k, n]);

  return {
    assetClasses: ent(f.byAssetClass, (k) => c.ASSET_CLASS_LABELS[k] || k),
    sources: ent(f.bySource, (k) => (S.boot.sources.find((s) => s.id === k) || {}).label || k),
    chains: ent(f.byChain),
    setups: ent(f.bySetup, (k) => (c.SETUP_INFO[k] || {}).label || k),
    eventKinds: ent(f.byEventKind, (k) => (c.EVENT_INFO[k] || {}).label || k),
    severities: (c.SEVERITY || []).map((s) => [s.key, s.label]),
    liquidity: Object.values(c.LIQUIDITY).map((v) => [v, window.F.liquidity(v)]),
    termPresets: (c.TERM_PRESETS || []).map((p) => [p.key, p.label]),
    taxTreatments: Object.values(c.TAX_TREATMENT).map((v) => [v, window.F.taxTreatment(v)]),
    trapFlags: Object.keys(c.TRAP_FLAG_TEXT || {}).map((k) => [k, k.replace(/_/g, ' ')]),
  };
}

function renderCtx() {
  return {
    track: S.query.track || 'all',
    classes: S.boot.constants.ASSET_CLASS_LABELS,
    setupInfo: S.boot.constants.SETUP_INFO,
    sourceLabels: Object.fromEntries(S.boot.sources.map((s) => [s.id, s.label])),
    termPresets: S.boot.constants.TERM_PRESETS,
    options: filterOptions(),
    budget: S.boot.settings.budget ?? 10000,
    watchlist: S.watchlist,
    changes: S.changes,
    selectedId: S.selectedId,
    sortBy: S.query.sortBy,
    sortDir: S.query.sortDir,
    facets: S.facets,
  };
}

/* ------------------------------------------------------------------ data -- */

async function runQuery() {
  try {
    const res = await window.apy.query(S.query);
    S.rows = res.rows;
    S.facets = res.facets;
    S.changes = res.changes || {};
    S.meta = res.meta;
    const ctx = renderCtx();
    $('#tablewrap').innerHTML = window.R.table(S.rows, ctx);
    $('#filterbar').innerHTML = window.R.filterBar(S.query, ctx);
    // A dollar figure computed on a reference amount must never be mistaken for
    // one computed on the reader's own money, so the asterisk that marks them
    // gets a legend rather than being left to guess at.
    const usingReference = !S.boot.settings?.budget
      && S.rows.some((o) => Number.isFinite(o.scores?.incomeYear1) && !o.scores?.hasBudget);
    $('#res-desc').innerHTML = `<b>${res.total.toLocaleString()}</b> of ${(res.facets?.total ?? 0).toLocaleString()}`
      + (usingReference
        ? ` <span class="reflegend">· dollar figures marked <b>*</b> are on a reference $10,000 —
            <a href="#" data-act="goto-view" data-val="settings">set your own amount</a></span>`
        : '');
    const bs = res.facets?.bySection || {};
    $('#n-income').textContent = (bs.income ?? 0).toLocaleString();
    $('#n-movement').textContent = (bs.movement ?? 0).toLocaleString();
    $('#n-deals').textContent = (bs.deals ?? 0).toLocaleString();
    $('#n-all').textContent = (res.facets?.total ?? 0).toLocaleString();
  } catch (err) {
    toast('Query failed', err.message, 'err');
  }
}

async function refresh(offline = false) {
  if (S.refreshing) return;
  S.refreshing = true;
  $('#btn-refresh').disabled = true;
  $('#refresh-label').textContent = 'Scanning…';
  $('#progress').classList.remove('hidden');
  try {
    const r = await window.apy.refresh({ offline });
    if (!r.ok) toast('Scan had a problem', r.reason, 'warn');
  } catch (err) {
    toast('Scan failed', err.message, 'err');
  } finally {
    S.refreshing = false;
    $('#btn-refresh').disabled = false;
    $('#refresh-label').textContent = 'Refresh';
    $('#progress').classList.add('hidden');
    syncLive();
  }
}

/* --------------------------------------------------------------- drawer --- */

async function openDetail(id) {
  S.selectedId = id;
  try { S.detail = await window.apy.detail(id); } catch { S.detail = null; }
  const d = $('#drawer');
  if (!S.detail) { d.classList.add('hidden'); return; }
  d.classList.remove('hidden');
  d.innerHTML = window.R.drawer(S.detail, renderCtx());
  $$('#tablewrap tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
}

function closeDrawer() {
  S.selectedId = null;
  S.detail = null;
  $('#drawer').classList.add('hidden');
  $$('#tablewrap tr.selected').forEach((tr) => tr.classList.remove('selected'));
}

/* ---------------------------------------------------------------- filters -- */

const defFor = (key) => window.FILTER_DEFS.find((d) => d.key === key);

function closePopovers() {
  $('#fmenu').classList.add('hidden');
  $('#fedit').classList.add('hidden');
  S.editingFilter = null;
}

function positionNear(el, anchor) {
  const r = anchor.getBoundingClientRect();
  el.classList.remove('hidden');
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)}px`;
}

function openFilterMenu(anchor) {
  S.filterSearch = '';
  const el = $('#fmenu');
  el.innerHTML = window.R.filterMenu(S.query, renderCtx(), '');
  positionNear(el, anchor);
  const inp = $('#fmenu-search');
  if (inp) inp.focus();
}

function openPresetMenu(anchor) {
  const el = $('#fmenu');
  el.innerHTML = window.R.presetMenu(renderCtx());
  positionNear(el, anchor);
}

function openFilterEditor(key, anchor) {
  const def = defFor(key);
  if (!def) return;
  S.editingFilter = key;
  const el = $('#fedit');
  el.innerHTML = window.R.filterEditor(def, S.query, renderCtx());
  positionNear(el, anchor);
  const first = el.querySelector('input[type="number"], input[type="text"], select');
  if (first) first.focus();
}

/** Give a newly-added filter a sensible starting value so it does something. */
function seedFilterValue(def) {
  const q = S.query;
  const k = def.keys[0];
  if (def.type === 'bool') { q[k] = !def.defaultOn; return; }
  if (def.type === 'multi') { if (!Array.isArray(q[k])) q[k] = []; return; }
  if (def.type === 'select') return;
  if (q[k] === null || q[k] === undefined) {
    const seeds = {
      minApy: 4, maxRisk: 40, minPrincipalAxis: 4, minInvestmentMax: 10000,
      minTvl: 1e8, minHeat: 40, catalystWithinDays: 14, minConfidence: 0.6,
      maxLockupDays: 365, minIncomeYear1: 500,
    };
    if (seeds[k] !== undefined) q[k] = seeds[k];
  }
}

function clearAllFilters() {
  // The section, the sort and the search box are navigation, not filters.
  // Wiping them would dump someone out of Deals and back into all 700 rows,
  // which is the opposite of what "clear my filters" means.
  const { track, sections, sortBy, sortDir, text } = S.query;
  S.query = { ...S.boot.constants.DEFAULT_QUERY, track, sections, sortBy, sortDir, text };
  closePopovers();
  runQuery();
}

function applyPreset(key) {
  const p = window.R.PRESETS.find((x) => x.key === key);
  if (!p) return;
  S.query = { ...S.boot.constants.DEFAULT_QUERY, ...p.q, text: S.query.text };
  if (p.track && p.track !== 'all') S.query.track = p.track;
  syncTrackButtons();
  syncSortOptions();
  closePopovers();
  runQuery();
}

/* ------------------------------------------------------------ track & sort */

function currentSection() {
  const sec = S.query.sections || [];
  if (sec.length === 1) return sec[0];
  return 'all';
}

function applySection(section) {
  if (section === 'all') { S.query.sections = []; S.query.track = 'all'; }
  else { S.query.sections = [section]; S.query.track = section === 'movement' ? 'movement' : 'all'; }
  syncTrackButtons();
  syncSortOptions();
  closePopovers();
  switchView('find');
  runQuery();
}

function syncTrackButtons() {
  const cur = currentSection();
  $$('#trackswitch button').forEach((b) => b.classList.toggle('on', b.dataset.section === cur));
}

const INCOME_SORTS = [
  ['dogScore', 'Best risk-adjusted'], ['apy', 'Highest yield'], ['afterTax', 'Highest after tax'],
  ['taxEquivalent', 'Tax-equivalent'], ['afterTaxReal', 'After inflation'], ['sharpe', 'Return per unit of risk'],
  ['grade', 'Safest first'], ['trap', 'Fewest warnings'], ['term', 'Shortest commitment'],
  ['tvl', 'Largest'], ['minInvestment', 'Lowest minimum'], ['name', 'Name'],
];
const MOVEMENT_SORTS = [
  ['heat', 'Most likely to move'], ['soonest', 'Soonest catalyst'], ['biggestMove', 'Biggest expected move'],
  ['clarity', 'Clearest signal'], ['grade', 'Safest first'], ['price', 'Lowest price'], ['name', 'Name'],
];

const DEAL_SORTS = [
  ['dogScore', 'Best value'], ['closingSoon', 'Closing soonest'], ['leastEffort', 'Least work'],
  ['obscurity', 'Least known'], ['apy', 'Highest annualised'], ['minInvestment', 'Lowest entry'], ['name', 'Name'],
];

function syncSortOptions() {
  const sec = currentSection();
  const list = sec === 'movement' ? MOVEMENT_SORTS : sec === 'deals' ? DEAL_SORTS : INCOME_SORTS;
  const valid = list.some(([v]) => v === S.query.sortBy);
  if (!valid) S.query.sortBy = list[0][0];
  $('#q-sort').innerHTML = list.map(([v, l]) => `<option value="${v}"${S.query.sortBy === v ? ' selected' : ''}>${l}</option>`).join('');
}

/* ------------------------------------------------------------ other views - */

async function renderRadar() {
  let d;
  try { d = await window.apy.radar(); } catch (err) { toast('Could not build the digest', err.message, 'err'); return; }
  const money = window.F.money;
  const pct = window.F.pct;
  const hasBudget = !!d.budget;

  // Each card picks the value that actually matters for its shelf. Showing a
  // yield next to a referral bonus, or a heat score next to a CD, is how the
  // old flat table became unreadable.
  const yieldVal = (o) => (hasBudget && Number.isFinite(o.scores?.incomeYear1)
    ? `${money(o.scores.incomeYear1, { dp: 0 })}<span class="u">year 1</span>`
    : `${pct(o.apy?.total, 2)}<span class="u">a year</span>`);
  const heatVal = (o) => {
    const m = o.movement || {};
    return `${Math.round(m.heat ?? 0)}<span class="u">${esc(m.heatLabel || '')}</span>`;
  };
  const dealVal = (o) => (hasBudget && Number.isFinite(o.scores?.incomeYear1)
    ? `${money(o.scores.incomeYear1, { dp: 0 })}<span class="u">to you</span>`
    : `${pct(o.apy?.total, 1)}<span class="u">annualised</span>`);

  const classOf = (o) => window.R.kindLabel(o, S.boot.constants.ASSET_CLASS_LABELS);
  const effortOf = (o) => (S.boot.constants.EFFORT_INFO?.[o.effort]?.label || '');
  const sub = {
    plain: (o) => `${classOf(o)} · ${o.rating?.grade || ''}`,
    withEffort: (o) => [classOf(o), effortOf(o), o.provider].filter(Boolean).join(' · '),
    withCatalyst: (o) => {
      const e = o.movement?.catalyst?.event;
      return e ? `${e.label} ${window.CATALYST_WHEN(e.daysAway)}` : (o.movement?.setupLabel || classOf(o));
    },
    withCountdown: (o) => [effortOf(o), o.provider || classOf(o)].filter(Boolean).join(' · '),
  };

  const g = d.groups;
  const cards = [];
  const card = (icon, title, blurb, group, valueFn, subFn, emptyText) => {
    if (!group) return;
    cards.push(window.R.radarCard({
      icon, title, blurb, rows: group.rows, count: group.count, query: group.query, valueFn, subFn, emptyText,
    }));
  };

  card('⏳', 'Closing soon', 'Windows that shut. The one thing a sorted table can never show you.',
    g.closing, (o) => window.R.countdownChip(o), sub.withCountdown,
    'Nothing with a published deadline right now.');
  // Built from the calendar rather than from rows, because most of what is
  // scheduled in a week belongs to no ticker.
  cards.push(window.R.radarCard({
    icon: '◈',
    title: 'Happening this week',
    blurb: 'Everything dated inside seven days, whether or not you hold it.',
    items: (d.weekEvents || []).map((e) => window.R.radarEventItem(e)),
    count: d.weekEventCount || 0,
    view: 'events',
    emptyText: 'Nothing scheduled in the next seven days.',
  }));
  card('★', 'Best deals', 'Bounded money. Usually the highest return per dollar in the app, and always capped.',
    g.deals, dealVal, sub.withEffort, 'No deals loaded.');
  card('◆', 'Best income', hasBudget ? 'Ranked by what it pays you on your amount.' : 'Ranked risk-adjusted, after tax.',
    g.income, yieldVal, sub.plain, 'No income rows.');
  card('⚡', 'Least work, real money', 'Deals you can take without chasing anyone.',
    g.easy, dealVal, sub.withEffort, 'Nothing that is both easy and worthwhile.');
  card('◇', 'Few people know', 'Obscure and niche. Uncrowded, and worth more scrutiny for the same reason.',
    g.obscure, yieldVal, sub.withEffort, 'Nothing flagged as obscure yet.');
  card('◈', 'Moving most', 'Highest heat. Not a direction call.',
    g.movement, heatVal, sub.withCatalyst, 'Nothing measured.');
  if (g.watching?.count) {
    card('★', 'You are watching', '', g.watching,
      (o) => (o.section === 'movement' ? heatVal(o) : yieldVal(o)), sub.plain, '');
  }

  $('#view-radar').innerHTML = window.R.radar({ cards, meta: d.meta, budget: d.budget }, renderCtx());
}

function renderEvents() {
  const upcoming = S.events.filter((e) => !e.past).sort((a, b) => a.dateMs - b.dateMs);
  const past = S.events.filter((e) => e.past).sort((a, b) => b.dateMs - a.dateMs);
  const byWeek = {};
  for (const e of upcoming.slice(0, 200)) {
    const wk = e.daysAway <= 7 ? 'This week' : e.daysAway <= 14 ? 'Next week' : e.daysAway <= 31 ? 'This month' : 'Later';
    (byWeek[wk] = byWeek[wk] || []).push(e);
  }

  $('#view-events').innerHTML = `<div class="wrap">
    <h2>Calendar</h2>
    <p class="lead">Dated events that can move what you hold. Nothing here predicts direction — it tells you when
      something is scheduled to happen and roughly how much this kind of event usually moves things.</p>
    ${S.events.length === 0 ? `<div class="infobox">No events loaded. The calendar and filings sources supply these —
      check <a href="#" data-act="goto-view" data-val="sources">Sources</a> to see whether they connected.</div>` : ''}
    ${['This week', 'Next week', 'This month', 'Later'].filter((k) => byWeek[k]).map((k) => `
      <section><h3>${k} <span style="color:var(--text-faint);font-weight:500">${byWeek[k].length}</span></h3>
        ${byWeek[k].map((e) => window.R.eventRow(e)).join('')}
      </section>`).join('')}
    ${past.length ? `<section><h3>Recently filed</h3>${past.slice(0, 40).map((e) => window.R.eventRow(e)).join('')}</section>` : ''}
  </div>`;
}

async function renderWatchlist() {
  let rows = [];
  try {
    const res = await window.apy.query({ ...S.boot.constants.DEFAULT_QUERY, track: 'all', watchlistOnly: true, hideTraps: false, includeSpeculative: true });
    rows = res.rows;
  } catch { /* fall through to an empty list */ }
  const entries = S.boot.watchlist || [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  $('#view-watch').innerHTML = `<div class="wrap">
    <h2>Watchlist</h2>
    <p class="lead">What you are tracking. Every scan records these, so the longer something sits here the more you
      actually know about whether its rate holds or its setup resolves.</p>
    ${entries.length === 0
    ? '<div class="infobox">Nothing here yet. Click the ☆ next to anything to track it.</div>'
    : `<section><div class="statgrid">${entries.map((w) => {
      const o = byId.get(w.id);
      const ch = S.changes[w.id];
      return `<div class="stat" data-act="goto" data-id="${esc(w.id)}" style="cursor:pointer">
        <div class="v">${o ? (o.track === 'movement' ? `${Math.round(o.movement?.heat ?? 0)}` : window.F.pct(o.apy?.total, 2)) : '—'}
          ${ch && ch.direction !== 'flat' ? `<span class="trend ${ch.direction}" style="font-size:11px">${ch.direction === 'up' ? '▲' : '▼'}${Math.abs(ch.delta).toFixed(2)}</span>` : ''}</div>
        <div class="k">${esc(o?.name || w.name || w.id)}</div>
        ${o?.track === 'movement' ? '<div class="k" style="color:var(--text-faint)">heat</div>' : ''}
        ${!o ? '<div class="k" style="color:var(--warn)">not in the latest scan</div>' : ''}
      </div>`;
    }).join('')}</div></section>`}
    <section><h3>Alerts</h3>
      ${(S.boot.alerts || []).length
    ? S.boot.alerts.map((a) => `<div class="srccard"><div class="info">
        <div class="nm">${esc(a.label || `${String(a.kind).replace(/_/g, ' ')} ${a.threshold}`)}</div>
        <div class="meta">${a.lastFired ? `Last fired ${window.F.ago(a.lastFired)}` : 'Never fired'}</div>
      </div><button class="btn ghost sm" data-act="rm-alert" data-id="${esc(a.id)}">Remove</button></div>`).join('')
    : '<div class="infobox">No alerts set. Open anything and choose “Alert me”.</div>'}
    </section>
    ${rows.length ? `<section><h3>Details</h3><div class="tablewrap">${window.R.table(rows, { ...renderCtx(), track: 'all' })}</div></section>` : ''}
  </div>`;
}

function renderSources() {
  const colour = { ok: 'var(--pos)', partial: 'var(--warn)', offline: 'var(--info)', failed: 'var(--neg)', disabled: 'var(--text-faint)' };
  const word = { ok: 'live', partial: 'partial', offline: 'snapshot', failed: 'failed', disabled: 'off' };
  const m = S.meta || {};
  const enabled = S.boot.settings.enabledSources;

  $('#view-sources').innerHTML = `<div class="wrap">
    <h2>Sources</h2>
    <p class="lead">Where every number came from, and whether it is a live quote or the bundled snapshot that ships
      with the app. If a source says <b>snapshot</b>, refresh before acting on its rates.</p>

    <section><h3>This scan</h3>
      <div class="statgrid">
        <div class="stat"><div class="v">${(m.total ?? 0).toLocaleString()}</div><div class="k">Opportunities</div></div>
        <div class="stat"><div class="v" style="color:var(--pos)">${(m.liveRows ?? 0).toLocaleString()}</div><div class="k">Live</div></div>
        <div class="stat"><div class="v" style="color:var(--warn)">${(m.seedRows ?? 0).toLocaleString()}</div><div class="k">From snapshot</div></div>
        <div class="stat"><div class="v">${(m.upcomingEvents ?? 0).toLocaleString()}</div><div class="k">Upcoming events</div></div>
        <div class="stat"><div class="v">${window.F.pct(m.riskFree, 2)}</div><div class="k">Risk-free rate</div></div>
        <div class="stat"><div class="v">${(m.measured ?? 0).toLocaleString()}</div><div class="k">Measured</div></div>
      </div>
      <div style="margin-top:9px;font-size:11.5px;color:var(--text-faint)">
        Last scan ${m.generatedAt ? window.F.ago(m.generatedAt) : 'never'} · risk-free from ${esc(m.riskFreeSource || 'fallback')}
        · ${m.duplicatesMerged ?? 0} duplicates merged · ${m.invalidDropped ?? 0} dropped as invalid
      </div>
    </section>

    <section><h3>Feeds</h3>
      ${S.health.map((h) => {
    const src = S.boot.sources.find((s) => s.id === h.id) || {};
    const on = enabled === null || enabled === undefined ? src.defaultEnabled !== false : enabled.includes(h.id);
    return `<div class="srccard">
      <span class="dot" style="background:${colour[h.status] || 'var(--text-faint)'}"></span>
      <div class="info">
        <div class="nm">${esc(h.label)} <span class="st" style="color:${colour[h.status]}">${word[h.status] || h.status}</span></div>
        <div class="meta">${esc(src.description || '')}</div>
        <div class="meta">${h.produces === 'events'
          ? `${(h.eventCount || 0).toLocaleString()} dated events`
          : `${h.count.toLocaleString()} rows${h.eventCount ? ` · ${h.eventCount} events` : ''}`}${h.ms ? ` · ${h.ms}ms` : ''}</div>
        ${(h.notes || []).map((n) => `<div class="msg">${esc(n)}</div>`).join('')}
        ${(h.warnings || []).map((w) => `<div class="msg warn">⚠ ${esc(w)}</div>`).join('')}
      </div>
      <label class="check"><input type="checkbox" data-act="source-toggle" data-val="${esc(h.id)}" ${on ? 'checked' : ''} /> on</label>
    </div>`;
  }).join('')}
    </section>

    <section><h3>Your own rates</h3>
      <p class="lead" style="margin-bottom:10px">No free API publishes retail deposit rates or promotional offers, so
        those ship curated. Keep your own current numbers in a JSON file and they are merged over the bundled ones.</p>
      <button class="btn" data-act="open-user-rates">Edit my rates file</button>
    </section>

    <section><h3>Storage</h3>
      <div id="storage-stats" class="statgrid"></div>
      <div style="margin-top:10px"><button class="btn sm" data-act="clear-cache">Clear cache</button></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-faint);user-select:text">Everything stays on this machine: ${esc(S.boot.paths?.userData || '')}</div>
    </section>
  </div>`;

  Promise.all([window.apy.cacheStats(), window.apy.historyStats()]).then(([c, h]) => {
    const el = $('#storage-stats');
    if (!el) return;
    el.innerHTML = `
      <div class="stat"><div class="v">${c.count}</div><div class="k">Cached responses</div></div>
      <div class="stat"><div class="v">${(c.bytes / 1e6).toFixed(1)}MB</div><div class="k">Cache size</div></div>
      <div class="stat"><div class="v">${h.points.toLocaleString()}</div><div class="k">History points</div></div>
      <div class="stat"><div class="v">${h.tracked.toLocaleString()}</div><div class="k">Rates tracked</div></div>`;
  }).catch(() => {});
}

function renderSettings() {
  const st = S.boot.settings;
  const t = st.tax || {};
  const states = Object.keys(S.boot.constants.STATE_TOP_RATES).sort();
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label ?? v)}</option>`;

  $('#view-settings').innerHTML = `<div class="wrap">
    <h2>Settings</h2>
    <p class="lead">Your tax situation and risk appetite change which opportunity is genuinely best, often
      dramatically. Set these honestly and the ranking becomes yours rather than generic.</p>

    <section><h3>Tax</h3>
      <div class="grid3">
        <div class="field"><label>Federal bracket</label>
          <select id="s-fedOrd">${S.boot.constants.FEDERAL_ORDINARY_BRACKETS.map((b) => opt(b, t.federalOrdinary, `${b}%`)).join('')}</select></div>
        <div class="field"><label>Long-term capital gains</label>
          <select id="s-fedLtcg">${S.boot.constants.FEDERAL_LTCG_BRACKETS.map((b) => opt(b, t.federalLtcg, `${b}%`)).join('')}</select></div>
        <div class="field"><label>State</label>
          <select id="s-state">${states.map((v) => opt(v, t.state, `${v} — ${S.boot.constants.STATE_TOP_RATES[v]}%`)).join('')}</select></div>
        <div class="field"><label>Account type</label>
          <select id="s-account">${opt('taxable', t.accountType, 'Taxable')}${opt('traditional', t.accountType, 'Traditional IRA / 401(k)')}${opt('roth', t.accountType, 'Roth')}</select></div>
        <div class="field"><label>Assumed inflation (%)</label><input type="number" id="s-inflation" value="${t.inflation ?? 2.6}" step="0.1" /></div>
        <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" id="s-niit" ${t.niitApplies ? 'checked' : ''} /> Net investment income tax applies</label></div>
      </div>
      <div class="infobox" style="margin-top:12px" id="tax-preview"></div>
    </section>

    <section><h3>Ranking</h3>
      <div class="grid2">
        <div class="field"><label>Risk appetite: <b id="s-appetite-lbl">${st.riskAppetite}</b> / 100</label>
          <input type="range" id="s-appetite" min="0" max="100" step="1" value="${st.riskAppetite}" />
          <span style="font-size:10.5px;color:var(--text-faint)">0 = I cannot lose this. 100 = swing for the fences.</span></div>
        <div class="field"><label>Rank income using</label>
          <select id="s-basis">${opt('gross', st.rankingBasis, 'Headline yield')}${opt('afterTax', st.rankingBasis, 'After tax')}${opt('afterTaxReal', st.rankingBasis, 'After tax and inflation')}</select></div>
        <div class="field"><label>Amount you would deploy ($)</label><input type="number" id="s-budget" value="${st.budget ?? 10000}" step="1000" /></div>
        <div class="field"><label>Movement horizon (days)</label><input type="number" id="s-mhorizon" value="${st.movementHorizonDays ?? 30}" step="7" min="1" />
          <span style="font-size:10.5px;color:var(--text-faint)">Expected-move bands are computed over this window.</span></div>
      </div>
    </section>

    <section><h3>Scanning</h3>
      <div class="grid2">
        <div class="field"><label>Auto-refresh every (minutes, 0 = off)</label><input type="number" id="s-auto" value="${st.autoRefreshMinutes ?? 60}" step="15" min="0" /></div>
        <div class="field"><label>Max DeFi pools</label><input type="number" id="s-maxpools" value="${st.maxDefiPools ?? 4000}" step="500" min="50" /></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-live" ${st.liveUpdates !== false ? 'checked' : ''} /> Live updating</label>
          <span style="font-size:10.5px;color:var(--text-faint)">Each feed refreshes on its own cadence — crypto every minute, the Treasury curve hourly, curated lists daily. Off falls back to one timer.</span></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-launch" ${st.refreshOnLaunch ? 'checked' : ''} /> Refresh when the app opens</label></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-offline" ${st.offlineMode ? 'checked' : ''} /> Offline mode</label></div>
      </div>
    </section>

    <section><h3>Appearance</h3>
      <div class="grid2"><div class="field"><label>Theme</label>
        <select id="s-theme">${opt('system', st.theme, 'Match system')}${opt('dark', st.theme, 'Dark')}${opt('light', st.theme, 'Light')}</select></div></div>
    </section>

    <section><h3>Reality check</h3>
      <div class="disclaimer">
        <b>APY Dog finds and ranks. It does not give advice and cannot tell you what to buy.</b><br><br>
        Every rate comes from a public feed or a bundled snapshot and can be wrong, stale, or unavailable to you.
        Verify with the provider before moving money.<br><br>
        On the movement side: nothing here predicts direction. Heat means something is unusually likely to happen
        soon, which is as often a reason to stay away as to buy. Expected-move bands are arithmetic on past
        volatility, not forecasts. Timing the market is not possible; knowing what is on the calendar is.<br><br>
        Safety grades and warning flags are this app's computed opinion from what each source publishes. A starting
        point for your own thinking, not a verdict.
      </div>
      <div style="margin-top:12px"><button class="btn ghost" data-act="reset-settings">Reset all settings</button></div>
    </section>
  </div>`;
  updateTaxPreview();
}

async function updateTaxPreview() {
  const el = $('#tax-preview');
  if (!el) return;
  try {
    const [ord, tre, muni] = await Promise.all([
      window.apy.taxPreview('ordinary'), window.apy.taxPreview('treasury'), window.apy.taxPreview('muni_federal_exempt'),
    ]);
    el.innerHTML = `At your settings a fully taxable rate loses <b>${ord.rate}%</b> to tax, a Treasury loses
      <b>${tre.rate}%</b>, and a municipal bond loses <b>${muni.rate}%</b>. That is why a lower headline Treasury or
      muni rate can genuinely beat a higher savings rate for you.`;
  } catch { el.textContent = ''; }
}

function switchView(view) {
  S.view = view;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-find').style.display = view === 'find' ? 'flex' : 'none';
  $('#view-radar').style.display = view === 'radar' ? 'flex' : 'none';
  $('#drawer').classList.toggle('hidden', view !== 'find' || !S.detail);
  for (const v of ['events', 'watch', 'sources', 'settings']) $(`#view-${v}`).hidden = view !== v;
  if (view === 'radar') renderRadar().catch(() => {});
  if (view === 'events') renderEvents();
  if (view === 'sources') renderSources();
  if (view === 'settings') renderSettings();
  if (view === 'watch') renderWatchlist().catch(() => {});
}

/* ----------------------------------------------------------------- events - */

function wire() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#trackswitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-section]');
    if (!b) return;
    applySection(b.dataset.section);
  });

  $('#btn-refresh').addEventListener('click', () => refresh(false));
  $('#btn-theme').addEventListener('click', async () => {
    const order = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(S.boot.settings.theme) + 1) % 3];
    S.boot.settings = await window.apy.updateSettings({ theme: next });
    applyTheme();
  });
  $('#btn-export').addEventListener('click', async () => {
    try { const r = await window.apy.exportCSV(S.query); if (r.saved) toast('Exported', `${r.rows} rows`); }
    catch (err) { toast('Export failed', err.message, 'err'); }
  });
  $('#notice-close').addEventListener('click', () => $('#notice').classList.add('hidden'));
  $('#progress-cancel').addEventListener('click', () => window.apy.cancelRefresh());

  let searchTimer = null;
  $('#q-text').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { S.query.text = v; runQuery(); }, 130);
  });

  $('#q-sort').addEventListener('change', (e) => { S.query.sortBy = e.target.value; runQuery(); });

  // --- filter bar ---------------------------------------------------------
  $('#filterbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, key } = b.dataset;
    if (act === 'open-filter-menu') return openFilterMenu(b);
    if (act === 'open-presets') return openPresetMenu(b);
    if (act === 'clear-filters') return clearAllFilters();
    if (act === 'remove-filter') {
      window.filterClear(defFor(key), S.query);
      closePopovers();
      return runQuery();
    }
    if (act === 'edit-filter') return openFilterEditor(key, b.closest('.fpill'));
  });

  // --- filter picker ------------------------------------------------------
  $('#fmenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'pick-preset') return applyPreset(b.dataset.key);
    if (b.dataset.act === 'pick-filter') {
      const def = defFor(b.dataset.key);
      seedFilterValue(def);
      $('#fmenu').classList.add('hidden');
      runQuery().then(() => {
        const pill = document.querySelector(`.fpill[data-filter="${CSS.escape(def.key)}"]`);
        openFilterEditor(def.key, pill || $('#filterbar'));
      });
    }
  });
  $('#fmenu').addEventListener('input', (e) => {
    if (e.target.id !== 'fmenu-search') return;
    S.filterSearch = e.target.value;
    const list = $('#fmenu .list');
    const tmp = document.createElement('div');
    tmp.innerHTML = window.R.filterMenu(S.query, renderCtx(), S.filterSearch);
    if (list) list.innerHTML = tmp.querySelector('.list').innerHTML;
  });

  // --- filter value editor ------------------------------------------------
  $('#fedit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close-editor') { closePopovers(); return; }
    if (b.dataset.act === 'toggle-fval') {
      const k = b.dataset.fkey;
      if (!Array.isArray(S.query[k])) S.query[k] = [];
      toggleIn(S.query[k], b.dataset.val);
      b.classList.toggle('on');
      runQuery();
    }
  });
  $('#fedit').addEventListener('change', (e) => {
    const el = e.target;
    const k = el.dataset.fkey;
    if (!k) return;
    const def = defFor(S.editingFilter);
    if (el.type === 'checkbox') S.query[k] = el.checked;
    else if (el.type === 'number') {
      const raw = numOrNull(el.value);
      S.query[k] = raw !== null && def?.encode ? def.encode(raw) : raw;
    } else S.query[k] = el.value === '' ? null : el.value;
    runQuery();
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('#fmenu, #fedit, .fpill, .addfilter')) return;
    closePopovers();
  });

  // --- table --------------------------------------------------------------
  $('#tablewrap').addEventListener('click', async (e) => {
    const star = e.target.closest('[data-act="watch"]');
    if (star) {
      e.stopPropagation();
      const row = S.rows.find((r) => r.id === star.dataset.id);
      S.watchlist = await window.apy.toggleWatch(star.dataset.id, row?.name);
      S.boot.watchlist = await window.apy.watchlist();
      $('#watch-count').textContent = S.watchlist.length;
      star.classList.toggle('on');
      star.textContent = star.classList.contains('on') ? '★' : '☆';
      return;
    }
    if (e.target.closest('[data-act="clear-filters"]')) return clearAllFilters();
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (S.query.sortBy === key) S.query.sortDir = S.query.sortDir === 'asc' ? 'desc' : 'asc';
      else { S.query.sortBy = key; S.query.sortDir = 'desc'; }
      $('#q-sort').value = key;
      return runQuery();
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });

  // --- drawer -------------------------------------------------------------
  $('#drawer').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id, url } = b.dataset;
    if (act === 'close-drawer') return closeDrawer();
    if (act === 'open') return window.apy.openExternal(url);
    if (act === 'watch') {
      S.watchlist = await window.apy.toggleWatch(id, S.detail?.opportunity?.name);
      S.boot.watchlist = await window.apy.watchlist();
      $('#watch-count').textContent = S.watchlist.length;
      openDetail(id);
      return runQuery();
    }
    if (act === 'dismiss') { await window.apy.dismiss(id); closeDrawer(); return refresh(true); }
    if (act === 'measure') {
      toast('Measuring…', 'Fetching price history for this one.');
      try { await window.apy.measure(id); await refresh(true); openDetail(id); }
      catch (err) { toast('Could not measure', err.message, 'err'); }
      return;
    }
    if (act === 'alert') {
      const o = S.detail?.opportunity;
      const cur = o?.apy?.total;
      if (Number.isFinite(cur)) {
        const threshold = Math.round(cur * 0.9 * 100) / 100;
        await window.apy.addAlert({ opportunityId: id, kind: 'apy_below', threshold, label: `${o.name} falls below ${threshold}%` });
        toast('Alert set', `You will be told if it drops below ${threshold}%.`);
      } else {
        await window.apy.addAlert({ opportunityId: id, kind: 'apy_above', threshold: 0, label: `${o.name} changes` });
        toast('Alert set', 'You will be told when this one changes.');
      }
      S.boot.alerts = await window.apy.alerts();
    }
  });

  // --- panes --------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.closest('#filterbar, #drawer, #tablewrap, #fmenu, #fedit')) return;
    const { act, id, url, val } = b.dataset;
    if (act === 'open') { e.preventDefault(); return window.apy.openExternal(url); }
    if (act === 'goto-view') { e.preventDefault(); return switchView(val); }
    if (act === 'goto-section') { return applySection(val); }
    if (act === 'radar-more') {
      let q = {};
      try { q = JSON.parse(b.dataset.query || '{}'); } catch { /* fall back to no filter */ }
      S.query = { ...S.boot.constants.DEFAULT_QUERY, ...q };
      syncTrackButtons(); syncSortOptions();
      switchView('find');
      return runQuery();
    }
    if (act === 'set-budget') {
      const v = Number($('#radar-budget')?.value);
      if (!Number.isFinite(v) || v <= 0) return toast('Enter an amount', 'Or clear it to go back to rates only.', 'warn');
      S.boot.settings = await window.apy.updateSettings({ budget: v });
      toast('Set', `Figures now shown on ${window.F.money(v)}.`);
      await runQuery();
      return renderRadar();
    }
    if (act === 'clear-budget') {
      S.boot.settings = await window.apy.updateSettings({ budget: null });
      toast('Cleared', 'Showing rates only.');
      await runQuery();
      return renderRadar();
    }
    if (act === 'goto') { switchView('find'); return openDetail(id); }
    if (act === 'goto-symbol') { switchView('find'); S.query.text = val; $('#q-text').value = val; return runQuery(); }
    if (act === 'open-user-rates') { await window.apy.openUserRates(); return toast('Opened', 'Edit, save, then refresh.'); }
    if (act === 'clear-cache') { const n = await window.apy.clearCache(); toast('Cache cleared', `${n} files`); return renderSources(); }
    if (act === 'reset-settings') { S.boot.settings = await window.apy.resetSettings(); applyTheme(); renderSettings(); return toast('Settings reset'); }
    if (act === 'rm-alert') { await window.apy.removeAlert(id); S.boot.alerts = await window.apy.alerts(); return renderWatchlist().catch(() => {}); }
    if (act === 'source-toggle') {
      const all = S.boot.sources.map((s) => s.id);
      const cur = S.boot.settings.enabledSources ?? all.filter((x) => (S.boot.sources.find((s) => s.id === x) || {}).defaultEnabled !== false);
      const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      S.boot.settings = await window.apy.updateSettings({ enabledSources: next });
      toast('Sources changed', 'Refresh to apply.');
    }
  });

  // --- settings -----------------------------------------------------------
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.id?.startsWith('s-')) return;
    const map = {
      's-fedOrd': (v) => ({ tax: { federalOrdinary: Number(v) } }),
      's-fedLtcg': (v) => ({ tax: { federalLtcg: Number(v) } }),
      's-state': (v) => ({ tax: { state: v, stateRate: null } }),
      's-account': (v) => ({ tax: { accountType: v } }),
      's-inflation': (v) => ({ tax: { inflation: Number(v) } }),
      's-niit': () => ({ tax: { niitApplies: $('#s-niit').checked } }),
      's-appetite': (v) => ({ riskAppetite: Number(v) }),
      's-basis': (v) => ({ rankingBasis: v }),
      's-budget': (v) => ({ budget: Number(v) }),
      's-mhorizon': (v) => ({ movementHorizonDays: Number(v) }),
      's-auto': (v) => ({ autoRefreshMinutes: Number(v) }),
      's-maxpools': (v) => ({ maxDefiPools: Number(v) }),
      's-live': () => ({ liveUpdates: $('#s-live').checked }),
      's-launch': () => ({ refreshOnLaunch: $('#s-launch').checked }),
      's-offline': () => ({ offlineMode: $('#s-offline').checked }),
      's-theme': (v) => ({ theme: v }),
    };
    const fn = map[el.id];
    if (!fn) return;
    S.boot.settings = await window.apy.updateSettings(fn(el.value));
    if (el.id === 's-theme') applyTheme();
    if (el.id === 's-live' || el.id === 's-offline') syncLive();
    if (el.id.startsWith('s-fed') || ['s-state', 's-account', 's-inflation', 's-niit'].includes(el.id)) updateTaxPreview();
    await runQuery();
    if (S.selectedId) openDetail(S.selectedId);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 's-appetite') $('#s-appetite-lbl').textContent = e.target.value;
  });

  // --- keyboard -----------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q-text').focus(); $('#q-text').select(); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFilterMenu($('#filterbar').querySelector('.addfilter') || $('#filterbar')); }
    else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(false); }
    else if (e.key === 'Escape') {
      if (!$('#fmenu').classList.contains('hidden') || !$('#fedit').classList.contains('hidden')) closePopovers();
      else if (S.detail) closeDrawer();
      else $('#q-text').blur();
    } else if (!mod && ['1', '2', '3', '4'].includes(e.key) && document.activeElement.tagName !== 'INPUT') {
      applySection(['income', 'movement', 'deals', 'all'][Number(e.key) - 1]);
    } else if (!mod && e.key.toLowerCase() === 'r' && document.activeElement.tagName !== 'INPUT') {
      switchView('radar');
    }
  });

  // --- from main ----------------------------------------------------------
  window.apy.onProgress((evt) => {
    const txt = $('#progress-text');
    if (evt.type === 'start') {
      S.sourcesTotal = evt.total; S.doneCount = 0;
      // A background cadence refresh touches one or two feeds; throwing a modal
      // progress bar up every twenty seconds for that would be intolerable.
      if (evt.total > 2) { $('#progress').classList.remove('hidden'); txt.textContent = `Scanning ${evt.total} sources…`; }
    }
    else if (evt.type === 'source_start') txt.textContent = `Fetching ${evt.label}…`;
    else if (evt.type === 'source_done') {
      S.doneCount += 1;
      $('#progress-bar').style.width = `${(S.doneCount / Math.max(1, S.sourcesTotal)) * 100}%`;
      txt.textContent = `${evt.label}: ${evt.count} found`;
    } else if (evt.type === 'log') txt.textContent = `${evt.source}: ${evt.message}`;
    else if (evt.type === 'error') toast('Scan error', evt.message, 'err');
  });

  window.apy.onDataUpdated(async (payload) => {
    S.meta = payload.meta;
    S.health = payload.health;
    S.events = payload.events || [];
    await runQuery();
    $('#src-count').textContent = `${payload.meta.sourcesOk}/${payload.meta.sourcesTotal}`;
    $('#ev-count').textContent = (payload.meta.upcomingEvents ?? 0).toLocaleString();
    syncLive();
    if (S.view === 'radar') renderRadar().catch(() => {});
    if (S.view === 'sources') renderSources();
    if (S.view === 'events') renderEvents();
    for (const a of payload.alerts || []) toast('Alert', a.message, 'warn');

    const failed = payload.health.filter((h) => h.status === 'failed');
    const snap = payload.meta.seedRows;
    if (failed.length) {
      notice(`<b>${failed.length} source${failed.length > 1 ? 's' : ''} failed.</b> ${esc(failed.map((f) => f.label).join(', '))} — showing bundled data for those.`,
        'See why', () => switchView('sources'));
    } else if (payload.meta.offline) {
      notice('<b>Showing the bundled snapshot.</b> These are a starting point, not live quotes.', 'Scan now', () => refresh(false));
    } else if (snap > 0) {
      notice(`<b>${snap} row${snap > 1 ? 's are' : ' is'} from the bundled snapshot.</b> Verify before acting.`, null);
    } else {
      $('#notice').classList.add('hidden');
    }
  });
}

/** The live indicator: on, busy, or off, with the age of the freshest feed. */
function syncLive() {
  const el = $('#livedot');
  const lbl = $('#live-label');
  if (!el || !lbl) return;
  const live = S.boot.settings.liveUpdates !== false && !S.boot.settings.offlineMode;
  el.classList.toggle('on', live && !S.refreshing);
  el.classList.toggle('busy', S.refreshing);
  if (S.refreshing) { lbl.textContent = 'updating'; return; }
  if (!live) { lbl.textContent = 'paused'; return; }
  const at = S.meta?.generatedAt;
  lbl.textContent = at ? window.F.ago(at).replace(' ago', '') : 'live';
  el.title = S.meta?.partial
    ? `Live. Last update refreshed ${(S.meta.refreshed || []).join(', ')}; the rest were not yet due.`
    : 'Live. Each feed refreshes on its own cadence.';
}

function applyTheme() {
  const t = S.boot.settings.theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/* ------------------------------------------------------------------ boot -- */

async function main() {
  S.boot = await window.apy.bootstrap();
  S.watchlist = (S.boot.watchlist || []).map((w) => w.id);
  S.health = S.boot.health || [];
  S.meta = S.boot.meta;
  S.events = S.boot.events || [];
  S.query = { ...S.boot.constants.DEFAULT_QUERY, ...(S.boot.settings.lastQuery || {}) };

  window.RATING_AXES = S.boot.constants.RATING_AXES;
  window.EFFORT_INFO = S.boot.constants.EFFORT_INFO;
  window.EVENT_INFO = S.boot.constants.EVENT_INFO;
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

  if (S.boot.platform === 'darwin') document.body.classList.add('mac');
  $('#ver').textContent = `v${S.boot.version}`;
  $('#watch-count').textContent = S.watchlist.length;
  $('#search-hint').textContent = S.boot.platform === 'darwin' ? '⌘K' : 'Ctrl K';
  applyTheme();
  syncLive();
  syncTrackButtons();
  syncSortOptions();

  window.__S = S;   // read by the headless smoke check; harmless otherwise
  wire();
  await runQuery();
  switchView('radar');

  if (!S.boot.settings.acknowledgedDisclaimer) {
    notice('<b>APY Dog finds and ranks — it does not give advice.</b> Nothing here predicts direction. Verify every number before moving money.',
      'Got it', async () => {
        await window.apy.updateSettings({ acknowledgedDisclaimer: true });
        $('#notice').classList.add('hidden');
      });
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

main().catch((err) => {
  document.body.innerHTML = `<div class="empty"><h3>APY Dog could not start</h3><p>${esc(err.message)}</p></div>`;
});
}());
