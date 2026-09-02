/* modules/redirect-detective/redirect-detective.js - renders redirect
 * chains as a card. Resolution itself lives in the SW (Part 0). */
(function () {
  'use strict';
  if (!globalThis.SL || !SL.__bridge) return;
  /* SSO handoffs: legitimate redirect machinery, not suspicion. */
  const SSO_SAFE_HOSTS = [
    'login.microsoftonline.com', 'login.live.com',
    'accounts.google.com', 'accounts.youtube.com',
    'login.yahoo.com', 'auth0.com', 'okta.com', 'appleid.apple.com'
  ];
  const MAX_CARD_ROWS = 10;
  let traces = 0;
  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
  }
  function classifyHop(url) {
    const host = hostOf(url);
    if (SSO_SAFE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      return { kind: 'ok', note: 'sign-in handoff' };
    }
    // Ask the engine for this hop's verdict - reasons only, no state.
    return { kind: 'pending', note: host };
  }
  function renderChain(payload) {
    const chain = payload.chain || [];
    if (!chain.length) return;
    traces++;
    SL.status('redirectDetective', traces + ' traces this session');
    const rows = [];
    const shown = chain.slice(0, MAX_CARD_ROWS);
    shown.forEach((url, idx) => {
      const host = hostOf(url);
      const label = idx === 0 ? 'Start' :
        (idx === shown.length - 1 ? 'Final' : 'Hop ' + idx);
      let note = host;
      if (SSO_SAFE_HOSTS.some((h) => host === h ||
          host.endsWith('.' + h))) {
        note += ' (sign-in handoff)';
      }
      rows.push({ label, value: note });
    });
    if (chain.length > MAX_CARD_ROWS) {
      rows.push({ label: '...', value: (chain.length - MAX_CARD_ROWS) +
        ' more hops' });
    }
    // Final-host verdict shapes the card's own verdict level.
    SL.verdict(chain[chain.length - 1], {}).then((verdict) => {
      const reasons = verdict.reasons.slice();
      if (payload.error) {
        reasons.push('The chain did not finish (' + payload.error + ').');
      }
      if (payload.hops === 0) {
        reasons.push('This link does not redirect - it goes straight ' +
                     'to ' + hostOf(chain[0]) + '.');
      }
      SLVerdict.card({
        verdict: verdict.verdict,
        title: 'Redirect trace (' + payload.hops + ' hops)',
        reasons,
        rows
      });
    });
  }
  function listenForTraces() {
    SL.msg.listen('redirectDetective', (msg) => {
      if (msg.type === 'showChain') renderChain(msg.payload);
      return null;
    });
  }
  SL.boot('redirectDetective', {
    onEnabled() {
      listenForTraces();
      SL.status('redirectDetective', 'standing by');
    },
    onDisabled() {
      SLVerdict.closeCard();   // remove any open trace card
      SL.status('redirectDetective', 'off');
    }
  });
  SL.registerCleanup('redirectDetective', () => SLVerdict.closeCard());
})();