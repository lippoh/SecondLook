/* SecondLook runtime - one MV3 service-worker entry for the active stack. */
'use strict';

importScripts(
  '/shared/settings.js',
  '/engine/verdict-engine.js',
  '/background/rd-sw.js'
);

const MODULES = {
  'link-sniper': {
    scriptId: 'sl-link-sniper',
    js: [
      'shared/settings.js', 'shared/cs-bridge.js', 'shared/sl-verdict.js',
      'engine/verdict-engine.js', 'modules/link-sniper/content.js'
    ],
    css: ['shared/sl-verdict.css', 'modules/link-sniper/content.css']
  },
  'redirect-detective': {
    scriptId: 'sl-redirect-detective',
    js: [
      'shared/settings.js', 'shared/cs-bridge.js',
      'modules/redirect-detective/content.js'
    ],
    css: ['modules/redirect-detective/card.css']
  },
  'trust-badge': {
    scriptId: 'sl-trust-badge',
    js: [
      'shared/settings.js', 'shared/cs-bridge.js',
      'modules/trust-badge/active.js'
    ],
    css: ['modules/trust-badge/active.css']
  },
  'form-guardian': {
    scriptId: 'sl-form-guardian',
    js: [
      'shared/settings.js', 'engine/verdict-engine.js',
      'modules/form-guardian/index.js'
    ],
    css: ['modules/form-guardian/style.css']
  }
};

const HTTP_MATCHES = ['http://*/*', 'https://*/*'];
const SETTINGS_KEY = globalThis.SecondLook.Settings.KEY;
let syncPromise = null;
let syncAgain = false;
const enabledState = Object.create(null);

async function moduleEnabled(id) {
  return globalThis.SecondLook.Settings.isModuleOn(id);
}

async function desiredModules() {
  const enabled = [];
  for (const [id, def] of Object.entries(MODULES)) {
    if (await moduleEnabled(id)) enabled.push(def);
  }
  return enabled;
}

async function syncScripts() {
  const desired = await desiredModules();
  const desiredIds = new Set(desired.map((def) => def.scriptId));
  const current = await chrome.scripting.getRegisteredContentScripts();
  const currentIds = new Set(current.map((item) => item.id));

  const stale = [...currentIds].filter((id) => !desiredIds.has(id));
  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale });
  }

  for (const def of desired) {
    if (currentIds.has(def.scriptId)) continue;
    await chrome.scripting.registerContentScripts([{
      id: def.scriptId,
      matches: HTTP_MATCHES,
      js: def.js,
      css: def.css,
      runAt: 'document_idle',
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions: true
    }]);
  }
}

function requestSync() {
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  syncPromise = syncScripts().catch((error) => {
    console.error('[SecondLook] content-script sync failed:', error);
  }).finally(() => {
    syncPromise = null;
    if (syncAgain) {
      syncAgain = false;
      requestSync();
    }
  });
  return syncPromise;
}

async function broadcast(moduleId, on) {
  const tabs = await chrome.tabs.query({ url: HTTP_MATCHES });
  await Promise.all(tabs.map(async (tab) => {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SL_MODULE_STATE', module: moduleId, on: !!on
      });
    } catch (e) { /* the module may not be present in this tab */ }
  }));
}

async function injectIntoOpenTabs(moduleId) {
  const def = MODULES[moduleId];
  if (!def) return;
  const tabs = await chrome.tabs.query({ url: HTTP_MATCHES });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: def.js
      });
      if (def.css.length) {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id }, files: def.css
        });
      }
    } catch (e) { /* tab navigated or is no longer injectable */ }
  }
}

async function reconcile() {
  for (const id of Object.keys(MODULES)) {
    const after = await moduleEnabled(id);
    if (enabledState[id] !== undefined && enabledState[id] !== after) {
      await broadcast(id, after);
      if (after) await injectIntoOpenTabs(id);
    }
    enabledState[id] = after;
  }
  await requestSync();
}

async function snapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  const pageVerdict = /^https?:/i.test(url)
    ? globalThis.SecondLook.Engine.analyze(url, { source: 'popup' }) : null;
  const stats = (await chrome.storage.local.get('slStats')).slStats ||
    { v: 1, modules: {} };
  let chain = null;
  try {
    const key = 'rd2:chain:' + tabId;
    const stored = (await chrome.storage.session.get(key))[key];
    if (stored && Array.isArray(stored.urls)) {
      chain = { hops: stored.urls, reasons: [] };
    }
  } catch (e) { /* redirect state is optional */ }
  return { pageVerdict, chain, stats, url, host: (() => {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  })() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'SL_SYNC_NOW') {
    requestSync();
    return false;
  }
  if (msg.type !== 'SL_GET_SNAPSHOT') return false;
  snapshot(msg.tabId).then(sendResponse).catch(() => sendResponse(null));
  return true;
});

globalThis.SecondLook.Settings.onChange(() => {
  reconcile().catch((error) => {
    console.error('[SecondLook] settings reconciliation failed:', error);
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await globalThis.SecondLook.Settings.migrate();
  await requestSync();
});
chrome.runtime.onStartup.addListener(requestSync);
chrome.tabs.onRemoved.addListener((tabId) => {
  try { chrome.storage.session.remove(['rd2:chain:' + tabId, 'rd2:verdict:' + tabId]); }
  catch (e) {}
});

chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: 'sl-where-does-this-go',
    title: 'Where does this link really go?',
    contexts: ['link']
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || info.menuItemId !== 'sl-where-does-this-go' || !info.linkUrl) return;
  try {
    const response = await fetch(info.linkUrl, {
      redirect: 'follow', credentials: 'omit', cache: 'no-store'
    });
    const result = { chain: [info.linkUrl, response.url || info.linkUrl],
      hops: response.url && response.url !== info.linkUrl ? 1 : 0,
      error: null };
    await chrome.tabs.sendMessage(tab.id, {
      type: 'showChain',
      payload: { startUrl: info.linkUrl, chain: result.chain,
        hops: result.hops, error: result.error }
    });
  } catch (e) { /* no redirect module in this tab */ }
});

reconcile();
