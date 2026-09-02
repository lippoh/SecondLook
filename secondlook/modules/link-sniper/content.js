/* ============================================================
   SecondLook — modules/link-sniper/content.js  (v1.2)
   WHAT'S NEW
   - Tab-key preview REMOVED (Tab belongs to keyboard navigation).
   - Press P while a pill is visible to PIN it in place so you
     can read everything; press P again or Esc (or click
     anywhere) to dismiss. PIN_KEY_CODE knob at the top.
   - Pill auto-sizes: width grows with its message up to
     PILL_MAX_WIDTH, then text wraps and height grows — long
     reason texts are never cut off.
   - Richer pill: top reasons + neutral link facts (host, file
     type, trackers, magnet name...) from the analyzer's meta.
   - Lifetime counters persisted to chrome.storage.local
     ("sl.stats" -> linkSniper). They survive toggle off/on
     and browser restarts. Flushes use additive deltas so
     multiple open tabs never overwrite each other.
   - Real-off behavior: watches chrome.storage directly, so if
     the module is switched off (or "pause everywhere" is set)
     this script tears itself down even without a message.
   SAFETY RULES
   - The pill NEVER blocks clicks: pointer-events:none unless
     pinned; even pinned it only swallows its own clicks.
   - The key handler never fires while you are typing in a
     field, and never touches modified key combos.
   ============================================================ */
(function () {
  'use strict';

  if (window.__slLinkSniperLoaded) return;
  window.__slLinkSniperLoaded = true;

  const MODULE_ID = 'link-sniper';
  const SETTINGS_KEY = 'sl.settings';   // the key background/bootstrap.js watches
  const STATS_KEY = 'sl.stats';         // lifetime counters live here
  const STATS_FIELD = 'linkSniper';

  /* ---------------- Tuning knobs ---------------- */
  const HOVER_DELAY_MS = 130;     // how long the cursor must rest before the pill shows
  const HIDE_GRACE_MS = 150;      // grace before hiding (avoids flicker between elements)
  const PIN_KEY_CODE = 'KeyP';    // physical key code — change to e.g. 'KeyS' for S
  const PIN_KEY_LABEL = 'P';
  const PILL_MAX_WIDTH = 380;     // px; also clamped to (viewport - 24) at runtime
  const STATS_FLUSH_MS = 1200;    // counters saved at most this often
  const MAX_REASONS_SHOWN = 3;
  const MAX_FACTS_SHOWN = 6;
  const RUN_IN_IFRAMES = false;   // pills only in the top frame (less noise)

  if (!RUN_IN_IFRAMES && window !== window.top) return;

  /* ---------------- state ---------------- */
  const stats = {
    saved: { scans: 0, flagged: 0 },     // totals loaded from storage
    pending: { scans: 0, flagged: 0 }    // deltas not yet written
  };
  const seenHrefs = new Set();           // unique destinations this page session
  let styleEl = null;
  let pill = null;
  let currentLink = null;
  let hoverTimer = 0;
  let hideTimer = 0;
  let flushTimer = 0;
  let pinned = false;
  let mouse = { x: 0, y: 0 };
  let lastPage = null;                   // last verdict — answered to the popup

  /* ---------------- tiny dom helpers ---------------- */
  function div(cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    return d;
  }
  function span(cls) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    return s;
  }

  /* ---------------- styles (fixed dark "tooltip ink" so the pill
     reads on any site theme; never inherits page CSS) ---------------- */
  function injectStyles() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'sl-link-sniper-style';
    const css = [
      '.slp-root{position:fixed;z-index:2147483647;box-sizing:border-box;',
      'max-width:min(' + PILL_MAX_WIDTH + 'px,calc(100vw - 24px));width:max-content;',
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'color:#E9EDF3;background:#1B2129;border:1px solid #39424E;border-radius:10px;',
      'box-shadow:0 10px 28px rgba(0,0,0,.4);pointer-events:none;',  /* never blocks clicks */
      'opacity:0;transform:translateY(2px);animation:slp-in .12s ease-out forwards;}',
      '.slp-root *{box-sizing:border-box;}',
      '.slp-root--pinned{pointer-events:auto;user-select:text;',      /* readable + selectable */
      'border-color:#4A5FEATURED? no. }',
    ].join('');
    styleEl.textContent = css;
    document.documentElement.appendChild(styleEl);
  }
  /* NOTE: the string above is assembled in pieces for readability; the
     full rule set is set below in one assignment to keep it honest. */
  function injectFullStyles() {
    if (!styleEl) return;
    styleEl.textContent = [
      '.slp-root{position:fixed;z-index:2147483647;box-sizing:border-box;',
      'max-width:min(' + PILL_MAX_WIDTH + 'px,calc(100vw - 24px));width:max-content;',
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'color:#E9EDF3;background:#1B2129;border:1px solid #39424E;border-radius:10px;',
      'box-shadow:0 10px 28px rgba(0,0,0,.4);pointer-events:none;',
      'opacity:0;transform:translateY(2px);animation:slp-in .12s ease-out forwards;}',
      '.slp-root *{box-sizing:border-box;}',
      '.slp-root--pinned{pointer-events:auto;user-select:text;border-color:#4E8DD8;',
      'box-shadow:0 12px 32px rgba(0,0,0,.5);cursor:default;}',
      '.slp-root--pinned .slp-pinflag{display:inline-block;}',
      '@keyframes slp-in{to{opacity:1;transform:none;}}',
      '@media (prefers-reduced-motion:reduce){.slp-root{animation:none;opacity:1;transform:none;}}',
      '.slp-head{display:flex;align-items:center;gap:7px;padding:9px 12px 3px;max-width:100%;}',
      '.slp-dot{width:8px;height:8px;border-radius:50%;background:#3FBE7A;flex:none;}',
      '.slp-dot--warn{background:#E8A93D;}',
      '.slp-title{font-weight:600;font-size:12.5px;color:#8FE3B0;}',
      '.slp-title--warn{color:#F2C063;}',
      '.slp-pinflag{display:none;margin-left:2px;font-size:9.5px;letter-spacing:.05em;',
      'text-transform:uppercase;color:#F2C063;border:1px solid #6B5420;border-radius:4px;padding:0 4px;}',
      '.slp-host{margin-left:auto;max-width:44%;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font:10.5px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#9FB0C0;padding-left:8px;}',
      '.slp-body{padding:2px 12px 6px;}',
      '.slp-reason{color:#DCE4EE;font-size:12px;line-height:1.55;margin:3px 0;',
      'padding-left:12px;position:relative;white-space:normal;overflow:visible;}',
      '.slp-reason::before{content:"";position:absolute;left:2px;top:.62em;width:4px;height:4px;',
      'border-radius:50%;background:#E8A93D;}',
      '.slp-reason--ok{color:#C4D3DE;padding-left:0;}',
      '.slp-reason--ok::before{display:none;}',
      '.slp-facts{border-top:1px solid #2A323E;margin:4px 12px 0;padding:6px 0 2px;}',
      '.slp-fact{font-size:11px;line-height:1.6;color:#A6B3C2;white-space:normal;overflow:visible;}',
      '.slp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'border-top:1px solid #2A323E;margin-top:6px;padding:6px 12px 8px;}',
      '.slp-count{font-size:10.5px;color:#93A2B2;white-space:nowrap;}',
      '.slp-hint{font-size:10.5px;color:#93A2B2;white-space:nowrap;}',
      '.slp-kbd{display:inline-block;min-width:14px;text-align:center;padding:0 4px;margin-right:2px;',
      'border:1px solid #414C5A;border-bottom-width:2px;border-radius:4px;background:#242C37;',
      'color:#CBD6E1;font:600 10px/1.5 ui-monospace,Menlo,Consolas,monospace;}'
    ].join('');
  }

  /* ---------------- analysis ---------------- */
  function analyzeTarget(href, text) {
    let resolved = href;
    try { resolved = new URL(href, location.href).href; } catch (_) { /* keep raw */ }
    const SL = window.SL || {};
    const fn = (SL.VerdictEngine && SL.VerdictEngine.analyze) ||
               (SL.UrlAnalyzer && SL.UrlAnalyzer.analyze) || null;
    let result = null;
    if (typeof fn === 'function') {
      try {
        result = fn.call(null, resolved, {
          linkText: text, baseUrl: location.href, source: MODULE_ID
        });
      } catch (_) { result = null; }
    }
    if (!result) result = localFallback(resolved, text);
    /* If only the raw analyzer answered (no verdict word), map it here. */
    if (typeof result.verdict !== 'string') {
      result.verdict = (result.score || 0) <= 12 ? 'CLEAR' : 'SECOND LOOK';
    }
    result.meta = result.meta || {};
    return result;
  }

  /* Works even if no engine files are registered alongside this script. */
  function localFallback(href, text) {
    const reasons = [];
    const facts = [];
    let score = 0;
    let host = '';
    try {
      const u = new URL(href, location.href);
      host = u.hostname;
      if (u.protocol === 'http:') {
        reasons.push({ signal: 'HTTP', weight: 14, plainText: 'Not a secure (https) connection.' });
        score += 14;
      }
      if (u.protocol === 'magnet:') {
        reasons.push({ signal: 'MAGNET_LINK', weight: 26, plainText: 'Peer-to-peer (magnet) link — files come from other people\u2019s computers.' });
        score += 26;
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
        reasons.push({ signal: 'IP_HOST', weight: 26, plainText: 'Points at a raw numeric address.' });
        score += 26;
      }
      facts.push('Domain: ' + u.hostname);
    } catch (_) { /* unparseable — treat as neutral */ }
    const invisible = (String(text).match(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g) || []).length;
    if (invisible) {
      reasons.push({ signal: 'INVISIBLE_CHARS', weight: 32, plainText: 'The link text hides ' + invisible + ' invisible character(s).' });
      score += 32;
    }
    return { verdict: score <= 12 ? 'CLEAR' : 'SECOND LOOK', reasons: reasons, score: score, meta: { facts: facts, tags: [], host: host } };
  }

  function displayHost(href, result) {
    const meta = result.meta || {};
    if (meta.isMagnet) return 'P2P magnet';
    if (meta.etld1) return meta.etld1;
    if (meta.host) return meta.host;
    try { return new URL(href, location.href).hostname; } catch (_) { return ''; }
  }

  /* ---------------- counters ---------------- */
  function statsTotal() {
    return {
      scans: stats.saved.scans + stats.pending.scans,
      flagged: stats.saved.flagged + stats.pending.flagged
    };
  }

  function loadStats() {
    try {
      chrome.storage.local.get(STATS_KEY, (stored) => {
        if (chrome.runtime.lastError) return;
        const field = stored && stored[STATS_KEY] && stored[STATS_KEY][STATS_FIELD];
        if (field && typeof field === 'object') {
          stats.saved.scans = Number(field.scans) || 0;
          stats.saved.flagged = Number(field.flagged) || 0;
        }
      });
    } catch (_) { /* storage unavailable — counters stay in memory */ }
  }

  /* Additive-delta flush: reads stored totals at flush time and adds only
     this tab's new events, so two open tabs never overwrite each other. */
  function flushStats() {
    flushTimer = 0;
    if (stats.pending.scans === 0 && stats.pending.flagged === 0) return;
    const dS = stats.pending.scans;
    const dF = stats.pending.flagged;
    try {
      chrome.storage.local.get(STATS_KEY, (stored) => {
        if (chrome.runtime.lastError) return;                 // read failed — keep pending
        const base = (stored && stored[STATS_KEY]) || {};
        const field = base[STATS_FIELD] || {};
        field.scans = (Number(field.scans) || 0) + dS;
        field.flagged = (Number(field.flagged) || 0) + dF;
        field.updatedAt = Date.now();
        base[STATS_FIELD] = field;
        chrome.storage.local.set({ [STATS_KEY]: base }, () => {
          if (chrome.runtime.lastError) return;               // write failed — keep pending
          stats.pending.scans -= dS;
          stats.pending.flagged -= dF;
          stats.saved.scans = field.scans;
          stats.saved.flagged = field.flagged;
        });
      });
    } catch (_) { /* ignore */ }
  }

  function bumpStats(flagged) {
    stats.pending.scans += 1;
    if (flagged) stats.pending.flagged += 1;
    if (!flushTimer) flushTimer = setTimeout(flushStats, STATS_FLUSH_MS);
  }

  /* ---------------- pill ---------------- */
  function buildPill(result, host) {
    const warn = result.verdict !== 'CLEAR';
    const el = div('slp-root');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    const head = div('slp-head');
    const dot = span('slp-dot' + (warn ? ' slp-dot--warn' : ''));
    const title = span('slp-title' + (warn ? ' slp-title--warn' : ''));
    title.textContent = warn ? 'Second look' : 'Nothing unusual';
    const pinflag = span('slp-pinflag');
    pinflag.textContent = 'pinned';
    const hostEl = span('slp-host');
    hostEl.textContent = host || '';
    hostEl.title = host || '';
    head.append(dot, title, pinflag, hostEl);

    const body = div('slp-body');
    if (warn) {
      (result.reasons || []).slice(0, MAX_REASONS_SHOWN).forEach((r) => {
        const line = div('slp-reason');
        line.textContent = r.plainText || r.signal || '';
        body.appendChild(line);
      });
    } else {
      const line = div('slp-reason slp-reason--ok');
      line.textContent = 'No spoofing, tracking or file tricks detected in this link.';
      body.appendChild(line);
    }

    const meta = result.meta || {};
    const facts = (meta.facts || []).slice(0, MAX_FACTS_SHOWN);

    const foot = div('slp-foot');
    const total = statsTotal();
    const countEl = span('slp-count');
    countEl.textContent = total.scans.toLocaleString() + ' links checked' +
      (total.flagged ? ' \u00B7 ' + total.flagged.toLocaleString() + ' flagged' : '');
    const hint = span('slp-hint');
    const kbd = span('slp-kbd');
    kbd.textContent = PIN_KEY_LABEL;
    hint.append(kbd, document.createTextNode(' to keep \u00B7 Esc closes'));
    foot.append(countEl, hint);

    el.append(head, body);
    if (facts.length) {
      const factsEl = div('slp-facts');
      facts.forEach((t) => {
        const f = div('slp-fact');
        f.textContent = t;
        factsEl.appendChild(f);
      });
      el.appendChild(factsEl);
    }
    el.appendChild(foot);

    /* Pinned pill is interactive — swallow clicks on itself so nothing
       underneath is triggered accidentally, but allow text selection. */
    el.addEventListener('click', (ev) => ev.preventDefault());
    return el;
  }

  function placePill() {
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    let x = mouse.x + 16;
    let y = mouse.y + 20;
    if (x + w > window.innerWidth - 12) x = Math.max(12, window.innerWidth - w - 12);
    if (y + h > window.innerHeight - 12) y = Math.max(12, window.innerHeight - h - 12);
    if (y < 12) y = 12;
    pill.style.left = x + 'px';
    pill.style.top = y + 'px';
  }

  function removePill() {
    if (pill && pill.isConnected) pill.remove();
    pill = null;
  }

  function hidePill() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    pinned = false;
    currentLink = null;
    removePill();
  }

  function shouldAnalyze(href) {
    const h = String(href || '').trim();
    if (!h || h.charAt(0) === '#') return false;
    if (/^javascript:/i.test(h)) return false;
    if (/^(mailto|tel):/i.test(h)) return false;
    return true;
  }

  function showPill() {
    clearTimeout(hideTimer);
    if (!currentLink || !currentLink.isConnected) return;
    const href = currentLink.getAttribute('href') || '';
    if (!shouldAnalyze(href)) return;
    const text = (currentLink.textContent ||
                  currentLink.getAttribute('aria-label') || '').trim();
    const result = analyzeTarget(href, text);

    /* Count each unique destination once per page session. */
    let key = href;
    try { key = new URL(href, location.href).href; } catch (_) { /* keep raw */ }
    if (!seenHrefs.has(key)) {
      seenHrefs.add(key);
      bumpStats(result.verdict !== 'CLEAR');
    }

    removePill();
    pill = buildPill(result, displayHost(href, result));
    document.documentElement.appendChild(pill);
    placePill();
    lastPage = {
      verdict: result.verdict,
      reasons: (result.reasons || []).map((r) => r.plainText || r.signal || ''),
      at: Date.now()
    };
  }

  /* ---------------- events ---------------- */
  function onOver(e) {
    const t = e.target;
    if (pill && t && t.closest && t.closest('.slp-root')) return;   // hovering the pill itself
    if (pinned) return;                                              // pinned pill stays put
    const link = t && t.closest ? t.closest('a[href]') : null;
    if (!link || !link.isConnected) { scheduleHide(); return; }
    if (link === currentLink) return;
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    currentLink = link;
    hoverTimer = setTimeout(showPill, HOVER_DELAY_MS);
  }

  function onOut(e) {
    if (pinned) return;
    if (!currentLink) return;
    const rel = e.relatedTarget;
    if (rel && rel.closest && rel.closest('a[href]') === currentLink) return;
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePill, HIDE_GRACE_MS);
  }

  function onMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (pill && !pinned) placePill();
  }

  function isEditable(t) {
    if (!t || !t.closest) return false;
    return !!t.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
  }

  function onKey(e) {
    if (pill && e.key === 'Escape') { hidePill(); return; }
    if (e.code !== PIN_KEY_CODE) return;
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (isEditable(e.target)) return;   // never fight the keyboard while typing
    if (!pill) return;                  // pin only works while a pill is visible
    e.preventDefault();
    if (pinned) {
      hidePill();
    } else {
      pinned = true;
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      if (pill) pill.classList.add('slp-root--pinned');
    }
  }

  function onMouseDown(e) {
    if (!pinned || !pill) return;
    if (e.target && e.target.closest && e.target.closest('.slp-root')) return; // selecting pill text
    hidePill();
  }

  /* ---------------- real-off watchdogs ---------------- */
  function settingsSayOff(nv) {
    if (!nv || typeof nv !== 'object') return false;
    const mods = (nv.modules && typeof nv.modules === 'object') ? nv.modules : nv;
    return mods[MODULE_ID] === false || mods['link-sniper'] === false || nv.pausedAll === true;
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (key === SETTINGS_KEY && settingsSayOff(changes[key].newValue)) {
        teardown();
        return;
      }
      /* Defensive: some other key carrying a settings-like object. */
      const nv = changes[key] && changes[key].newValue;
      if (nv && typeof nv === 'object' && nv.modules && settingsSayOff(nv)) {
        teardown();
        return;
      }
    }
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return;
    const mod = msg.module || msg.target || '';
    const type = String(msg.type || msg.action || '');
    if ((type === 'teardown' || type === 'sl:teardown') &&
        (mod === MODULE_ID || mod === 'all')) {
      teardown();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'getPageVerdict' &&
        (mod === MODULE_ID || mod === 'core' || mod === '')) {
      const total = statsTotal();
      sendResponse({
        ok: true,
        module: MODULE_ID,
        verdict: lastPage ? lastPage.verdict : null,
        reasons: lastPage ? lastPage.reasons : [],
        scans: total.scans,
        flagged: total.flagged
      });
    }
  }

  function onPageHide() {
    flushStats();
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') flushStats();
  }

  /* ---------------- lifecycle ---------------- */
  function start() {
    injectStyles();
    injectFullStyles();
    loadStats();
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_) {}
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_) {}
  }

  function teardown() {
    flushStats();
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    clearTimeout(flushTimer);
    flushTimer = 0;
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) {}
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
    removePill();
    if (styleEl && styleEl.isConnected) styleEl.remove();
    styleEl = null;
    window.__slLinkSniperLoaded = false;   // allows a clean re-injection when re-enabled
  }

  start();
})();