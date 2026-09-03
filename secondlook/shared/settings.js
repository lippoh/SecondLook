/* SecondLook — shared/settings.js
 * The single source of truth for module settings.
 *
 * WHERE IT RUNS
 *   - Service worker: importScripts('shared/settings.js') FIRST, before
 *     any module background file.
 *   - Extension pages (popup/options): <script src="shared/settings.js">.
 *   - Content scripts: shared/cs-bridge.js carries an identical twin of
 *     this logic (content scripts cannot importScripts). Keep the twins
 *     in sync when you touch this file.
 *
 * THE CONTRACT (this is what stopped toggles from sticking)
 *   1. ONE storage key: 'slSettings' in chrome.storage.local. Nothing
 *      else in the codebase writes that key.
 *   2. Defaults apply at READ time via per-key merge - stored user values
 *      always win. A new module added by an update can never clobber
 *      existing choices.
 *   3. set() is always a read-modify-write MERGE, never a wholesale
 *      replace, and every write goes through one serialized queue, so
 *      two writers can never race each other back to a stale value.
 *   4. Module ids are canonicalized ('redirect-detective',
 *      'redirectDetective', 'Redirect_Detective' are the same switch),
 *      so a spelling drift can never silently kill a module.
 *   5. Implemented modules default ON; unimplemented ones default OFF
 *      (absent from DEFAULTS). A one-time v1 -> v2 migration repairs
 *      profiles whose defaults were flattened by the old bug.
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  if (root.Settings) return;                       // twin already loaded

  const KEY = 'slSettings';
  const VERSION = 2;

  const DEFAULTS = Object.freeze({
    v: VERSION,
    modules: Object.freeze({                       // implemented today -> ON
      'link-sniper': true,
      'redirect-detective': true
    }),
    hosts: Object.freeze({})                       // host -> { moduleId: false }
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

  /* Canonical spellings on every write: legacy camelCase keys collapse
   * onto their kebab form, so a module can never exist twice. */
  function normalizeStored(s) {
    const out = Object.assign({}, s);
    const modules = {};
    for (const k of Object.keys(s.modules || {})) modules[kebab(k)] = s.modules[k] === true;
    out.modules = modules;
    const hosts = {};
    for (const h of Object.keys(s.hosts || {})) {
      const bag = {};
      for (const mk of Object.keys(s.hosts[h] || {})) {
        if (s.hosts[h][mk] === false) bag[kebab(mk)] = false;  // only "off" is meaningful
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

  /* Serialized write queue: every settings write funnels through here,
   * so a popup toggle can never race a background sync back to a stale
   * snapshot. */
  let queue = Promise.resolve();
  function enqueue(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  async function get() {
    return merge(DEFAULTS, (await readRaw()) || {});
  }

  async function set(a, b) {
    return enqueue(async () => {
      let patch = null;
      if (typeof a === 'string' && typeof b === 'boolean') {
        patch = { modules: { [a]: b } };           // set(moduleId, on)
      } else if (a && typeof a === 'object' && !Array.isArray(a)) {
        patch = a;                                 // set({ modules|hosts })
      } else {
        throw new TypeError('Settings.set expects (moduleId, on) or a patch object');
      }
      const next = normalizeStored(
        merge(merge(DEFAULTS, (await readRaw()) || {}), patch));
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    });
  }

  async function reset() {                         // back to pure defaults
    return enqueue(async () => {
      await chrome.storage.local.set({ [KEY]: { v: VERSION } });
      return get();
    });
  }

  /* Normalized view of s.modules: every spelling of a module id lands
   * on one bucket, stored values overriding defaults. */
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

  /* One-time repair for profiles flattened by the toggle bug: if the
   * stored object predates v2, re-assert the implemented defaults once.
   * Deliberate offs made AFTER this are respected forever after. */
  async function migrateIfNeeded(raw) {
    if (!raw || raw.v === VERSION) return;
    try {
      await enqueue(async () => {
        const fresh = (await readRaw()) || {};     // re-read inside the lock
        if (fresh.v === VERSION) return;           // someone else migrated
        const next = normalizeStored(merge(merge(DEFAULTS, fresh),
          { v: VERSION, modules: { 'link-sniper': true, 'redirect-detective': true } }));
        await chrome.storage.local.set({ [KEY]: next });
      });
      console.info('[SecondLook] settings migrated to v' + VERSION +
        ' - implemented modules re-enabled.');
    } catch (e) { /* defaults still apply at read time */ }
  }

  const booted = (async () => {
    await migrateIfNeeded(await readRaw());
  })();

  root.Settings = { KEY, VERSION, DEFAULTS, get, set, reset,
                    isModuleOn, moduleMap, kebab, booted };
})();