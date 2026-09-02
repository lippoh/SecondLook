/* shared/cs-bridge.js - content-world runtime for all modules.
 * Modules call SL.boot(id, impl); the bridge owns lifecycle. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.__bridge) return;
  const impls = {};      // moduleId -> implementation hooks
  const cleanups = {};   // moduleId -> [undo functions]
  const alive = {};      // moduleId -> currently active on this page
  const VERDICT_CACHE_MAX = 300;
  let pageHost = '';
  try { pageHost = location.hostname || ''; } catch (e) { /* non-http(s) */ }
  function host() { return pageHost; }
  function send(module, type, payload) {
    return root.msg.send(module, type, payload);
  }
  /* ---- verdict cache: one analysis per URL per page load ---------- */
  const verdictCache = new Map();
  const verdictPending = new Map();
  function verdictKey(url, ctx) {
    const c = ctx || {};
    return url + '|' + (c.credentials ? 'c' : '') +
           (c.escalate ? 'e' : '') + (c.resolvedUrl ? 'r' : '');
  }
  async function verdict(url, ctx) {
    const key = verdictKey(url, ctx);
    if (verdictCache.has(key)) return verdictCache.get(key);
    if (verdictPending.has(key)) return verdictPending.get(key);
    const p = send('engine', 'analyze', { url, context: ctx || {} })
      .then((res) => {
        const v = res.ok ? res.data : { verdict: 'CLEAR', reasons: [],
                                        score: 0, meta: { error: res.error } };
        verdictPending.delete(key);
        verdictCache.set(key, v);
        if (verdictCache.size > VERDICT_CACHE_MAX) {
          verdictCache.delete(verdictCache.keys().next().value);
        }
        return v;
      });
    verdictPending.set(key, p);
    return p;
  }
  /* ---- status lines shown in the popup ---------------------------- */
  function status(moduleId, line) {
    // fire-and-forget; SW writes session storage keyed by tab id
    send(moduleId, 'status', { line: String(line).slice(0, 80) });
  }
  /* ---- lifecycle ---------------------------------------------------- */
  async function enabledFor(moduleId) {
    const s = await root.Settings.get();
    return root.Settings.isModuleOn(s, moduleId, pageHost);
  }
  async function configFor(moduleId) {
    const s = await root.Settings.effective(pageHost);
    return s.modules[moduleId] || { enabled: false };
  }
  function registerCleanup(moduleId, fn) {
    if (typeof fn !== 'function') return;
    (cleanups[moduleId] = cleanups[moduleId] || []).push(fn);
  }
  function teardown(moduleId) {
    const fns = cleanups[moduleId] || [];
    cleanups[moduleId] = [];
    for (const fn of fns) {
      try { fn(); } catch (e) { /* undo must never throw the bridge */ }
    }
    alive[moduleId] = false;
    const impl = impls[moduleId];
    if (impl && typeof impl.onDisabled === 'function') {
      try { impl.onDisabled(); } catch (e) { /* ignore */ }
    }
  }
  async function boot(moduleId, impl) {
    impls[moduleId] = impl || {};
    const on = await enabledFor(moduleId);
    if (on) {
      alive[moduleId] = true;
      const cfg = await configFor(moduleId);
      if (typeof impl.onEnabled === 'function') {
        impl.onEnabled(cfg);   // module starts observers here
      }
    }
  }
  /* ---- broadcast + settings listeners (installed once) ------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.module !== '*') return false;
    const p = msg.payload || {};
    if (msg.type === 'moduleToggled' && impls[p.moduleId]) {
      if (p.enabled === true) {
        (async () => {
          alive[p.moduleId] = true;
          const cfg = await configFor(p.moduleId);
          const impl = impls[p.moduleId];
          if (typeof impl.onEnabled === 'function') impl.onEnabled(cfg);
        })();
      } else {
        teardown(p.moduleId);   // run undo fns, then onDisabled()
      }
    } else if (msg.type === 'globalToggled') {
      if (p.enabled === false) {
        for (const id of Object.keys(impls)) teardown(id);
      }
    } else if (msg.type === 'moduleConfig' && impls[p.moduleId]) {
      const impl = impls[p.moduleId];
      if (typeof impl.onConfig === 'function') impl.onConfig(p.config || {});
    }
    return false;   // broadcasts never expect a response
  });
  /* Local settings edits (options page) reach content scripts through
   * storage.onChanged; re-check enablement and config for our modules. */
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes['sl.settings']) return;
    for (const moduleId of Object.keys(impls)) {
      const on = await enabledFor(moduleId);
      if (on && !alive[moduleId]) {
        alive[moduleId] = true;
        const cfg = await configFor(moduleId);
        const impl = impls[moduleId];
        if (typeof impl.onEnabled === 'function') impl.onEnabled(cfg);
      } else if (!on && alive[moduleId]) {
        teardown(moduleId);
      } else if (on && alive[moduleId]) {
        const cfg = await configFor(moduleId);
        const impl = impls[moduleId];
        if (typeof impl.onConfig === 'function') impl.onConfig(cfg);
      }
    }
  });
  root.__bridge = true;
  root.host = host;
  root.send = send;
  root.verdict = verdict;
  root.status = status;
  root.boot = boot;
  root.registerCleanup = registerCleanup;
  root.teardown = teardown;
})(globalThis);