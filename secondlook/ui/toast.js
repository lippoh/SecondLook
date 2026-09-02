/* ui/toast.js - SLToast: stacked, dismissible, undo-friendly toasts.
 * Classic script; runs in content worlds AND extension pages. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.SLToast) return;
  function ensureStack() {
    let stack = document.querySelector('.sl-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'sl-toast-stack sl-root';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      (document.body || document.documentElement).appendChild(stack);
    }
    return stack;
  }
  /**
   * Show a toast. Returns a handle with dismiss().
   * opts: {kind:'info'|'ok'|'warn'|'danger', title, body, timeoutMs,
   *        actions:[{label, onClick, primary}], onDismiss}
   * Undo pattern: pass actions:[{label:'Undo', onClick:fn}] - the
   * action runs, the toast closes, the user is never trapped.
   */
  function show(opts) {
    const o = opts || {};
    const stack = ensureStack();
    const toast = document.createElement('div');
    toast.className = 'sl-toast sl-toast--' + (o.kind || 'info');
    if (o.title) {
      const t = document.createElement('div');
      t.className = 'sl-toast__title';
      t.textContent = o.title;
      toast.appendChild(t);
    }
    if (o.body) {
      const b = document.createElement('div');
      b.className = 'sl-toast__body';
      b.textContent = o.body;
      toast.appendChild(b);
    }
    let dismissed = false;
    const actions = Array.isArray(o.actions) ? o.actions : [];
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'sl-toast__actions';
      for (const act of actions) {
        const btn = document.createElement('button');
        btn.className = 'sl-btn' + (act.primary ? ' sl-btn--primary' : '');
        btn.type = 'button';
        btn.textContent = act.label;
        btn.addEventListener('click', () => {
          try { act.onClick && act.onClick(); } catch (e) { /* undo errors
            must never break the toast lifecycle */ }
          dismiss();
        });
        row.appendChild(btn);
      }
      toast.appendChild(row);
    }
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.remove();
      if (o.onDismiss) { try { o.onDismiss(); } catch (e) {} }
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape' && stack.contains(toast)) dismiss();
    }
    document.addEventListener('keydown', onKey);
    stack.appendChild(toast);
    const firstBtn = toast.querySelector('button');
    if (firstBtn && actions.length) firstBtn.focus();
    const ms = typeof o.timeoutMs === 'number' ? o.timeoutMs : 8000;
    if (ms > 0 && !actions.length) setTimeout(dismiss, ms);
    else if (ms > 0) setTimeout(dismiss, Math.max(ms, 20000));
    return { dismiss, el: toast };
  }
  root.SLToast = { show };
  /* DEVIATION from guide: later guide parts call bare SLToast.*. */
  globalThis.SLToast = root.SLToast;
})(globalThis);
