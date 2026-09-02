/* modules/demo-greeting/demo-greeting.js - dev-only toggle proof.
 * Rides the exact pipeline real modules use; removed in Part 13. */
(function () {
  'use strict';
  if (!globalThis.SL || !SL.__bridge) return;
  let chip = null;
  function mount() {
    if (chip) return;
    chip = document.createElement('div');
    chip.className = 'sl-chip sl-demo-chip';
    chip.textContent = 'SecondLook active on this page';
    chip.appendChild(dismissButton());
    (document.body || document.documentElement).appendChild(chip);
    SL.registerCleanup('demoGreeting', unmount);
    SL.status('demoGreeting', 'Demo chip visible - toggles are real');
  }
  function dismissButton() {
    const btn = document.createElement('button');
    btn.className = 'sl-chip__dismiss';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Dismiss demo chip');
    btn.textContent = '\u00d7';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      unmount();
      SL.status('demoGreeting', 'Demo chip dismissed this tab');
    });
    return btn;
  }
  function unmount() {
    if (chip) { chip.remove(); chip = null; }
  }
  SL.boot('demoGreeting', {
    onEnabled() { mount(); },
    onDisabled() { unmount(); }
  });
})();