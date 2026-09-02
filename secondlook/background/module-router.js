/* background/module-router.js - the single message dispatcher.
 * Contract: {module, type, payload} -> {ok:true, data} | {ok:false, error}.
 * Later parts call SL.Router.register(moduleId, handlers) to add routes
 * without editing this file. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.Router) return;
  const HANDLERS = {};
  function register(moduleId, handlers) {
    HANDLERS[moduleId] = Object.assign(HANDLERS[moduleId] || {}, handlers);
  }
  /* ------------------------- engine routes ------------------------ */
  register('engine', {
    async analyze(payload) {
      const v = await SL.Engine.analyze(payload.url, payload.context || {});
      await SL.Storage.bumpStat('engine', v.verdict);
      if (v.verdict !== 'CLEAR') {
        await SL.Storage.pushEvent({
          module: 'engine', verdict: v.verdict,
          url: payload.url, note: v.reasons[0] || ''
        });
      }
      return v;
    },
    async resolveRedirect(payload) {
      return SL.Engine.Redirect.resolve(payload.url);
    }
  });
  /* ------------------------ generic status ------------------------ */
  register('core', {
    async 'status-sink'(payload, sender) { return null; }
  });
  /* --------------------------- core routes ------------------------ */
  register('core', {
    async getSnapshot(payload) {
      const tabId = payload && payload.tabId;
      const tab = await chrome.tabs.get(tabId);
      let host = '';
      try { host = new URL(tab.url || '').hostname; } catch (e) {}
      const [settings, statusMap, safeTabs, stats] = await Promise.all([
        SL.Settings.effective(host),
        SL.Storage.sessionGet('sl.status', {}),
        SL.Storage.sessionGet('sl.safemode', []),
        SL.Storage.getStats()
      ]);
      const pageVerdict = tab.url && /^https?:/i.test(tab.url)
        ? await SL.Engine.analyze(tab.url, {})
        : null;
      return {
        settings, host, pageVerdict, stats,
        statusLines: statusMap[tabId] || {},
        safeModeOn: safeTabs.includes(tabId),
        url: tab.url || ''
      };
    },
    async setModuleEnabled(payload) {
      return SL.Settings.setModuleEnabled(payload.moduleId, payload.enabled);
    },
    async setModuleOption(payload) {
      return SL.Settings.setModuleOption(
        payload.moduleId, payload.option, payload.value);
    },
    async setGlobalEnabled(payload) {
      return SL.Settings.setGlobalEnabled(payload.enabled);
    },
    async setSiteOverride(payload) {
      return SL.Settings.setSiteOverride(
        payload.host, payload.moduleId, payload.enabled);
    },
    async clearSiteOverride(payload) {
      return payload.moduleId
        ? SL.Settings.clearSiteOverride(payload.host, payload.moduleId)
        : SL.Settings.clearAllSiteOverrides(payload.host);
    },
    async safeMode(payload) {
      await SL.SafeMode.set(payload.tabId, payload.on);
      return { on: payload.on };
    },
    async getEvents(payload) {
      return SL.Storage.getEvents((payload && payload.limit) || 50);
    },
    async getStats() { return SL.Storage.getStats(); },
    async resetData() { return SL.Storage.resetData(); },
    async exportSettings() {
      const s = await SL.Settings.get();
      return JSON.stringify(s, null, 2);
    },
    async importSettings(payload) {
      const parsed = JSON.parse(payload.json);
      return SL.Settings.save(parsed);
    }
  });
  /* Status lines from content scripts: file under the sender's tab.
   * DEVIATION from guide: the moduleId rides the message envelope
   * (msg.module) - cs-bridge sends {line} as the payload, so the
   * guide's payload.moduleId read was always undefined. */
  async function handleStatus(msg, sender) {
    const payload = msg.payload || {};
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return null;
    const map = await SL.Storage.sessionGet('sl.status', {});
    map[tabId] = Object.assign({}, map[tabId]);
    map[tabId][msg.module] = payload.line;
    await SL.Storage.sessionSet('sl.status', map);
    return null;
  }
  async function dropTab(tabId) {
    const map = await SL.Storage.sessionGet('sl.status', {});
    if (map[tabId]) {
      delete map[tabId];
      await SL.Storage.sessionSet('sl.status', map);
    }
  }
  function initRouter() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      const moduleTable = HANDLERS[msg.module];
      (async () => {
        // Every module's 'status' route lands here, generically.
        if (msg.type === 'status') return handleStatus(msg, sender);
        const fn = moduleTable && moduleTable[msg.type];
        if (typeof fn !== 'function') {
          return { ok: false, error: 'unknown-route:' +
                  msg.module + '/' + msg.type };
        }
        return { ok: true, data: await fn(msg.payload || {}, sender) };
      })().then((res) => sendResponse(res || { ok: true, data: null }))
        .catch((err) => sendResponse({
          ok: false, error: String((err && err.message) || err)
        }));
      return true;   // async response
    });
  }
  root.Router = { register, initRouter, dropTab, HANDLERS };
})(globalThis);