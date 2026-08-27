'use strict';

/* Formatting helpers. Numbers people read while deciding where money goes must
   be unambiguous: always signed where sign matters, always the same number of
   decimals within a column, never a bare rounded integer that hides a difference. */

const F = {
  pct(v, dp = 2) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return `${Math.round(v).toLocaleString()}%`;
    return `${v.toFixed(dp)}%`;
  },

  pctSigned(v, dp = 2) {
    if (!Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
  },

  money(v, { dp = 0, sign = false } = {}) {
    if (!Number.isFinite(v)) return '—';
    const s = sign && v > 0 ? '+' : '';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${s}$${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${s}$${(v / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
    if (abs >= 1e4) return `${s}$${Math.round(v).toLocaleString()}`;
    return `${s}$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  },

  moneyExact(v) {
    if (!Number.isFinite(v)) return '—';
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  compact(v) {
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
    return String(Math.round(v));
  },

  term(o) {
    const d = o?.term?.days;
    if (o?.term?.label) return o.term.label;
    if (!Number.isFinite(d) || d <= 0) return 'Open';
    if (d < 31) return `${Math.round(d)}d`;
    if (d < 365) return `${Math.round(d / 30.44)}mo`;
    const y = d / 365.25;
    return y % 1 < 0.08 || y % 1 > 0.92 ? `${Math.round(y)}y` : `${y.toFixed(1)}y`;
  },

  liquidity(l) {
    return ({
      instant: 'Instant', daily: 'Daily', settled: 'T+2',
      notice: 'Notice period', locked: 'Locked', illiquid: 'Illiquid',
    })[l] || l || '—';
  },

  insurance(i) {
    return ({
      us_gov: 'US Government', fdic: 'FDIC', ncua: 'NCUA',
      sipc: 'SIPC (custody only)', private: 'Private', none: 'None',
    })[i] || '—';
  },

  taxTreatment(t) {
    return ({
      ordinary: 'Ordinary income',
      qualified_dividend: 'Qualified dividend',
      treasury: 'Treasury — state tax exempt',
      muni_federal_exempt: 'Municipal — federal exempt',
      muni_triple_exempt: 'Municipal — triple exempt',
      section_199a: 'REIT/BDC — 20% §199A deduction',
      return_of_capital: 'Return of capital (deferred)',
      capital_gain_long: 'Long-term capital gain',
      mixed: 'Mixed distribution',
      tax_deferred: 'Tax deferred',
    })[t] || t || '—';
  },

  yieldKind(k) {
    return ({
      contractual: 'Contractual — fixed for the term',
      administered: 'Administered — issuer can change it',
      market: 'Market rate',
      trailing: 'Trailing 12 months',
      forward: 'Forward annualised',
      variable: 'Variable',
      expected: 'Modelled expectation',
    })[k] || k || '—';
  },

  ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    const d = Math.round(s / 86400);
    if (d < 45) return `${d}d ago`;
    return `${Math.round(d / 30.44)}mo ago`;
  },

  date(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  },

  /** Escapes anything going into innerHTML. Source data is third-party text. */
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },
};

window.F = F;
