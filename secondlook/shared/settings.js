/* ============================================================
 * SecondLook - shared/settings.js  (core v2.4 - __API 2.4)
 * Single source of truth for module state. One storage key:
 * slSettings. Works in the SW (importScripts / dynamic import),
 * in content scripts (ISOLATED world) and in extension pages.
 * Writes are serialized (queue) and always a read-modify-write
 * MERGE. Reads merge defaults. Change notices are key-filtered
 * and fingerprint-deduped. The __API guard lets a newer copy of
 * this file safely replace an older one in the same context.
 * ============================================================ */
(() => {
  "use strict";

  const NS = (globalThis.SecondLook = globalThis.SecondLook || {});
  const __API = 2.4;
  const prev = NS.Settings;
  if (prev && typeof prev.__API === "number" && prev.__API >= __API) return; // same or newer already loaded

  const KEY = "slSettings";
  const VERSION = 5;

  const kebab = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  /* ---------- module registry (11) --------------------------
   * pillar 1: look before you leap  |  pillar 2: guard what you type
   * pillar 3: intercept the irreversible  |  pillar 4: quiet by default
   * --------------------------------------------------------- */
  const MODULES = [
    { id: "link-sniper",        title: "Link Sniper",        pillar: 1, implemented: true,  defaultOn: true,
      desc: "Hover a link to see where it really goes, before you click." },
    { id: "redirect-detective", title: "Redirect Detective", pillar: 1, implemented: true,  defaultOn: true,
      desc: "Shows the redirect chain that carried you to this page." },
    { id: "trust-badge",        title: "Trust Badge",        pillar: 1, implemented: true,  defaultOn: true,
      desc: "A quiet corner badge for how much this site deserves trust." },
    { id: "form-guardian",      title: "Form Guardian",      pillar: 2, implemented: true,  defaultOn: true,
      desc: "Watches login and payment forms - tells you where your input is really sent." },
    { id: "credential-radar",   title: "Credential Radar",   pillar: 2, implemented: false, defaultOn: false,
      desc: "Flags password fields on sites that have no business asking for one." },
    { id: "download-sentinel",  title: "Download Sentinel",  pillar: 3, implemented: false, defaultOn: false,
      desc: "Looks twice at downloads before they land." },
    { id: "tab-shield",         title: "Tab Shield",         pillar: 3, implemented: false, defaultOn: false,
      desc: "Guards against tabs that change identity while you're away." },
    { id: "clipboard-guard",    title: "Clipboard Guard",    pillar: 3, implemented: false, defaultOn: false,
      desc: "Watches for pages that rewrite what you paste." },
    { id: "tracker-tally",      title: "Tracker Tally",      pillar: 4, implemented: false, defaultOn: false,
      desc: "Counts who is following you on each page." },
    { id: "fingerprint-flare",  title: "Fingerprint Flare",  pillar: 4, implemented: false, defaultOn: false,
      desc: "Flags canvas and font fingerprinting probes." },
    { id: "privacy-pulse",      title: "Privacy Pulse",      pillar: 4, implemented: false, defaultOn: false,
      desc: "A quiet weekly summary of what the suite saw." },
  ];

  const DEFAULTS = () => ({
    v: VERSION,
    theme: "auto",
    modules: Object.fromEntries(MODULES.map((m) => [m.id, !!m.defaultOn])),
    hosts: {},    // hosts[host] = { muted: false } - site-level preferences
    perSite: {},  // perSite[host] = { [moduleId]: boolean } - per-site module override
  });

  /* ---------- read / merge --------------------------------- */
  const raw = async () => ((await chrome.storage.local.get(KEY))[KEY]) || {};

  function withDefaults(s) {
    s = (s && typeof s === "object") ? s : {};
    const d = DEFAULTS();
    const out = Object.assign({}, d, s);
    out.modules = Object.assign({}, d.modules, (s.modules && typeof s.modules === "object") ? s.modules : {});
    out.hosts = Object.assign({}, (s.hosts && typeof s.hosts === "object") ? s.hosts : {});
    out.perSite = Object.assign({}, (s.perSite && typeof s.perSite === "object") ? s.perSite : {});
    if (typeof out.theme !== "string" || !["auto", "light", "dark"].includes(out.theme)) out.theme = "auto";
    out.v = typeof s.v === "number" ? s.v : VERSION;
    return out;
  }

  function mergeSettings(base, patch) {
    const out = Object.assign({}, base);
    for (const [k, val] of Object.entries(patch || {})) {
      const deep = (k === "modules" || k === "hosts" || k === "perSite");
      if (deep && val && typeof val === "object" && !Array.isArray(val)) {
        const cur = (base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) ? base[k] : {};
        const merged = Object.assign({}, cur);
        for (const [k2, v2] of Object.entries(val)) {
          merged[k2] =
            (v2 && typeof v2 === "object" && !Array.isArray(v2) &&
             cur[k2] && typeof cur[k2] === "object" && !Array.isArray(cur[k2]))
              ? Object.assign({}, cur[k2], v2) : v2;
        }
        out[k] = merged;
      } else {
        out[k] = val;
      }
    }
    return out;
  }

  /* ---------- serialized write path ------------------------ */
  let _queue = Promise.resolve();
  function enqueue(job) {
    const run = _queue.then(job, job);
    _queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /* ---------- module resolution ---------------------------- */
  function resolveOn(s, mid) {
    try {
      const host = (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) ? location.hostname : null;
      const site = host && s.perSite && s.perSite[host];
      if (site && typeof site[mid] === "boolean") return site[mid];
    } catch (e) {}
    if (s.modules && typeof s.modules[mid] === "boolean") return s.modules[mid];
    return !!DEFAULTS().modules[mid];
  }

  /* ---------- API ------------------------------------------ */
  async function get() {
    return withDefaults(await raw());
  }

  function set(a, b) {
    if (typeof a === "string") return setModule(a, b);
    const patch = (a && typeof a === "object" && !Array.isArray(a)) ? a : {};
    return enqueue(async () => {
      const base = withDefaults(await raw());
      const next = mergeSettings(base, patch);
      next.v = VERSION;
      await chrome.storage.local.set({ [KEY]: next });
      return { ok: true, settings: next };
    });
  }

  function setModule(id, on) {
    const mid = kebab(id);
    if (!MODULES.some((m) => m.id === mid)) {
      return Promise.resolve({ ok: false, error: "unknown module: " + mid });
    }
    return set({ modules: { [mid]: !!on } });
  }

  function reset() {
    return enqueue(async () => {
      const d = DEFAULTS();
      await chrome.storage.local.set({ [KEY]: d });
      return { ok: true, settings: d };
    });
  }

  function migrate() {
    return enqueue(async () => {
      const stored = await raw();
      if (!stored || Object.keys(stored).length === 0) {
        const d = DEFAULTS();
        await chrome.storage.local.set({ [KEY]: d });
        return { from: null, to: VERSION, changed: true };
      }
      const from = typeof stored.v === "number" ? stored.v : 0;
      const next = withDefaults(stored);
      next.v = VERSION;
      if (JSON.stringify(next) === JSON.stringify(stored)) return { from: from, to: VERSION, changed: false };
      await chrome.storage.local.set({ [KEY]: next });
      return { from: from, to: VERSION, changed: true };
    });
  }

  /* ---------- change notices (key-filtered + dedup) --------- */
  const subs = new Set();
  let lastPrint = null;
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes || !(KEY in changes)) return;
        const s = withDefaults(changes[KEY].newValue);
        let fp;
        try { fp = JSON.stringify(s); } catch (e) { fp = "x" + Date.now(); }
        if (fp === lastPrint) return;
        lastPrint = fp;
        for (const cb of Array.from(subs)) {
          try { if (typeof cb === "function") cb(s); } catch (e) { console.error("[SL:settings] onChange listener failed:", e); }
        }
      });
    }
  } catch (e) {}
  function onChange(cb) {
    if (typeof cb !== "function") return () => {};
    subs.add(cb);
    return () => subs.delete(cb);
  }

  async function isModuleOn(id) {
    return resolveOn(await get(), kebab(id));
  }

  /* ---------- export ---------------------------------------- */
  NS.Settings = {
    __API: __API,
    KEY: KEY,
    VERSION: VERSION,
    MODULES: MODULES,
    kebab: kebab,
    DEFAULTS: DEFAULTS,
    defaults: () => DEFAULTS(),
    moduleMap: () => Object.fromEntries(MODULES.map((m) => [m.id, m])),
    get: get,
    set: set,
    setModule: setModule,
    reset: reset,
    migrate: migrate,
    onChange: onChange,
    isModuleOn: isModuleOn,
  };

  console.info("[SL:settings] core up v" + __API + " - schema " + VERSION + ", " + MODULES.length + " modules registered");
})();