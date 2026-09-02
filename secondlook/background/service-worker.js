/* background/service-worker.js - the single brain.
 * Classic worker; importScripts keeps shared files identical across
 * every runtime in the extension. All listeners register synchronously
 * (MV3 requirement: the worker dies often and must re-arm instantly). */
importScripts(
  '/shared/storage.js',
  '/shared/settings.js',
  '/shared/messaging.js',
  '/shared/module-registry.js',
  '/engine/known-brands.js',
  '/engine/domain-intel.js',
  '/engine/url-analyzer.js',
  '/engine/redirect-resolver.js',
  '/engine/verdict-engine.js',
  '/background/bootstrap.js',
  '/background/module-router.js',
  '/background/context-menu.js',
  '/background/safe-mode.js'
);
/* Part 7/8 append their files to the list above when those parts land. */
chrome.runtime.onInstalled.addListener(async (details) => {
  await SL.Bootstrap.reconcile('install:' + details.reason);
  SL.CtxMenu.init();
  await SL.Storage.ensureSalt();
  if (details.reason === 'install') {
    await SL.Storage.bumpStat('core', null);
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await SL.Bootstrap.reconcile('startup');
});
/* The single reconciliation point: the SW is the only settings writer,
 * so every toggle flows through here exactly once. */
SL.Settings.subscribe(async (next, prev) => {
  const ids = SL.Registry.MODULES.map((m) => m.id);
  for (const id of ids) {
    const was = prev && SL.Settings.isModuleOn(prev, id, null);
    const now = SL.Settings.isModuleOn(next, id, null);
    if (was === now) continue;
    // Broadcast before reconcile: pages clean themselves up while the
    // registration state settles.
    await SL.Bootstrap.broadcast(id, now);
    if (now) await SL.Bootstrap.injectIntoOpenTabs(id);
  }
  const globalWas = prev ? prev.globalEnabled !== false : true;
  const globalNow = next.globalEnabled !== false;
  if (globalWas !== globalNow) {
    await SL.Bootstrap.broadcastAll({
      module: '*', type: 'globalToggled',
      payload: { enabled: globalNow }
    });
  }
  await SL.Bootstrap.reconcile('settings-changed');
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await SL.Router.dropTab(tabId);
  await SL.SafeMode.clearFor(tabId);
});
/* Daily-ish prune of the local event log (never grows past EVENTS_MAX). */
chrome.alarms.create('sl:prune', { periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sl:prune') await SL.Storage.pruneEvents();
});
SL.Router.initRouter();