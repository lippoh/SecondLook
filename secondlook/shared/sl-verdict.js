/* SecondLook — shared/sl-verdict.js
 * Global verdict chip: SLVerdict.pill(verdict, label, opts)
 * verdict: 'CLEAR' | 'SECOND_LOOK' | 'INTERCEPTED'
 * Styles live in shared/sl-verdict.css (linked by the popup, registered
 * with content bundles — immune to page CSP).
 */
(() => {
  'use strict';
  if (globalThis.SLVerdict) return;

  const LABELS = {
    CLEAR: 'Looks fine',
    SECOND_LOOK: 'Take a look',
    INTERCEPTED: 'Blocked'
  };
  const CLASS = {
    CLEAR: 'sl-v-clear',
    SECOND_LOOK: 'sl-v-warn',
    INTERCEPTED: 'sl-v-bad'
  };

  function pill(verdict, label, opts) {
    opts = opts || {};
    const v = CLASS[verdict] ? verdict : 'CLEAR';
    const el = document.createElement(opts.tag || 'span');
    el.className = 'sl-pill ' + CLASS[v] + (opts.size === 'lg' ? ' sl-pill-lg' : '');
    el.setAttribute('data-sl-verdict', v);
    const dot = document.createElement('span');
    dot.className = 'sl-pill-dot';
    el.appendChild(dot);
    el.appendChild(document.createTextNode(label != null ? String(label) : LABELS[v]));
    if (opts.title) el.title = opts.title;
    return el;
  }

  globalThis.SLVerdict = { pill, LABELS };
})();