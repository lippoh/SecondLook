/* =====================================================================
 * SecondLook - Redirect Detective - content side (v2.2)
 * REPLACE the whole existing Redirect Detective content script with
 * this file (the same file path the sl-redirect-detective bundle
 * loads - do NOT create a new file next to it).
 * ---------------------------------------------------------------------
 * v2.2 is a thin control plane: the card itself is rendered by the
 * service worker via chrome.scripting (background/rd-sw.js). This
 * script handles late delivery (ready ping), live off/on, the
 * right-click "Where does this link really go?" trace (showChain
 * bounced to the SW for rendering), and the console API:
 *   await SecondLook.RD.selfTest()   // demo card
 *   await SecondLook.RD.debug()      // full state, both sides
 *   await SecondLook.RD.forceShow()  // replay last verdict for this tab
 *   SecondLook.RD.hide()             // remove the card
 * ===================================================================== */
(function () {
  'use strict';

  const V = 2.2;
  const CARD_ID = 'sl-rd2-card';
  const NS = (globalThis.SecondLook = globalThis.SecondLook || {});

  /* paste-safe guard: a same-or-newer copy already initialized */
  if (NS.RD && Number(NS.RD.__v) >= V) return;

  let up = false;

  const send = function (type, extra) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (r) {
        if (!done) { done = true; resolve(r || null); }
      };
      const timer = setTimeout(function () { finish(null); }, 3000);
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: type }, extra || {}),
          function (r) {
            clearTimeout(timer);
            void chrome.runtime.lastError;
            finish(r);
          }
        );
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
  };

  async function start() {
    if (up) return;
    up = true;
    console.log('[RD] content v2.2 up - try: await SecondLook.RD.selfTest()');
    /* ready ping: picks up a verdict that completed before this
     * script loaded (the old delivery race, now closed) */
    try { await send('RD2_READY'); } catch (e) {}
  }

  function stop() {
    if (!up) return;
    up = false;
    const card = document.getElementById(CARD_ID);
    if (card) card.remove();
  }

  /* right-click tracer support: the SW resolves the chain and sends
   * {type:'showChain', payload:{startUrl, chain, hops, error}}.
   * We bounce it to the SW renderer so there is exactly one card
   * implementation. Returns false - never holds the message port. */
  chrome.runtime.onMessage.addListener(function (msg) {
    try {
      if (msg && typeof msg === 'object' && msg.type === 'showChain' &&
          msg.payload && Array.isArray(msg.payload.chain) &&
          msg.payload.chain.length) {
        const p = msg.payload;
        send('RD2_RENDER', {
          data: {
            id: 'rd2-trace-' + Date.now(),
            chain: p.chain.slice(0, 16),
            hops: typeof p.hops === 'number'
              ? p.hops : Math.max(0, p.chain.length - 1),
            startUrl: p.startUrl || p.chain[0],
            error: p.error || null
          }
        });
      }
    } catch (e) {}
    return false;
  });

  NS.RD = {
    __v: V,
    version: '2.2',
    debug: async function () {
      const sw = await send('RD2_DEBUG');
      return {
        content: {
          up: up,
          cardOnPage: !!document.getElementById(CARD_ID),
          url: location.href
        },
        sw: sw
      };
    },
    forceShow: function () { return send('RD2_FORCE'); },
    selfTest: function () { return send('RD2_FORCE'); },
    hide: function () {
      const c = document.getElementById(CARD_ID);
      if (c) c.remove();
    }
  };

  /* self-starting module; the bridge watch only handles live off/on */
  start();

  const B = NS.Bridge || NS.CSBridge || globalThis.SLBridge ||
            globalThis.__slBridge || null;
  try {
    if (B && typeof B.watch === 'function') {
      B.watch('redirect-detective', function (on) { on ? start() : stop(); });
    }
  } catch (e) { /* bridge optional: OFF is enforced at registration */ }
})();