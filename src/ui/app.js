(function () {
'use strict';

/* App controller. Owns state, wires events, calls into the main process.
   Filtering is done in main (it holds the dataset) but is cheap and synchronous
   there, so every control can re-query on change without feeling laggy. */

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
  watchlist: [],
  selectedId: null,
  detail: null,
  view: 'find',
  preset: 'best',
  refreshing: false,
  sourcesTotal: 0,
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

/* ------------------------------------------------------------------ data -- */

async function runQuery({ rerenderSidebar = true } = {}) {
  try {
    const res = await window.apy.query(S.query);
    S.rows = res.rows;
    S.facets = res.facets;
    S.changes = res.changes || {};
    S.meta = res.meta;
    renderResults(res);
    if (rerenderSidebar) renderSidebar();
    $('#res-desc').innerHTML = `<b>${res.total.toLocaleString()}</b> of ${(res.facets?.total ?? 0).toLocaleString()} — ${esc(res.description)}`;
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
  }
}

/* --------------------------------------------------------------- render --- */

function renderSidebar() {
  $('#sidebar').innerHTML = window.R.sidebar(S.query, S.facets, S.boot, S.preset);
}

function renderResults(res) {
  $('#tablewrap').innerHTML = window.R.table(S.rows, {
    watchlist: S.watchlist,
    changes: S.changes,
    selectedId: S.selectedId,
    classes: S.boot.constants.ASSET_CLASS_LABELS,
    sortBy: S.query.sortBy,
    sortDir: S.query.sortDir,
    facets: res?.facets || S.facets,
  });
}

async function openDetail(id) {
  S.selectedId = id;
  try {
    S.detail = await window.apy.detail(id);
  } catch { S.detail = null; }
  const d = $('#drawer');
  if (!S.detail) { d.classList.add('hidden'); return; }
  d.classList.remove('hidden');
  d.innerHTML = window.R.drawer(S.detail, {
    watchlist: S.watchlist,
    classes: S.boot.constants.ASSET_CLASS_LABELS,
    budget: S.boot.settings.budget ?? 10000,
  });
  $$('#tablewrap tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
}

function closeDrawer() {
  S.selectedId = null;
  S.detail = null;
  $('#drawer').classList.add('hidden');
  $$('#tablewrap tr.selected').forEach((tr) => tr.classList.remove('selected'));
}

/* ------------------------------------------------------------ other views - */

function renderSources() {
  const statusColor = { ok: 'var(--pos)', partial: 'var(--warn)', offline: 'var(--info)', failed: 'var(--neg)', disabled: 'var(--text-faint)' };
  const statusWord = { ok: 'live', partial: 'partial', offline: 'snapshot', failed: 'failed', disabled: 'off' };
  const m = S.meta || {};
  const enabled = S.boot.settings.enabledSources;

  $('#view-sources').innerHTML = `<div class="wrap">
    <h2>Sources</h2>
    <p class="lead">Where every number in the table came from, and whether it is a live quote or the bundled
      snapshot that ships with the app. If a source says <b>snapshot</b>, refresh it before you act on the rate.</p>

    <section><h3>This scan</h3>
      <div class="statgrid">
        <div class="stat"><div class="v">${(m.total ?? 0).toLocaleString()}</div><div class="k">Opportunities</div></div>
        <div class="stat"><div class="v" style="color:var(--pos)">${(m.liveRows ?? 0).toLocaleString()}</div><div class="k">Live</div></div>
        <div class="stat"><div class="v" style="color:var(--warn)">${(m.seedRows ?? 0).toLocaleString()}</div><div class="k">From snapshot</div></div>
        <div class="stat"><div class="v">${window.F.pct(m.riskFree, 2)}</div><div class="k">Risk-free rate</div></div>
        <div class="stat"><div class="v">${m.duplicatesMerged ?? 0}</div><div class="k">Duplicates merged</div></div>
        <div class="stat"><div class="v">${m.invalidDropped ?? 0}</div><div class="k">Dropped as invalid</div></div>
      </div>
      <div style="margin-top:9px;font-size:11.5px;color:var(--text-faint)">
        Last scan ${m.generatedAt ? window.F.ago(m.generatedAt) : 'never'} · risk-free rate from ${esc(m.riskFreeSource || 'fallback')}
      </div>
    </section>

    <section><h3>Feeds</h3>
      ${S.health.map((h) => {
    const src = S.boot.sources.find((s) => s.id === h.id) || {};
    const on = enabled === null || enabled === undefined ? src.defaultEnabled !== false : enabled.includes(h.id);
    return `<div class="srccard">
          <span class="dot" style="background:${statusColor[h.status] || 'var(--text-faint)'}"></span>
          <div class="info">
            <div class="nm">${esc(h.label)} <span class="st" style="color:${statusColor[h.status]}">${statusWord[h.status] || h.status}</span></div>
            <div class="meta">${esc(src.description || '')}</div>
            <div class="meta">${h.count.toLocaleString()} rows${h.ms ? ` · ${h.ms}ms` : ''}${src.homepage ? ` · <a href="#" data-act="open" data-url="${esc(src.homepage)}">${esc(new URL(src.homepage).host)}</a>` : ''}</div>
            ${(h.notes || []).map((n) => `<div class="msg">${esc(n)}</div>`).join('')}
            ${(h.warnings || []).map((w) => `<div class="msg warn">⚠ ${esc(w)}</div>`).join('')}
          </div>
          <label class="check"><input type="checkbox" data-act="source-toggle" data-val="${esc(h.id)}" ${on ? 'checked' : ''} /> on</label>
        </div>`;
  }).join('')}
      ${(S.boot.sourceProblems || []).length ? `<div class="warnbox severe" style="margin-top:10px">
        <div class="ttl">Adapters that failed to load</div>
        ${S.boot.sourceProblems.map((p) => `${esc(p.file)}: ${esc(p.error)}`).join('<br>')}
      </div>` : ''}
    </section>

    <section><h3>Your own rates</h3>
      <p class="lead" style="margin-bottom:10px">No free public API publishes retail savings and CD rates, so those ship as a
        curated list. Keep your own current rates in a JSON file and APY Dog will merge them over the bundled ones.</p>
      <button class="btn" data-act="open-user-rates">Edit my rates file</button>
      <div style="margin-top:8px;font-size:11px;color:var(--text-faint);user-select:text">${esc(S.boot.paths?.userRates || '')}</div>
    </section>

    <section><h3>Storage</h3>
      <div id="storage-stats" class="statgrid"></div>
      <div style="margin-top:10px;display:flex;gap:7px">
        <button class="btn sm" data-act="clear-cache">Clear cache</button>
      </div>
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

function renderWatchlist() {
  const ids = S.watchlist;
  const rows = S.rows.filter((r) => ids.includes(r.id));
  $('#view-watch').innerHTML = `<div class="wrap">
    <h2>Watchlist</h2>
    <p class="lead">Rates you are tracking. APY Dog records each one on every scan, so the longer you keep it here
      the more you know about whether the rate actually holds.</p>
    ${ids.length === 0
    ? '<div class="infobox">Nothing here yet. Click the ☆ next to anything in the table to track it.</div>'
    : `<section><div class="statgrid">${ids.map((id) => {
      const o = S.rows.find((r) => r.id === id) || S.watchlist.find((w) => w.id === id);
      const w = (S.boot.watchlist || []).find((x) => x.id === id);
      const name = o?.name || w?.name || id;
      const ch = S.changes[id];
      return `<div class="stat" data-act="goto" data-id="${esc(id)}" style="cursor:pointer">
          <div class="v">${o ? window.F.pct(o.apy?.total, 2) : '—'}
            ${ch && ch.direction !== 'flat' ? `<span class="trend ${ch.direction}" style="font-size:11px">${ch.direction === 'up' ? '▲' : '▼'}${Math.abs(ch.delta).toFixed(2)}</span>` : ''}</div>
          <div class="k">${esc(name)}</div>
        </div>`;
    }).join('')}</div></section>
      <section><h3>Alerts</h3>
        ${(S.boot.alerts || []).length
    ? (S.boot.alerts).map((a) => `<div class="srccard"><div class="info">
            <div class="nm">${esc(a.label || `${a.kind.replace(/_/g, ' ')} ${a.threshold}%`)}</div>
            <div class="meta">${a.lastFired ? `Last fired ${window.F.ago(a.lastFired)}` : 'Never fired'}</div>
          </div><button class="btn ghost sm" data-act="rm-alert" data-id="${esc(a.id)}">Remove</button></div>`).join('')
    : '<div class="infobox">No alerts set. Open any opportunity and choose “Alert me if it changes”.</div>'}
      </section>`}
    ${rows.length ? `<section><h3>Details</h3><div class="tablewrap">${window.R.table(rows, {
    watchlist: S.watchlist, changes: S.changes, selectedId: S.selectedId,
    classes: S.boot.constants.ASSET_CLASS_LABELS, sortBy: S.query.sortBy, sortDir: S.query.sortDir,
  })}</div></section>` : ''}
  </div>`;
}

function renderSettings() {
  const st = S.boot.settings;
  const t = st.tax || {};
  const states = Object.keys(S.boot.constants.STATE_TOP_RATES).sort();
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label ?? v)}</option>`;

  $('#view-settings').innerHTML = `<div class="wrap">
    <h2>Settings</h2>
    <p class="lead">Your tax situation and how much risk you are willing to take change which opportunity is
      genuinely best — often dramatically. Set these honestly and the ranking becomes yours rather than generic.</p>

    <section><h3>Tax</h3>
      <div class="grid3">
        <div class="field"><label>Federal ordinary bracket</label>
          <select id="s-fedOrd">${S.boot.constants.FEDERAL_ORDINARY_BRACKETS.map((b) => opt(b, t.federalOrdinary, `${b}%`)).join('')}</select></div>
        <div class="field"><label>Long-term capital gains</label>
          <select id="s-fedLtcg">${S.boot.constants.FEDERAL_LTCG_BRACKETS.map((b) => opt(b, t.federalLtcg, `${b}%`)).join('')}</select></div>
        <div class="field"><label>State</label>
          <select id="s-state">${states.map((v) => opt(v, t.state, `${v} — ${S.boot.constants.STATE_TOP_RATES[v]}%`)).join('')}</select></div>
        <div class="field"><label>Account type</label>
          <select id="s-account">
            ${opt('taxable', t.accountType, 'Taxable brokerage / bank')}
            ${opt('traditional', t.accountType, 'Traditional IRA / 401(k)')}
            ${opt('roth', t.accountType, 'Roth')}
          </select></div>
        <div class="field"><label>Assumed inflation (%)</label>
          <input type="number" id="s-inflation" value="${t.inflation ?? 2.6}" step="0.1" /></div>
        <div class="field" style="justify-content:flex-end">
          <label class="check"><input type="checkbox" id="s-niit" ${t.niitApplies ? 'checked' : ''} /> Net investment income tax applies</label></div>
      </div>
      <div class="infobox" style="margin-top:12px" id="tax-preview"></div>
    </section>

    <section><h3>Ranking</h3>
      <div class="grid2">
        <div class="field"><label>Risk appetite: <b id="s-appetite-lbl">${st.riskAppetite}</b> / 100</label>
          <input type="range" id="s-appetite" min="0" max="100" step="1" value="${st.riskAppetite}" />
          <span style="font-size:10.5px;color:var(--text-faint)">0 = I cannot lose this. 100 = swing for the fences.</span></div>
        <div class="field"><label>Rank using</label>
          <select id="s-basis">
            ${opt('gross', st.rankingBasis, 'Headline APY')}
            ${opt('afterTax', st.rankingBasis, 'After tax')}
            ${opt('afterTaxReal', st.rankingBasis, 'After tax and inflation')}
          </select></div>
        <div class="field"><label>Amount you'd deploy ($)</label>
          <input type="number" id="s-budget" value="${st.budget ?? 10000}" step="1000" /></div>
        <div class="field"><label>When you need it back (days, blank = no constraint)</label>
          <input type="number" id="s-horizon" value="${st.horizonDays ?? ''}" step="30" placeholder="no constraint" /></div>
      </div>
    </section>

    <section><h3>Scanning</h3>
      <div class="grid2">
        <div class="field"><label>Auto-refresh every (minutes, 0 = off)</label>
          <input type="number" id="s-auto" value="${st.autoRefreshMinutes ?? 60}" step="15" min="0" /></div>
        <div class="field"><label>Max DeFi pools to pull</label>
          <input type="number" id="s-maxpools" value="${st.maxDefiPools ?? 1200}" step="100" min="50" /></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-launch" ${st.refreshOnLaunch ? 'checked' : ''} /> Refresh when the app opens</label></div>
        <div class="field"><label class="check"><input type="checkbox" id="s-offline" ${st.offlineMode ? 'checked' : ''} /> Offline mode (bundled snapshot only)</label></div>
      </div>
    </section>

    <section><h3>Appearance</h3>
      <div class="grid2">
        <div class="field"><label>Theme</label>
          <select id="s-theme">${opt('system', st.theme, 'Match system')}${opt('dark', st.theme, 'Dark')}${opt('light', st.theme, 'Light')}</select></div>
      </div>
    </section>

    <section><h3>Reality check</h3>
      <div class="disclaimer">
        <b>APY Dog finds and ranks rates. It does not give advice, and it cannot tell you what to buy.</b><br><br>
        Every rate here comes from a public feed or a bundled snapshot and can be wrong, stale, or no longer
        available to you. Verify the number with the provider before you move money. Advertised yields are not
        promises: variable rates change without notice, trailing yields describe the past, and modelled
        expectations in the High Upside section are guesses with wide error bars.<br><br>
        Risk scores and trap flags are this app's own opinion, computed from the fields each source publishes.
        They are a starting point for your own thinking, not a verdict. Nothing here is a recommendation, and
        no one involved in this app knows your circumstances.
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
    const ord = await window.apy.taxPreview('ordinary');
    const tre = await window.apy.taxPreview('treasury');
    const muni = await window.apy.taxPreview('muni_federal_exempt');
    el.innerHTML = `At your settings, a fully taxable rate loses <b>${ord.rate}%</b> to tax, a Treasury loses
      <b>${tre.rate}%</b>, and a municipal bond loses <b>${muni.rate}%</b>.
      That is why a lower headline Treasury or muni rate can genuinely beat a higher savings rate for you.`;
  } catch { el.textContent = ''; }
}

function switchView(view) {
  S.view = view;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-find').style.display = view === 'find' ? 'flex' : 'none';
  $('#sidebar').classList.toggle('collapsed', view !== 'find');
  $('#drawer').classList.toggle('hidden', view !== 'find' || !S.detail);
  for (const v of ['watch', 'sources', 'settings']) $(`#view-${v}`).hidden = view !== v;
  if (view === 'sources') renderSources();
  if (view === 'settings') renderSettings();
  if (view === 'watch') renderWatchlist();
}

/* ----------------------------------------------------------------- events - */

function applyPreset(key) {
  const p = window.R.PRESETS.find((x) => x.key === key);
  if (!p) return;
  S.preset = key;
  S.query = { ...S.boot.constants.DEFAULT_QUERY, ...p.q, text: S.query.text };
  runQuery();
}

function wire() {
  // --- tabs / chrome ------------------------------------------------------
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });
  $('#btn-refresh').addEventListener('click', () => refresh(false));
  $('#btn-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));
  $('#btn-theme').addEventListener('click', async () => {
    const order = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(S.boot.settings.theme) + 1) % 3];
    S.boot.settings = await window.apy.updateSettings({ theme: next });
    applyTheme();
    toast('Theme', next);
  });
  $('#btn-export').addEventListener('click', async () => {
    try {
      const r = await window.apy.exportCSV(S.query);
      if (r.saved) toast('Exported', `${r.rows} rows to ${r.path}`);
    } catch (err) { toast('Export failed', err.message, 'err'); }
  });
  $('#btn-reset').addEventListener('click', () => applyPreset('best'));
  $('#notice-close').addEventListener('click', () => $('#notice').classList.add('hidden'));
  $('#progress-cancel').addEventListener('click', () => window.apy.cancelRefresh());

  // --- search -------------------------------------------------------------
  let searchTimer = null;
  $('#q-text').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { S.query.text = v; runQuery({ rerenderSidebar: false }); }, 130);
  });

  // --- sort ---------------------------------------------------------------
  $('#q-sort').addEventListener('change', (e) => { S.query.sortBy = e.target.value; runQuery({ rerenderSidebar: false }); });

  // --- sidebar (delegated; it is re-rendered constantly) ------------------
  $('#sidebar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, val } = b.dataset;
    const q = S.query;
    if (act === 'preset') return applyPreset(val);
    S.preset = null;
    if (act === 'class') toggleIn(q.assetClasses, val);
    else if (act === 'tier') toggleIn(q.riskTiers, val);
    else if (act === 'liq') toggleIn(q.liquidity, val);
    else if (act === 'denom') toggleIn(q.denominations, val);
    else if (act === 'chain') toggleIn(q.chains, val);
    else if (act === 'source') toggleIn(q.sources, val);
    else if (act === 'term') { q.termPreset = val === 'any' ? null : val; if (val === 'any') { q.termMinDays = null; q.termMaxDays = null; q.includeOpenEnded = true; } }
    else return;
    runQuery();
  });

  $('#sidebar').addEventListener('change', (e) => {
    const el = e.target;
    const q = S.query;
    const id = el.id?.replace(/^q-/, '');
    if (!id) return;
    S.preset = null;
    if (el.type === 'checkbox') q[id] = el.checked;
    else if (el.type === 'number') q[id] = numOrNull(el.value);
    else q[id] = el.value;
    if (id === 'maxRisk') q.maxRisk = Number(el.value) >= 100 ? null : Number(el.value);
    if (id === 'minConfidence') q.minConfidence = Number(el.value) <= 0 ? null : Number(el.value) / 100;
    if (id === 'maxProbabilityOfLoss') q.maxProbabilityOfLoss = numOrNull(el.value) === null ? null : numOrNull(el.value) / 100;
    if (id === 'onlySpeculative' && el.checked) q.includeSpeculative = true;
    runQuery();
  });

  // Live label updates on sliders without a full re-render on every pixel.
  $('#sidebar').addEventListener('input', (e) => {
    if (e.target.id === 'q-maxRisk') $('#lbl-maxRisk').textContent = Number(e.target.value) >= 100 ? 'any' : e.target.value;
    if (e.target.id === 'q-minConfidence') $('#lbl-minConfidence').textContent = Number(e.target.value) <= 0 ? 'any' : `${e.target.value}%`;
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
    if (e.target.closest('[data-act="reset"]')) return applyPreset('best');
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (S.query.sortBy === key) S.query.sortDir = S.query.sortDir === 'asc' ? 'desc' : 'asc';
      else { S.query.sortBy = key; S.query.sortDir = 'desc'; }
      $('#q-sort').value = key;
      return runQuery({ rerenderSidebar: false });
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
      renderResults();
      return;
    }
    if (act === 'dismiss') {
      await window.apy.dismiss(id);
      closeDrawer();
      toast('Hidden', 'It will not come back until you refresh settings.');
      return refresh(true);
    }
    if (act === 'alert') {
      const o = S.detail?.opportunity;
      const cur = o?.apy?.total;
      if (!Number.isFinite(cur)) return toast('No rate to watch', '', 'warn');
      const threshold = Math.round((cur * 0.9) * 100) / 100;
      await window.apy.addAlert({
        opportunityId: id, kind: 'apy_below', threshold,
        label: `${o.name} falls below ${threshold}%`,
      });
      S.boot.alerts = await window.apy.alerts();
      toast('Alert set', `You'll be notified if it drops below ${threshold}%.`);
    }
  });

  // --- panes --------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.closest('#sidebar, #drawer, #tablewrap')) return;
    const { act, id, url, val } = b.dataset;
    if (act === 'open') { e.preventDefault(); return window.apy.openExternal(url); }
    if (act === 'open-user-rates') { await window.apy.openUserRates(); return toast('Opened', 'Edit, save, then refresh.'); }
    if (act === 'clear-cache') { const n = await window.apy.clearCache(); toast('Cache cleared', `${n} files`); return renderSources(); }
    if (act === 'reset-settings') { S.boot.settings = await window.apy.resetSettings(); applyTheme(); renderSettings(); return toast('Settings reset'); }
    if (act === 'rm-alert') { await window.apy.removeAlert(id); S.boot.alerts = await window.apy.alerts(); return renderWatchlist(); }
    if (act === 'goto') { switchView('find'); return openDetail(id); }
    if (act === 'source-toggle') {
      const all = S.boot.sources.map((s) => s.id);
      const cur = S.boot.settings.enabledSources ?? all.filter((x) => (S.boot.sources.find((s) => s.id === x) || {}).defaultEnabled !== false);
      const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      S.boot.settings = await window.apy.updateSettings({ enabledSources: next });
      toast('Sources changed', 'Refresh to apply.');
    }
  });

  // --- settings inputs ----------------------------------------------------
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
      's-horizon': (v) => ({ horizonDays: v === '' ? null : Number(v) }),
      's-auto': (v) => ({ autoRefreshMinutes: Number(v) }),
      's-maxpools': (v) => ({ maxDefiPools: Number(v) }),
      's-launch': () => ({ refreshOnLaunch: $('#s-launch').checked }),
      's-offline': () => ({ offlineMode: $('#s-offline').checked }),
      's-theme': (v) => ({ theme: v }),
    };
    const fn = map[el.id];
    if (!fn) return;
    S.boot.settings = await window.apy.updateSettings(fn(el.value));
    if (el.id === 's-theme') applyTheme();
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
    else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(false); }
    else if (e.key === 'Escape') { if (S.detail) closeDrawer(); else $('#q-text').blur(); }
    else if (!mod && ['1', '2', '3', '4'].includes(e.key) && document.activeElement.tagName !== 'INPUT') {
      switchView(['find', 'watch', 'sources', 'settings'][Number(e.key) - 1]);
    }
  });

  // --- from main ----------------------------------------------------------
  window.apy.onProgress((evt) => {
    const p = $('#progress');
    const txt = $('#progress-text');
    if (evt.type === 'start') { S.sourcesTotal = evt.total; S.doneCount = 0; p.classList.remove('hidden'); txt.textContent = `Scanning ${evt.total} sources…`; }
    else if (evt.type === 'source_start') txt.textContent = `Fetching ${evt.label}…`;
    else if (evt.type === 'source_done') {
      S.doneCount = (S.doneCount || 0) + 1;
      $('#progress-bar').style.width = `${(S.doneCount / Math.max(1, S.sourcesTotal)) * 100}%`;
      txt.textContent = `${evt.label}: ${evt.count} found`;
    } else if (evt.type === 'log') txt.textContent = `${evt.source}: ${evt.message}`;
    else if (evt.type === 'error') toast('Scan error', evt.message, 'err');
  });

  window.apy.onDataUpdated(async (payload) => {
    S.meta = payload.meta;
    S.health = payload.health;
    await runQuery();
    $('#src-count').textContent = `${payload.meta.sourcesOk}/${payload.meta.sourcesTotal}`;
    if (S.view === 'sources') renderSources();
    for (const a of payload.alerts || []) toast('Alert', a.message, 'warn');

    const failed = payload.health.filter((h) => h.status === 'failed');
    const snap = payload.meta.seedRows;
    if (failed.length) {
      notice(`<b>${failed.length} source${failed.length > 1 ? 's' : ''} failed.</b> ${esc(failed.map((f) => f.label).join(', '))} — showing bundled data for those.`,
        'See why', () => switchView('sources'));
    } else if (snap > 0 && payload.meta.liveRows > 0) {
      notice(`<b>${snap} row${snap > 1 ? 's are' : ' is'} from the bundled snapshot</b>, not a live quote. Verify before acting.`,
        'Which ones?', () => { $('#notice').classList.add('hidden'); S.query.hideSeed = false; switchView('find'); });
    } else if (payload.meta.offline) {
      notice('<b>Showing the bundled snapshot.</b> These rates are a starting point, not live quotes.', 'Scan now', () => refresh(false));
    } else {
      $('#notice').classList.add('hidden');
    }
  });
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
  S.query = { ...S.boot.constants.DEFAULT_QUERY, ...(S.boot.settings.lastQuery || {}) };

  if (S.boot.platform === 'darwin') document.body.classList.add('mac');
  $('#ver').textContent = `v${S.boot.version}`;
  $('#watch-count').textContent = S.watchlist.length;
  $('#search-hint').textContent = S.boot.platform === 'darwin' ? '⌘K' : 'Ctrl K';
  applyTheme();

  $('#q-sort').innerHTML = [
    ['dogScore', 'Best overall'], ['apy', 'Highest APY'], ['afterTax', 'Highest after tax'],
    ['taxEquivalent', 'Tax-equivalent'], ['afterTaxReal', 'After inflation'],
    ['certaintyEquivalent', 'Certainty equivalent'], ['sharpe', 'Return per unit of risk'],
    ['risk', 'Lowest risk'], ['trap', 'Fewest warnings'], ['term', 'Shortest term'],
    ['tvl', 'Largest'], ['minInvestment', 'Lowest minimum'], ['price', 'Lowest price'], ['name', 'Name'],
  ].map(([v, l]) => `<option value="${v}"${S.query.sortBy === v ? ' selected' : ''}>${l}</option>`).join('');

  wire();
  await runQuery();

  if (!S.boot.settings.acknowledgedDisclaimer) {
    notice('<b>APY Dog finds rates, it does not give advice.</b> Verify every number with the provider before moving money.',
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
