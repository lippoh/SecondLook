/* SecondLook — modules/trust-badge/content.js
 * The quiet green side of SecondLook. When a page's own address raises
 * no flags, show a small "this site checks out" chip with the reasons
 * one tap away. Amber and red pages stay OFF the page on purpose:
 * warnings already live in the popup, the pill, and the other modules.
 *
 * Behaviour:
 *   - Main frame only, https only (no green chip over plain http).
 *   - Bottom-right (Redirect Detective's card owns the bottom-left).
 *   - Dismissible (x or Esc), auto-fades after 15s unless opened or
 *     hovered, at most once per page load, and leaves no trace a page
 *     script could read afterwards (no sessionStorage keys).
 *   - Optionally quotes Redirect Detective's real route record ("clean
 *     route") — only when RD is on and the route was CLEAR.
 *   - Reacts live to the module toggle: off = chip vanishes at once.
 *   - Requires shared/cs-bridge.js and engine/verdict-engine.js to be
 *     registered BEFORE this file (bootstrap.js does this).
 */
(() => {
  'use strict';
  if (window.top !== window) return;               // main frame only
  const root = globalThis.SecondLook;
  if (!root || !root.Bridge) return;               // bridge missing: stay quiet
  if (root.TB) return;                             // one chip per page
  root.TB = true;

  const CHIP_ID = 'sl-tb-chip';
  const AUTO_FADE_MS = 15000;        // 0 = stay until dismissed
  const SHOW_DELAY_MS = 600;         // let the page settle before appearing

  let ctrl = null;                   // Esc listener
  let fadeTimer = null;
  let hover = false;
  let open = false;

  function removeChip(now) {
    const el = document.getElementById(CHIP_ID);
    if (el) {
      if (now) el.remove();
      else {
        el.classList.add('sl-tb-out');
        setTimeout(() => {
          const e2 = document.getElementById(CHIP_ID);
          if (e2) e2.remove();
        }, 300);
      }
    }
    if (ctrl) { ctrl.abort(); ctrl = null; }
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }

  /* Borrow Redirect Detective's record for this tab — only when it is
   * on AND the route was CLEAR. Anything else is silence, not a guess. */
  function routeNote() {
    return root.Bridge.send({ type: 'SL_RD_GET_CHAIN' })
      .then((res) => {
        if (!res || !Array.isArray(res.hops) || res.hops.length < 2) return null;
        if (res.verdict && res.verdict !== 'CLEAR') return null;
        const hops = res.hops.length - 1;
        return 'You arrived through a clean route (' + hops +
          (hops === 1 ? ' redirect' : ' redirects') + ', nothing unusual).';
      })
      .catch(() => null);
  }

  function countVouched() {                    // best-effort, fire-and-forget
    (async () => {
      try {
        const got = await chrome.storage.local.get('slStats');
        const stats = (got && got.slStats) || { v: 1, modules: {} };
        const m = (stats.modules['trust-badge'] = stats.modules['trust-badge'] || {});
        m.vouched = (m.vouched || 0) + 1;
        await chrome.storage.local.set({ slStats: stats });
      } catch (e) { /* stats are best-effort */ }
    })();
  }

  function armFade() {
    if (!AUTO_FADE_MS || open || hover) return;
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => removeChip(false), AUTO_FADE_MS);
  }

  function render(goods) {
    removeChip(true);

    const chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.setAttribute('role', 'status');

    const head = document.createElement('div');
    head.className = 'sl-tb-head';
    const dot = document.createElement('span');
    dot.className = 'sl-tb-dot';
    const title = document.createElement('strong');
    title.textContent = 'This site checks out';
    const why = document.createElement('button');
    why.type = 'button';
    why.className = 'sl-tb-why-btn';
    why.textContent = 'Why?';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sl-tb-close';
    close.textContent = '\u00d7';
    close.title = 'Dismiss (Esc)';
    close.setAttribute('aria-label', 'Dismiss');
    head.append(dot, title, why, close);

    const list = document.createElement('ul');
    list.className = 'sl-tb-why';
    list.hidden = true;
    for (const g of goods) {
      const li = document.createElement('li');
      li.textContent = g;
      list.appendChild(li);
    }

    chip.append(head, list);
    document.documentElement.appendChild(chip);

    ctrl = new AbortController();
    const opts = { signal: ctrl.signal, capture: true };
    close.addEventListener('click', () => removeChip(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') removeChip(false);
    }, opts);
    why.addEventListener('click', () => {
      open = !open;
      list.hidden = !open;
      why.textContent = open ? 'Hide' : 'Why?';
      if (open && fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
      else armFade();
    });
    chip.addEventListener('mouseenter', () => {
      hover = true;
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    });
    chip.addEventListener('mouseleave', () => { hover = false; armFade(); });

    armFade();
    countVouched();
  }

  async function start() {
    if (location.protocol !== 'https:') return;   // never vouch for plain http
    if (!(await root.Bridge.enabledFor('trust-badge'))) return;

    const Engine = root.Engine;
    if (!Engine || typeof Engine.analyze !== 'function') return;

    let v = null;
    try { v = Engine.analyze(location.href, { source: 'page' }); }
    catch (e) { return; }
    if (!v || v.verdict !== 'CLEAR') return;      // flagged pages stay quiet here

    const goods = ['The connection to this site is secure (https).',
                   'Nothing about this address raises a flag - no look-alike ' +
                   'spelling, no link shortener, no odd host.'];
    const route = await routeNote();
    if (route) goods.push(route);

    setTimeout(() => {
      if (document.getElementById(CHIP_ID)) return;       // already shown
      root.Bridge.enabledFor('trust-badge').then((on) => {
        if (on) render(goods);
      });
    }, SHOW_DELAY_MS);
  }

  /* Live toggle-off: the chip disappears immediately. */
  if (typeof root.Bridge.watch === 'function') {
    root.Bridge.watch('trust-badge', (on) => { if (!on) removeChip(true); });
  }

  start();
})();