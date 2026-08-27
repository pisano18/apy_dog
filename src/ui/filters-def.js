'use strict';

/**
 * The filter catalogue.
 *
 * Every filter the app supports is declared here once, with the metadata the UI
 * needs to render it, describe it and turn it into a removable pill. The old
 * sidebar hardcoded each control in markup, which is why adding one meant editing
 * three places and why the panel grew into a wall of switches.
 *
 * Declaring them as data buys three things the user asked for: a searchable
 * "add filter" menu instead of a permanently-visible wall, pills that show
 * exactly what is currently applied, and one Clear-all that provably resets
 * everything because it iterates this list.
 */

(function () {
  const G = {
    RETURN: 'Return',
    SAFETY: 'Risk & safety',
    TYPE: 'What it is',
    TIMING: 'Timing & access',
    MONEY: 'Money in',
    MOVEMENT: 'Movement',
    DATA: 'Data quality',
  };

  /**
   * type:
   *   range   -> two numbers, keys [minKey, maxKey]
   *   number  -> one number
   *   multi   -> array of values chosen from options
   *   bool    -> checkbox
   *   select  -> single value from options
   *   text    -> free text
   */
  const DEFS = [
    // ---- Return -----------------------------------------------------------
    {
      key: 'apy', type: 'range', keys: ['minApy', 'maxApy'], group: G.RETURN,
      label: 'Yield', unit: '%', track: 'income',
      description: 'Annual percentage yield, on whichever basis you are comparing.',
      format: (q) => rangeText(q.minApy, q.maxApy, '%'),
    },
    {
      key: 'apyBasis', type: 'select', keys: ['apyBasis'], group: G.RETURN,
      label: 'Compare yields as', track: 'income',
      description: 'Headline is what it advertises. After-tax is what you keep.',
      options: [
        ['headline', 'Headline APY'],
        ['afterTax', 'After tax'],
        ['taxEquivalent', 'Tax-equivalent'],
        ['afterTaxReal', 'After tax and inflation'],
      ],
      isDefault: (v) => !v || v === 'headline',
      format: (q) => ({ headline: 'Headline', afterTax: 'After tax', taxEquivalent: 'Tax-equivalent', afterTaxReal: 'After tax + inflation' }[q.apyBasis] || 'Headline'),
    },
    {
      key: 'income', type: 'number', keys: ['minIncomeYear1'], group: G.RETURN,
      label: 'Income in year 1', unit: '$', track: 'income',
      description: 'At least this much cash in the first year, on the amount you plan to deploy.',
      format: (q) => `at least $${Number(q.minIncomeYear1).toLocaleString()}`,
    },

    // ---- Risk & safety ----------------------------------------------------
    {
      key: 'grade', type: 'multi', keys: ['grades'], group: G.SAFETY,
      label: 'Safety grade',
      description: 'A+ is government-guaranteed. F means you can lose all of it.',
      options: [['A+', 'A+'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['F', 'F']],
      format: (q) => q.grades.join(', '),
    },
    {
      key: 'insuredOnly', type: 'bool', keys: ['insuredOnly'], group: G.SAFETY,
      label: 'Insured or government-backed only',
      description: 'FDIC, NCUA or full faith and credit. Nothing else.',
      format: () => 'on',
    },
    {
      key: 'minPrincipal', type: 'number', keys: ['minPrincipalAxis'], group: G.SAFETY,
      label: 'Principal safety at least', unit: '/5',
      description: 'The principal-safety axis, 0 to 5.',
      format: (q) => `${q.minPrincipalAxis}/5 or better`,
    },
    {
      key: 'maxRisk', type: 'number', keys: ['maxRisk'], group: G.SAFETY,
      label: 'Max risk score', unit: '/100',
      description: 'The underlying 0-100 risk number, if you prefer it to grades.',
      format: (q) => `${q.maxRisk} or below`,
    },
    {
      key: 'hideTraps', type: 'bool', keys: ['hideTraps'], group: G.SAFETY,
      label: 'Hide likely yield traps', defaultOn: true,
      description: 'Hides rows the trap detector rates as probably not real money.',
      format: () => 'on',
    },
    {
      key: 'excludeFlags', type: 'multi', keys: ['excludeFlags'], group: G.SAFETY,
      label: 'Exclude specific warnings',
      description: 'Drop anything carrying these particular flags.',
      optionsFrom: 'trapFlags',
      format: (q) => `${q.excludeFlags.length} excluded`,
    },

    // ---- What it is -------------------------------------------------------
    {
      key: 'assetClasses', type: 'multi', keys: ['assetClasses'], group: G.TYPE,
      label: 'Category',
      description: 'Savings, CDs, Treasuries, ETFs, REITs, DeFi and so on.',
      optionsFrom: 'assetClasses',
      format: (q, ctx) => q.assetClasses.map((k) => ctx.classes[k] || k).join(', '),
    },
    {
      key: 'denominations', type: 'multi', keys: ['denominations'], group: G.TYPE,
      label: 'Paid in',
      description: 'Dollars, stablecoins, or a volatile crypto asset.',
      options: [['usd', 'Dollars'], ['stable', 'Stablecoins'], ['crypto', 'Crypto']],
      format: (q) => q.denominations.map((d) => ({ usd: 'dollars', stable: 'stablecoins', crypto: 'crypto' }[d] || d)).join(', '),
    },
    {
      key: 'sources', type: 'multi', keys: ['sources'], group: G.TYPE,
      label: 'Data source',
      description: 'Which feed the row came from.',
      optionsFrom: 'sources',
      format: (q, ctx) => q.sources.map((s) => (ctx.sourceLabels || {})[s] || s).join(', '),
    },
    {
      key: 'chains', type: 'multi', keys: ['chains'], group: G.TYPE,
      label: 'Chain',
      description: 'For on-chain positions only.',
      optionsFrom: 'chains',
      format: (q) => q.chains.join(', '),
    },
    {
      key: 'taxTreatments', type: 'multi', keys: ['taxTreatments'], group: G.TYPE,
      label: 'Tax treatment', track: 'income',
      description: 'Treasury interest, municipal, qualified dividends and the rest.',
      optionsFrom: 'taxTreatments',
      format: (q) => `${q.taxTreatments.length} selected`,
    },

    // ---- Timing & access --------------------------------------------------
    {
      key: 'termPreset', type: 'select', keys: ['termPreset'], group: G.TIMING,
      label: 'How long committed',
      description: 'Real lockups and maturities only. A bond fund you can sell daily counts as no lockup.',
      optionsFrom: 'termPresets',
      isDefault: (v) => !v || v === 'any',
      format: (q, ctx) => (ctx.termPresets.find((p) => p.key === q.termPreset) || {}).label || q.termPreset,
    },
    {
      key: 'termDays', type: 'range', keys: ['termMinDays', 'termMaxDays'], group: G.TIMING,
      label: 'Exact term', unit: ' days',
      description: 'Precise day range, for building a ladder.',
      format: (q) => rangeText(q.termMinDays, q.termMaxDays, 'd'),
    },
    {
      key: 'maxLockupDays', type: 'number', keys: ['maxLockupDays'], group: G.TIMING,
      label: 'Max lockup', unit: ' days',
      description: 'Never tie money up longer than this.',
      format: (q) => `${q.maxLockupDays} days or less`,
    },
    {
      key: 'liquidity', type: 'multi', keys: ['liquidity'], group: G.TIMING,
      label: 'How you exit',
      description: 'Instant, daily, notice period, locked.',
      optionsFrom: 'liquidity',
      format: (q) => q.liquidity.join(', '),
    },

    // ---- Money in ---------------------------------------------------------
    {
      key: 'minInvestmentMax', type: 'number', keys: ['minInvestmentMax'], group: G.MONEY,
      label: 'Most I would put in', unit: '$',
      description: 'Hides anything whose entry minimum is higher than this.',
      format: (q) => `$${Number(q.minInvestmentMax).toLocaleString()} or less to enter`,
    },
    {
      key: 'price', type: 'range', keys: ['priceMin', 'priceMax'], group: G.MONEY,
      label: 'Share price', unit: '$',
      description: 'Per-share or per-unit price. Only applies to things that have one.',
      format: (q) => rangeText(q.priceMin, q.priceMax, '$', true),
    },
    {
      key: 'minTvl', type: 'number', keys: ['minTvl'], group: G.MONEY,
      label: 'Minimum size', unit: '$',
      description: 'Fund AUM or pool TVL floor. Thin things are hard to exit.',
      format: (q) => `over $${abbrev(q.minTvl)}`,
    },

    // ---- Movement ---------------------------------------------------------
    {
      key: 'minHeat', type: 'number', keys: ['minHeat'], group: G.MOVEMENT,
      label: 'Minimum heat', unit: '/100', track: 'movement',
      description: 'How much is likely to happen here soon. Not a forecast of direction.',
      format: (q) => `${q.minHeat}+`,
    },
    {
      key: 'setups', type: 'multi', keys: ['setups'], group: G.MOVEMENT,
      label: 'Setup', track: 'movement',
      description: 'Coiled, expanding, breaking out, deep drawdown and so on.',
      optionsFrom: 'setups',
      format: (q, ctx) => q.setups.map((k) => (ctx.setupInfo[k] || {}).label || k).join(', '),
    },
    {
      key: 'severities', type: 'multi', keys: ['severities'], group: G.MOVEMENT,
      label: 'How severe a move', track: 'movement',
      description: 'The size of the plausible move over your horizon.',
      optionsFrom: 'severities',
      format: (q) => q.severities.join(', '),
    },
    {
      key: 'lean', type: 'multi', keys: ['leans'], group: G.MOVEMENT,
      label: 'Direction lean', track: 'movement',
      description: 'Usually "none", which is the honest answer for most things.',
      options: [['up', 'Leans up'], ['down', 'Leans down'], ['none', 'No lean']],
      format: (q) => q.leans.join(', '),
    },
    {
      key: 'catalystWithin', type: 'number', keys: ['catalystWithinDays'], group: G.MOVEMENT,
      label: 'Catalyst within', unit: ' days', track: 'movement',
      description: 'Only things with a dated event coming up inside this window.',
      format: (q) => `next ${q.catalystWithinDays} days`,
    },
    {
      key: 'eventKinds', type: 'multi', keys: ['eventKinds'], group: G.MOVEMENT,
      label: 'Kind of catalyst', track: 'movement',
      description: 'Earnings, Fed decision, CPI, token unlock, a filing.',
      optionsFrom: 'eventKinds',
      format: (q) => `${q.eventKinds.length} kinds`,
    },
    {
      key: 'minClarity', type: 'select', keys: ['minClarity'], group: G.MOVEMENT,
      label: 'Minimum signal clarity', track: 'movement',
      description: 'How legible the situation is. Never a claim about direction.',
      options: [['faint', 'Faint or better'], ['clear', 'Clear or better'], ['sharp', 'Sharp only']],
      format: (q) => q.minClarity,
    },

    // ---- Data quality -----------------------------------------------------
    {
      key: 'minConfidence', type: 'number', keys: ['minConfidence'], group: G.DATA,
      label: 'Minimum confidence', unit: '%',
      description: 'How much we trust the numbers on the row.',
      format: (q) => `${Math.round(q.minConfidence * 100)}%+`,
      encode: (v) => Number(v) / 100,
      decode: (v) => Math.round((v || 0) * 100),
    },
    {
      key: 'hideSeed', type: 'bool', keys: ['hideSeed'], group: G.DATA,
      label: 'Live data only',
      description: 'Hide anything still showing the bundled snapshot.',
      format: () => 'on',
    },
    {
      key: 'measuredOnly', type: 'bool', keys: ['measuredOnly'], group: G.DATA,
      label: 'Measured only',
      description: 'Hide index-only rows that we have identity for but have not analysed.',
      format: () => 'on',
    },
    {
      key: 'watchlistOnly', type: 'bool', keys: ['watchlistOnly'], group: G.DATA,
      label: 'Watchlist only',
      description: 'Just the things you are tracking.',
      format: () => 'on',
    },
    {
      key: 'strictUnknowns', type: 'bool', keys: ['strictUnknowns'], group: G.DATA,
      label: 'Strict about missing data',
      description: 'Drop rows where a field you filtered on is unknown, rather than letting them through.',
      format: () => 'on',
    },
  ];

  function rangeText(min, max, unit, prefix = false) {
    const f = (v) => (prefix ? `${unit}${v}` : `${v}${unit}`);
    if (min !== null && min !== undefined && min !== '' && max !== null && max !== undefined && max !== '') return `${f(min)}–${f(max)}`;
    if (min !== null && min !== undefined && min !== '') return `over ${f(min)}`;
    if (max !== null && max !== undefined && max !== '') return `under ${f(max)}`;
    return 'any';
  }

  function abbrev(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
    return String(n);
  }

  /** Is this filter currently doing anything? */
  function isActive(def, q) {
    if (!q) return false;
    if (def.type === 'bool') {
      const v = q[def.keys[0]];
      return def.defaultOn ? v === false : v === true;
    }
    if (def.type === 'multi') {
      const v = q[def.keys[0]];
      return Array.isArray(v) && v.length > 0;
    }
    if (def.type === 'select') {
      const v = q[def.keys[0]];
      return def.isDefault ? !def.isDefault(v) : v !== null && v !== undefined && v !== '';
    }
    return def.keys.some((k) => q[k] !== null && q[k] !== undefined && q[k] !== '');
  }

  /** Reset just this filter back to its default. */
  function clear(def, q) {
    for (const k of def.keys) {
      if (def.type === 'multi') q[k] = [];
      else if (def.type === 'bool') q[k] = !!def.defaultOn;
      else q[k] = null;
    }
    return q;
  }

  window.FILTER_DEFS = DEFS;
  window.FILTER_GROUPS = G;
  window.filterIsActive = isActive;
  window.filterClear = clear;
}());
