'use strict';

const C = require('./constants');

/**
 * Export.
 *
 * The CSV is deliberately wide and deliberately explicit: if someone is going to
 * take these numbers into a spreadsheet and make a decision there, the file has
 * to carry the caveats with it. That means the trap flags, the confidence, the
 * as-of date and whether the row was a live quote or the bundled snapshot travel
 * with the rate — not just the headline number, which is the part most likely to
 * be wrong and the only part most exports keep.
 */

const COLUMNS = [
  ['Name', (o) => o.name],
  ['Symbol', (o) => o.symbol ?? ''],
  ['Category', (o) => C.ASSET_CLASS_LABELS[o.assetClass] || o.assetClass],
  ['Source', (o) => o.sourceLabel || o.source],
  ['APY %', (o) => o.apy?.total ?? ''],
  ['Base APY %', (o) => o.apy?.base ?? ''],
  ['Reward APY %', (o) => o.apy?.reward ?? ''],
  ['30d mean APY %', (o) => o.apy?.mean30d ?? ''],
  ['Expected return %', (o) => o.expected?.annualReturn ?? ''],
  ['Expected p10 %', (o) => o.expected?.p10 ?? ''],
  ['Expected p90 %', (o) => o.expected?.p90 ?? ''],
  ['Chance of loss', (o) => o.expected?.probabilityOfLoss ?? ''],
  ['After-tax %', (o) => o.tax?.afterTaxApy ?? ''],
  ['Tax-equivalent %', (o) => o.tax?.taxEquivalentYield ?? ''],
  ['After-tax real %', (o) => o.tax?.afterTaxRealApy ?? ''],
  ['Your tax rate on it %', (o) => o.tax?.effectiveTaxRate ?? ''],
  ['Dog score', (o) => o.scores?.dogScore ?? ''],
  ['Certainty equivalent %', (o) => o.scores?.certaintyEquivalent ?? ''],
  ['Sharpe', (o) => o.scores?.sharpe ?? ''],
  ['Risk score', (o) => o.risk?.score ?? ''],
  ['Risk tier', (o) => o.risk?.tierLabel ?? ''],
  ['Catastrophic risk /yr', (o) => o.scores?.tail?.annualProbability ?? ''],
  ['Trap score', (o) => o.trapScore ?? ''],
  ['Warning flags', (o) => (o.trapFlags || []).join(' ')],
  ['Committed for', (o) => (['lockup', 'maturity'].includes(o.term?.kind) ? o.term.label : 'Open')],
  ['Term days', (o) => (['lockup', 'maturity'].includes(o.term?.kind) ? o.term.days : '')],
  ['Term kind', (o) => o.term?.kind ?? ''],
  ['Liquidity', (o) => o.liquidity],
  ['Paid in', (o) => o.denomination ?? ''],
  ['Price', (o) => o.price ?? ''],
  ['Min investment', (o) => o.minInvestment ?? ''],
  ['Max investment', (o) => o.maxInvestment ?? ''],
  ['TVL / AUM', (o) => o.tvl ?? ''],
  ['Expense ratio %', (o) => o.expenseRatio ?? ''],
  ['Insurance', (o) => o.risk?.insurance ?? ''],
  ['Tax treatment', (o) => o.taxTreatment],
  ['Rate type', (o) => o.yieldKind],
  ['Confidence', (o) => o.confidence ?? ''],
  ['Income yr 1', (o) => o.scores?.incomeYear1 ?? ''],
  ['Income 5 yr', (o) => o.scores?.income5yr ?? ''],
  ['Rate as of', (o) => o.dataAsOf ?? ''],
  ['Live or snapshot', (o) => (o.seed ? 'bundled snapshot' : 'live')],
  ['How to buy', (o) => o.accessNotes ?? ''],
  ['Requirements', (o) => (o.requirements || []).join('; ')],
  ['URL', (o) => o.url ?? ''],
];

/**
 * RFC 4180 escaping, plus one hardening step: a cell starting with =, +, - or @
 * is prefixed with a single quote. Excel and Sheets treat those as formulas, and
 * this file contains names pulled from third-party feeds — a pool called
 * "=HYPERLINK(...)" should land in a cell, not execute.
 */
function escapeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && s.trim() !== '' && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows, { meta = null } = {}) {
  const lines = [];
  if (meta) {
    // A leading comment block so a file opened months later still explains itself.
    lines.push(`# APY Dog export — ${meta.generatedAt || new Date().toISOString()}`);
    lines.push(`# ${meta.total ?? rows.length} opportunities found, ${meta.liveRows ?? '?'} live and ${meta.seedRows ?? '?'} from the bundled snapshot`);
    lines.push(`# Risk-free rate used: ${meta.riskFree ?? '?'}% (${meta.riskFreeSource || 'unknown'})`);
    lines.push('# Rates are not quotes. Verify with the provider before moving money.');
  }
  lines.push(COLUMNS.map((c) => escapeCell(c[0])).join(','));
  for (const o of rows) lines.push(COLUMNS.map((c) => escapeCell(c[1](o))).join(','));
  return `${lines.join('\n')}\n`;
}

function toJSON(rows, { meta = null } = {}) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    disclaimer: 'Rates are collected from public feeds or a bundled snapshot and are not quotes. '
      + 'Verify with the provider before acting. Risk scores and warning flags are APY Dog\'s own '
      + 'computed opinion, not advice.',
    meta,
    count: rows.length,
    opportunities: rows,
  }, null, 2);
}

module.exports = { toCSV, toJSON, escapeCell, COLUMNS };
