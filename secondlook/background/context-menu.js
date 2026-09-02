/* background/context-menu.js - right-click entries. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.CtxMenu) return;
  const ID_TRACE = 'sl-where-does-this-go';
  const ID_SAFE = 'sl-safe-mode';
  function init() {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: ID_TRACE,
        title: 'Where does this link really go?',
        contexts: ['link']
      });
      chrome.contextMenus.create({
        id: ID_SAFE,
        title: 'SecondLook: Safe Mode for this tab',
        contexts: ['page']
      });
    });
  }
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    if (info.menuItemId === ID_TRACE && info.linkUrl) {
      const result = await SL.Engine.Redirect.resolve(info.linkUrl);
      try {
        await chrome.tabs.sendMessage(tab.id, {
          module: 'redirectDetective',
          type: 'showChain',
          payload: { startUrl: info.linkUrl, chain: result.chain,
                     hops: result.hops, error: result.error }
        });
      } catch (e) {
        // Redirect Detective content script not present (module off or
        // Part 2 not built yet). Nothing to do - resolution still ran.
      }
    } else if (info.menuItemId === ID_SAFE) {
      const safeTabs = await SL.Storage.sessionGet('sl.safemode', []);
      const on = !safeTabs.includes(tab.id);
      await SL.SafeMode.set(tab.id, on);
    }
  });
  root.CtxMenu = { init, ID_TRACE, ID_SAFE };
})(globalThis);