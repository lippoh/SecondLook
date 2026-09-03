/* SecondLook — shared/cs-bridge.js
 * The content-script bridge. Registered FIRST in every module's content
 * script list (before the module's own JS), matching http/https pages.
 *
 * Defines on the page (ISOLATED world):
 *   SecondLook.Settings  - twin of shared/settings.js; reads
 *                          chrome.storage.local directly, so it works
 *                          even while the service worker sleeps. It does
 *                          NOT auto-migrate (the SW / popup owns writes).
 *   SecondLook.Bridge    - enabledFor(id), send(msg), post(msg),
 *                          watch(id, cb), listen(id, handler)
 *
 * Live toggling: watchers fire from two independent channels -
 *   a) the SW pushing {type:'SL_MODULE_STATE', module, on} to tabs, and
 *   b) chrome.storage.onChanged on the settings key - the backbone that
 *      works no matter what the SW does.
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  if (root.Bridge && root.__bridgeReady) return;

  /* ================= Settings twin (keep in sync with settings.js) ============= */
  if (!root.Settings) {
    const KEY = 'slSettings';
    const VERSION = 2;
    const DEFAULTS = Object.freeze({
      v: VERSION,
      modules: Object.freeze({
        'link-sniper': true,
        'redirect-detective': true
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
      const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
      if (!over || typeof over !== 'object') return out;
      for (const k of Object.keys(over)) {
        const b = out[k], o = over[k];
        out[k] = (b && o && typeof b === 'object' && typeof o === 'object' &&
                  !Array.isArray(b) && !Array.isArray(o)) ? merge(b, o) : o;
      }
      return out;
    }
    function normalizeStored(s) {
      const out = Object.assign({}, s);
      const modules = {};
      for (const k of Object.keys(s.modules || {})) modules[kebab(k)] = s.modules[k] === true;
      out.modules = modules;
      const hosts = {};
      for (const h of Object.keys(s.hosts || {})) {
        const bag = {};
        for (const mk of Object.keys(s.hosts[h] || {})) {
          if (s.hosts[h][mk] === false) bag[kebab(mk)] = false;
        }
        hosts[normHost(h)] = bag;
      }
      out.hosts = hosts;
      out.v = VERSION;
      return out;
    }
    async function readRaw() {
      try {
        const got = await chrome.storage.local.get(KEY);
        const raw = got && got[KEY];
        return (raw && typeof raw === 'object') ? raw : null;
      } catch (e) { return null; }
    }
    let queue = Promise.resolve();
    function enqueue(job) {
      const run = queue.then(job, job);
      queue = run.catch(() => {});
      return run;
    }
    async function get() { return merge(DEFAULTS, (await readRaw()) || {}); }
    async function set(a, b) {
      return enqueue(async () => {
        let patch = null;
        if (typeof a === 'string' && typeof b === 'boolean') {
          patch = { modules: { [a]: b } };
        } else if (a && typeof a === 'object' && !Array.isArray(a)) {
          patch = a;
        } else {
          throw new TypeError('Settings.set expects (moduleId, on) or a patch object');
        }
        const next = normalizeStored(
          merge(merge(DEFAULTS, (await readRaw()) || {}), patch));
        await chrome.storage.local.set({ [KEY]: next });
        return next;
      });
    }
    function moduleMap(s) {
      const out = {};
      const bags = [DEFAULTS.modules, (s && s.modules) || {}];
      for (const bag of bags) {
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
    root.Settings = { KEY, VERSION, DEFAULTS, get, set, isModuleOn, moduleMap, kebab };
  }
  const Settings = root.Settings;

  /* ================================ Bridge ==================================== */
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

  function watch(moduleId, cb) {
    if (typeof cb !== 'function') return () => {};
    const id = Settings.kebab(moduleId);
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(cb);
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

  root.Bridge = { enabledFor, send, post, watch, listen };
  root.__bridgeReady = true;
})();