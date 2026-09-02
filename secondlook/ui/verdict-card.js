/* ui/verdict-card.js - SLVerdict: pills and detail cards.
 * pill()  -> inline element you position yourself (hover previews)
 * card()  -> fixed-position detail card with rows, reasons, actions */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.SLVerdict) return;
  const KIND = {
    CLEAR: ['sl-pill--clear', 'Nothing unusual'],
    SECOND_LOOK: ['sl-pill--warn', 'Second look'],
    INTERCEPTED: ['sl-pill--danger', 'Intercepted']
  };
  /**
   * Build a verdict pill element.
   * @param {string} verdict CLEAR | SECOND_LOOK | INTERCEPTED
   * @param {string} [text] override label (default per verdict)
   */
  function pill(verdict, text) {
    const conf = KIND[verdict] || KIND.CLEAR;
    const el = document.createElement('span');
    el.className = 'sl-pill ' + conf[0] + ' sl-root';
    el.textContent = text || conf[1];
    return el;
  }
  /**
   * Build + show a detail card.
   * opts: {verdict, title, reasons:[string], rows:[{label,value}],
   *        actions:[{label,onClick,primary}], anchorEl?, onDismiss}
   * Positioning: below the anchor if given, else centered viewport.
   * Cards are singletons per page - showing one closes the previous.
   */
  let currentCard = null;
  function card(opts) {
    const o = opts || {};
    closeCard();
    const conf = KIND[o.verdict] || KIND.CLEAR;
    const wrap = document.createElement('div');
    wrap.className = 'sl-card sl-root';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', o.title || 'SecondLook details');
    const title = document.createElement('div');
    title.className = 'sl-card__title';
    title.textContent = o.title || conf[1];
    wrap.appendChild(title);
    const close = document.createElement('button');
    close.className = 'sl-card__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '\u00d7';   // multiplication sign, not emoji
    close.addEventListener('click', () => closeCard());
    wrap.appendChild(close);
    const pillEl = pill(o.verdict);
    wrap.appendChild(pillEl);
    wrap.appendChild(document.createElement('br'));
    for (const reason of (o.reasons || []).slice(0, 3)) {
      const r = document.createElement('div');
      r.className = 'sl-card__reason';
      r.textContent = reason;
      wrap.appendChild(r);
    }
    for (const row of (o.rows || [])) {
      const rowEl = document.createElement('div');
      rowEl.className = 'sl-card__row';
      const k = document.createElement('span');
      k.textContent = row.label;
      const v = document.createElement('b');
      v.textContent = row.value;
      rowEl.appendChild(k);
      rowEl.appendChild(v);
      wrap.appendChild(rowEl);
    }
    const actions = Array.isArray(o.actions) ? o.actions : [];
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'sl-card__row';
      row.style.border = '0';
      row.style.justifyContent = 'flex-end';
      row.style.gap = '8px';
      for (const act of actions) {
        const btn = document.createElement('button');
        btn.className = 'sl-btn' + (act.primary ? ' sl-btn--primary' : '');
        btn.type = 'button';
        btn.textContent = act.label;
        btn.addEventListener('click', () => {
          try { act.onClick && act.onClick(); } catch (e) {}
          closeCard();
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }
    (document.body || document.documentElement).appendChild(wrap);
    // Position: prefer below-left of the anchor, clamp to viewport.
    if (o.anchorEl && o.anchorEl.getBoundingClientRect) {
      const r = o.anchorEl.getBoundingClientRect();
      wrap.style.left = Math.max(8, Math.min(r.left,
        window.innerWidth - 392)) + 'px';
      wrap.style.top = Math.min(r.bottom + 6,
        window.innerHeight - wrap.offsetHeight - 8) + 'px';
    } else {
      wrap.style.left = '50%';
      wrap.style.top = '18%';
      wrap.style.transform = 'translateX(-50%)';
    }
    document.addEventListener('keydown', onDocKey, true);
    currentCard = { el: wrap, onDismiss: o.onDismiss };
    const firstBtn = wrap.querySelector('button');
    if (firstBtn) firstBtn.focus();
    return { dismiss: closeCard, el: wrap };
  }
  function onDocKey(e) {
    if (e.key === 'Escape') closeCard();
  }
  function closeCard() {
    if (!currentCard) return;
    const { el, onDismiss } = currentCard;
    currentCard = null;
    document.removeEventListener('keydown', onDocKey, true);
    el.remove();
    if (onDismiss) { try { onDismiss(); } catch (e) {} }
  }
  root.SLVerdict = { pill, card, closeCard };
  /* DEVIATION from guide: guide code calls bare SLVerdict.*, so the
   * namespace object is also exposed as a global. */
  globalThis.SLVerdict = root.SLVerdict;
})(globalThis);