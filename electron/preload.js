'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire bridge between the sandboxed UI and the app.
 *
 * Every function here is an explicit, named capability. The renderer gets no
 * `require`, no filesystem, no network and no generic "invoke anything" escape
 * hatch — if a channel is not listed below, the UI cannot reach it.
 */

const invoke = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `${channel} failed`);
  return res.data;
};

const listeners = new Map();
function on(channel, cb) {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(cb, { channel, wrapped });
  return () => {
    const entry = listeners.get(cb);
    if (entry) { ipcRenderer.removeListener(entry.channel, entry.wrapped); listeners.delete(cb); }
  };
}

contextBridge.exposeInMainWorld('apy', {
  bootstrap: () => invoke('app:bootstrap'),

  query: (q) => invoke('data:query', q),
  detail: (id) => invoke('data:detail', id),
  refresh: (opts) => invoke('data:refresh', opts),
  cancelRefresh: () => invoke('data:cancelRefresh'),
  health: () => invoke('data:health'),

  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  resetSettings: () => invoke('settings:reset'),

  toggleWatch: (id, name) => invoke('watch:toggle', id, name),
  setWatchNote: (id, note) => invoke('watch:note', id, note),
  watchlist: () => invoke('watch:list'),

  addAlert: (spec) => invoke('alert:add', spec),
  removeAlert: (id) => invoke('alert:remove', id),
  alerts: () => invoke('alert:list'),

  dismiss: (id) => invoke('row:dismiss', id),
  undismiss: (id) => invoke('row:undismiss', id),

  taxPreview: (treatment, profile) => invoke('tax:preview', treatment, profile),
  historyStats: () => invoke('history:stats'),
  cacheStats: () => invoke('cache:stats'),
  clearCache: () => invoke('cache:clear'),

  openExternal: (url) => invoke('shell:open', url),
  exportCSV: (q) => invoke('export:csv', q),
  exportJSON: (q) => invoke('export:json', q),
  openUserRates: () => invoke('userRates:open'),

  onProgress: (cb) => on('refresh:progress', cb),
  onDataUpdated: (cb) => on('data:updated', cb),
});
