'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateAdapter } = require('./_contract');

/**
 * Source registry.
 *
 * Adapters are discovered from this directory rather than hand-listed, so adding
 * a new data source is one file and nothing else. An adapter that fails to load
 * or fails contract validation is reported and skipped — a broken new source
 * must not stop the app from starting.
 */

const SKIP = new Set(['index.js', '_contract.js']);

function loadAdapters({ dir = __dirname, log = () => {} } = {}) {
  const adapters = [];
  const problems = [];

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !SKIP.has(f) && !f.endsWith('.test.js'));
  } catch (err) {
    return { adapters, problems: [{ file: dir, error: String(err) }] };
  }

  for (const file of files.sort()) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(path.join(dir, file));
      const issues = validateAdapter(mod);
      if (issues.length) {
        problems.push({ file, error: `contract violations: ${issues.join('; ')}` });
        log(`skipping ${file}: ${issues.join('; ')}`);
        continue;
      }
      if (adapters.some((a) => a.id === mod.id)) {
        problems.push({ file, error: `duplicate adapter id "${mod.id}"` });
        continue;
      }
      adapters.push(mod);
    } catch (err) {
      problems.push({ file, error: err?.message || String(err) });
      log(`failed to load ${file}: ${err?.message || err}`);
    }
  }

  // Treasury first: the aggregator reads the risk-free rate from it, and a
  // deterministic order makes runs reproducible.
  const priority = { treasury: 0, savings: 1, bonds: 2, funds: 3, defillama: 4, speculative: 5 };
  adapters.sort((a, b) => (priority[a.id] ?? 50) - (priority[b.id] ?? 50) || a.id.localeCompare(b.id));

  return { adapters, problems };
}

/** Lightweight descriptors for the Sources settings panel. */
function describeAdapters(adapters) {
  return adapters.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description || '',
    homepage: a.homepage || null,
    assetClasses: a.assetClasses || [],
    requiresNetwork: a.requiresNetwork !== false,
    requiresKey: !!a.requiresKey,
    defaultEnabled: a.defaultEnabled !== false,
    ttlMs: a.ttlMs || 3600e3,
  }));
}

module.exports = { loadAdapters, describeAdapters };
