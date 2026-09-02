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

function notice(text, actionLabel, onAction, tone = 'info') {
  const n = $('#notice');
  $('#notice-text').innerHTML = text;
  const btn = $('#notice-action');
  if (actionLabel) { btn.textContent = actionLabel; btn.hidden = false; btn.onclick = onAction; }
  else btn.hidden = true;
  // A dead price feed and a friendly reminder should not look the same.
  n.classList.remove('hidden', 'err', 'warn');
  if (tone === 'err' || tone === 'warn') n.classList.add(tone);
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
    efforts: (c.EFFORT || []).map((e) => [e.key, e.label]),
    reaches: (c.REACH || []).map((r) => [r.key, r.label]),
    vehicles: Object.entries(c.VEHICLE || {}).map(([, v]) => [v, VEHICLE_LABELS[v] || v]),
  };
}

// The filter picker needs a human name for each vehicle key. The full
// description lives on the row itself; here it is just the noun.
const VEHICLE_LABELS = {
  shares: 'Shares', fractional: 'Fractional shares', etf: 'Fund or ETF',
  long_call: 'Call option', leaps: 'LEAPS', covered_call: 'Covered call',
  cash_secured_put: 'Cash-secured put', protective_put: 'Protective put',
  spread: 'Spread', deposit: 'Deposit account', direct: 'Direct with the provider',
  on_chain: 'On-chain', auction: 'Auction',
};

function renderCtx() {
  return {
    track: S.query.track || 'all',
    classes: S.boot.constants.ASSET_CLASS_LABELS,
    setupInfo: S.boot.constants.SETUP_INFO,
    sourceLabels: Object.fromEntries(S.boot.sources.map((s) => [s.id, s.label])),
    termPresets: S.boot.constants.TERM_PRESETS,
    options: filterOptions(),
    budget: S.boot.settings.budget ?? null,
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

  // Offers that expire and deadlines you can miss are the same thing to the
  // person holding the money, so they share a card. Keeping them apart is why
  // this used to read "3" while a hundred and fifty dated things sat one tab
  // away in the Calendar.
  cards.push(window.R.radarCard({
    icon: '⏳',
    title: 'On the clock',
    blurb: 'Everything with a date after which it is gone — offers that expire and deadlines you can miss.',
    items: (d.onTheClock || []).slice(0, 8).map((x) => window.R.clockItem(x)),
    count: d.onTheClockCount || 0,
    query: { expiringWithinDays: 45, sortBy: 'closingSoon', hideTraps: false },
    emptyText: 'Nothing with a published deadline in the next six weeks.',
    // How busy the next six weeks are is a fact about the calendar, not about
    // how hard the app looked. Late August is genuinely empty and the second
    // half of December is genuinely packed, and a card showing four things with
    // no other context reads as a failure to find anything.
    footNote: d.beyondWindow
      ? `${d.beyondWindow.toLocaleString()} more dated ${d.beyondWindow === 1 ? 'thing' : 'things'} `
        + `beyond ${d.clockWindowDays} days${d.nextBeyond ? `, the next in ${d.nextBeyond.days} — ${d.nextBeyond.name}` : ''}. `
        + 'See the Calendar for all of them.'
      : null,
  }));
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

/* ------------------------------------------------------------- onboarding - */

/**
 * First run.
 *
 * Draft state is held here and written once at the end, so backing out of a
 * step does not leave half a configuration behind, and skipping writes nothing
 * at all beyond the fact that they have seen it.
 */
function startOnboarding() {
  const t = S.boot.settings.tax || {};
  S.ob = {
    step: 'welcome',
    draft: {
      budget: S.boot.settings.budget ?? null,
      state: t.state ?? 'TX',
      federalOrdinary: t.federalOrdinary ?? 24,
      accountType: t.accountType ?? 'taxable',
      riskAppetite: S.boot.settings.riskAppetite ?? 45,
    },
  };
  renderOnboard();
}

function renderOnboard() {
  const el = $('#onboard');
  if (!S.ob) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = window.R.onboard(S.ob.step, S.ob.draft, {
    constants: S.boot.constants,
    platform: S.boot.platform,
  });
  el.querySelector('#ob-amount')?.focus();
}

/** Pull whatever the current step is showing into the draft before moving on. */
function captureOnboardStep() {
  const d = S.ob.draft;
  const amt = $('#ob-amount');
  if (amt) {
    const t = amt.value.trim().toLowerCase().replace(/[$,\s]/g, '');
    const mult = t.endsWith('k') ? 1e3 : t.endsWith('m') ? 1e6 : 1;
    const n = parseFloat(mult === 1 ? t : t.slice(0, -1));
    d.budget = Number.isFinite(n) && n > 0 ? Math.round(n * mult) : null;
  }
  if ($('#ob-state')) d.state = $('#ob-state').value;
  if ($('#ob-fed')) d.federalOrdinary = Number($('#ob-fed').value);
  if ($('#ob-account')) d.accountType = $('#ob-account').value;
}

async function finishOnboarding({ save = true } = {}) {
  const d = S.ob?.draft || {};
  const patch = { onboardedAt: new Date().toISOString(), acknowledgedDisclaimer: true };
  if (save) {
    patch.budget = d.budget ?? null;
    patch.riskAppetite = d.riskAppetite;
    patch.tax = { state: d.state, stateRate: null, federalOrdinary: d.federalOrdinary, accountType: d.accountType };
  }
  S.boot.settings = await window.apy.updateSettings(patch);
  S.ob = null;
  $('#onboard').classList.add('hidden');
  syncAmountBox();
  await runQuery();
  renderRadar().catch(() => {});
}

/* ---------------------------------------------------------------- signals - */

/**
 * What is showing the conditions that precede a large move.
 *
 * The calibration banner is not decoration. An uncalibrated ranking and a
 * measured one are different products and the interface has to say which it is
 * showing, every time, at the top — otherwise a number that has never been
 * checked against an outcome gets read as a probability.
 */
async function renderSignals() {
  const el = $('#view-signals');
  let d;
  try {
    d = await window.apy.signals();
  } catch (err) {
    el.innerHTML = `<div class="wrap"><h2>Signals</h2><div class="infobox">${esc(err.message)}</div></div>`;
    return;
  }
  el.innerHTML = window.R.signalsView(d);
}

/* ------------------------------------------------------------------- help - */

/**
 * The "?" affordance and its popover.
 *
 * Every piece of jargon on screen can be clicked and explained in place. The
 * alternative — a help page you have to go and find — is a help page nobody
 * reads, and the moment somebody needs to know what "duration" means is the
 * moment they are looking at it.
 */
window.helpChip = helpChip;
function helpChip(key, label = '?') {
  const e = window.glossaryLookup(key);
  if (!e) return '';
  return `<button class="helpq" data-act="help" data-key="${esc(key)}" title="What is ${esc(e.term)}?"
    aria-label="Explain ${esc(e.term)}">${esc(label)}</button>`;
}

function showHelp(key, anchor) {
  const e = window.glossaryLookup(key);
  const pop = $('#helppop');
  if (!e || !pop) return;
  pop.innerHTML = `
    <div class="hhead">${esc(e.term)}<button class="hx" data-act="help-close">✕</button></div>
    <div class="hwhat">${esc(e.what)}</div>
    ${e.why ? `<div class="hwhy"><b>Why it is here.</b> ${esc(e.why)}</div>` : ''}
    ${e.catch ? `<div class="hcatch"><b>The catch.</b> ${esc(e.catch)}</div>` : ''}
    ${(e.see || []).length ? `<div class="hsee">See also ${e.see.map((k) => {
    const t = window.glossaryLookup(k);
    return t ? `<button class="hlink" data-act="help" data-key="${esc(k)}">${esc(t.term)}</button>` : '';
  }).filter(Boolean).join(' · ')}</div>` : ''}
    <div class="hfoot"><button class="hlink" data-act="goto-view" data-val="learn">Open the full glossary →</button></div>`;
  pop.classList.remove('hidden');

  // Anchor to the thing that was clicked, then pull back inside the window.
  const r = anchor?.getBoundingClientRect?.();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r ? r.left : window.innerWidth / 2 - w / 2;
  let top = r ? r.bottom + 8 : 120;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  if (top + h > window.innerHeight - 10) top = Math.max(10, (r ? r.top : 120) - h - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideHelp() { $('#helppop')?.classList.add('hidden'); }

function renderLearn() {
  const q = S.learnQuery || '';
  const entries = window.glossarySearch(q);
  $('#view-learn').innerHTML = `<div class="wrap">
    <h2>What everything means</h2>
    <p class="lead">Every term this app puts on screen, explained without using another piece of jargon to do it.
      The <b>catch</b> on each one is usually the part that matters — it is what people get wrong about it.
      Anywhere you see a <span class="helpq" style="pointer-events:none">?</span> in the app, it opens the same
      explanation right where you are.</p>
    <div class="learnsearch">
      <input id="learn-q" type="text" placeholder="Search — try &quot;short&quot;, &quot;tax&quot;, &quot;risk&quot;…" value="${esc(q)}" />
      <span class="n">${entries.length} of ${Object.keys(window.GLOSSARY).length}</span>
    </div>
    ${entries.length ? `<div class="learngrid">${entries.map((e) => `
      <section class="learncard" id="g-${esc(e.key)}">
        <h3>${esc(e.term)}</h3>
        <p class="lwhat">${esc(e.what)}</p>
        ${e.why ? `<p class="lwhy"><b>Why it is here.</b> ${esc(e.why)}</p>` : ''}
        ${e.catch ? `<p class="lcatch"><b>The catch.</b> ${esc(e.catch)}</p>` : ''}
        ${(e.see || []).length ? `<p class="lsee">See also ${e.see.map((k) => {
    const t = window.glossaryLookup(k);
    return t ? `<button class="hlink" data-act="help" data-key="${esc(k)}">${esc(t.term)}</button>` : '';
  }).filter(Boolean).join(' · ')}</p>` : ''}
      </section>`).join('')}</div>`
    : '<div class="infobox">Nothing matches that. Try a shorter word.</div>'}
  </div>`;
}

/* ------------------------------------------------------------------- plan - */

/**
 * The plan view.
 *
 * Everything else in this app ranks. This orders — and the order is frequently
 * not the ranking, because an employer match and a 5.4% CD are not two
 * points on one scale.
 */
async function renderPlan() {
  const el = $('#view-plan');
  let p;
  try {
    p = await window.apy.plan(S.planFacts || null);
  } catch (err) {
    el.innerHTML = `<div class="wrap"><h2>Plan</h2><div class="infobox">Could not build a plan: ${esc(err.message)}</div></div>`;
    return;
  }
  S.plan = p;
  const f = p.facts;
  const money = (v) => window.F.money(v, { dp: 0 });

  const askRow = (id, label, input, hint) => `<div class="field">
    <label>${label}</label>${input}
    ${hint ? `<span style="font-size:10.5px;color:var(--text-faint)">${hint}</span>` : ''}
  </div>`;

  // Numbered across the whole plan, not within each tier. It is one sequence —
  // restarting at 1 under every heading turns an order of operations back into
  // six unrelated lists.
  const order = new Map(p.steps.map((s, i) => [s.id, i + 1]));
  const stepHtml = (s) => `<li class="planstep" data-act="goto" data-id="${esc(s.id)}">
    <span class="pnum">${order.get(s.id)}</span>
    <span class="pbody">
      <span class="ptop">
        <span class="pname">${esc(s.name)}</span>
        ${s.grade ? `<span class="grade" style="color:${esc(s.gradeColor || 'var(--text-dim)')};background:${esc((s.gradeColor || '#888') + '18')}">${esc(s.grade)}</span>` : ''}
        ${Number.isFinite(s.daysLeft) ? `<span class="countdown" style="color:var(--neg);background:var(--neg-soft)">${s.daysLeft <= 0 ? 'today' : `${Math.round(s.daysLeft)}d`}</span>` : ''}
      </span>
      <span class="pmeta">
        ${s.provider ? `${esc(s.provider)} · ` : ''}${esc(window.EFFORT_INFO?.[s.effort]?.label || s.effort)}
        ${s.minutes ? ` · about ${s.minutes < 60 ? `${s.minutes} min` : `${Math.round(s.minutes / 60)}h`}` : ''}
      </span>
      ${s.note ? `<span class="pnote">${esc(s.note)}</span>` : ''}
      ${s.caution ? `<span class="pcaution">${esc(s.caution)}</span>` : ''}
    </span>
    <span class="pval">
      ${s.dollarsUnknown ? '<span class="pund">rate only</span>'
    : Number.isFinite(s.dollars) ? `<b>${money(s.dollars)}</b><span class="u">year one</span>` : '<span class="pund">—</span>'}
      ${Number.isFinite(s.capital) && s.capital > 0 ? `<span class="pcap">${money(s.capital)} committed</span>` : ''}
    </span>
  </li>`;

  el.innerHTML = `<div class="wrap">
    <h2>What to do, in order</h2>
    <p class="lead">Every other view in this app ranks things. This one orders them — and the order is often not
      the ranking, because an employer match returns 50 cents or a dollar on every dollar you defer, and no yield
      on this page competes with either. Tell it the handful of things it cannot work out for itself and the
      sequence becomes yours.</p>

    <section><h3>What it needs from you</h3>
      <div class="grid3">
        ${askRow('p-match', 'Does your employer match?',
    `<select id="p-match">
            <option value="">I do not know</option>
            <option value="yes" ${f.employerMatches === true ? 'selected' : ''}>Yes</option>
            <option value="no" ${f.employerMatches === false ? 'selected' : ''}>No</option>
          </select>`, 'Roughly a third of plans do not.')}
        ${askRow('p-card', 'Card balance you carry ($)',
    `<input type="number" id="p-card" min="0" step="100" value="${Number.isFinite(f.cardBalance) ? f.cardBalance : ''}" placeholder="0" />`,
    'At 25% APR, clearing it beats everything below the match.')}
        ${askRow('p-spend', 'You spend about ($ / month)',
    `<input type="number" id="p-spend" min="0" step="100" value="${Number.isFinite(f.monthlyExpenses) ? f.monthlyExpenses : ''}" placeholder="not set" />`,
    'Only used to size the buffer.')}
        ${askRow('p-hours', 'Hours of hassle you will spend',
    `<input type="number" id="p-hours" min="0" max="80" step="1" value="${f.hoursAvailable}" />`,
    'Decides how many bounded offers are worth chasing.')}
        ${askRow('p-months', 'Months of buffer you want',
    `<input type="number" id="p-months" min="0" max="24" step="1" value="${f.bufferMonths}" />`, '')}
      </div>
    </section>

    <section><h3>What it comes to</h3>
      <div class="statgrid">
        <div class="stat"><div class="v" style="color:var(--pos)">${p.fromCapital ? money(p.fromCapital) : '—'}</div>
          <div class="k">Year one, on the money you deploy</div></div>
        <div class="stat"><div class="v" style="color:var(--brand)">${p.fromActions ? money(p.fromActions) : '—'}</div>
          <div class="k">Year one, from actions needing no capital</div></div>
        <div class="stat"><div class="v">${Number.isFinite(p.unallocated) ? money(p.unallocated) : '—'}</div>
          <div class="k">Left unallocated</div></div>
        <div class="stat"><div class="v">${Math.round(p.minutesUsed / 6) / 10}h</div>
          <div class="k">Of your time, spent</div></div>
      </div>
      ${p.beyondYearOne ? `<div class="sectionnote">A further <b>${money(p.beyondYearOne)}</b> from these same
        steps lands after the first twelve months — a transfer match with a multi-year clawback pays in full and
        pays slowly. The totals above count only the part that arrives inside a year; each step still shows the
        whole payment.</div>` : ''}
      <div class="sectionnote">These two totals are deliberately not added together. A pre-tax commuter election
        saves real money and needs no capital, so it does not scale with what you have and does not belong in the
        same number as a yield on a balance.</div>
    </section>

    ${p.tiers.map((t) => `<section>
      <h3>${esc(t.title)}</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.55;margin:0 0 10px;max-width:780px">${esc(t.why)}</p>
      <ol class="plansteps">${p.steps.filter((s) => s.tier === t.key).map(stepHtml).join('')}</ol>
    </section>`).join('')}

    ${p.notKnown.length ? `<section><h3>What it does not know</h3>
      <div class="infobox"><ul style="margin:0;padding-left:18px;line-height:1.6">
        ${p.notKnown.map((n) => `<li>${esc(n)}</li>`).join('')}
      </ul></div></section>` : ''}

    ${p.skipped.length ? `<section><h3>Left out, and why</h3>
      <div class="sectionnote">A plan that silently drops things reads as a complete plan. These did not fit the
        money or the time you gave it.</div>
      <ul class="skiplist">${p.skipped.slice(0, 12).map((s) => `<li><b>${esc(s.name || s.tier)}</b> — ${esc(s.why)}</li>`).join('')}
        ${p.skipped.length > 12 ? `<li style="color:var(--text-faint)">…and ${p.skipped.length - 12} more</li>` : ''}</ul>
    </section>` : ''}

    <section><h3>What this is</h3>
      <div class="disclaimer">This is an ordering, computed from public rate data and the handful of facts above.
        It is not financial advice and it does not know your circumstances — your job security, your dependants,
        your health, your other holdings, or your plan documents. The tiers reflect an ordering most people would
        recognise as sensible; whether it is right <i>for you</i> is a judgement this app cannot make.
        ${p.assumptions.map((a) => esc(a)).join(' ')}</div>
    </section>
  </div>`;
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

    <section><h3>Where the limits are</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;max-width:820px">
        Every source has a ceiling, and an app that hides them lets you assume it found everything. These are the
        current ones. Raising them costs calls and time, not accuracy.</p>
      <div class="statgrid">
        ${[
    ['Crypto assets', `${((S.boot.settings.sources?.crypto?.pages ?? 8) * 250).toLocaleString()}`, 'by market cap, in 250s'],
    ['DeFi pools', `${(S.boot.settings.maxDefiPools ?? 8000).toLocaleString()}`, 'the whole set is fetched, then capped'],
    ['US issuers indexed', '12,000', 'identity only, from SEC'],
    ['Fully measured', `${(S.meta?.measured ?? 0).toLocaleString()}`, 'price, volatility and chart read'],
  ].map(([k, v, note]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div>
        <div class="k" style="color:var(--text-faint);margin-top:3px">${esc(note)}</div></div>`).join('')}
      </div>
      <div class="sectionnote">The index tier is deliberately cheap: ten thousand price fetches per refresh is not
        a reasonable thing to do to your machine or to a free endpoint. Rows that are indexed but not measured say
        <b>not measured</b> and sort last — open one and it measures just that one.</div>
    </section>

    <section><h3>What this does not look at</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;max-width:820px">
        No screener sees everything, and one that implies it does is lying by omission. These are the money-making
        venues this app knowingly does not cover, so you know where its blind spots are rather than assuming it
        found nothing there.</p>
      <ul class="gaps">
        <li><b>Options chains.</b> Rows say which vehicles exist and what capital each needs, but nothing here
          prices a contract or scans for mispriced premium. Treat the vehicle list as "this is expressible", not
          "this is currently a good trade".</li>
        <li><b>Prediction markets and event contracts.</b> Kalshi, Polymarket and the rest. Real venues with real
          returns and a risk model nothing else here shares.</li>
        <li><b>Private credit, P2P lending and real-estate crowdfunding.</b> Mostly no public rate API, frequently
          accredited-only, and historically the source of the widest gap between advertised and realised yield.</li>
        <li><b>Individual corporate and municipal bonds.</b> Covered through funds; the retail bond desk, where
          the markup is, is not.</li>
        <li><b>Structured notes, annuities, and anything sold rather than bought.</b> Priced per-issue and
          per-customer, so a published number would be fiction.</li>
        <li><b>Non-US accounts, rates and tax treatment.</b> The entire tax engine assumes a US filer.</li>
        <li><b>Anything requiring a job, a business, or an asset you do not have.</b> This app finds places to put
          money, not ways to earn it.</li>
      </ul>
      <div class="sectionnote">Two more honest limits. Rates are what each provider published, not what you will
        be offered — bonuses in particular are frequently targeted per-customer. And a bundled snapshot is a
        starting point, not a quote: refresh before acting on any of it.</div>
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
        <div class="field"><label>Amount you are working with ($)</label><input type="number" id="s-budget" value="${Number.isFinite(st.budget) && st.budget > 0 ? st.budget : ''}" step="1000" placeholder="leave empty for rates only" />
          <span style="font-size:10.5px;color:var(--text-faint)">Empty means the app shows rates and ranks capped offers against a stated reference. Fill it in and every figure becomes dollars on your money.</span></div>
        <div class="field"><label>Movement horizon (days)</label><input type="number" id="s-mhorizon" value="${st.movementHorizonDays ?? 30}" step="7" min="1" />
          <span style="font-size:10.5px;color:var(--text-faint)">Expected-move bands are computed over this window.</span></div>
      </div>
    </section>

    <section><h3>Scanning</h3>
      <div class="grid2">
        <div class="field"><label>Auto-refresh every (minutes, 0 = off)</label><input type="number" id="s-auto" value="${st.autoRefreshMinutes ?? 60}" step="15" min="0" /></div>
        <div class="field"><label>Max DeFi pools</label><input type="number" id="s-maxpools" value="${st.maxDefiPools ?? 8000}" step="500" min="50" /></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-live" ${st.liveUpdates !== false ? 'checked' : ''} /> Live updating</label>
          <span style="font-size:10.5px;color:var(--text-faint)">Each feed refreshes on its own cadence — crypto every minute, the Treasury curve hourly, curated lists daily. Off falls back to one timer.</span></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-launch" ${st.refreshOnLaunch ? 'checked' : ''} /> Refresh when the app opens</label></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-offline" ${st.offlineMode ? 'checked' : ''} /> Offline mode</label></div>
      </div>
    </section>

    <section><h3>Watching while you are away</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.55;margin:0 0 12px">A deal that closes on Friday
        is worth nothing to someone who opens the app on Saturday. With these on, APY Dog keeps a tray icon after
        you close the window, re-checks deadlines every fifteen minutes against the clock rather than the feeds,
        and tells you once — not every scan.</p>
      <div class="grid2">
        <div class="field"><label class="check"><input type="checkbox" id="s-background" ${st.runInBackground !== false ? 'checked' : ''} /> Keep watching after I close the window</label>
          <span style="font-size:10.5px;color:var(--text-faint)">Quit from the tray icon to stop it completely.</span></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-login" ${st.startAtLogin ? 'checked' : ''} /> Start when I log in</label>
          <span style="font-size:10.5px;color:var(--text-faint)">Starts hidden in the tray.</span></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-notify" ${st.notify !== false ? 'checked' : ''} /> Desktop notifications</label></div>
        <div class="field"><label>Warn me this many days before a watched window closes (0 = off)</label>
          <input type="number" id="s-closing" value="${st.watchClosingDays ?? 7}" step="1" min="0" max="90" /></div>
        <div class="field"><label>Tell me about new deals worth at least ($, 0 = off)</label>
          <input type="number" id="s-newdeal" value="${st.watchNewDealsWorth ?? 200}" step="50" min="0" /></div>
      </div>
    </section>

    <section><h3>The app itself</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.55;margin:0 0 12px">Separate from the data,
        which refreshes on its own every time this runs. This is the code — the source list, the maths, the
        warnings. A screener frozen at whatever shipped goes quietly stale while looking exactly as authoritative
        as the day it was built.</p>
      <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
        <button class="btn" data-act="check-updates">Check for updates</button>
        <span id="update-status" style="font-size:11.5px;color:var(--text-faint)">Running v${esc(S.boot.version)}.</span>
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
  for (const v of ['signals', 'plan', 'learn', 'events', 'watch', 'sources', 'settings']) $(`#view-${v}`).hidden = view !== v;
  if (view === 'radar') renderRadar().catch(() => {});
  if (view === 'signals') renderSignals().catch(() => {});
  if (view === 'plan') renderPlan().catch(() => {});
  if (view === 'learn') renderLearn();
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
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'learn-q') return;
    S.learnQuery = e.target.value;
    const at = e.target.selectionStart;
    renderLearn();
    const next = $('#learn-q');
    if (next) { next.focus(); next.setSelectionRange(at, at); }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#helppop') || e.target.closest('[data-act="help"]')) return;
    hideHelp();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });

  $('#q-amount')?.addEventListener('input', (e) => {
    clearTimeout(amountTimer);
    const v = e.target.value;
    amountTimer = setTimeout(() => commitAmount(v), 450);
  });
  $('#q-amount')?.addEventListener('blur', () => syncAmountBox());
  $('#q-amount')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(amountTimer); commitAmount(e.target.value); e.target.blur(); }
    if (e.key === 'Escape') { clearTimeout(amountTimer); syncAmountBox(); e.target.blur(); }
  });
  $('#q-amount-clear')?.addEventListener('click', () => { clearTimeout(amountTimer); commitAmount(''); });

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
    // The "?" in a column header must explain the column, not re-sort it.
    const q = e.target.closest('[data-act="help"]');
    if (q) { e.preventDefault(); e.stopPropagation(); return showHelp(q.dataset.key, q); }
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
      try {
        const r = await window.apy.measure(id);
        await refresh(true); openDetail(id);
        // A measurement that came back with a caveat says so. Silently showing
        // numbers built on a partial series is how a guess passes for a reading.
        if (r?.warnings?.length) toast('Measured, with a caveat', r.warnings[0], 'warn');
      }
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
    if (act === 'ob-next') {
      captureOnboardStep();
      const steps = window.R.ONBOARD_STEPS;
      const i = steps.indexOf(S.ob.step);
      if (i >= steps.length - 1) return finishOnboarding({ save: true });
      S.ob.step = steps[i + 1];
      return renderOnboard();
    }
    if (act === 'ob-back') {
      captureOnboardStep();
      const steps = window.R.ONBOARD_STEPS;
      S.ob.step = steps[Math.max(0, steps.indexOf(S.ob.step) - 1)];
      return renderOnboard();
    }
    if (act === 'ob-skip') return finishOnboarding({ save: false });
    if (act === 'ob-appetite') {
      S.ob.draft.riskAppetite = Number(b.dataset.val);
      return renderOnboard();
    }
    if (act === 'help') { e.preventDefault(); e.stopPropagation(); return showHelp(b.dataset.key, b); }
    if (act === 'help-close') { e.preventDefault(); return hideHelp(); }
    if (act === 'check-updates') {
      const el = $('#update-status');
      if (el) el.textContent = 'Checking…';
      const r = await window.apy.checkUpdates();
      if (!el) return;
      if (!r?.ok) el.textContent = `Could not check: ${r?.error || 'no answer from the update server'}.`;
      else if (r.newer || (r.version && r.version !== S.boot.version)) el.innerHTML = `<b style="color:var(--brand)">v${esc(r.version)} is available.</b> Downloading in the background — it installs next time you quit.`;
      else el.textContent = `v${esc(S.boot.version)} is the latest version.`;
      return;
    }
    if (act === 'install-update') { await window.apy.installUpdate(); return; }
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
    // Both the Settings panel (s-*) and the Plan view (p-*) arrive here, and
    // which is which is decided in src/ui/inputs.js, where it can be tested.
    // The guard used to be `if (!el.id?.startsWith('s-')) return;`, which made
    // the plan branch below unreachable and silently threw away every answer
    // anyone gave the Plan view.
    const route = window.UI_INPUTS.routeChange(el.id, el.value);
    if (route.kind === 'none') return;
    if (route.kind === 'plan') {
      // Merge, never replace: each control answers one question and the other
      // four answers have to survive it.
      S.planFacts = window.UI_INPUTS.mergeFacts(S.planFacts, route.facts);
      await renderPlan();
      return;
    }
    const map = {
      's-fedOrd': (v) => ({ tax: { federalOrdinary: Number(v) } }),
      's-fedLtcg': (v) => ({ tax: { federalLtcg: Number(v) } }),
      's-state': (v) => ({ tax: { state: v, stateRate: null } }),
      's-account': (v) => ({ tax: { accountType: v } }),
      's-inflation': (v) => ({ tax: { inflation: Number(v) } }),
      's-niit': () => ({ tax: { niitApplies: $('#s-niit').checked } }),
      's-appetite': (v) => ({ riskAppetite: Number(v) }),
      's-basis': (v) => ({ rankingBasis: v }),
      's-budget': (v) => ({ budget: v === '' || Number(v) <= 0 ? null : Number(v) }),
      's-mhorizon': (v) => ({ movementHorizonDays: Number(v) }),
      's-auto': (v) => ({ autoRefreshMinutes: Number(v) }),
      's-maxpools': (v) => ({ maxDefiPools: Number(v) }),
      's-live': () => ({ liveUpdates: $('#s-live').checked }),
      's-launch': () => ({ refreshOnLaunch: $('#s-launch').checked }),
      's-offline': () => ({ offlineMode: $('#s-offline').checked }),
      's-theme': (v) => ({ theme: v }),
      's-background': () => ({ runInBackground: $('#s-background').checked }),
      's-login': () => ({ startAtLogin: $('#s-login').checked }),
      's-notify': () => ({ notify: $('#s-notify').checked }),
      's-closing': (v) => ({ watchClosingDays: Number(v) }),
      's-newdeal': (v) => ({ watchNewDealsWorth: Number(v) }),
    };
    const fn = map[el.id];
    if (!fn) return;
    S.boot.settings = await window.apy.updateSettings(fn(el.value));
    if (el.id === 's-budget') syncAmountBox();
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

  window.apy.onUpdateAvailable(({ version, url }) => {
    notice(`<b>APY Dog ${esc(version)} is available.</b> You are running ${esc(S.boot.version)}.`,
      'Get it', () => window.apy.openExternal(url));
  });
  window.apy.onUpdateReady(({ version }) => {
    notice(`<b>APY Dog ${esc(version || 'update')} is downloaded.</b> It installs the next time you quit.`,
      'Restart now', () => window.apy.installUpdate());
  });
  // Clicking a desktop notification should land on the thing it was about.
  window.apy.onNavOpen(({ id }) => {
    if (!id) return;
    switchView('find');
    openDetail(id);
  });

  window.apy.onDataUpdated(async (payload) => {
    S.meta = payload.meta;
    S.health = payload.health;
    S.events = payload.events || [];
    await runQuery();
    syncCounters();
  syncAmountBox();
    syncLive();
    if (S.view === 'radar') renderRadar().catch(() => {});
    if (S.view === 'sources') renderSources();
    if (S.view === 'events') renderEvents();
    for (const a of payload.alerts || []) toast('Alert', a.message, 'warn');

    // A source failing has to be loud. The old version whispered "N sources
    // failed" in the same tone as everything else, so an app whose price feed
    // had been dead for weeks looked exactly like one that was working — which
    // is how somebody ends up believing a screen full of stale numbers.
    const failed = payload.health.filter((h) => h.status === 'failed');
    const snap = payload.meta.seedRows;
    const total = payload.meta.total || (snap + (payload.meta.liveRows || 0)) || 1;
    const mostlyStale = snap / total > 0.5;

    if (failed.length) {
      const names = failed.map((f) => f.label).join(', ');
      const why = failed.map((f) => f.error || (f.warnings || [])[0]).filter(Boolean)[0];
      notice(`<b>${failed.length} source${failed.length > 1 ? 's are' : ' is'} down: ${esc(names)}.</b> `
        + `Those rows are the bundled snapshot, which can be months old. `
        + `${why ? `First error: ${esc(String(why).slice(0, 140))}` : ''}`,
      'Diagnose', () => switchView('sources'), 'err');
    } else if (payload.meta.offline) {
      notice('<b>Showing the bundled snapshot.</b> These are a starting point, not live quotes.', 'Scan now', () => refresh(false));
    } else if (mostlyStale) {
      // The case that used to slip through entirely: nothing "failed", but most
      // of the data is bundled because the feeds returned nothing usable.
      notice(`<b>${snap} of ${total} rows are still the bundled snapshot after a live scan.</b> `
        + 'That usually means a feed answered but gave nothing usable. Run <code>npm run doctor</code> to see '
        + 'exactly which one and why.', 'Open Sources', () => switchView('sources'), 'warn');
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

/**
 * The amount box in the results bar.
 *
 * It lived in Settings, which is the wrong place for it: the number changes
 * what every figure in the list means, so it belongs where the figures are.
 * Debounced rather than live because re-scoring eight hundred rows on each
 * keystroke makes typing feel broken.
 */
let amountTimer = null;
function syncAmountBox() {
  const el = $('#q-amount');
  if (!el) return;
  const v = S.boot.settings.budget;
  const set = Number.isFinite(v) && v > 0;
  if (document.activeElement !== el) el.value = set ? Number(v).toLocaleString() : '';
  $('#q-amount-clear')?.classList.toggle('on', set);
}

async function commitAmount(raw) {
  // Accept "10k", "25,000", "$1200" — people type money the way they say it.
  const t = String(raw ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
  let n = null;
  if (t) {
    const mult = t.endsWith('k') ? 1e3 : t.endsWith('m') ? 1e6 : 1;
    const num = parseFloat(mult === 1 ? t : t.slice(0, -1));
    if (Number.isFinite(num) && num > 0) n = Math.round(num * mult);
  }
  S.boot.settings = await window.apy.updateSettings({ budget: n });
  syncAmountBox();
  await runQuery();
  if (S.selectedId) openDetail(S.selectedId);
  if (S.view === 'radar') renderRadar().catch(() => {});
  if (S.view === 'plan') renderPlan().catch(() => {});
}

/** Header badges that describe the loaded dataset rather than any one view. */
function syncCounters() {
  const m = S.meta || {};
  const ev = $('#ev-count');
  if (ev) ev.textContent = (m.upcomingEvents ?? S.events.filter((e) => !e.past).length ?? 0).toLocaleString();
  const src = $('#src-count');
  if (src && Number.isFinite(m.sourcesTotal)) {
    // Before the first refresh every source reads "offline", which is true and
    // reads as catastrophe: "0/13" says nothing is working when in fact all
    // thirteen supplied their bundled snapshot. Live counts belong on the badge
    // only once something has actually been fetched.
    const failed = (S.health || []).filter((h) => h.status === 'failed').length;
    if (m.sourcesOk > 0 || failed > 0) {
      src.textContent = `${m.sourcesOk ?? 0}/${m.sourcesTotal}`;
      src.title = `${m.sourcesOk ?? 0} of ${m.sourcesTotal} sources fetched live${failed ? `, ${failed} failed` : ''}.`;
    } else {
      src.textContent = 'seed';
      src.title = `All ${m.sourcesTotal} sources are showing bundled data. Nothing has been fetched live yet — hit Refresh.`;
    }
  }
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

  if (S.boot.platform === 'darwin') document.body.classList.add('mac');
  $('#ver').textContent = `v${S.boot.version}`;
  $('#watch-count').textContent = S.watchlist.length;
  // These were only ever written by the refresh handler, so on a cold start the
  // Calendar tab read "0" next to 148 upcoming events and Sources read "–".
  syncCounters();
  $('#search-hint').textContent = S.boot.platform === 'darwin' ? '⌘K' : 'Ctrl K';
  applyTheme();
  syncLive();
  syncTrackButtons();
  syncSortOptions();

  window.__S = S;   // read by the headless smoke check; harmless otherwise
  wire();
  await runQuery();
  switchView('radar');

  if (!S.boot.settings.onboardedAt) { startOnboarding(); return; }
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
