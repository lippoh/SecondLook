/* SecondLook — background/bootstrap.js (classic service worker)
 * Owns: script registration sync ("OFF is truly OFF"), the one-time
 * settings migration, and the popup snapshot endpoint.
 *
 * This file NEVER writes settings in reaction to a change event — the
 * register/unregister churn is gone by construction.
 */
'use strict';

importScripts(
  '/shared/settings.js',
  '/engine/verdict-engine.js',
  '/modules/redirect-detective/background.js'
);

const SL = globalThis.SecondLook;

/* Content bundles per implemented module. Anything not listed here is
 * never injected anywhere. CSS is registered with the bundle so page
 * CSP can never block our styling. */
const CS_MODULES = {
  'link-sniper': {
    scriptId: 'sl-link-sniper',
    js: [
      '/shared/settings.js',
      '/shared/cs-bridge.js',
      '/shared/sl-verdict.js',
      '/engine/verdict-engine.js',
      '/modules/link-sniper/content.js'
    ],
    css: ['/shared/sl-verdict.css', '/modules/link-sniper/content.css']
  },
  'redirect-detective': {
    scriptId: 'sl-redirect-detective',
    js: [
      '/shared/settings.js',
      '/shared/cs-bridge.js',
      '/modules/redirect-detective/content.js'
    ],
    css: ['/modules/redirect-detective/content.css']
  }
};

let syncing = null;
let syncQueued = false;

async function syncScripts() {
  const settings = await SL.Settings.get();
  const wanted = [];
  for (const [moduleId, def] of Object.entries(CS_MODULES)) {
    if (SL.Settings.isModuleOn(settings, moduleId)) wanted.push(def);
  }
  const wantedIds = new Set(wanted.map((d) => d.scriptId));

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const haveIds = new Set(registered.map((r) => r.id));

  /* Sweep: remove anything we no longer want — including leftover ids
   * from earlier builds (e.g. the old demo script). */
  const stale = [...haveIds].filter((id) => !wantedIds.has(id));
  if (stale.length) {
    try { await chrome.scripting.unregisterContentScripts({ ids: stale }); }
    catch (e) { console.warn('[SL] unregister failed:', stale, e && e.message); }
  }

  /* Add what's missing — no blind unregister/re-register of healthy ids. */
  for (const def of wanted) {
    if (haveIds.has(def.scriptId)) continue;
    try {
      await chrome.scripting.registerContentScripts([{
        id: def.scriptId,
        js: def.js,
        css: def.css,
        matches: ['<all_urls>'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
        world: 'ISOLATED'
      }]);
      console.info('[SL] registered content scripts:', def.scriptId);
    } catch (e) {
      console.warn('[SL] register failed:', def.scriptId, e && e.message);
    }
  }
  console.info('[SL] scripts in sync —', wanted.length, 'active module(s)');
}

function requestSync() {
  if (syncing) { syncQueued = true; return; }
  syncing = syncScripts()
    .catch((e) => console.warn('[SL] sync error:', e && e.message))
    .finally(() => {
      syncing = null;
      if (syncQueued) { syncQueued = false; requestSync(); }
    });
}

async function syncRD() {
  try {
    const s = await SL.Settings.get();
    SL.RD.setEnabled(SL.Settings.isModuleOn(s, 'redirect-detective'));
  } catch (e) { /* RD stays in its last known state */ }
}

/* Reactions to settings changes: READ ONLY. No writes here, ever. */
SL.Settings.onChange(() => {
  requestSync();
  syncRD();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await SL.Settings.migrate();   // one-time clean defaults (schema-gated)
  } catch (e) { console.warn('[SL] migrate failed:', e && e.message); }
  console.info('[SL] installed/updated:', details && details.reason);
  requestSync();
  syncRD();
});

chrome.runtime.onStartup.addListener(() => {
  requestSync();
  syncRD();
});

/* Cold start / any wake-up: reconcile and move on. */
requestSync();
syncRD();

/* ---- popup endpoint ---- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'SL_GET_SNAPSHOT') return false;   // RD answers its own types
  handleSnapshot(msg.tabId)
    .then(sendResponse)
    .catch(() => sendResponse(null));
  return true;   // async response
});

async function handleSnapshot(tabId) {
  const snap = { pageVerdict: null, chain: null, stats: null, engineVersion: SL.Engine.VERSION };
  try {
    if (typeof tabId === 'number' && tabId >= 0) {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && /^https?:/i.test(tab.url)) {
        snap.pageVerdict = SL.Engine.analyze(tab.url, { source: 'page' });
      }
      snap.chain = await SL.RD.getChainFor(tabId);
    }
  } catch (e) { /* partial snapshot is fine */ }
  try {
    const got = await chrome.storage.local.get('slStats');
    snap.stats = (got && got.slStats) || { v: 1, modules: {} };
  } catch (e) { snap.stats = { v: 1, modules: {} }; }
  return snap;
}