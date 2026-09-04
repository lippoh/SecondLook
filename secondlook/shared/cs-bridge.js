/* SecondLook — shared/cs-bridge.js v3
 * The content-script bridge. Registered after settings.js in every
 * module's bundle; all bundles share one isolated world, so this file
 * may execute up to three times per page — the version guard below
 * makes repeats a no-op and UPGRADES any older bridge already present.
 *
 * v3 RESTORES two APIs the v2 rewrite dropped — the regression that
 * silently killed Link Sniper while Trust Badge (self-starting, no
 * stats) kept working:
 *   1. watch(id, cb) now fires IMMEDIATELY with the module's current
 *      state. Link Sniper activates from watch(); without an initial
 *      fire it never attached its hover listeners.
 *   2. bumpStat(module, field) is back — Link Sniper counts shown
 *      pills through it; a missing method made show() throw before
 *      the pill could render.
 *
 * Full surface: enabledFor | send | post | watch (initial fire) |
 *               listen | bumpStat   — a strict superset of every
 *               bridge version shipped so far.
 *
 * Backed by: storage.onChanged on the settings key (fires even while
 *            the SW sleeps) + SL_MODULE_STATE pushes from the SW.
 * Stats write to slStats only — never the settings key, so they can
 * never trigger script re-registration churn.
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  const API = 3;
  if (root.Bridge && (root.__bridgeAPI || 0) >= API) return;  // dedupe + no downgrades

  /* ================= Settings twin (subset; read-only) =====================
   * Only used if this file loads BEFORE shared/settings.js (not the case
   * in any current bundle — settings.js is always first). Deliberately
   * has NO set(): a bridge-solo content script must never write settings.
   * If settings.js loads later, its version guard replaces this twin. */
  if (!root.Settings) {
    const KEY = 'slSettings';
    const DEFAULTS = Object.freeze({
      modules: Object.freeze({
        'link-sniper': true,
        'redirect-detective': true,
        'trust-badge': true
      }),
      hosts: Object.freeze({})
    });
    const kebab = (id) => String(id == null ? '' : id)
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '');
    const normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
    function merge(base, over) {
      const out = Object.assign({}, base);
      if (!over || typeof over !== 'object') return out;
      for (const k of Object.keys(over)) {
        const b = out[k], o = over[k];
        out[k] = (b && o && typeof b === 'object' && typeof o === 'object' &&
                  !Array.isArray(b) && !Array.isArray(o)) ? merge(b, o) : o;
      }
      return out;
    }
    async function get() {
      try {
        const got = await chrome.storage.local.get(KEY);
        return merge(DEFAULTS, (got && got[KEY]) || {});
      } catch (e) { return merge(DEFAULTS, null); }
    }
    function moduleMap(s) {
      const out = {};
      for (const bag of [DEFAULTS.modules, (s && s.modules) || {}]) {
        for (const k of Object.keys(bag)) out[kebab(k)] = bag[k] === true;
      }
      return out;
    }
    function isModuleOn(s, moduleId, pageHost) {
      const id = kebab(moduleId);
      if (moduleMap(s)[id] !== true) return false;
      if (pageHost) {
        const h = normHost(pageHost);
        const hosts = (s && s.hosts) || {};
        for (const k of Object.keys(hosts)) {
          const key = normHost(k);
          if (h === key || h.endsWith('.' + key)) {
            for (const mk of Object.keys(hosts[k] || {})) {
              if (kebab(mk) === id && hosts[k][mk] === false) return false;
            }
          }
        }
      }
      return true;
    }
    root.Settings = { KEY, DEFAULTS, get, isModuleOn, moduleMap, kebab };
  }
  const Settings = root.Settings;

  /* ================================ Bridge ================================= */
  const watchers = new Map();   // kebab id -> Set<(on: boolean) => void>
  const channels = new Map();   // kebab id -> Set<(payload) => void>
  const lastOn = new Map();     // kebab id -> boolean (suppress repeats)

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;           // SW asleep / no receiver
          resolve(res === undefined ? null : res);
        });
      } catch (e) { resolve(null); }               // extension reloaded
    });
  }

  function post(msg) { send(msg); }                // fire-and-forget

  async function enabledFor(moduleId) {
    const s = await Settings.get();
    return Settings.isModuleOn(s, moduleId, location.hostname);
  }

  function fire(id, on) {
    if (lastOn.has(id) && lastOn.get(id) === on) return;
    lastOn.set(id, on);
    for (const cb of (watchers.get(id) || [])) {
      try { cb(on); } catch (e) { /* module code */ }
    }
  }

  async function fireWatchers() {
    let s;
    try { s = await Settings.get(); } catch (e) { return; }
    for (const id of watchers.keys()) {
      fire(id, Settings.isModuleOn(s, id, location.hostname));
    }
  }

  /* v3: watch() fires immediately with the CURRENT state, so modules
   * that activate from watch() (Link Sniper's pattern) come alive at
   * load instead of waiting for the next change. Repeat fires for the
   * same state are deduped by lastOn. */
  function watch(moduleId, cb) {
    if (typeof cb !== 'function') return () => {};
    const id = Settings.kebab(moduleId);
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(cb);
    (async () => {
      try {
        const s = await Settings.get();
        fire(id, Settings.isModuleOn(s, id, location.hostname));
      } catch (e) { /* stay quiet */ }
    })();
    return () => { const set = watchers.get(id); if (set) set.delete(cb); };
  }

  /* Per-module message channel: the SW can push structured payloads with
   * tabs.sendMessage({type:'SL_TO_MODULE', module, payload}). */
  function listen(moduleId, handler) {
    if (typeof handler !== 'function') return () => {};
    const id = Settings.kebab(moduleId);
    if (!channels.has(id)) channels.set(id, new Set());
    channels.get(id).add(handler);
    return () => { const set = channels.get(id); if (set) set.delete(handler); };
  }

  /* ---- v3: stats. Debounced deltas into slStats (storage.local).
   * NEVER touches the settings key, so a hover storm can never trigger
   * a settings-changed re-render or script re-registration. */
  const statDeltas = new Map();   // 'moduleId.field' -> count
  let statTimer = null;

  function bumpStat(moduleId, field, by) {
    const k = Settings.kebab(moduleId) + '.' + String(field);
    statDeltas.set(k, (statDeltas.get(k) || 0) +
      (typeof by === 'number' && by > 0 ? by : 1));
    if (!statTimer) statTimer = setTimeout(flushStats, 3000);
  }

  async function flushStats() {
    statTimer = null;
    const deltas = [...statDeltas.entries()];
    statDeltas.clear();
    if (!deltas.length) return;
    try {
      const got = await chrome.storage.local.get('slStats');
      const stats = (got && got.slStats) || { v: 1, modules: {} };
      for (const [k, n] of deltas) {
        const dot = k.indexOf('.');
        const mod = k.slice(0, dot), field = k.slice(dot + 1);
        const m = (stats.modules[mod] = stats.modules[mod] || {});
        m[field] = (m[field] || 0) + n;
      }
      await chrome.storage.local.set({ slStats: stats });
    } catch (e) { /* best-effort */ }
  }
  try { window.addEventListener('pagehide', flushStats, true); } catch (e) {}

  /* Channel a) SW-pushed state. */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'SL_MODULE_STATE' && msg.module) {
      fire(Settings.kebab(msg.module), msg.on === true);
    } else if (msg.type === 'SL_TO_MODULE' && msg.module) {
      const id = Settings.kebab(msg.module);
      for (const h of (channels.get(id) || [])) {
        try { h(msg.payload); } catch (e) { /* module code */ }
      }
    }
  });

  /* Channel b) storage backbone - works no matter what the SW does. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[Settings.KEY]) fireWatchers();
  });

  root.Bridge = { __API: API, enabledFor, send, post, watch, listen, bumpStat };
  root.__bridgeReady = true;      // honored by older bridges' guards
  root.__bridgeAPI = API;
})();