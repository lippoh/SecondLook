/* SecondLook — modules/link-sniper/content.js
 * Hover verdicts for links. In this version:
 *  - Alt+P (or F2) pins the bubble open so it survives the cursor leaving;
 *    Esc or a click outside dismisses it. (Tab was a browser conflict.)
 *  - Scan counters persist through storage (Bridge stats) — they survive
 *    toggles and reloads.
 *  - The bubble sizes itself to its content (no more clipped reasons).
 *  - Richer engine signals: torrents/magnets, unlicensed-streaming
 *    patterns, .zip/.mov tricks, plus an info block: destination host,
 *    insecure http, file downloads, link text.
 *  - Live toggle: switching the module off mid-page tears everything down.
 *  - Self-starts at load (activate() is idempotent, so the bridge's
 *    initial watch fire AND this check can both run safely).
 *  - Stats are best-effort: a bridge without bumpStat() can no longer
 *    break the pill — that regression is what killed this module.
 */
(() => {
  'use strict';
  const root = globalThis.SecondLook;
  if (!root || !root.Bridge || !root.Engine || !globalThis.SLVerdict) return;
  if (root.LinkSniper) return;
  root.LinkSniper = true;

  const PIN_HINT = 'Alt+P keeps this open · Esc closes it';
  const SHOW_DELAY_MS = 160;     // flagged links: appear quickly
  const CLEAR_DELAY_MS = 320;    // clean links: calm, slightly later
  const HIDE_DELAY_MS = 240;

  let ctrl = null;      // AbortController while active
  let pop = null;       // current popup element
  let pinned = false;
  let hideTimer = 0;
  let showTimer = 0;
  const verdictCache = new Map();

  /* Stats must never be able to kill the pill: a missing or throwing
   * bumpStat is swallowed here. */
  function bump(field) {
    try {
      if (typeof root.Bridge.bumpStat === 'function') {
        root.Bridge.bumpStat('link-sniper', field);
      }
    } catch (e) { /* best-effort */ }
  }

  /* ---- lifecycle (driven by the bridge) ---- */
  root.Bridge.watch('link-sniper', (on) => (on ? activate() : deactivate()));
  /* Belt-and-braces self-start: activate() guards against double-start,
   * so this is harmless when watch()'s initial fire already ran — and
   * life-saving if it ever doesn't. */
  if (typeof root.Bridge.enabledFor === 'function') {
    root.Bridge.enabledFor('link-sniper')
      .then((on) => { if (on) activate(); })
      .catch(() => {});
  }

  function activate() {
    if (ctrl) return;
    ctrl = new AbortController();
    const opts = { signal: ctrl.signal, capture: true };
    document.addEventListener('pointerover', onOver, opts);
    document.addEventListener('pointerout', onOut, opts);
    document.addEventListener('focusin', onOver, opts);
    document.addEventListener('focusout', onOut, opts);
    document.addEventListener('keydown', onKey, opts);
    document.addEventListener('pointerdown', onPointerDown, opts);
    window.addEventListener('blur', hideNow, opts);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hideNow();
    }, opts);
  }

  function deactivate() {
    hideNow();
    if (ctrl) { ctrl.abort(); ctrl = null; }
    verdictCache.clear();
  }

  /* ---- hover/focus tracking (delegated — no per-link listeners) ---- */
  function anchorFrom(e) {
    const t = e.target;
    if (!t || !t.closest) return null;
    return t.closest('a[href]');
  }

  function verdictFor(a) {
    const href = a.getAttribute('href');
    let v = verdictCache.get(href);
    if (!v) {
      v = root.Engine.analyze(href, { text: a.textContent || '', base: location.href });
      if (verdictCache.size > 800) verdictCache.clear();
      verdictCache.set(href, v);
    }
    return v;
  }

  function onOver(e) {
    const a = anchorFrom(e);
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^(mailto|tel|sms|callto):/i.test(href)) return;
    clearTimeout(hideTimer);
    if (pop && pop._link === a) return;
    if (pinned) return;                       // user is studying the pinned bubble
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(a),
      verdictFor(a).verdict === 'CLEAR' ? CLEAR_DELAY_MS : SHOW_DELAY_MS);
  }

  function onOut(e) {
    const a = anchorFrom(e);
    if (!a || pinned) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hideNow, HIDE_DELAY_MS);
  }

  function onPointerDown(e) {
    if (!pinned || !pop) return;
    if (pop.contains(e.target)) return;
    hideNow();
  }

  function onKey(e) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    if (!pop) return;
    if (e.key === 'Escape') { hideNow(); return; }
    const isPin = (e.altKey && !e.ctrlKey && !e.metaKey &&
      (e.code === 'KeyP' || /^p$/i.test(e.key || ''))) || e.key === 'F2';
    if (isPin) {
      pinned = !pinned;
      pop.classList.toggle('sl-ls-pinned', pinned);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /* ---- rendering ---- */
  function show(a) {
    if (!ctrl) return;
    const v = verdictFor(a);
    bump('scanned');
    if (v.verdict !== 'CLEAR') bump('flagged');
    hideNow();

    pop = document.createElement('div');
    pop.className = 'sl-ls-pop';
    pop._link = a;
    if (v.verdict === 'CLEAR') {
      pop.classList.add('sl-ls-mini');
      pop.appendChild(globalThis.SLVerdict.pill('CLEAR', 'OK'));
    } else {
      pop.appendChild(buildBubble(a, v));
    }
    document.documentElement.appendChild(pop);
    place(a, pop);
  }

  function buildBubble(a, v) {
    const box = document.createElement('div');
    box.className = 'sl-ls-box';

    const head = document.createElement('div');
    head.className = 'sl-ls-head';
    head.appendChild(globalThis.SLVerdict.pill(v.verdict, 'Take a second look'));
    const sig = document.createElement('span');
    sig.className = 'sl-ls-signals';
    sig.textContent = v.reasons.length + (v.reasons.length === 1 ? ' signal' : ' signals');
    head.appendChild(sig);
    box.appendChild(head);

    if (v.reasons.length) {
      const ul = document.createElement('ul');
      ul.className = 'sl-ls-reasons';
      for (const r of v.reasons.slice(0, 4)) {
        const li = document.createElement('li');
        li.textContent = r;
        ul.appendChild(li);
      }
      if (v.reasons.length > 4) {
        const li = document.createElement('li');
        li.className = 'sl-ls-more';
        li.textContent = '+ ' + (v.reasons.length - 4) + ' more';
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    const info = buildInfo(a, v);
    if (info) box.appendChild(info);

    const hint = document.createElement('div');
    hint.className = 'sl-ls-hint';
    hint.textContent = PIN_HINT;
    box.appendChild(hint);

    return box;
  }

  function buildInfo(a, v) {
    const rows = [];
    const m = v.meta || {};
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      rows.push(['Goes to', u.hostname.replace(/^www\./, '')]);
      if (m.shortlink) rows.push(['Kind', 'Shortened link']);
      else if (m.magnet || m.torrent) rows.push(['Kind', 'Torrent / magnet']);
      else if (m.file) rows.push(['Kind', '.' + m.file + ' download']);
      if (m.piracy) rows.push(['Note', 'Unlicensed streaming pattern']);
      if (m.scheme === 'http') rows.push(['Connection', 'Not secure (http)']);
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) rows.push(['Link text', '"' + (txt.length > 42 ? txt.slice(0, 42) + '…' : txt) + '"']);
    } catch (e) { /* info is best-effort */ }
    if (!rows.length) return null;
    const dl = document.createElement('dl');
    dl.className = 'sl-ls-info';
    for (const [k, val] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = val;
      dl.append(dt, dd);
    }
    return dl;
  }

  function place(a, el) {
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    el.style.visibility = 'hidden';
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = Math.max(8, Math.min(r.left, vw - w - 8));
    let y = r.bottom + 8;
    if (y + h > vh - 8) y = r.top - h - 8;
    if (y < 8) y = Math.max(8, vh - h - 8);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.visibility = '';
  }

  function hideNow() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (pop) { pop.remove(); pop = null; }
    pinned = false;
  }
})();