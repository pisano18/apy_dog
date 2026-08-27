'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Rate history.
 *
 * Every refresh appends a compact snapshot per opportunity to a JSONL file. This
 * is what lets the app answer the question a one-shot screener cannot: "is this
 * 9% pool actually a 9% pool, or was it 3% last week?" A rate you have watched
 * for a month is a completely different proposition from one you just found, and
 * this is the only way to know the difference from your own machine.
 *
 * JSONL because appends must be cheap and a truncated final line must not
 * destroy the file.
 */

class History {
  constructor(dir, { maxDays = 400 } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'rate-history.jsonl');
    this.maxDays = maxDays;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Append one snapshot per opportunity that has a usable rate. */
  record(list, at = Date.now()) {
    const day = new Date(at).toISOString().slice(0, 10);
    const lines = [];
    for (const o of list) {
      const v = o?.apy?.total ?? o?.expected?.annualReturn;
      if (!Number.isFinite(v)) continue;
      lines.push(JSON.stringify({
        d: day,
        t: at,
        id: o.id,
        y: Math.round(v * 1000) / 1000,
        b: Number.isFinite(o.apy?.base) ? Math.round(o.apy.base * 1000) / 1000 : null,
        tv: Number.isFinite(o.tvl) ? Math.round(o.tvl) : null,
        p: Number.isFinite(o.price) ? Math.round(o.price * 10000) / 10000 : null,
        r: Number.isFinite(o.risk?.score) ? o.risk.score : null,
      }));
    }
    if (!lines.length) return 0;
    fs.appendFileSync(this.file, `${lines.join('\n')}\n`);
    return lines.length;
  }

  /** All recorded points for one opportunity, oldest first. */
  seriesFor(id, { days = 180 } = {}) {
    const cutoff = Date.now() - days * 86400000;
    const out = [];
    for (const rec of this._scan()) {
      if (rec.id !== id) continue;
      if (rec.t < cutoff) continue;
      out.push(rec);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * Change summary for a set of ids: current vs the value N days ago. This is
   * what powers the "rate is falling" indicator in the table.
   */
  changes(ids, { days = 30 } = {}) {
    const want = new Set(ids);
    const cutoff = Date.now() - days * 86400000;
    const first = new Map();
    const last = new Map();
    for (const rec of this._scan()) {
      if (!want.has(rec.id)) continue;
      if (rec.t < cutoff) continue;
      if (!first.has(rec.id)) first.set(rec.id, rec);
      last.set(rec.id, rec);
    }
    const out = {};
    for (const id of want) {
      const a = first.get(id); const b = last.get(id);
      if (!a || !b || a.t === b.t) { out[id] = null; continue; }
      out[id] = {
        from: a.y, to: b.y, delta: Math.round((b.y - a.y) * 1000) / 1000,
        days: Math.round((b.t - a.t) / 86400000),
        direction: b.y > a.y + 0.01 ? 'up' : b.y < a.y - 0.01 ? 'down' : 'flat',
      };
    }
    return out;
  }

  *_scan() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* a torn final line is expected; skip it */ }
    }
  }

  /** Drop points older than maxDays so the file cannot grow without bound. */
  prune() {
    const cutoff = Date.now() - this.maxDays * 86400000;
    let kept = 0, dropped = 0;
    const keep = [];
    for (const rec of this._scan()) {
      if (rec.t >= cutoff) { keep.push(JSON.stringify(rec)); kept += 1; } else dropped += 1;
    }
    if (dropped) {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '');
      fs.renameSync(tmp, this.file);
    }
    return { kept, dropped };
  }

  stats() {
    let n = 0; const ids = new Set(); let earliest = Infinity;
    for (const rec of this._scan()) { n += 1; ids.add(rec.id); if (rec.t < earliest) earliest = rec.t; }
    return {
      points: n,
      tracked: ids.size,
      since: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
      file: this.file,
    };
  }
}

module.exports = { History };
