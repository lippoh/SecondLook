/* =====================================================================
 * SecondLook - Redirect Detective - service-worker side (v2.2)
 * NEW FILE: background/rd-sw.js
 * ---------------------------------------------------------------------
 * Self-contained rebuild of the automatic redirect tracker. The old
 * RD (v2.1, inside background.js) goes dormant by itself: this module
 * speaks a new protocol (RD2_* messages, rd2:* storage keys) that the
 * old code ignores. The right-click "Where does this link really go?"
 * tracer keeps working: its showChain message is honored by the new
 * content script and rendered through the same card.
 *
 * Why v2.1 never showed anything: it delivered the verdict at
 * webRequest.onCompleted - the instant the network request finishes,
 * BEFORE the landing page's content script exists (content scripts run
 * at document_idle, seconds later). The push found no receiver (or hit
 * the previous, dying page) and there was no retry, so the card died
 * silently on every single navigation.
 *
 * v2.2 delivery model:
 *  - The card is injected DIRECTLY from the SW via chrome.scripting
 *    ~1.6 s after commit. No dependency on content-script timing.
 *  - Verdicts persist per tab (storage.session, 10-min TTL); the
 *    content script's ready-ping is a second delivery path.
 *  - Chains are keyed by TAB (not requestId), built from
 *    onBeforeRedirect (which carries url AND redirectUrl), so a
 *    cold-started SW still sees the whole path. Chains carry across
 *    JS/meta-refresh redirects within 15 s.
 *  - Every stage is counted for SecondLook.RD.debug().
 * ===================================================================== */
'use strict';

(function () {
  const VERSION = 2.2;

  /* paste-safe guard: newest copy wins, older copies stand down */
  const prior = globalThis.__SL_RD2_SW;
  if (prior && prior.version >= VERSION) return;
  globalThis.__SL_RD2_SW = { version: VERSION };

  const startedAt = Date.now();
  const session = chrome.storage.session || {
    get: async function () { return {}; },
    set: async function () {},
    remove: async function () {}
  };

  const COUNT = {
    navStart: 0, redirects: 0, completions: 0, errors: 0, blocked: 0,
    carried: 0, shown: 0, quiet: 0, cooldown: 0, settingsOff: 0,
    injectOk: 0, injectFail: 0, pingHits: 0, pingMiss: 0, traces: 0
  };
  let lastError = null;
  let lastVerdict = null;   /* { id, tabId, ts, delivered, data } */

  const K = {
    chain:   function (t) { return 'rd2:chain:' + t; },
    verdict: function (t) { return 'rd2:verdict:' + t; }
  };
  const COOLDOWN_KEY = 'rd2:cooldown';
  const COOLDOWN_MS  = 10 * 60 * 1000;
  const VERDICT_TTL  = 10 * 60 * 1000;
  const CARRY_MS     = 15 * 1000;
  const INJECT_DELAY = 1600;

  function kv(k, v) { const o = {}; o[k] = v; return o; }

  /* ---------- per-tab event serialization (storage is async) ------- */
  const tabQ = new Map();
  function enq(tabId, job) {
    const prev = (tabQ.get(tabId) || Promise.resolve()).catch(function () {});
    const next = prev.then(job).catch(function (e) {
      lastError = String((e && e.message) || e);
    });
    tabQ.set(tabId, next);
    next.then(function () {
      if (tabQ.get(tabId) === next) tabQ.delete(tabId);
    });
    return next;
  }

  /* ---------- webRequest listeners: top level, synchronous --------- */
  const listeners = {};
  function reg(name, api, fn) {
    try {
      if (!api || typeof api.addListener !== 'function') {
        throw new Error('missing ' + name);
      }
      api.addListener(fn, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });
      listeners[name] = true;
    } catch (e) {
      listeners[name] = false;
      lastError = String((e && e.message) || e);
    }
  }
  const WR = chrome.webRequest || {};
  reg('onBeforeRequest', WR.onBeforeRequest, onNavStart);
  reg('onBeforeRedirect', WR.onBeforeRedirect, onRedirect);
  reg('onCompleted', WR.onCompleted, onNavDone);
  reg('onErrorOccurred', WR.onErrorOccurred, onNavFail);

  try {
    chrome.tabs.onRemoved.addListener(function (tabId) {
      session.remove([K.chain(tabId), K.verdict(tabId)]).catch(function () {});
    });
  } catch (e) { /* non-fatal */ }

  console.log('[RD2] SW side up v' + VERSION + ' - webRequest listeners', listeners);

  /* ---------- message router (RD2_* only; other traffic untouched) - */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.slice(0, 4) !== 'RD2_') {
      return false;
    }
    handle(msg, sender)
      .then(function (r) { try { sendResponse(r); } catch (e) {} })
      .catch(function (e) {
        try {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        } catch (e2) {}
      });
    return true;   /* async response */
  });

  function senderTab(sender) {
    return sender && sender.tab && typeof sender.tab.id === 'number'
      ? sender.tab.id : -1;
  }

  async function handle(msg, sender) {
    const tabId = senderTab(sender);

    /* content script finished loading: hand over any pending verdict */
    if (msg.type === 'RD2_READY') {
      if (tabId < 0) return { ok: true, had: false };
      const rec = (await session.get(K.verdict(tabId)))[K.verdict(tabId)];
      if (rec && !rec.delivered && Date.now() - rec.ts <= VERDICT_TTL) {
        if (await injectCard(tabId, rec.data)) {
          rec.delivered = true; lastVerdict = rec;
          await session.set(kv(K.verdict(tabId), rec));
          COUNT.pingHits++;
          return { ok: true, had: true, injected: true };
        }
      }
      COUNT.pingMiss++;
      return { ok: true, had: false };
    }

    if (msg.type === 'RD2_DEBUG') return debugState();

    /* right-click trace / explicit render request */
    if (msg.type === 'RD2_RENDER') return doRender(msg, tabId);

    /* SecondLook.RD.selfTest() / forceShow() */
    if (msg.type === 'RD2_FORCE') {
      if (tabId < 0) return { ok: false, error: 'run from a page' };
      const rec = (await session.get(K.verdict(tabId)))[K.verdict(tabId)];
      const data = (rec && Date.now() - rec.ts <= 30 * 60 * 1000 && rec.data)
        || demoVerdict();
      const ok = await injectCard(tabId, data);
      return { ok: true, injected: ok, demo: !!data.demo, data: data };
    }

    return { ok: false, error: 'unknown type: ' + msg.type };
  }

  /* ---------- event handlers (sync wrappers -> serialized jobs) ---- */
  function onNavStart(d) { if (d && d.tabId >= 0) enq(d.tabId, function () { return onNavStart_(d); }); }
  function onRedirect(d) { if (d && d.tabId >= 0) enq(d.tabId, function () { return onRedirect_(d); }); }
  function onNavDone(d)  { if (d && d.tabId >= 0) enq(d.tabId, function () { return onNavDone_(d); }); }
  function onNavFail(d)  { if (d && d.tabId >= 0) enq(d.tabId, function () { return onNavFail_(d); }); }

  async function onNavStart_(d) {
    COUNT.navStart++;
    const t = d.tabId;
    /* a brand-new navigation invalidates any pending verdict */
    await session.remove(K.verdict(t));
    const c = await loadChain(t);
    const now = Date.now();
    if (c && Array.isArray(c.urls) && c.urls.length &&
        c.urls[c.urls.length - 1] === d.url &&
        now - (c.lastTs || 0) < CARRY_MS) {
      /* same URL moments later: meta-refresh / JS redirect - continue */
      c.lastTs = now; COUNT.carried++;
      await saveChain(t, c);
    } else {
      await saveChain(t, { urls: [d.url], lastTs: now });
    }
  }

  async function onRedirect_(d) {
    COUNT.redirects++;
    const t = d.tabId;
    let c = await loadChain(t);
    if (!c || !Array.isArray(c.urls) || !c.urls.length) {
      c = { urls: [d.url], lastTs: 0 };
    }
    const last = c.urls[c.urls.length - 1];
    if (d.redirectUrl && d.redirectUrl !== last && c.urls.length < 64) {
      c.urls.push(d.redirectUrl);
    }
    c.lastTs = Date.now();
    if (d.statusCode) c.lastStatus = d.statusCode;
    await saveChain(t, c);
  }

  async function onNavDone_(d) {
    COUNT.completions++;
    const t = d.tabId;
    const c = await loadChain(t);
    let urls = (c && Array.isArray(c.urls) && c.urls.length) ? c.urls.slice() : [];
    if (!urls.length || urls[urls.length - 1] !== d.url) urls.push(d.url);
    const hops = urls.length - 1;

    /* compact to [first, last] so a follow-up JS/meta redirect
     * can carry the original start across documents */
    const first = urls[0], last = urls[urls.length - 1];
    await saveChain(t, { urls: first === last ? [last] : [first, last], lastTs: Date.now() });

    if (!(await moduleOn())) { COUNT.settingsOff++; return; }
    await maybeVerdict(t, urls, hops);
  }

  async function onNavFail_(d) {
    COUNT.errors++;
    if (String(d.error || '').indexOf('BLOCKED') !== -1) COUNT.blocked++;
    if (d.tabId >= 0) await saveChain(d.tabId, { urls: [d.url], lastTs: Date.now() });
  }

  /* ---------- verdict ---------- */
  async function maybeVerdict(t, urls, hops) {
    try {
      const start = urls[0], final = urls[urls.length - 1];
      const sh = hostOf(start), fh = hostOf(final);
      const domainChanged = !!(sh && fh && registrableOf(sh) !== registrableOf(fh));
      const shortStart = isShortHost(sh);
      const eng = engineCheck(final);

      const reasons = [];
      if (hops >= 2) {
        reasons.push('This link made ' + hops + ' extra stop' +
          (hops === 1 ? '' : 's') + ' before showing you a page.');
      }
      if (domainChanged) {
        reasons.push('You clicked a link on ' + sh + ' but landed on ' +
          fh + ' - a different site.');
      }
      if (shortStart) {
        reasons.push('It started as a shortened link (' + sh +
          "), so you couldn't see where it was really going.");
      }
      if (eng && eng.flagged) {
        for (const r of eng.reasons) reasons.push(r);
      }

      /* quiet by design: same registrable site, few hops, no flags */
      const show = !!(eng && eng.flagged) ||
                   (domainChanged && (shortStart || hops >= 2));
      if (!show) { COUNT.quiet++; return; }

      /* 10-minute cooldown per start-host -> final-host pair */
      const pair = sh + '|' + fh;
      const cd = (await session.get(COOLDOWN_KEY))[COOLDOWN_KEY] || {};
      if (Date.now() - (cd[pair] || 0) < COOLDOWN_MS) { COUNT.cooldown++; return; }
      cd[pair] = Date.now();
      pruneCooldown(cd);
      await session.set(kv(COOLDOWN_KEY, cd));

      const data = {
        id: 'rd2-' + t + '-' + Date.now(),
        verdict: 'SECOND_LOOK',
        title: 'Where that link really went',
        reasons: reasons,
        rows: [
          ['You clicked', start],
          ['Landed on', final]
        ],
        chain: urls.slice(0, 12),
        chainLabels: urls.slice(0, 12).map(function (u) {
          const h = hostOf(u);
          return ssoHost(h) ? h + ' (sign-in handoff)' : h;
        }),
        hops: hops, startHost: sh, finalHost: fh,
        engine: { used: !!(eng && eng.flagged) },
        ts: Date.now(),
        demo: false
      };
      lastVerdict = { id: data.id, tabId: t, ts: data.ts, delivered: false, data: data };
      await session.set(kv(K.verdict(t), lastVerdict));
      COUNT.shown++;

      /* deliver: SW-side injection, no dependency on content scripts */
      setTimeout(function () { deliverIfPending(t); }, INJECT_DELAY);
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  async function deliverIfPending(t) {
    try {
      const rec = (await session.get(K.verdict(t)))[K.verdict(t)];
      if (!rec || rec.delivered || Date.now() - rec.ts > VERDICT_TTL) return;
      if (await injectCard(t, rec.data)) {
        rec.delivered = true; lastVerdict = rec;
        await session.set(kv(K.verdict(t), rec));
      }
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  async function injectCard(tabId, data) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: __sl_rd_card,
        args: [data]
      });
      COUNT.injectOk++;
      return true;
    } catch (e) {
      COUNT.injectFail++;
      lastError = 'inject: ' + String((e && e.message) || e);
      return false;
    }
  }

  /* explicit render (right-click trace "showChain" bounced by content) */
  async function doRender(msg, tabId) {
    const d = (msg && msg.data) || {};
    const chain = Array.isArray(d.chain) ? d.chain.filter(Boolean) : [];
    if (tabId < 0 || !chain.length) {
      return { ok: false, error: 'empty chain' };
    }
    const start = d.startUrl || chain[0];
    const final = chain[chain.length - 1];
    const hops = typeof d.hops === 'number' ? d.hops : chain.length - 1;
    const eng = engineCheck(final);

    const reasons = [];
    if (eng && eng.flagged) {
      for (const r of eng.reasons) reasons.push(r);
    }
    if (d.error) reasons.push('The chain did not finish (' + d.error + ').');
    if (hops === 0) {
      reasons.push('This link does not redirect - it goes straight to ' +
        hostOf(start) + '.');
    }
    if (!reasons.length) {
      reasons.push('The full path this link took, from first click to final stop.');
    }

    const data = {
      id: d.id || ('rd2-trace-' + Date.now()),
      verdict: (eng && eng.flagged) ? 'SECOND_LOOK' : 'CLEAR',
      title: 'Redirect trace (' + hops + (hops === 1 ? ' hop)' : ' hops)'),
      reasons: reasons,
      rows: [
        ['You clicked', start],
        ['Landed on', final]
      ],
      chain: chain.slice(0, 12),
      chainLabels: chain.slice(0, 12).map(function (u) {
        const h = hostOf(u);
        return ssoHost(h) ? h + ' (sign-in handoff)' : h;
      }),
      hops: hops, ts: Date.now(), demo: false, trace: true
    };
    const ok = await injectCard(tabId, data);
    COUNT.traces++;
    return { ok: true, injected: ok };
  }

  function demoVerdict() {
    return {
      id: 'rd2-demo-' + Date.now(),
      verdict: 'SECOND_LOOK',
      demo: true,
      title: 'Where that link really went',
      reasons: [
        'Demo card - the pipeline works: the service worker built this ' +
        'and injected it into the page.',
        'Real cards appear after a redirect chain, e.g. through a link ' +
        'shortener.'
      ],
      rows: [
        ['You clicked', 'https://bit.ly/4demo-link'],
        ['Landed on', 'https://example.org/somewhere/else']
      ],
      chain: ['https://bit.ly/4demo-link', 'https://example.org/somewhere/else'],
      hops: 1, ts: Date.now()
    };
  }

  /* ---------- state helpers ---------- */
  async function loadChain(t) {
    try { return (await session.get(K.chain(t)))[K.chain(t)] || null; }
    catch (e) { lastError = String((e && e.message) || e); return null; }
  }
  async function saveChain(t, c) {
    try { await session.set(kv(K.chain(t), c)); }
    catch (e) { lastError = String((e && e.message) || e); }
  }

  /* read-only settings check (writes stay exclusive to the settings API) */
  async function moduleOn() {
    try {
      const s = (await chrome.storage.local.get('slSettings')).slSettings;
      return !!(s && s.modules && s.modules['redirect-detective'] !== false);
    } catch (e) { return true; }
  }

  async function debugState() {
    let all = {};
    try { all = await session.get(null); } catch (e) {}
    const eng = getEngine();
    return {
      ok: true, module: 'redirect-detective', swVersion: VERSION,
      uptimeMs: Date.now() - startedAt,
      listeners: listeners,
      counters: COUNT,
      lastError: lastError ? String(lastError) : null,
      gate: { settingsOn: await moduleOn() },
      engine: { available: !!eng, version: (eng && eng.VERSION) || '?' },
      storage: {
        verdictKeys: Object.keys(all).filter(function (k) {
          return k.indexOf('rd2:verdict:') === 0;
        }),
        chainKeys: Object.keys(all).filter(function (k) {
          return k.indexOf('rd2:chain:') === 0;
        })
      },
      lastVerdict: lastVerdict ? {
        id: lastVerdict.id, tabId: lastVerdict.tabId, ts: lastVerdict.ts,
        delivered: lastVerdict.delivered,
        hops: lastVerdict.data && lastVerdict.data.hops,
        start: lastVerdict.data && lastVerdict.data.rows &&
               lastVerdict.data.rows[0] && lastVerdict.data.rows[0][1]
      } : null
    };
  }

  /* ---------- Engine (optional, discovered via the shared global) --- */
  function getEngine() {
    const SL = globalThis.SecondLook;
    return (SL && SL.Engine) || globalThis.SLEngine || globalThis.Engine || null;
  }
  function engineCheck(url) {
    const E = getEngine();
    if (!E || typeof E.analyze !== 'function') return null;
    try {
      const r = E.analyze(url, { source: 'redirect-detective' }) || {};
      const v = String(r.verdict || '').toUpperCase().replace(/[\s-]+/g, '_');
      const reasons = (Array.isArray(r.reasons) ? r.reasons : [])
        .filter(function (x) { return typeof x === 'string' && x.trim(); })
        .slice(0, 3);
      const flagged = (v === 'SECOND_LOOK' || v === 'INTERCEPTED' ||
                       v === 'DANGER' || v === 'WARNING') && reasons.length > 0;
      return { flagged: flagged, reasons: reasons, version: E.VERSION || '?' };
    } catch (e) {
      lastError = 'engine: ' + String((e && e.message) || e);
      return null;
    }
  }

  /* ---------- domain helpers (Engine-independent fallbacks) -------- */
  const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly',
    'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc',
    'rb.gy', 's.id', 'lnkd.in', 'smarturl.it', 'bl.ink', 'shorte.st',
    'clck.ru', 'trib.al', 'loom.ly'];
  const TWO_LEVEL = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp',
    'ne.jp', 'co.kr', 'co.in', 'co.nz', 'co.za', 'com.au', 'net.au',
    'org.au', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.tw',
    'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'co.id', 'com.co',
    'com.pe', 'com.eg', 'com.sa', 'com.ng', 'com.pk', 'com.bd'];
  const SSO_SAFE = ['login.microsoftonline.com', 'login.live.com',
    'accounts.google.com', 'accounts.youtube.com', 'login.yahoo.com',
    'auth0.com', 'okta.com', 'appleid.apple.com'];

  function hostOf(u) {
    try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
  }
  function registrableOf(h) {
    if (!h) return '';
    const p = h.split('.');
    if (p.length <= 2) return h;
    const last2 = p.slice(-2).join('.');
    return TWO_LEVEL.indexOf(last2) !== -1 ? p.slice(-3).join('.') : last2;
  }
  function isShortHost(h) {
    if (!h) return false;
    if (SHORTENERS.indexOf(h) !== -1) return true;
    for (let i = 0; i < SHORTENERS.length; i++) {
      if (h.slice(-(SHORTENERS[i].length + 1)) === '.' + SHORTENERS[i]) {
        return true;
      }
    }
    return false;
  }
  function ssoHost(h) {
    if (!h) return false;
    for (let i = 0; i < SSO_SAFE.length; i++) {
      if (h === SSO_SAFE[i] || h.slice(-(SSO_SAFE[i].length + 1)) === '.' + SSO_SAFE[i]) {
        return true;
      }
    }
    return false;
  }
  function pruneCooldown(cd) {
    const now = Date.now();
    Object.keys(cd).forEach(function (k) {
      if (now - cd[k] > COOLDOWN_MS) delete cd[k];
    });
  }

  /* =====================================================================
   * The card - injected via chrome.scripting.executeScript.
   * MUST be fully self-contained: no references to anything outside
   * this function. All dynamic text goes in via textContent (live URLs
   * are never injected as HTML).
   * ===================================================================== */
  function __sl_rd_card(v) {
    const ID = 'sl-rd2-card';
    const old = document.getElementById(ID);
    if (old) old.remove();
    if (!v) return true;

    const CLEAR = v.verdict === 'CLEAR';
    const COLOR = CLEAR ? '#3dc97b' : '#f0a437';
    const INK = '#e9eef3';
    const DIM = '#9fb0bd';
    const BG = 'rgba(13,18,24,.96)';

    const css = function (el, list) {
      el.style.cssText = list.map(function (s) { return s + ' !important'; }).join(';');
    };
    const shortStr = function (s, n) {
      s = String(s == null ? '' : s);
      return s.length > n ? s.slice(0, n - 18) + '\u2026' + s.slice(-16) : s;
    };
    const hostOf = function (u) {
      try { return new URL(u).hostname; } catch (e) { return ''; }
    };

    const card = document.createElement('div');
    card.id = ID;
    card.setAttribute('role', 'alert');
    css(card, [
      'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483646',
      'width:min(370px,calc(100vw - 32px))', 'box-sizing:border-box',
      'background:' + BG, 'color:' + INK,
      "font:13px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      'border-radius:12px', 'border:1px solid rgba(255,255,255,.09)',
      'border-left:4px solid ' + COLOR,
      'box-shadow:0 14px 36px rgba(0,0,0,.45)',
      'padding:14px 14px 12px', 'margin:0'
    ]);

    /* header: pill + title + close */
    const head = document.createElement('div');
    css(head, ['display:flex', 'align-items:center', 'gap:8px', 'margin:0 0 10px']);
    const pill = document.createElement('span');
    pill.textContent = v.demo ? (CLEAR ? 'CLEAR' : 'SECOND LOOK') + ' \u00b7 DEMO'
                              : (CLEAR ? 'CLEAR' : 'SECOND LOOK');
    css(pill, [
      'flex:none', 'font-size:10.5px', 'font-weight:700', 'letter-spacing:.09em',
      'color:' + (CLEAR ? '#0b1a12' : '#20140a'), 'background:' + COLOR,
      'padding:3px 8px', 'border-radius:999px'
    ]);
    const title = document.createElement('span');
    title.textContent = String(v.title || 'Where that link really went');
    css(title, ['flex:1', 'font-weight:600', 'font-size:13.5px', 'color:' + INK]);
    const close = document.createElement('button');
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss');
    css(close, [
      'flex:none', 'border:0', 'background:transparent', 'color:' + DIM,
      'font-size:15px', 'line-height:1', 'padding:4px 6px', 'cursor:pointer',
      'border-radius:6px'
    ]);
    head.appendChild(pill); head.appendChild(title); head.appendChild(close);
    card.appendChild(head);

    const btnBase = [
      'border:1px solid rgba(255,255,255,.14)',
      'background:rgba(255,255,255,.05)', 'color:' + INK,
      'font-size:12px', 'padding:5px 10px', 'border-radius:8px', 'cursor:pointer'
    ];

    /* reasons */
    (Array.isArray(v.reasons) ? v.reasons : []).slice(0, 4).forEach(function (r) {
      const row = document.createElement('div');
      css(row, ['display:flex', 'gap:8px', 'margin:0 0 6px', 'font-size:12.5px', 'color:' + INK]);
      const dot = document.createElement('span');
      css(dot, ['flex:none', 'width:6px', 'height:6px', 'border-radius:50%',
                'background:' + COLOR, 'margin-top:6px']);
      const txt = document.createElement('span');
      txt.textContent = String(r);
      row.appendChild(dot); row.appendChild(txt);
      card.appendChild(row);
    });

    /* rows: You clicked / Landed on */
    (Array.isArray(v.rows) ? v.rows : []).slice(0, 3).forEach(function (pair) {
      if (!Array.isArray(pair) || pair.length < 2) return;
      const wrap = document.createElement('div');
      css(wrap, ['margin:8px 0 0']);
      const lab = document.createElement('div');
      lab.textContent = String(pair[0]);
      css(lab, ['font-size:10.5px', 'font-weight:600', 'letter-spacing:.07em',
                'text-transform:uppercase', 'color:' + DIM]);
      const val = document.createElement('div');
      val.textContent = shortStr(pair[1], 72);
      val.title = String(pair[1]);
      css(val, ['font-size:12px', 'color:#c9d4dc', 'word-break:break-all',
                'font-family:ui-monospace,SFMono-Regular,Consolas,monospace']);
      wrap.appendChild(lab); wrap.appendChild(val);
      card.appendChild(wrap);
    });

    /* chain path */
    const chain = Array.isArray(v.chain) ? v.chain.filter(Boolean) : [];
    const labels = Array.isArray(v.chainLabels) ? v.chainLabels : null;
    if (chain.length > 1) {
      const head2 = document.createElement('div');
      head2.textContent = 'Path it took (' + (chain.length - 1) +
        ' redirect' + (chain.length === 2 ? '' : 's') + ')';
      css(head2, ['margin:10px 0 4px', 'font-size:10.5px', 'font-weight:600',
                  'letter-spacing:.07em', 'text-transform:uppercase', 'color:' + DIM]);
      card.appendChild(head2);
      const list = document.createElement('div');
      css(list, ['font-size:11.5px', 'color:' + DIM, 'line-height:1.6']);
      chain.slice(0, 12).forEach(function (u, i) {
        const line = document.createElement('div');
        const label = labels && labels[i] ? labels[i] : hostOf(u);
        line.textContent = (i === 0 ? '\u00b7 ' : '\u2192 ') + label;
        line.title = String(u);
        css(line, ['white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']);
        list.appendChild(line);
      });
      if (chain.length > 12) {
        const more = document.createElement('div');
        more.textContent = '\u2026 ' + (chain.length - 12) + ' more';
        list.appendChild(more);
      }
      card.appendChild(list);
    }

    /* footer: brand + actions */
    const foot = document.createElement('div');
    css(foot, ['display:flex', 'align-items:center', 'gap:8px', 'margin:12px 0 0']);
    const brand = document.createElement('span');
    brand.textContent = 'SecondLook \u00b7 Redirect Detective';
    css(brand, ['flex:1', 'font-size:10.5px', 'color:' + DIM]);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy path';
    css(copyBtn, btnBase);

    const okBtn = document.createElement('button');
    okBtn.textContent = 'Got it';
    css(okBtn, btnBase.concat(['background:' + COLOR,
      'color:' + (CLEAR ? '#0b1a12' : '#20140a'), 'font-weight:600', 'border-color:transparent']));

    const onEsc = function (e) { if (e.key === 'Escape') dismiss(); };
    const dismiss = function () {
      card.remove();
      document.removeEventListener('keydown', onEsc, true);
    };
    close.onclick = dismiss;
    okBtn.onclick = dismiss;
    document.addEventListener('keydown', onEsc, true);

    copyBtn.onclick = function () {
      const txt = chain.join('\n');
      const done = function (ok) {
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(function () {
          try { copyBtn.textContent = 'Copy path'; } catch (e) {}
        }, 1500);
      };
      const fallback = function () {
        let ok = false;
        try {
          const ta = document.createElement('textarea');
          ta.value = txt;
          ta.setAttribute('style', 'position:fixed;left:-9999px;top:0');
          document.documentElement.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch (e) {}
        done(ok);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { done(true); }, fallback);
      } else { fallback(); }
    };

    foot.appendChild(brand); foot.appendChild(copyBtn); foot.appendChild(okBtn);
    card.appendChild(foot);

    (document.body || document.documentElement).appendChild(card);

    /* best-effort slide-in; strict page CSP may ignore it - the card
     * is still fully visible without the animation */
    try {
      const st = document.createElement('style');
      st.textContent = '@keyframes slRd2In{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}';
      (document.head || document.documentElement).appendChild(st);
      card.style.setProperty('animation', 'slRd2In .26s ease-out', 'important');
      setTimeout(function () { try { st.remove(); } catch (e) {} }, 4000);
    } catch (e) {}

    return true;
  }

})();