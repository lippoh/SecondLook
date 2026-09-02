/* ============================================================
   SecondLook — ui/verdict-card.js  (v1.1)
   Shared verdict visuals. Global: window.SLVerdict.
   API unchanged: SLVerdict.pill(kind, label) -> HTMLElement
                  SLVerdict.card(kind, title, reasons) -> HTMLElement
   Markup matched to components.css v1.2.
   ============================================================ */
(function () {
  'use strict';

  function kindClass(kind) {
    const k = String(kind || '').toUpperCase().replace(/\s+/g, '_');
    if (k === 'CLEAR' || k === 'OK') return 'ok';
    if (k === 'SECOND_LOOK' || k === 'WARN') return 'warn';
    if (k === 'INTERCEPTED' || k === 'DANGER') return 'danger';
    return 'neutral';
  }

  /** Small rounded status pill. */
  function pill(kind, label) {
    const node = document.createElement('span');
    node.className = 'sl-pill sl-pill--' + kindClass(kind);
    const dot = document.createElement('span');
    dot.className = 'sl-pill__dot';
    node.appendChild(dot);
    node.appendChild(document.createTextNode(label || String(kind || '')));
    return node;
  }

  /** Larger card with a title and a reason list. */
  function card(kind, title, reasons) {
    const node = document.createElement('div');
    node.className = 'sl-card sl-card--' + kindClass(kind);
    const head = document.createElement('div');
    head.className = 'sl-card__title';
    head.textContent = title || String(kind || '');
    node.appendChild(head);
    const list = document.createElement('ul');
    list.className = 'sl-card__reasons';
    (Array.isArray(reasons) ? reasons : []).forEach((r) => {
      const text = typeof r === 'string' ? r : (r && (r.plainText || r.text)) || '';
      if (!text) return;
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    if (list.children.length) node.appendChild(list);
    return node;
  }

  window.SLVerdict = { pill: pill, card: card, kindClass: kindClass };
})();