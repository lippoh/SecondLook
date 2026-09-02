/* modules/link-sniper/link-sniper.js - hover verdict pills for links.
 * Observe-only: never blocks, never rewrites the link. */
(function () {
  'use strict';
  if (!globalThis.SL || !SL.__bridge) return;

  const PILL_OFFSET = 14;         // px from cursor
  const DISPLAY_TEXT_MAX = 60;    // chars of anchor text fed to engine
  const STATUS_EVERY = 8;         // scan count between status updates

  let cfg = { hoverDelayMs: 350, showClear: true };
  let hoverTimer = 0;
  let current = null;            // { link, url, pillEl }
  let scanned = 0;
  let flagged = 0;
  let scansSinceStatus = 0;

  function onConfig(next) { cfg = Object.assign(cfg, next || {}); }

  /* ---- pill rendering ------------------------------------------- */
  function showPill(link, url, verdict) {
    hidePill();
    if (verdict.verdict === 'CLEAR' && !cfg.showClear) return;
    const pill = SLVerdict.pill(verdict.verdict,
      verdict.verdict === 'CLEAR' ? 'Nothing unusual'
      : (verdict.reasons && verdict.reasons[0]) || 'Second look');
    pill.classList.add('sl-ls-pill');
    pill.addEventListener('click', () => openDetail(link, url, verdict));
    document.body.appendChild(pill);
    positionPill(pill, link);
    current = { link, url, pillEl: pill };
    if (verdict.verdict !== 'CLEAR') {
      flagged++;
      SL.status('linkSniper', scanned + ' links scanned, ' +
                 flagged + ' flagged');
    }
  }

  function positionPill(pill, link) {
    const r = link.getBoundingClientRect();
    const x = Math.min(window.scrollX + r.right + PILL_OFFSET,
                       window.scrollX + window.innerWidth - 240);
    const y = Math.min(window.scrollY + r.bottom + 4,
                       window.scrollY + window.innerHeight - 34);
    pill.style.left = x + 'px';
    pill.style.top = y + 'px';
  }

  function hidePill() {
    if (current && current.pillEl) current.pillEl.remove();
    current = null;
  }

  function openDetail(link, url, verdict) {
    SLVerdict.card({
      verdict: verdict.verdict,
      title: 'Link details',
      reasons: verdict.reasons,
      rows: [
         { label: 'Text', value: textOf(link) || '(no text)' },
         { label: 'Goes to', value: shortHost(url) }
      ],
      anchorEl: link
    });
  }

  function textOf(link) {
    return (link.textContent || '').trim().slice(0, DISPLAY_TEXT_MAX);
  }
  function shortHost(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
  }

  /* ---- hover / focus flow ---------------------------------------- */
  function inspect(link) {
    const url = link.getAttribute('href') || '';
    if (!/^https?:/i.test(url)) return;    // ignore anchors, mailto, js:
    scanned++;
    scansSinceStatus++;
    if (scansSinceStatus >= STATUS_EVERY && !flagged) {
      scansSinceStatus = 0;
      SL.status('linkSniper', scanned + ' links scanned, 0 flagged');
    }
    const context = { displayText: textOf(link) };
    SL.verdict(url, context).then((verdict) => {
      if (current && current.link !== link && hoverTimer) return;
      showPill(link, url, verdict);
      // Shorteners get a second, resolved pass.
      if (verdict.meta && verdict.meta.isShortener) {
        SL.send('engine', 'resolveRedirect', { url }).then((res) => {
          if (!res.ok || !res.data || !res.data.finalUrl) return;
          SL.verdict(url, Object.assign({}, context, {
            resolvedUrl: res.data.finalUrl
          })).then((v2) => showPill(link, url, v2));
        });
      }
    });
  }

  function onOver(e) {
    const link = e.target && e.target.closest &&
                 e.target.closest('a[href]');
    if (!link || link === (current && current.link)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => inspect(link), cfg.hoverDelayMs);
  }

  function onOut(e) {
    const link = e.target && e.target.closest && e.target.closest('a[href]');
    if (link && current && current.link === link) hidePill();
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  }

  function onFocusIn(e) {
    const link = e.target;
    if (link && link.tagName === 'A' && link.getAttribute('href')) {
      clearTimeout(hoverTimer);
      inspect(link);       // keyboard users get the pill immediately
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') hidePill();
  }

  function onScroll() { hidePill(); }     // pill is cursor-anchored

  /* ---- lifecycle --------------------------------------------------- */
  function attach() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    SL.status('linkSniper', '0 links scanned, 0 flagged');
  }

  function detach() {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    clearTimeout(hoverTimer);
    hidePill();
    scanned = 0; flagged = 0;
  }

  SL.boot('linkSniper', {
    onEnabled(config) { cfg = Object.assign(cfg, config); attach(); },
    onConfig,
    onDisabled() { detach(); }
  });
  SL.registerCleanup('linkSniper', detach);
})();