/* Trust Badge - flag seal images that cannot verify their issuer. */
(() => {
  'use strict';
  const root = globalThis.SecondLook;
  if (!root || !root.Bridge || root.TrustBadge) return;
  root.TrustBadge = true;

  const issuers = [
    { name: 'Norton / Symantec', words: ['norton', 'symantec', 'hacker safe'], domains: ['norton.com', 'symantec.com'] },
    { name: 'McAfee', words: ['mcafee'], domains: ['mcafee.com', 'mcafeesecure.com'] },
    { name: 'BBB', words: ['bbb', 'better business'], domains: ['bbb.org'] },
    { name: 'Trustpilot', words: ['trustpilot', 'trust pilot'], domains: ['trustpilot.com'] },
    { name: 'TRUSTe', words: ['truste', 'trustarc'], domains: ['truste.com', 'trustarc.com'] },
    { name: 'GoDaddy', words: ['godaddy'], domains: ['godaddy.com'] },
    { name: 'SSL issuer', words: ['ssl secure', 'ssl certified', 'digicert', 'sectigo', 'comodo'], domains: ['digicert.com', 'sectigo.com', 'comodo.com'] }
  ];
  const marked = new Map();
  let observer = null;
  let timer = 0;

  function textOf(image) {
    const parent = image.closest('figure, a, div, span');
    return [image.alt, image.getAttribute('aria-label'), image.title,
      image.currentSrc, image.className, parent && parent.textContent]
      .filter(Boolean).join(' ').toLowerCase();
  }
  function issuerFor(text) {
    return issuers.find((entry) => entry.words.some((word) => text.includes(word)));
  }
  function hostFor(link) {
    try { return new URL(link, location.href).hostname.toLowerCase(); }
    catch (e) { return ''; }
  }
  function noteFor(image, issuer) {
    const anchor = image.closest('a');
    const href = anchor && anchor.getAttribute('href');
    if (!href || href === '#' || /^javascript:/i.test(href)) {
      return 'This badge is only an image and links nowhere.';
    }
    const host = hostFor(href);
    const valid = issuer.domains.some((domain) => host === domain || host.endsWith('.' + domain));
    return valid ? '' : 'This badge claims ' + issuer.name + ' but points to ' + (host || 'an unknown host') + '.';
  }
  function showDetails(image, issuer, note) {
    const old = document.querySelector('.sl-tb-details');
    if (old) old.remove();
    const card = document.createElement('div');
    card.className = 'sl-tb-details';
    card.setAttribute('role', 'dialog');
    const title = document.createElement('strong');
    title.textContent = issuer.name + ' seal';
    const body = document.createElement('p');
    body.textContent = note;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => card.remove());
    card.append(title, body, close);
    document.documentElement.appendChild(card);
    const rect = image.getBoundingClientRect();
    card.style.left = Math.max(8, Math.min(rect.left, innerWidth - 328)) + 'px';
    card.style.top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - 150)) + 'px';
  }
  function scan() {
    if (!document.body) return;
    let count = 0;
    for (const image of document.querySelectorAll('img')) {
      if (marked.has(image)) continue;
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height || width > 260 || height > 260) continue;
      const issuer = issuerFor(textOf(image));
      if (!issuer) continue;
      const note = noteFor(image, issuer);
      if (!note) continue;
      marked.set(image, { issuer, note });
      image.classList.add('sl-tb-marked');
      image.title = note;
      image.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showDetails(image, issuer, note);
      }, true);
      count++;
    }
    root.Bridge.bumpStat('trust-badge', 'flagged', count);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 700);
  }
  function detach() {
    clearTimeout(timer);
    if (observer) observer.disconnect();
    observer = null;
    for (const [image] of marked) {
      image.classList.remove('sl-tb-marked');
      image.removeAttribute('title');
    }
    marked.clear();
    const card = document.querySelector('.sl-tb-details');
    if (card) card.remove();
  }
  function attach() {
    scan();
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.Bridge.watch('trust-badge', (on) => on ? attach() : detach());
})();
