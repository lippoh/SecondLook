/* SecondLook — modules/redirect-detective/background.js
 * Service-worker side. Load via importScripts AFTER shared/settings.js
 * (it also survives being loaded first - everything is resolved lazily).
 *
 * What it does
 *   - Tracks server-side redirect chains per navigation (webRequest,
 *     main_frame only, keyed by requestId: one navigation = one chain).
 *   - Stores finished routes in storage.session (survives SW restarts),
 *     written through immediately - no debounce window to lose.
 *   - Sets the hop-count badge + tooltip; feeds the on-page route card
 *     (content.js) via SL_RD_GET_CHAIN.
 *
 * Correctness rules baked in
 *   - Listeners are registered synchronously at the top level so the SW
 *     wakes for navigations. When the module is off, handlers return
 *     immediately and all stored data is wiped: observed = nothing.
 *   - The module syncs its own on/off state from settings on SW start
 *     and on every settings-key change. It does not depend on bootstrap
 *     calling RD.setEnabled (kept for compatibility if you already do).
 *   - Engine helpers (isShortlinkHost / registrable) are OPTIONAL: if
 *     the engine build lacks them, local fallbacks keep the analysis
 *     alive instead of throwing on every navigation.
 *   - http -> https same-site upgrades at the start of a chain are
 *     browser noise, not routing: stripped before counting.
 *   - Nothing here ever writes settings. Stats are debounced and never
 *     touch the settings key.
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  if (root.RD) return;

  const CHAIN_KEY = 'slChains';           // storage.session
  const MAX_HOPS = 12;
  const KEEP_TABS = 25;

  let enabled = true;                     // optimistic; sync() corrects it
  let chains = {};
  const active = new Map();               // requestId -> { tabId, hops }

  const chainsReady = (async () => {
    try {
      const got = await chrome.storage.session.get(CHAIN_KEY);
      if (got && got[CHAIN_KEY] && typeof got[CHAIN_KEY] === 'object') {
        chains = got[CHAIN_KEY];
      }
    } catch (e) { chains = {}; }
  })();

  const FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] };

  /* ---------- optional engine helpers, with fallbacks ---------- */
  const FALLBACK_SHORTENERS = new Set([
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
    'rebrand.ly', 'cutt.ly', 'shorturl.at', 't.ly', 's.id', 'tiny.cc',
    'bit.do', 'lnkd.in', 'rb.gy', 'smarturl.it', 'bl.ink', 'snip.ly',
    'shrtco.de', 'gg.gg', 'shorte.st', 'clc.to', 'vm.tiktok.com'
  ]);
  /* Legitimate sign-in machinery, not suspicion: when a route hops
   * through one of these, the "different companies" flag stays quiet
   * (every other flag still applies). */
  const SSO_SAFE = [
    'login.microsoftonline.com', 'login.live.com', 'accounts.google.com',
    'accounts.youtube.com', 'login.yahoo.com', 'auth0.com', 'okta.com',
    'okta-emea.com', 'appleid.apple.com', 'signin.aws.amazon.com',
    'login.salesforce.com', 'auth.cloudflare.com'
  ];
  const TWO_PART_TLD = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp',
    'co.za', 'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.ar',
    'co.in', 'co.nz', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'com.tr',
    'co.kr', 'com.my', 'com.ph', 'com.vn', 'co.id', 'com.co', 'com.pe',
    'com.ve', 'com.eg', 'co.il', 'org.il', 'net.il'
  ]);

  const parse = (u) => { try { return new URL(u); } catch (e) { return null; } };

  function registrableFallback(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    return TWO_PART_TLD.has(last2) ? parts.slice(-3).join('.') : last2;
  }
  function engRegistrable(host) {
    const f = root.Engine && root.Engine.registrable;
    if (typeof f === 'function') {
      try { const r = f(host); if (r) return String(r).toLowerCase(); } catch (e) {}
    }
    return registrableFallback(host);
  }
  function engShortlink(host) {
    const f = root.Engine && root.Engine.isShortlinkHost;
    if (typeof f === 'function') {
      try { if (f(host) === true) return true; } catch (e) {}
    }
    const h = String(host || '').toLowerCase();
    return FALLBACK_SHORTENERS.has(h) ||
           FALLBACK_SHORTENERS.has(engRegistrable(h));
  }
  function isSsoHost(host) {
    host = String(host || '').toLowerCase();
    return SSO_SAFE.some((h) => host === h || host.endsWith('.' + h));
  }

  /* Leading same-site http -> https hops are the browser's own upgrade
   * (HTTPS-First / HSTS), not a decision by the site. Strip them before
   * counting or the badge lies about real routing. */
  function stripHttpsUpgrades(hops) {
    let i = 0;
    while (i + 1 < hops.length) {
      const a = parse(hops[i]), b = parse(hops[i + 1]);
      if (a && b && a.protocol === 'http:' && b.protocol === 'https:' &&
          engRegistrable(a.hostname) === engRegistrable(b.hostname)) i++;
      else break;
    }
    return i ? hops.slice(i) : hops;
  }

  function analyzeChain(hops) {
    const reasons = [];
    const flags = [];
    const push = (flag, text) => {
      if (!flags.includes(flag)) { flags.push(flag); reasons.push(text); }
    };

    const redirects = hops.length - 1;
    if (redirects >= 4) push('long',
      'This route used ' + redirects + ' redirects - unusually long for a normal site.');

    let sawShortener = false, sawIp = false, sawHttp = false, sawSso = false;
    for (const h of hops) {
      const u = parse(h);
      if (!u) continue;
      if (engShortlink(u.hostname)) sawShortener = true;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) sawIp = true;
      if (u.protocol === 'http:') sawHttp = true;
      if (isSsoHost(u.hostname)) sawSso = true;
    }
    if (sawShortener) push('shortener',
      'The route passes through a link shortener before reaching the destination.');
    if (sawIp) push('ip',
      'The route passes through a raw IP address instead of a named site.');

    const first = parse(hops[0]), last = parse(hops[hops.length - 1]);
    const secureStart = first && first.protocol === 'https:';
    const insecureEnd = last && last.protocol === 'http:';
    if (secureStart && insecureEnd) push('downgrade',
      'The route ends on an insecure (http) page after starting secure.');
    else if (sawHttp) push('http',
      'Part of the route travelled over plain http.');

    const firstReg = first ? engRegistrable(first.hostname) : '';
    const lastReg = last ? engRegistrable(last.hostname) : '';
    if (firstReg && lastReg && firstReg !== lastReg && !sawSso) {
      push('cross-domain', 'The site you started at (' + firstReg +
        ') and the one you landed on (' + lastReg + ') are different companies.');
    }
    return { verdict: reasons.length ? 'SECOND_LOOK' : 'CLEAR', reasons, flags };
  }

  /* ---------- badge ---------- */
  function badgeClear(tabId) {
    if (tabId < 0) return;
    try {
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({ tabId, title: '' });
    } catch (e) { /* tab can disappear mid-flight */ }
  }
  function badgeSet(tabId, count, suspicious, analysis) {
    if (tabId < 0) return;
    try {
      chrome.action.setBadgeText({ tabId, text: String(count) });
      chrome.action.setBadgeBackgroundColor(
        { tabId, color: suspicious ? '#b45309' : '#5a7d9a' });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
      }
      chrome.action.setTitle({ tabId, title: suspicious
        ? 'SecondLook - ' + count + ' redirects. ' +
          (analysis && analysis.reasons[0]
            ? analysis.reasons[0] : 'This route deserves a second look.')
        : 'SecondLook - ' + count + ' redirects, nothing unusual.' });
    } catch (e) { /* tab can disappear mid-flight */ }
  }

  /* ---------- webRequest handlers (top-level registration below) ---- */
  function onBeforeRequest(d) {
    if (!enabled) return;
    if (d.tabId < 0) return;
    const ex = active.get(d.requestId);
    if (ex) {
      if (d.url && d.url !== ex.hops[ex.hops.length - 1]) ex.hops.push(d.url);
      return;
    }
    active.set(d.requestId, { tabId: d.tabId, hops: [d.url], ts: Date.now() });
    badgeClear(d.tabId);                    // old route is now stale
  }

  function onBeforeRedirect(d) {
    if (!enabled) return;
    const chain = active.get(d.requestId);
    if (!chain) return;
    if (d.redirectUrl && d.redirectUrl !== chain.hops[chain.hops.length - 1]) {
      chain.hops.push(d.redirectUrl);
    }
  }

  function onCompleted(d) {
    if (!enabled) return;
    const chain = active.get(d.requestId);
    if (!chain) return;
    active.delete(d.requestId);
    if (d.url && d.url !== chain.hops[chain.hops.length - 1]) chain.hops.push(d.url);
    finalize(chain, null);
  }

  function onErrorOccurred(d) {
    if (!enabled) return;
    const chain = active.get(d.requestId);
    if (!chain) return;
    active.delete(d.requestId);
    finalize(chain, d.error || 'net error');
  }

  function finalize(chain, error) {
    try {
      const hops = stripHttpsUpgrades(chain.hops);
      if (hops.length <= 1) { badgeClear(chain.tabId); return; }   // direct landing
      if (hops.length > MAX_HOPS + 1) hops.length = MAX_HOPS + 1;
      const analysis = analyzeChain(hops);
      const record = {
        hops,
        ts: Date.now(),
        verdict: analysis.verdict,
        reasons: analysis.reasons,
        flags: analysis.flags,
        finalUrl: hops[hops.length - 1]
      };
      if (error) record.error = error;
      chains[chain.tabId] = record;
      prune();
      writeNow();                           // write-through: no debounce to lose
      badgeSet(chain.tabId, hops.length - 1, analysis.verdict !== 'CLEAR', analysis);
      countRoute(record);
    } catch (e) {
      console.warn('[RD] finalize failed:', e && e.message);
    }
  }

  function prune() {
    const ids = Object.keys(chains).map(Number)
      .sort((a, b) => (chains[b].ts || 0) - (chains[a].ts || 0));
    for (const id of ids.slice(KEEP_TABS)) delete chains[id];
  }

  async function writeNow() {
    try { await chrome.storage.session.set({ [CHAIN_KEY]: chains }); }
    catch (e) { /* quota - records are best-effort */ }
  }

  /* ---------- stats (debounced; never touches the settings key) ---- */
  const pendingStats = { routes: 0, flagged: 0 };
  let statsTimer = null;
  function countRoute(record) {
    pendingStats.routes++;
    if (record.verdict !== 'CLEAR') pendingStats.flagged++;
    if (!statsTimer) statsTimer = setTimeout(flushStats, 15000);
  }
  async function flushStats() {
    statsTimer = null;
    const delta = { routes: pendingStats.routes, flagged: pendingStats.flagged };
    pendingStats.routes = 0; pendingStats.flagged = 0;
    if (!delta.routes) return;
    try {
      const got = await chrome.storage.local.get('slStats');
      const stats = (got && got.slStats) || { v: 1, modules: {} };
      const m = (stats.modules['redirect-detective'] =
        stats.modules['redirect-detective'] || {});
      m.routes = (m.routes || 0) + delta.routes;
      m.flagged = (m.flagged || 0) + delta.flagged;
      await chrome.storage.local.set({ slStats: stats });
    } catch (e) { /* best-effort */ }
  }

  /* ---------- lifecycle ---------- */
  function setEnabled(on) {
    const next = on === true;
    if (next === enabled) return;
    enabled = next;
    if (!next) {
      active.clear();
      chains = {};
      try { chrome.storage.session.remove(CHAIN_KEY); } catch (e) {}
      try {
        chrome.action.setBadgeText({ text: '' });      // all tabs
        chrome.action.setTitle({ title: '' });
      } catch (e) {}
    }
  }

  /* Self-synced from settings: runs at SW start and on every settings
   * change. Works with or without a bootstrap hook. */
  async function sync() {
    if (!root.Settings || typeof root.Settings.get !== 'function') return;
    try {
      const s = await root.Settings.get();
      setEnabled(root.Settings.isModuleOn(s, 'redirect-detective'));
    } catch (e) { /* keep current state */ }
  }

  async function getChainFor(tabId) {
    await chainsReady;
    if (!enabled || tabId < 0) return null;
    return chains[tabId] || null;
  }

  /* Tab hygiene */
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (chains[tabId]) { delete chains[tabId]; writeNow(); }
    badgeClear(tabId);
  });
  /* Prerender activation: the finished route belongs to the tab that
   * swapped in, so hand it over instead of dropping it. */
  chrome.tabs.onReplaced.addListener((added, removed) => {
    if (chains[removed]) {
      chains[added] = chains[removed];
      delete chains[removed];
      writeNow();
    }
  });

  /* Route card endpoint (used by the content script, works from the
   * popup too via msg.tabId). */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'SL_RD_GET_CHAIN') return false;
    const tabId = sender && sender.tab ? sender.tab.id
      : (typeof msg.tabId === 'number' ? msg.tabId : -1);
    (async () => {
      await chainsReady;
      sendResponse(enabled && tabId >= 0 ? (chains[tabId] || null) : null);
    })();
    return true;
  });

  /* Settings changes -> re-sync (the key is read lazily so this also
   * works if the module loads before shared/settings.js). */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const key = (root.Settings && root.Settings.KEY) || 'slSettings';
    if (changes[key]) sync();
  });

  /* Registered synchronously at SW top level - required for wake-ups. */
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER);
  chrome.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, FILTER);
  chrome.webRequest.onCompleted.addListener(onCompleted, FILTER);
  chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, FILTER);

  sync();

  root.RD = { setEnabled, sync, getChainFor, analyzeChain };
})();