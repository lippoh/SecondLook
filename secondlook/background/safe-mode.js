/* background/safe-mode.js - per-tab network freeze via DNR session rules.
 * This is the ONLY blocking code path in the whole extension. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.SafeMode) return;
  const RULE_BASE = 90000;   // rule id = RULE_BASE + tabId (unique per tab)
  const RESOURCE_TYPES = [   // everything except main_frame: the page
    'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'media', 'websocket', 'webtransport',
    'webbundle', 'csp_report', 'other'
  ];
  async function set(tabId, on) {
    const list = await SL.Storage.sessionGet('sl.safemode', []);
    const idx = list.indexOf(tabId);
    if (on) {
      if (idx === -1) { list.push(tabId);
        await SL.Storage.sessionSet('sl.safemode', list); }
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: RULE_BASE + tabId,
          priority: 1,
          condition: { tabIds: [tabId], resourceTypes: RESOURCE_TYPES },
          action: { type: 'BLOCK' }
        }]
      });
    } else {
      if (idx !== -1) { list.splice(idx, 1);
        await SL.Storage.sessionSet('sl.safemode', list); }
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [RULE_BASE + tabId]
      });
    }
    // Toolbar state for this tab only.
    await chrome.action.setBadgeText({ tabId, text: on ? 'SAFE' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b45309' });
    try {
      await chrome.tabs.sendMessage(tabId,
        { module: '*', type: 'safeModeChanged', payload: { on } });
    } catch (e) { /* no listener in tab - fine */ }
  }
  async function isOn(tabId) {
    const list = await SL.Storage.sessionGet('sl.safemode', []);
    return list.includes(tabId);
  }
  async function clearFor(tabId) {
    try { await set(tabId, false); } catch (e) { /* tab already gone */ }
  }
  root.SafeMode = { set, isOn, clearFor, RULE_BASE, RESOURCE_TYPES };
})(globalThis);
