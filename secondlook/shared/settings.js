/* SecondLook — shared/settings.js v2.1 (FULL API)
 * Single source of truth for settings AND the module catalogue.
 * Loaded in every context:
 *   - service worker  : importScripts FIRST (bootstrap.js does this)
 *   - extension pages : <script src="shared/settings.js"> before popup.js
 *   - content scripts : first file of every registered bundle (read-only
 *                       there: the self-heal migration only runs where
 *                       chrome.tabs exists — SW and extension pages)
 *
 * API: get | set(id,on) | set({patch}) | setModule | reset | defaults |
 *       migrate | onChange(cb) -> unsubscribe | isModuleOn | moduleMap |
 *       MODULES | KEY | VERSION | DEFAULTS | kebab | __API
 *
 * v2.1: an older/partial SecondLook.Settings (the lean v2 file, or this
 * file pasted after it) is now UPGRADED, not skipped. The old
 * "if (root.Settings) return" guard let a stale twin silently win when
 * a file got appended to; every consumer of onChange()/migrate()/MODULES
 * then died. Now: identical file twice = one copy; stale file = replaced.
 * VERSION is 3 so profiles that ran the lean v2 file also get the
 * one-time repair (re-enables the two implemented modules once).
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  const API = 2.1;
  if (root.Settings && root.Settings.__API === API) return;   // dedupe only

  const KEY = 'slSettings';
  const VERSION = 3;

  /* ---- module catalogue ---------------------------------------------------
   * The popup renders this top to bottom. Defaults DERIVE from it:
   * implemented => default ON, unbuilt => default OFF. Shipping a module
   * = flip implemented AND bump VERSION (the v-gated migration then
   * re-enables it for existing profiles). Only id + implemented are
   * load-bearing; name/desc/pillar are presentation. */
  const MODULES = Object.freeze([
    { id: 'link-sniper', pillar: 'Links', implemented: true,
      name: 'Link Sniper',
      desc: 'Hover any link to see where it really goes before you click.' },
    { id: 'redirect-detective', pillar: 'Links', implemented: true,
      name: 'Redirect Detective',
      desc: 'Traces the route a link takes and flags detours worth a second look.' },
    { id: 'login-lookout', pillar: 'Logins', implemented: false,
      name: 'Login Lookout',
      desc: 'Warns when a login form appears on a domain that mimics a brand.' },
    { id: 'twin-site-spotter', pillar: 'Logins', implemented: false,
      name: 'Twin-Site Spotter',
      desc: 'Spots look-alike and typo-squat domains shadowing the real ones.' },
    { id: 'download-sentinel', pillar: 'Downloads', implemented: false,
      name: 'Download Sentinel',
      desc: 'Flags downloads with risky file types or misleading names.' },
    { id: 'archive-trap', pillar: 'Downloads', implemented: false,
      name: 'Archive Trap',
      desc: 'Flags zipped installers and double-extension file tricks.' },
    { id: 'fake-alert-shield', pillar: 'Pages', implemented: false,
      name: 'Fake Alert Shield',
      desc: 'Intercepts fake virus warnings and scareware popups.' },
    { id: 'pressure-meter', pillar: 'Pages', implemented: false,
      name: 'Pressure Meter',
      desc: 'Flags fake countdowns and manufactured urgency.' },
    { id: 'overlay-inspector', pillar: 'Pages', implemented: false,
      name: 'Overlay Inspector',
      desc: 'Flags invisible overlays and click-stealing page layers.' },
    { id: 'shop-decoy', pillar: 'Pages', implemented: false,
      name: 'Shop Decoy',
      desc: 'Flags too-good-to-be-true prices on unfamiliar stores.' }
  ]);

  function computeDefaults() {
    const modules = {};
    for (const m of MODULES) modules[m.id] = m.implemented === true;
    return Object.freeze({
      v: VERSION,
      modules: Object.freeze(modules),
      hosts: Object.freeze({})
    });
  }
  const DEFAULTS = computeDefaults();

  /* ---- helpers ------------------------------------------------------------ */
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

  /* Canonical spellings on every write: legacy camelCase keys collapse onto
   * their kebab form, so a module can never exist twice. */
  function normalizeStored(s) {
    const out = Object.assign({}, s);
    const modules = {};
    for (const k of Object.keys(s.modules || {})) modules[kebab(k)] = s.modules[k] === true;
    out.modules = modules;
    const hosts = {};
    for (const h of Object.keys(s.hosts || {})) {
      const bag = {};
      for (const mk of Object.keys(s.hosts[h] || {})) {
        if (s.hosts[h][mk] === false) bag[kebab(mk)] = false;   // only "off" is meaningful
      }
      if (Object.keys(bag).length) hosts[normHost(h)] = bag;
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

  /* Serialized write queue: every settings write funnels through here. */
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
        patch = { modules: { [a]: b } };                 // set(moduleId, on)
      } else if (a && typeof a === 'object' && !Array.isArray(a)) {
        patch = a;                                       // set({ modules | hosts })
      } else {
        throw new TypeError('Settings.set expects (moduleId, on) or a patch object');
      }
      const next = normalizeStored(merge(merge(DEFAULTS, (await readRaw()) || {}), patch));
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    });
  }
  const setModule = (id, on) => set(id, on);

  async function reset() {                               // back to pure defaults
    return enqueue(async () => {
      await chrome.storage.local.set({ [KEY]: { v: VERSION } });
      return get();
    });
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

  /* Sync snapshot for render fallbacks (popup's catch path). */
  function defaults() {
    return { v: VERSION, modules: Object.assign({}, DEFAULTS.modules), hosts: {} };
  }

  /* One-time repair for stale-schema profiles: if the stored object
   * predates this schema, re-assert implemented defaults ONCE, then
   * respect every choice made after. Idempotent + lock-guarded. */
  async function migrate() {
    return enqueue(async () => {
      const fresh = await readRaw();
      if (fresh && fresh.v === VERSION) return false;    // current schema: hands off
      const next = normalizeStored(merge(merge(DEFAULTS, fresh || {}), { v: VERSION }));
      for (const m of MODULES) {
        if (m.implemented) next.modules[m.id] = true;    // bug-era repair
      }
      await chrome.storage.local.set({ [KEY]: next });
      console.info('[SecondLook] settings migrated to v' + VERSION + '.');
      return true;
    });
  }

  /* ---- change notifications ------------------------------------------------
   * One lazily-attached storage listener per context, filtered to the
   * settings key (stats / chain writes can never trigger it), shared by
   * all subscribers, deduped by fingerprint so echoes and no-op writes
   * don't re-fire. */
  const listeners = new Set();
  let storageHooked = false;
  let seeded = false;
  let lastFingerprint = null;

  function fingerprint(s) {
    try { return JSON.stringify(normalizeStored(s)); } catch (e) { return String(Date.now()); }
  }

  function notify(rawNewValue) {
    const settings = merge(DEFAULTS, rawNewValue || {});
    const fp = fingerprint(settings);
    if (fp === lastFingerprint) return;                  // echo / no-op write
    lastFingerprint = fp;
    for (const cb of listeners) {
      try { cb(settings); } catch (e) { /* subscriber code */ }
    }
  }

  function hookStorage() {
    if (storageHooked) return;
    storageHooked = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        notify(changes[KEY].newValue);
      });
    } catch (e) { /* no storage events in this context */ }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    hookStorage();
    if (!seeded) {                                       // seed: only real changes fire
      seeded = true;
      get().then((s) => { lastFingerprint = fingerprint(s); }).catch(() => {});
    }
    return () => { listeners.delete(cb); };
  }

  /* Self-heal at load - extension contexts ONLY. chrome.tabs exists in
   * the SW and extension pages, never in content scripts, which share
   * this file via the registered bundles and must stay read-only. */
  if (typeof chrome !== 'undefined' && chrome.tabs) migrate().catch(() => {});

  root.Settings = { __API: API, KEY, VERSION, DEFAULTS, MODULES,
                    get, set, setModule, reset, defaults, migrate,
                    isModuleOn, moduleMap, kebab, onChange };
})();