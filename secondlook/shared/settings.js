/* shared/settings.js - settings schema + effective(host) resolution. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.Settings) return;
  const KEY = 'sl.settings';
  const DEFAULTS = {
    globalEnabled: true,
    modules: {
      demoGreeting:      { enabled: true },                      // dev only
      linkSniper:        { enabled: true, hoverDelayMs: 350, showClear: true },
      redirectDetective: { enabled: true, maxHops: 8 },
      trustBadge:        { enabled: true },
      formGuardian:      { enabled: true, rememberApproved: true },
      ghostClick:        { enabled: true, annotate: false },
      fakeDownload:      { enabled: true },
      downloadGuard:     { enabled: true, blockOnMismatch: true },
      tabGuard:          { enabled: true, threshold: 3, windowMs: 10000 },
      cookieTamer:       { enabled: true, strategy: 'prefer-reject' },
      avIndicator:       { enabled: true }
    },
    siteOverrides: {}   // host -> { modules: { moduleId: false } }
  };
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function mergeInto(base, patch) {
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        mergeInto(base[k], v);
      } else if (v !== undefined) {
        base[k] = v;
      }
    }
    return base;
  }
  async function get() {
    const stored = await root.Storage.localGet(KEY, null);
    if (!stored) return clone(DEFAULTS);
    // unknown-module-proof: defaults win for anything missing
    return mergeInto(clone(DEFAULTS), stored);
  }
  async function save(next) {
    await root.Storage.localSet(KEY, next);
    return next;
  }
  async function setModuleEnabled(moduleId, enabled) {
    const s = await get();
    if (!s.modules[moduleId]) s.modules[moduleId] = { enabled };
    else s.modules[moduleId].enabled = !!enabled;
    return save(s);
  }
  async function setModuleOption(moduleId, option, value) {
    const s = await get();
    if (!s.modules[moduleId]) s.modules[moduleId] = {};
    s.modules[moduleId][option] = value;
    return save(s);
  }
  async function setGlobalEnabled(enabled) {
    const s = await get();
    s.globalEnabled = !!enabled;
    return save(s);
  }
  async function setSiteOverride(host, moduleId, enabled) {
    const s = await get();
    if (!s.siteOverrides[host]) s.siteOverrides[host] = { modules: {} };
    s.siteOverrides[host].modules[moduleId] = !!enabled;
    if (!Object.keys(s.siteOverrides[host].modules).length) {
      delete s.siteOverrides[host];
    }
    return save(s);
  }
  async function clearSiteOverride(host, moduleId) {
    const s = await get();
    const site = s.siteOverrides[host];
    if (site && site.modules && moduleId in site.modules) {
      delete site.modules[moduleId];
      if (!Object.keys(site.modules).length) delete s.siteOverrides[host];
    }
    return save(s);
  }
  async function clearAllSiteOverrides(host) {
    const s = await get();
    delete s.siteOverrides[host];
    return save(s);
  }
  /* Effective settings for one host: defaults <- global <- site override. */
  async function effective(host) {
    const s = await get();
     const out = clone(s);
    const site = host && s.siteOverrides && s.siteOverrides[host];
    if (site && site.modules) {
      for (const [modId, enabled] of Object.entries(site.modules)) {
        if (!out.modules[modId]) out.modules[modId] = {};
        out.modules[modId].enabled = enabled;   // site layer wins
      }
    }
    return out;
  }
  function isModuleOn(settings, moduleId, host) {
    if (!settings || settings.globalEnabled === false) return false;
    const site = host && settings.siteOverrides &&
      settings.siteOverrides[host];
    const siteFlag = site && site.modules && site.modules[moduleId];
    if (siteFlag !== undefined && siteFlag !== null) return !!siteFlag;
    const m = settings.modules && settings.modules[moduleId];
    return !!m && m.enabled !== false;
  }
  /* Subscribe to settings changes (chrome.storage.onChanged). */
  function subscribe(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue,
                                               changes[KEY].oldValue);
    });
  }
  root.Settings = {
    KEY, DEFAULTS, get, save, setModuleEnabled, setModuleOption,
    setGlobalEnabled, setSiteOverride, clearSiteOverride,
    clearAllSiteOverrides, effective, isModuleOn, subscribe
  };
})(globalThis);