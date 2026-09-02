/* shared/messaging.js - promise message bus. Message shape:
 *   {module, type, payload} -> {ok:true, data} | {ok:false, error} */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.msg) return;
  function send(module, type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ module, type, payload }, (res) => {
          // Absorb "Receiving end does not exist" (SW asleep or no listener)
          void chrome.runtime.lastError;
          resolve(res && typeof res === 'object' ? res
                  : { ok: false, error: 'no-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }
  /* Handler -> may return plain data (wrapped as {ok:true,data}) or a
   * full response object. Never throws across the boundary. */
  function listen(moduleId, handler) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return false;
      }
      if (msg.module !== moduleId && msg.module !== '*') return false;
      Promise.resolve(handler(msg, sender))
        .then((data) => {
          sendResponse(data && data.__response ? data
                       : { ok: true, data: data === undefined ? null : data });
        })
        .catch((err) => {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        });
      return true;   // keep the channel open for the async sendResponse
    });
  }
  root.msg = { send, listen };
})(globalThis);