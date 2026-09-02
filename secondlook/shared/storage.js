/* shared/storage.js - storage, stats, event log, salt.
 * Classic script, attaches SL.Storage; safe to load in any runtime. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.Storage) return;
  const EVENTS_KEY = 'sl.events';
  const EVENTS_MAX = 200;   // tuning: local event-log cap
  const STATS_KEY = 'sl.stats';
  const SALT_KEY = 'sl.salt';
  async function localGet(key, fallback) {
    const got = await chrome.storage.local.get(key);
    return (key in got && got[key] !== undefined) ? got[key] : fallback;
  }
  async function localSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }
  /* storage.session is reachable from the SW and extension pages only.
   * Content scripts report through SL.msg instead - by design, so no
   * setAccessLevel call ever widens session data to page worlds. */
  async function sessionGet(key, fallback) {
    if (!chrome.storage.session) return fallback;
    const got = await chrome.storage.session.get(key);
    return (key in got && got[key] !== undefined) ? got[key] : fallback;
  }
  async function sessionSet(key, value) {
    if (!chrome.storage.session) return;
    await chrome.storage.session.set({ [key]: value });
  }
  async function getStats() {
    return localGet(STATS_KEY, {
      byVerdict: { CLEAR: 0, SECOND_LOOK: 0, INTERCEPTED: 0 },
      byModule: {}
    });
  }
  async function bumpStat(moduleId, verdict) {
    const stats = await getStats();
    if (verdict && stats.byVerdict[verdict] !== undefined) {
      stats.byVerdict[verdict] += 1;
    }
    stats.byModule[moduleId] = (stats.byModule[moduleId] || 0) + 1;
    await localSet(STATS_KEY, stats);
  }
  /* Privacy boundary: events persist the HOST only, never the full URL,
   * so the local log can never be reconstructed into a browsing history. */
  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }
  async function pushEvent(evt) {
    const list = await localGet(EVENTS_KEY, []);
    list.unshift({
      ts: Date.now(),
      module: evt.module || '?',
      verdict: evt.verdict || null,
      host: hostOf(evt.url || ''),        // hostname only, by design
      note: evt.note || ''
    });
    await localSet(EVENTS_KEY, list.slice(0, EVENTS_MAX));
  }
  async function getEvents(limit) {
    const list = await localGet(EVENTS_KEY, []);
    return typeof limit === 'number' ? list.slice(0, limit) : list;
     }
  async function pruneEvents() {
    const list = await localGet(EVENTS_KEY, []);
    if (list.length && list.length < EVENTS_MAX * 0.75) return 0;
    await localSet(EVENTS_KEY, list.slice(0, EVENTS_MAX));
    return list.length - EVENTS_MAX;
  }
  /* Random per-install salt; used by Form Guardian to store salted
   * hashes of approved origins instead of the origins themselves. */
  async function ensureSalt() {
    let salt = await localGet(SALT_KEY, null);
    if (!salt) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      salt = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await localSet(SALT_KEY, salt);
    }
    return salt;
  }
  async function resetData() {
    await chrome.storage.local.remove([EVENTS_KEY, STATS_KEY]);
  }
  root.Storage = {
    localGet, localSet, sessionGet, sessionSet,
    getStats, bumpStat, pushEvent, getEvents, pruneEvents,
    ensureSalt, resetData,
    EVENTS_MAX
  };
})(globalThis);