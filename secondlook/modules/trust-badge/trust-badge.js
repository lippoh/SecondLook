/* modules/trust-badge/trust-badge.js - trust-seal authenticity notes.
 * Stage 1: find seal-looking images. Stage 2: check the claim. */
(function () {
  'use strict';
  if (!globalThis.SL || !SL.__bridge) return;
  const MAX_IMG_EDGE = 260;      // px; seals are small, heroes are not
  const SCAN_DELAY_MS = 800;     // debounce after DOM settles
  const ISSUER_TABLE = [
    { issuer: 'Norton / Symantec', words: ['norton', 'symantec',
      'hacker safe', 'norton secured'],
      domains: ['norton.com', 'symantec.com', 'safeweb.norton.com'] },
    { issuer: 'McAfee', words: ['mcafee', 'mcafee secure'],
      domains: ['mcafee.com', 'mcafeesecure.com'] },
    { issuer: 'BBB', words: ['bbb', 'bbb accredited', 'better business'],
      domains: ['bbb.org'] },
    { issuer: 'Trustpilot', words: ['trustpilot', 'trust pilot'],
      domains: ['trustpilot.com'] },
    { issuer: 'TRUSTe', words: ['truste', 'trustarc', 'privacy trusted'],
      domains: ['truste.com', 'trustarc.com'] },
    { issuer: 'GoDaddy', words: ['godaddy verified', 'godaddy'],
      domains: ['godaddy.com', 'verify.godaddy.com'] },
    { issuer: 'SSL / padlock art', words: ['ssl secure', 'ssl certified',
      'ssl verified', 'comodo', 'sectigo', 'digicert', 'globalsign'],
      domains: ['comodo.com', 'sectigo.com', 'digicert.com',
                'globalsign.com', 'ssls.com'] },
    { issuer: 'Yotpo / reviews', words: ['yotpo', 'verified reviews',
      'certified reviews'],
      domains: ['yotpo.com'] }
  ];
  let observer = null;
  let scanTimer = 0;
  const annotated = [];          // elements to clean up on toggle-off
  function textAround(img) {
    const bits = [img.getAttribute('alt') || '',
                  img.getAttribute('aria-label') || '',
                  img.getAttribute('title') || '',
                  img.getAttribute('src') || '',
                  img.className && String(img.className) || ''];
    // caption-ish text directly around the seal
    const parent = img.closest('figure, a, div, span');
    if (parent && parent.textContent &&
        parent.textContent.length < 140) {
      bits.push(parent.textContent);
    }
    return bits.join(' ').toLowerCase();
  }
  function matchIssuer(haystack) {
    for (const entry of ISSUER_TABLE) {
      for (const w of entry.words) {
        if (haystack.includes(w)) return entry;
      }
    }
    return null;
  }
  function verdictForSeal(img, issuer) {
    const link = img.closest('a');
    const href = link ? link.getAttribute('href') : '';
    if (!link || !href || href === '#' ||
        /^javascript:/i.test(href)) {
      return {
        kind: 'warn',
        note: 'This badge is just an image - anyone can paste one. ' +
              'It links nowhere.'
      };
    }
    let host = '';
    try { host = new URL(href, location.href).hostname; } catch (e) {}
    const legit = issuer.domains.some((d) => host === d ||
      host.endsWith('.' + d));
    if (legit) return { kind: 'ok', note: '' };
    return {
      kind: 'warn',
      note: 'This badge claims ' + issuer.issuer + ' but points to ' +
            (host || 'an unknown host') + ' - not the issuer.'
    };
  }
  function annotate(img, issuer, verdict) {
    img.classList.add('sl-outline-warn');
    img.classList.add('sl-tb-marked');
    img.setAttribute('data-sl-note', verdict.note);
    img.addEventListener('click', (e) => {
      // Only when the seal itself is clicked without following a link
      if (verdict.kind === 'warn' && !img.closest('a[href]')) {
        e.preventDefault();
      }
      SLVerdict.card({
        verdict: 'SECOND_LOOK',
        title: issuer.issuer + ' seal',
        reasons: [verdict.note],
        rows: [{ label: 'Badge', value: issuer.issuer }],
        anchorEl: img
      });
    });
    annotated.push(img);
  }
  function scan() {
    if (document.readyState !== 'complete' &&
        document.readyState !== 'interactive') return;
    let flagged = 0;
    for (const img of document.querySelectorAll('img')) {
      if (img.classList.contains('sl-tb-marked')) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) continue;
      if (w > MAX_IMG_EDGE || h > MAX_IMG_EDGE) continue;
      const issuer = matchIssuer(textAround(img));
      if (!issuer) continue;
      const verdict = verdictForSeal(img, issuer);
      if (verdict.kind === 'warn') {
        annotate(img, issuer, verdict);
        flagged++;
      }
    }
    SL.status('trustBadge', flagged
      ? flagged + ' unverifiable seal' + (flagged > 1 ? 's' : '') +
        ' on this page'
      : 'No suspicious seals');
  }
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }
  function attach() {
    scan();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement || document.body, {
      childList: true, subtree: true
    });
  }
  function detach() {
    clearTimeout(scanTimer);
    if (observer) { observer.disconnect(); observer = null; }
    for (const el of annotated) {
      el.classList.remove('sl-outline-warn', 'sl-tb-marked')
      el.removeAttribute('data-sl-note');
    }
    annotated.length = 0;
    SLVerdict.closeCard();
    SL.status('trustBadge', 'off');
  }
  SL.boot('trustBadge', {
    onEnabled() { attach(); },
    onDisabled() { detach(); }
  });
  SL.registerCleanup('trustBadge', detach);
})();