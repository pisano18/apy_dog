'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Disk cache with TTL.
 *
 * Two jobs: stop us re-hammering free public APIs on every refresh, and keep the
 * app fully usable offline. A stale entry is better than an empty table, so
 * `get` can return expired data explicitly flagged as stale rather than nothing.
 */

class Cache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(key) {
    const safe = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 24);
    const hint = String(key).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
    return path.join(this.dir, `${hint}.${safe}.json`);
  }

  /** @returns {{value:any, age:number, stale:boolean}|null} */
  get(key, ttlMs = 3600e3, { allowStale = true } = {}) {
    const f = this._file(key);
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      const age = Date.now() - parsed.storedAt;
      const stale = age > ttlMs;
      if (stale && !allowStale) return null;
      return { value: parsed.value, age, stale, storedAt: parsed.storedAt };
    } catch {
      return null;
    }
  }

  set(key, value) {
    const f = this._file(key);
    const payload = JSON.stringify({ key: String(key), storedAt: Date.now(), value });
    const tmp = `${f}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, f);   // atomic, so a crash mid-write cannot corrupt the cache
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      return false;
    }
  }

  /**
   * Fetch-through helper: return fresh cache, otherwise call `producer`. If the
   * producer throws and we hold stale data, serve the stale data — an old rate
   * with a warning beats a blank screen.
   */
  async wrap(key, ttlMs, producer) {
    const hit = this.get(key, ttlMs);
    if (hit && !hit.stale) return { value: hit.value, fromCache: true, stale: false, age: hit.age };
    try {
      const value = await producer();
      this.set(key, value);
      return { value, fromCache: false, stale: false, age: 0 };
    } catch (err) {
      if (hit) return { value: hit.value, fromCache: true, stale: true, age: hit.age, error: err };
      throw err;
    }
  }

  clear(prefix = null) {
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (prefix && !f.startsWith(String(prefix).replace(/[^a-zA-Z0-9._-]+/g, '-'))) continue;
      try { fs.unlinkSync(path.join(this.dir, f)); n += 1; } catch { /* ignore */ }
    }
    return n;
  }

  stats() {
    let bytes = 0, count = 0;
    for (const f of fs.readdirSync(this.dir)) {
      try { bytes += fs.statSync(path.join(this.dir, f)).size; count += 1; } catch { /* ignore */ }
    }
    return { count, bytes, dir: this.dir };
  }
}

module.exports = { Cache };
