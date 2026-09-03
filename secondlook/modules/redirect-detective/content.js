/* SecondLook — modules/redirect-detective/content.js
 * Dismissible on-page "route card", shown when this page was reached
 * through a noteworthy route (2+ redirects). Reacts live to the module
 * toggle, never renders in iframes, and retries its fetch so a
 * cold-starting service worker can't swallow the card.
 *
 * Requires shared/cs-bridge.js to be registered BEFORE this file.
 */
(() => {
  'use strict';
  if (window.top !== window) return;               // main frame only
  const root = globalThis.SecondLook;
  if (!root || !root.Bridge) return;               // bridge missing: stay quiet

  const CARD_ID = 'sl-rd-card';
  const FETCH_ATTEMPTS = 3;
  const FETCH_GAP_MS = 350;
  let ctrl = null;

  function removeCard() {
    const el = document.getElementById(CARD_ID);
    if (el) el.remove();
    if (ctrl) { ctrl.abort(); ctrl = null; }
  }

  function hostList(hops) {
    const names = hops.map((h) => {
      try { return new URL(h).hostname.replace(/^www\./, ''); }
      catch (e) { return String(h); }
    });
    const dedup = names.filter((n, i) => i === 0 || n !== names[i - 1]);
    if (dedup.length > 6) {
      return dedup.slice(0, 2).concat(['...'], dedup.slice(-2));
    }
    return dedup;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchChain() {
    for (let i = 0; i < FETCH_ATTEMPTS; i++) {
      const res = await root.Bridge.send({ type: 'SL_RD_GET_CHAIN' });
      if (res && Array.isArray(res.hops) && res.hops.length) return res;
      if (i < FETCH_ATTEMPTS - 1) await sleep(FETCH_GAP_MS);
    }
    return null;
  }

  async function start() {
    if (!(await root.Bridge.enabledFor('redirect-detective'))) return;
    const chain = await fetchChain();
    if (!chain || !Array.isArray(chain.hops) || chain.hops.length < 3) return;

    /* Stale-route guard: if you navigated on since landing, stay quiet. */
    let lastHost = '';
    try { lastHost = new URL(chain.hops[chain.hops.length - 1]).hostname; } catch (e) {}
    const here = location.hostname;
    const sameSite = lastHost === here ||
      lastHost.endsWith('.' + here) || here.endsWith('.' + lastHost);
    if (!sameSite) return;

    const suspicious = chain.verdict !== 'CLEAR';
    const redirects = chain.hops.length - 1;

    removeCard();
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.className = 'sl-rd-card' + (suspicious ? ' sl-rd-warn' : '');
    card.setAttribute('role', 'status');

    const head = document.createElement('div');
    head.className = 'sl-rd-head';
    const dot = document.createElement('span');
    dot.className = 'sl-rd-dot';
    const title = document.createElement('strong');
    title.textContent = redirects +
      (redirects === 1 ? ' redirect' : ' redirects') + ' to reach this page';
    const close = document.createElement('button');
    close.className = 'sl-rd-close';
    close.type = 'button';
    close.textContent = '\u00d7';
    close.title = 'Dismiss (Esc)';
    close.setAttribute('aria-label', 'Dismiss');
    head.append(dot, title, close);

    const route = document.createElement('div');
    route.className = 'sl-rd-route';
    const shown = hostList(chain.hops);
    shown.forEach((name, i) => {
      if (i) route.appendChild(document.createTextNode(' \u2192 '));
      const span = document.createElement(i === shown.length - 1 ? 'b' : 'span');
      span.textContent = name;
      route.appendChild(span);
    });

    card.append(head, route);

    if (chain.error) {
      const err = document.createElement('div');
      err.className = 'sl-rd-err';
      err.textContent = 'The route did not finish cleanly (' + chain.error + ').';
      card.appendChild(err);
    }

    if (Array.isArray(chain.reasons) && chain.reasons.length) {
      const ul = document.createElement('ul');
      ul.className = 'sl-rd-why';
      for (const r of chain.reasons) {
        const li = document.createElement('li');
        li.textContent = r;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const foot = document.createElement('div');
    foot.className = 'sl-rd-foot';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sl-rd-more';
    more.textContent = 'Show every hop';
    foot.appendChild(more);

    const full = document.createElement('ol');
    full.className = 'sl-rd-full';
    full.hidden = true;
    for (const h of chain.hops) {
      const li = document.createElement('li');
      li.textContent = h;
      full.appendChild(li);
    }

    card.append(foot, full);
    document.documentElement.appendChild(card);

    ctrl = new AbortController();
    const opts = { signal: ctrl.signal, capture: true };
    close.addEventListener('click', removeCard);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') removeCard();
    }, opts);
    more.addEventListener('click', () => {
      const open = !full.hidden;
      full.hidden = open;
      more.textContent = open ? 'Show every hop' : 'Hide hops';
    });
  }

  /* Live toggle-off: the card disappears immediately. */
  if (typeof root.Bridge.watch === 'function') {
    root.Bridge.watch('redirect-detective', (on) => { if (!on) removeCard(); });
  }

  start();
})();