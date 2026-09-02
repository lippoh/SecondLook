/* modules/link-sniper/link-sniper.js - hover verdict pills for links.
 * Observe-only: never blocks, never rewrites the link.
 * Additions over the guide: magnet-link support, a pin key (P) that keeps
 * the pill on screen after the cursor leaves, persistent scan counters,
 * and a richer detail card fed from the engine's meta. */
(function () {
  'use strict';
  if (!globalThis.SL || !SL.__bridge) return;

  const PILL_OFFSET = 14;         // px from cursor
  const DISPLAY_TEXT_MAX = 60;    // chars of anchor text fed to engine
  const STATUS_EVERY = 8;         // scan count between status updates
  const PIN_KEY = 'p';            // toggles the pill to stay after mouse-out
  const COUNTER_KEY = 'sl.ls-counters';   // persisted scanned/flagged totals

  let cfg = { hoverDelayMs: 350, showClear: true };
  let hoverTimer = 0;
  let current = null;            // { link, url, pillEl }
  let pinned = false;            // pill stays until dismissed
  let scanned = 0;
  let flagged = 0;
  let scansSinceStatus = 0;

  function onConfig(next) { cfg = Object.assign(cfg, next || {}); }

  /* ---- persistent counters (survive toggling + new pages) ---------- */
  async function loadCounters() {
    try {
      const c = await SL.Storage.localGet(COUNTER_KEY, null);
      if (c) { scanned = c.scanned || 0; flagged = c.flagged || 0; }
    } catch (e) { /* storage unavailable - start from 0 */ }
  }
  function saveCounters() {
    try {
      // fire-and-forget; races between tabs are acceptable for a counter
      SL.Storage.localSet(COUNTER_KEY, { scanned, flagged });
    } catch (e) { /* ignore */ }
  }
  function reportStatus() {
    SL.status('linkSniper', scanned + ' links scanned, ' +
              flagged + ' flagged');
  }

  /* ---- pill rendering ------------------------------------------- */
  function showPill(link, url, verdict) {
    hidePill();
    if (verdict.verdict === 'CLEAR' && !cfg.showClear) return;
    const pill = SLVerdict.pill(verdict.verdict,
      verdict.verdict === 'CLEAR' ? 'Nothing unusual'
      : (verdict.reasons && verdict.reasons[0]) || 'Second look');
    pill.classList.add('sl-ls-pill');
    pill.addEventListener('click', () => openDetail(link, url, verdict));
    pill.title = 'Click for details · press P to pin';
    document.body.appendChild(pill);
    positionPill(pill, link);
    current = { link, url, pillEl: pill };
    pinned = false;
    if (verdict.verdict !== 'CLEAR') {
      flagged++;
      saveCounters();
      reportStatus();
    }
  }

  function positionPill(pill, link) {
    const r = link.getBoundingClientRect();
    // size the clearance to the pill's real width (it now wraps text).
    const pw = Math.min(pill.offsetWidth || 240, 380);
    const x = Math.min(window.scrollX + r.right + PILL_OFFSET,
                       window.scrollX + window.innerWidth - pw - 8);
    const y = Math.min(window.scrollY + r.bottom + 4,
                       window.scrollY + window.innerHeight - 40);
    pill.style.left = x + 'px';
    pill.style.top = y + 'px';
  }

  function hidePill() {
    if (current && current.pillEl) current.pillEl.remove();
    current = null;
    pinned = false;
  }

  function togglePin() {
    if (!current || !current.pillEl) return;
    pinned = !pinned;
    current.pillEl.classList.toggle('sl-ls-pill--pinned', pinned);
  }

  function displayTarget(url, meta) {
    if (meta && meta.protocol === 'magnet') {
      const m = String(url).match(/btih:([0-9a-fA-F]+)/);
      return 'torrent magnet' + (m ? ' #' + m[1].slice(0, 12) + '\u2026' : '');
    }
    try { return new URL(url).hostname || url; } catch (e) { return url; }
  }

  function openDetail(link, url, verdict) {
    const m = verdict.meta || {};
    const rows = [
      { label: 'Text', value: textOf(link) || '(no text)' },
      { label: 'Goes to', value: displayTarget(url, m) }
    ];
    if (m.protocol) {
      rows.push({ label: 'Protocol', value: m.protocol.toUpperCase() });
    }
    if (m.host) rows.push({ label: 'Host', value: m.host });
    if (m.registrable && m.registrable !== m.host) {
      rows.push({ label: 'Registered to', value: m.registrable });
    }
    if (m.isIp) rows.push({ label: 'Address type', value: 'Numeric IP' });
    if (m.port && m.port !== 80 && m.port !== 443 && m.port !== 8080) {
      rows.push({ label: 'Port', value: String(m.port) });
    }
    if (m.resolvedHost && m.resolvedHost !== m.host) {
      rows.push({ label: 'Real destination', value: m.resolvedHost });
    }
    SLVerdict.card({
      verdict: verdict.verdict,
      title: 'Link details',
      reasons: verdict.reasons,
      rows,
      anchorEl: link
    });
  }

  function textOf(link) {
    return (link.textContent || '').trim().slice(0, DISPLAY_TEXT_MAX);
  }

  /* ---- hover / focus flow ---------------------------------------- */
  function inspect(link) {
    const url = link.getAttribute('href') || '';
    // ignore bookmarks, javascript:, mailto:; accept http(s) and magnet
    if (!/^(https?|magnet):/i.test(url)) return;
    scanned++;
    scansSinceStatus++;
    if (scansSinceStatus >= STATUS_EVERY) {
      scansSinceStatus = 0;
      reportStatus();
      saveCounters();
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
    if (pinned) return;           // a pinned pill stays put until dismissed
    const link = e.target && e.target.closest &&
                 e.target.closest('a[href]');
    if (!link || link === (current && current.link)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => inspect(link), cfg.hoverDelayMs);
  }

  function onOut(e) {
    const link = e.target && e.target.closest && e.target.closest('a[href]');
    if (link && current && current.link === link && !pinned) hidePill();
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  }

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' ||
           tag === 'select' || t.isContentEditable === true;
  }

  function onKey(e) {
    if (isEditable(e.target)) return;
    if (e.key === 'Escape') { hidePill(); return; }
    if (e.key.toLowerCase() === PIN_KEY) togglePin();
  }

  function onScroll() { if (!pinned) hidePill(); }  // pill is cursor-anchored

  /* ---- lifecycle --------------------------------------------------- */
  function attach() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    reportStatus();
  }

  function detach() {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    clearTimeout(hoverTimer);
    hidePill();
    saveCounters();   // persist, never reset
  }

  SL.boot('linkSniper', {
    async onEnabled(config) {
      cfg = Object.assign(cfg, config);
      await loadCounters();
      attach();
    },
    onConfig,
    onDisabled() { detach(); }
  });
  SL.registerCleanup('linkSniper', detach);
})();