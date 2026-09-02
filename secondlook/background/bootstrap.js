/* background/bootstrap.js - script registration + open-tab injection. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.Bootstrap) return;
  const HTTP = ['http://*/*', 'https://*/*'];
  function log(...args) {
    console.log('[sl:bootstrap]', ...args);   // visible in the SW console
  }
  function toChromeSpec(spec) {
    return {
      id: spec.id,
      matches: spec.matches || HTTP,
      js: spec.js,
      css: spec.css || [],
      runAt: spec.runAt || 'document_idle',
      world: spec.world || 'ISOLATED',
      allFrames: !!spec.allFrames,
      persistAcrossSessions: true
    };
  }
  /** Diff desired vs registered content scripts; apply the delta. */
  async function reconcile(reason) {
    try {
      const settings = await SL.Settings.get();
      const desired = [];
      for (const mod of SL.Registry.MODULES) {
        if (!mod.scripts) continue;
        const on = SL.Settings.isModuleOn(settings, mod.id, null);
        if (on) desired.push(...mod.scripts);
      }
      const desiredIds = new Set(desired.map((s) => s.id));
      const current = await chrome.scripting.getRegisteredContentScripts();
      const currentIds = new Set(current.map((s) => s.id));
      const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));
      const toAdd = desired.filter((s) => !currentIds.has(s.id));
      if (toRemove.length) {
        await chrome.scripting.unregisterContentScripts({ ids: toRemove });
        log(reason, 'unregistered', toRemove.join(', '));
      }
      if (toAdd.length) {
        try {
          await chrome.scripting.registerContentScripts(toAdd.map(toChromeSpec));
          log(reason, 'registered', toAdd.map((s) => s.id).join(', '));
        } catch (err) {
          if (!/duplicate/i.test(String(err))) throw err;
          // duplicate id = already registered; benign after restarts
          log(reason, 'duplicate registration ignored');
        }
      }
      if (!toRemove.length && !toAdd.length) {
        log(reason, 'in sync (', desiredIds.size, 'scripts )');
      }
    } catch (err) {
      console.error('[sl:bootstrap] reconcile failed:', err);
    }
  }
  /** Flip ON for pages that already loaded: registered scripts will
   *  not fire for them, so inject the module's files right now. */
  async function injectIntoOpenTabs(moduleId) {
    const mod = SL.Registry.byId(moduleId);
    if (!mod || !mod.scripts) return;
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: HTTP }); } catch (e) { return; }
    for (const tab of tabs) {
      for (const spec of mod.scripts) {
        const target = { tabId: tab.id, allFrames: !!spec.allFrames };
        try {
          await chrome.scripting.executeScript({
            target, files: spec.js, world: spec.world || 'ISOLATED'
          });
          if (spec.css && spec.css.length) {
            await chrome.scripting.insertCSS({ target, files: spec.css });
          }
        } catch (err) {
          // tab may have navigated or be inaccessible; not an error
        }
      }
    }
  }
  /** Broadcast module state to every open http/https tab. */
  async function broadcast(moduleId, enabled) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: HTTP }); } catch (e) { return; }
    const msg = {
      module: '*', type: 'moduleToggled',
      payload: { moduleId, enabled: !!enabled }
    };
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, msg); } catch (e) {
        // no listener in that tab (module never loaded there) - fine
      }
    }
  }
  async function broadcastAll(msg) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: HTTP }); } catch (e) { return; }
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, msg); } catch (e) {}
    }
  }
  root.Bootstrap = { reconcile, injectIntoOpenTabs, broadcast, broadcastAll };
})(globalThis)