'use strict';

/* Pure-ish render functions: state in, HTML string out. Kept separate from app.js
   so the wiring and the markup do not tangle. Everything user-facing that came
   from a third-party feed goes through F.esc — pool names and fund names are
   attacker-controllable strings in the DeFi case. */

const R = {};
const { esc } = window.F;

/* ------------------------------------------------------------------ table -- */

R.COLUMNS = [
  { key: 'watch', label: '', width: 26, sortable: false },
  { key: 'name', label: 'Opportunity', sort: 'name' },
  { key: 'apy', label: 'APY', sort: 'apy', num: true },
  { key: 'aftertax', label: 'After tax', sort: 'afterTax', num: true },
  { key: 'dog', label: 'Score', sort: 'dogScore', num: true },
  { key: 'risk', label: 'Risk', sort: 'risk' },
  { key: 'traps', label: 'Flags', sort: 'trap' },
  { key: 'term', label: 'Term', sort: 'term' },
  { key: 'liq', label: 'Access', sort: null },
  { key: 'entry', label: 'Min / Price', sort: 'minInvestment', num: true },
  { key: 'size', label: 'Size', sort: 'tvl', num: true },
  { key: 'income', label: 'Income yr 1', sort: null, num: true },
];

function apyCell(o) {
  const spec = o.yieldKind === 'expected';
  const v = spec ? o.expected?.annualReturn : o.apy?.total;
  if (!Number.isFinite(v)) return '<td class="num">—</td>';
  const cls = spec ? 'spec' : v >= 8 ? 'hi' : 'mid';
  const txt = spec ? `~${window.F.pct(v, 1)}` : window.F.pct(v, 2);

  // For DeFi, show at a glance how much of the yield is real revenue vs emissions.
  let split = '';
  const base = o.apy?.base; const rew = o.apy?.reward;
  if (Number.isFinite(base) && Number.isFinite(rew) && base + rew > 0 && rew > 0) {
    const bp = Math.max(0, Math.min(100, (base / (base + rew)) * 100));
    split = `<div class="apysplit" title="${window.F.pct(base, 2)} real revenue + ${window.F.pct(rew, 2)} token emissions"><i class="base" style="width:${bp}%"></i><i class="rew" style="width:${100 - bp}%"></i></div>`;
  }
  return `<td class="num"><span class="apy ${cls}">${txt}</span>${split}</td>`;
}

function trendCell(change) {
  if (!change || change.direction === 'flat') return '';
  const arrow = change.direction === 'up' ? '▲' : '▼';
  return `<span class="trend ${change.direction}" title="${window.F.pctSigned(change.delta)} over ${change.days} days">${arrow}${Math.abs(change.delta).toFixed(2)}</span>`;
}

R.row = (o, { watched, change, selected, classes }) => {
  const spec = o.yieldKind === 'expected';
  const tier = o.risk || {};
  const trapVerdict = o.scores?.traps?.verdict || 'clean';
  const nFlags = (o.trapFlags || []).length;
  const dog = o.scores?.dogScore;

  const badges = [
    o.seed ? '<span class="badge snap" title="Bundled snapshot, not a live quote. Refresh to update.">snapshot</span>' : '',
    spec ? '<span class="badge spec" title="A modelled expectation, not a yield">estimate</span>' : '',
    o.subType === 'tips' ? '<span class="badge real" title="This is a REAL (inflation-adjusted) yield, not nominal">real</span>' : '',
    ['fdic', 'ncua', 'us_gov'].includes(o.risk?.insurance) ? `<span class="badge ins" title="${window.F.insurance(o.risk.insurance)}">insured</span>` : '',
  ].filter(Boolean).join('');

  const meta = [classes[o.assetClass] || o.assetClass, o.provider || o.chain || o.sourceLabel]
    .filter(Boolean).map(esc).join(' · ');

  const entry = Number.isFinite(o.price)
    ? window.F.money(o.price, { dp: 2 })
    : Number.isFinite(o.minInvestment) ? window.F.money(o.minInvestment) : '—';

  return `<tr data-id="${esc(o.id)}" class="${selected ? 'selected' : ''} ${trapVerdict === 'likely_trap' ? 'trap' : ''}">
    <td><span class="star ${watched ? 'on' : ''}" data-act="watch" data-id="${esc(o.id)}" title="${watched ? 'Remove from watchlist' : 'Add to watchlist'}">${watched ? '★' : '☆'}</span></td>
    <td><div class="cell-name">
      <span class="n">${esc(o.name)}</span>
      <span class="m">${meta}${badges}</span>
    </div></td>
    ${apyCell(o)}
    <td class="num" title="After your tax settings">${window.F.pct(o.tax?.afterTaxApy, 2)} ${trendCell(change)}</td>
    <td class="num"><div class="scorebar" style="justify-content:flex-end">
      <span class="v">${Number.isFinite(dog) ? dog.toFixed(0) : '—'}</span>
      <span class="track"><i class="fill" style="width:${Number.isFinite(dog) ? dog : 0}%"></i></span>
    </div></td>
    <td><span class="tierchip" style="color:${tier.tierColor || 'var(--text-dim)'}">
      <span class="tierdot" style="background:${tier.tierColor || 'var(--text-faint)'}"></span>${esc(tier.tierLabel || '—')}
    </span></td>
    <td><span class="flagcell ${trapVerdict}" title="${nFlags ? esc((o.trapFlags || []).join(', ')) : 'No warning flags'}">
      ${nFlags ? `⚑ ${nFlags}` : '—'}
    </span></td>
    <td>${esc(window.F.term(o))}</td>
    <td style="color:var(--text-dim)">${esc(window.F.liquidity(o.liquidity))}</td>
    <td class="num">${entry}</td>
    <td class="num" style="color:var(--text-dim)">${Number.isFinite(o.tvl) ? window.F.money(o.tvl) : '—'}</td>
    <td class="num" style="color:var(--pos)">${Number.isFinite(o.scores?.incomeYear1) ? window.F.money(o.scores.incomeYear1, { dp: 0 }) : '—'}</td>
  </tr>`;
};

R.table = (rows, ctx) => {
  if (!rows.length) {
    return `<div class="empty">
      <h3>Nothing matches those filters</h3>
      <p>${ctx.facets?.trapsHidden ? `${ctx.facets.trapsHidden} result${ctx.facets.trapsHidden === 1 ? ' is' : 's are'} hidden as likely yield traps. ` : ''}
      Try widening the APY range, allowing longer terms, or turning off "hide likely traps".</p>
      <button class="btn" data-act="reset">Reset all filters</button>
    </div>`;
  }
  const head = R.COLUMNS.map((c) => {
    const sorted = ctx.sortBy === c.sort;
    return `<th class="${c.num ? 'num' : ''} ${sorted ? 'sorted' : ''}" ${c.sort ? `data-sort="${c.sort}"` : ''} style="${c.width ? `width:${c.width}px` : ''}">
      ${esc(c.label)}${sorted ? `<span class="arrow">${ctx.sortDir === 'asc' ? '▲' : '▼'}</span>` : ''}
    </th>`;
  }).join('');
  const body = rows.map((o) => R.row(o, {
    watched: ctx.watchlist.includes(o.id),
    change: ctx.changes?.[o.id],
    selected: ctx.selectedId === o.id,
    classes: ctx.classes,
  })).join('');
  return `<table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
};

/* --------------------------------------------------------------- sidebar -- */

R.PRESETS = [
  { key: 'best', label: 'Best overall', sub: 'risk-adjusted', q: { sortBy: 'dogScore', hideTraps: true } },
  { key: 'max', label: 'Max APY', sub: 'everything, raw', q: { sortBy: 'apy', hideTraps: false, includeSpeculative: false } },
  { key: 'safe', label: 'Safe & liquid', sub: 'insured, no lockup', q: { insuredOnly: true, termPreset: 'liquid', sortBy: 'afterTax' } },
  { key: 'aftertax', label: 'Best after tax', sub: 'your bracket', q: { sortBy: 'afterTax', hideTraps: true } },
  { key: 'lock', label: 'Lock a rate', sub: 'fixed-term', q: { liquidity: ['locked'], sortBy: 'apy' } },
  { key: 'upside', label: 'High upside', sub: 'uncertain', q: { onlySpeculative: true, sortBy: 'apy', hideTraps: false } },
];

function chips(items, activeList, act) {
  return items.map(([val, label, n]) => `
    <button class="chip ${activeList.includes(val) ? 'on' : ''}" data-act="${act}" data-val="${esc(val)}">
      ${esc(label)}${Number.isFinite(n) ? `<span class="n">${n}</span>` : ''}
    </button>`).join('');
}

R.sidebar = (q, facets, boot, activePreset) => {
  const classes = boot.constants.ASSET_CLASS_LABELS;
  const present = Object.entries(facets?.byAssetClass || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => [k, classes[k] || k, n]);
  const tiers = boot.constants.RISK_TIER.map((t) => [t.key, t.label, facets?.byTier?.[t.key]]);
  const chains = Object.entries(facets?.byChain || {}).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => [k, k, n]);
  const srcs = boot.sources.map((s) => [s.id, s.label.replace(/,.*$/, ''), facets?.bySource?.[s.id]]);
  const num = (id, val, ph, step = 'any') =>
    `<input type="number" id="${id}" value="${val ?? ''}" placeholder="${ph}" step="${step}" />`;

  return `
  <div class="presets">
    ${R.PRESETS.map((p) => `<button class="preset ${activePreset === p.key ? 'active' : ''}" data-act="preset" data-val="${p.key}">
      ${esc(p.label)}<span class="sub">${esc(p.sub)}</span></button>`).join('')}
  </div>

  <details class="fgroup" open><summary>Return</summary><div class="body">
    <div class="field"><label>APY range (%)</label><div class="row">
      ${num('q-minApy', q.minApy, 'min', '0.1')}<span>to</span>${num('q-maxApy', q.maxApy, 'max', '0.1')}
    </div></div>
    <div class="field"><label>Compare rates as</label>
      <select id="q-apyBasis">
        <option value="headline"${q.apyBasis === 'headline' ? ' selected' : ''}>Headline APY</option>
        <option value="afterTax"${q.apyBasis === 'afterTax' ? ' selected' : ''}>After tax</option>
        <option value="taxEquivalent"${q.apyBasis === 'taxEquivalent' ? ' selected' : ''}>Tax-equivalent</option>
        <option value="afterTaxReal"${q.apyBasis === 'afterTaxReal' ? ' selected' : ''}>After tax + inflation</option>
      </select>
    </div>
  </div></details>

  <details class="fgroup" open><summary>Type</summary><div class="body">
    <div class="chips">${chips(present, q.assetClasses, 'class')}</div>
  </div></details>

  <details class="fgroup" open><summary>Length</summary><div class="body">
    <div class="chips">${boot.constants.TERM_PRESETS.map((p) => `
      <button class="chip ${q.termPreset === p.key || (!q.termPreset && p.key === 'any') ? 'on' : ''}" data-act="term" data-val="${p.key}">${esc(p.label)}</button>`).join('')}
    </div>
    <div class="field"><label>Exact term, days</label><div class="row">
      ${num('q-termMinDays', q.termMinDays, 'min', '1')}<span>to</span>${num('q-termMaxDays', q.termMaxDays, 'max', '1')}
    </div></div>
    <div class="field"><label>Max lockup, days</label>${num('q-maxLockupDays', q.maxLockupDays, 'any', '1')}</div>
    <label class="check"><input type="checkbox" id="q-includeOpenEnded" ${q.includeOpenEnded ? 'checked' : ''} /> Include open-ended</label>
  </div></details>

  <details class="fgroup" open><summary>Money in</summary><div class="body">
    <div class="field"><label>Most I'd put in ($)</label>${num('q-minInvestmentMax', q.minInvestmentMax, 'no limit', '100')}
      <span style="font-size:10.5px;color:var(--text-faint)">Hides anything with a higher entry minimum.</span></div>
    <div class="field"><label>Share price ($)</label><div class="row">
      ${num('q-priceMin', q.priceMin, 'min', '1')}<span>to</span>${num('q-priceMax', q.priceMax, 'max', '1')}
    </div><span style="font-size:10.5px;color:var(--text-faint)">Only applies to things with a per-share price.</span></div>
    <div class="field"><label>Minimum size / TVL ($)</label>${num('q-minTvl', q.minTvl, 'any', '1000')}</div>
  </div></details>

  <details class="fgroup" open><summary>Risk</summary><div class="body">
    <div class="field"><label>Max risk score: <b id="lbl-maxRisk">${q.maxRisk ?? 'any'}</b></label>
      <input type="range" id="q-maxRisk" min="0" max="100" step="1" value="${q.maxRisk ?? 100}" /></div>
    <div class="chips">${chips(tiers, q.riskTiers, 'tier')}</div>
    <label class="check"><input type="checkbox" id="q-insuredOnly" ${q.insuredOnly ? 'checked' : ''} /> Insured or government-backed only</label>
    <label class="check"><input type="checkbox" id="q-hideTraps" ${q.hideTraps ? 'checked' : ''} /> Hide likely yield traps${facets?.trapsHidden ? ` <span style="color:var(--text-faint)">(${facets.trapsHidden})</span>` : ''}</label>
    <div class="field"><label>Minimum confidence: <b id="lbl-minConfidence">${q.minConfidence ? `${Math.round(q.minConfidence * 100)}%` : 'any'}</b></label>
      <input type="range" id="q-minConfidence" min="0" max="95" step="5" value="${(q.minConfidence ?? 0) * 100}" /></div>
  </div></details>

  <details class="fgroup"><summary>Access</summary><div class="body">
    <div class="chips">${chips(
    Object.entries(boot.constants.LIQUIDITY).map(([, v]) => [v, window.F.liquidity(v)]),
    q.liquidity, 'liq',
  )}</div>
  </div></details>

  <details class="fgroup"><summary>High upside</summary><div class="body">
    <label class="check"><input type="checkbox" id="q-includeSpeculative" ${q.includeSpeculative ? 'checked' : ''} /> Include modelled estimates</label>
    <label class="check"><input type="checkbox" id="q-onlySpeculative" ${q.onlySpeculative ? 'checked' : ''} /> Show only these</label>
    <div class="field"><label>Min expected return (%)</label>${num('q-minExpectedReturn', q.minExpectedReturn, 'any', '1')}</div>
    <div class="field"><label>Max chance of loss (%)</label>${num('q-maxProbabilityOfLoss', q.maxProbabilityOfLoss === null || q.maxProbabilityOfLoss === undefined ? null : q.maxProbabilityOfLoss * 100, 'any', '5')}</div>
    <div class="infobox" style="font-size:11px">These are model estimates with wide error bars, not yields. The model can be wrong.</div>
  </div></details>

  ${chains.length ? `<details class="fgroup"><summary>Chain</summary><div class="body">
    <div class="chips">${chips(chains, q.chains, 'chain')}</div></div></details>` : ''}

  <details class="fgroup"><summary>Source</summary><div class="body">
    <div class="chips">${chips(srcs, q.sources, 'source')}</div>
    <label class="check"><input type="checkbox" id="q-hideSeed" ${q.hideSeed ? 'checked' : ''} /> Live data only (hide bundled snapshot)</label>
    <label class="check"><input type="checkbox" id="q-strictUnknowns" ${q.strictUnknowns ? 'checked' : ''} /> Strict: drop rows with missing data</label>
  </div></details>`;
};

/* ---------------------------------------------------------------- drawer -- */

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
  const last = ys[ys.length - 1]; const first = ys[0];
  const color = last >= first ? 'var(--pos)' : 'var(--neg)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" />
  </svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-faint);font-family:var(--mono)">
    <span>${window.F.pct(first, 2)} · ${window.F.date(new Date(series[0].t).toISOString())}</span>
    <span>${window.F.pct(last, 2)} · now</span>
  </div>`;
}

function bands(exp) {
  if (!exp || !Number.isFinite(exp.p10) || !Number.isFinite(exp.p90)) return '';
  const lo = Math.min(exp.p10, -5); const hi = Math.max(exp.p90, 5);
  const span = hi - lo || 1;
  const pos = (v) => `${(((v - lo) / span) * 100).toFixed(1)}%`;
  return `<div class="bandbar">
    <div class="track"></div>
    <div class="range" style="left:${pos(exp.p10)};right:${(100 - parseFloat(pos(exp.p90))).toFixed(1)}%"></div>
    <div class="mid" style="left:${pos(exp.p50 ?? exp.annualReturn)}"></div>
    <div class="lbl" style="left:${pos(exp.p10)}">${window.F.pctSigned(exp.p10, 0)}</div>
    <div class="lbl" style="left:${pos(exp.p90)}">${window.F.pctSigned(exp.p90, 0)}</div>
  </div>`;
}

R.drawer = (detail, ctx) => {
  if (!detail) return '';
  const o = detail.opportunity;
  const s = o.scores || {};
  const spec = o.yieldKind === 'expected';
  const watched = ctx.watchlist.includes(o.id);
  const traps = s.traps?.detail || [];
  const factors = s.risk?.factors || [];
  const tax = o.tax || {};

  const big = spec
    ? [
      ['v', window.F.pctSigned(o.expected?.annualReturn, 1), 'Expected / yr'],
      ['v', window.F.pctSigned(o.expected?.p10, 0), 'Bad case (p10)'],
      ['v', window.F.pctSigned(o.expected?.p90, 0), 'Good case (p90)'],
      ['v', Number.isFinite(o.expected?.probabilityOfLoss) ? `${Math.round(o.expected.probabilityOfLoss * 100)}%` : '—', 'Chance of loss'],
    ]
    : [
      ['v', window.F.pct(o.apy?.total, 2), 'Headline APY'],
      ['v', window.F.pct(tax.afterTaxApy, 2), 'After your tax'],
      ['v', window.F.pct(tax.taxEquivalentYield, 2), 'Tax-equivalent'],
      ['v', window.F.pct(tax.afterTaxRealApy, 2), 'After inflation'],
    ];

  return `
  <div class="dhead">
    <div class="top">
      <h2>${esc(o.name)}</h2>
      <button class="btn ghost icon" data-act="watch" data-id="${esc(o.id)}" title="${watched ? 'Unwatch' : 'Watch'}"><span class="star ${watched ? 'on' : ''}">${watched ? '★' : '☆'}</span></button>
      <button class="btn ghost icon" data-act="close-drawer" title="Close">✕</button>
    </div>
    <div class="sub">
      <span>${esc(ctx.classes[o.assetClass] || o.assetClass)}</span>
      ${o.symbol ? `<span>· ${esc(o.symbol)}</span>` : ''}
      ${o.chain ? `<span>· ${esc(o.chain)}</span>` : ''}
      <span>· via ${esc(o.sourceLabel || o.source)}</span>
      ${o.seed ? '<span class="badge snap">snapshot</span>' : ''}
      ${spec ? '<span class="badge spec">estimate</span>' : ''}
    </div>
  </div>

  <div class="dsection">
    <div class="bignum">${big.map(([, v, k]) => `<div class="item"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('')}</div>
    ${spec ? bands(o.expected) : ''}
    ${o.notes ? `<div class="infobox" style="margin-top:12px">${esc(o.notes)}</div>` : ''}
  </div>

  ${!spec ? `<div class="dsection">
    <h4>On ${window.F.money(ctx.budget)}</h4>
    <div class="bignum">
      <div class="item"><div class="v" style="color:var(--pos)">${window.F.money(s.incomeYear1, { dp: 0 })}</div><div class="k">After tax, year 1</div></div>
      <div class="item"><div class="v" style="color:var(--pos)">${window.F.money(s.income5yr, { dp: 0 })}</div><div class="k">After tax, 5 years</div></div>
    </div>
  </div>` : ''}

  ${traps.length ? `<div class="dsection">
    <h4>What to watch out for</h4>
    ${traps.map((t) => `<div class="warnbox ${t.points >= 15 ? 'severe' : 'mild'}">
      <div class="ttl">${esc(String(t.flag).replace(/_/g, ' '))}</div>${esc(t.message)}
    </div>`).join('')}
  </div>` : ''}

  <div class="dsection">
    <h4>Why this risk score (${s.risk?.score ?? '—'} · ${esc(s.risk?.tierLabel || '—')})</h4>
    ${factors.map((f) => `<div class="factor">
      <span class="pts ${f.points > 0 ? 'plus' : 'minus'}">${f.points > 0 ? '+' : ''}${f.points}</span>
      <span class="lbl">${esc(f.label)}</span>
    </div>`).join('')}
    ${s.risk?.volatilityAssumed ? '<div class="infobox" style="margin-top:9px;font-size:11px">Volatility was assumed from the asset class because this source does not report it.</div>' : ''}
  </div>

  ${!spec ? `<div class="dsection">
    <h4>Tax</h4>
    <dl class="kv">
      <dt>Treatment</dt><dd>${esc(window.F.taxTreatment(o.taxTreatment))}</dd>
      <dt>Your rate on it</dt><dd>${tax.effectiveTaxRate ?? '—'}%</dd>
      <dt>Keeps</dt><dd>${window.F.pct(tax.afterTaxApy, 2)} of ${window.F.pct(tax.grossApy, 2)}</dd>
    </dl>
    ${(tax.parts || []).length ? `<div style="margin-top:9px">${tax.parts.map((p) => `<div class="factor"><span class="pts">${p.rate}%</span><span class="lbl">${esc(p.label)}</span></div>`).join('')}</div>` : ''}
  </div>` : ''}

  <div class="dsection">
    <h4>Terms</h4>
    <dl class="kv">
      <dt>Rate type</dt><dd>${esc(window.F.yieldKind(o.yieldKind))}</dd>
      <dt>Length</dt><dd>${esc(o.term?.label || 'Open-ended')}${o.term?.maturity ? ` · matures ${window.F.date(o.term.maturity)}` : ''}</dd>
      <dt>Getting out</dt><dd>${esc(window.F.liquidity(o.liquidity))}${o.term?.earlyExitPenalty ? ` · ${esc(o.term.earlyExitPenalty)}` : ''}</dd>
      <dt>Protection</dt><dd>${esc(window.F.insurance(o.risk?.insurance))}${o.risk?.insuredLimit ? ` up to ${window.F.money(o.risk.insuredLimit)}` : ''}</dd>
      ${Number.isFinite(o.minInvestment) ? `<dt>Minimum</dt><dd>${window.F.money(o.minInvestment, { dp: 2 })}</dd>` : ''}
      ${Number.isFinite(o.maxInvestment) ? `<dt>Cap</dt><dd>${window.F.money(o.maxInvestment)}</dd>` : ''}
      ${Number.isFinite(o.price) ? `<dt>Share price</dt><dd>${window.F.moneyExact(o.price)}</dd>` : ''}
      ${Number.isFinite(o.tvl) ? `<dt>Size</dt><dd>${window.F.money(o.tvl)}</dd>` : ''}
      ${Number.isFinite(o.expenseRatio) ? `<dt>Expense ratio</dt><dd>${window.F.pct(o.expenseRatio, 2)}</dd>` : ''}
      <dt>Confidence</dt><dd>${Math.round((o.confidence ?? 0) * 100)}%</dd>
      <dt>Rate as of</dt><dd>${window.F.date(o.dataAsOf)} <span style="color:var(--text-faint)">(${window.F.ago(o.dataAsOf)})</span></dd>
    </dl>
    ${(o.requirements || []).length ? `<div class="infobox" style="margin-top:10px"><b>Requirements:</b> ${o.requirements.map(esc).join(' · ')}</div>` : ''}
  </div>

  ${detail.series?.length > 1 ? `<div class="dsection">
    <h4>Rate history you've recorded</h4>
    ${sparkline(detail.series)}
  </div>` : ''}

  ${spec && o.expected?.basis?.length ? `<div class="dsection">
    <h4>How the estimate was built</h4>
    ${o.expected.basis.map((b) => `<div class="factor"><span class="pts">·</span><span class="lbl">${esc(b)}</span></div>`).join('')}
    ${o.expected.thesis ? `<div class="infobox" style="margin-top:10px">${esc(o.expected.thesis)}</div>` : ''}
  </div>` : ''}

  <div class="dsection">
    <h4>How to buy it</h4>
    <div class="infobox">${esc(o.accessNotes || 'No access notes recorded for this one.')}</div>
    <div style="display:flex;gap:7px;margin-top:11px;flex-wrap:wrap">
      ${o.url ? `<button class="btn sm" data-act="open" data-url="${esc(o.url)}">Open source ↗</button>` : ''}
      <button class="btn sm" data-act="alert" data-id="${esc(o.id)}">Alert me if it changes</button>
      <button class="btn ghost sm" data-act="dismiss" data-id="${esc(o.id)}">Never show again</button>
    </div>
  </div>`;
};

window.R = R;
