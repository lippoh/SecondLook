/* engine/redirect-resolver.js - SERVICE WORKER ONLY (needs webRequest).
 *
 * The trap this file exists to avoid:
 *   fetch(url, {redirect:'manual'})  ->  OPAQUE response, headers
 *   unreadable. Useless for chain inspection.
 * The working shape: follow redirects with fetch(), capture each hop
 * via webRequest.onBeforeRedirect keyed by requestId. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  root.Engine = root.Engine || {};
  if (root.Engine.Redirect) return;
  const MAX_HOPS = 8;         // tuning: stop following after this many hops
  const TIMEOUT_MS = 6000;    // tuning: per-resolution budget
  let queue = Promise.resolve();   // serialize: one resolution in flight
  let collector = null;            // requestId -> [{fromUrl,toUrl,status}]
  let listening = false;
  function ensureListener() {
    if (listening) return;
    listening = true;
    // OBSERVER ONLY: no blocking, no header modification.
    chrome.webRequest.onBeforeRedirect.addListener((details) => {
      if (!collector) return;
      const list = collector.get(details.requestId) || [];
      list.push({
        fromUrl: details.url,
        toUrl: details.redirectUrl,
        status: details.statusCode
      });
      collector.set(details.requestId, list);
    }, { urls: ['<all_urls>'] });
  }
  function buildChain(startUrl, events, finalUrl) {
    const chain = [startUrl];
    let cursor = startUrl;
    for (const ev of events) {
      if (ev.fromUrl === cursor) { chain.push(ev.toUrl); cursor = ev.toUrl; }
    }
    if (finalUrl && chain[chain.length - 1] !== finalUrl) {
      chain.push(finalUrl);
    }
    return chain;
  }
  async function resolveOnce(url) {
    collector = new Map();
    ensureListener();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let finalUrl = url;
    let error = null;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        credentials: 'omit',   // never send the user's cookies upstream
        cache: 'no-store',
        signal: ctrl.signal
      });
      finalUrl = res.url || url;
    } catch (err) {
      error = String((err && err.message) || err);
    } finally {
      clearTimeout(timer);
    }
    // Pick the event list that starts at our URL; prefer one that also
    // ends at our finalUrl (guards against unrelated parallel requests).
    let events = null;
    for (const list of collector.values()) {
      if (!list.length || list[0].fromUrl !== url) continue;
      if (!events) events = list;
      if (finalUrl && list[list.length - 1].toUrl === finalUrl) { events = list; break; }
    }
    collector = null;
    const chain = buildChain(url, events || [], finalUrl)
      .slice(0, MAX_HOPS + 1);
    return {
      chain,
      finalUrl,
      hops: Math.max(0, chain.length - 1),
      error
    };
  }
  /**
   * Resolve a URL's redirect chain.
   * @param {string} url
   * @returns {Promise<{chain:string[], finalUrl:string, hops:number,
   *                    error:(string|null)}>}
   */
  function resolve(url) {
    const run = queue.then(() => resolveOnce(url));
    queue = run.then(() => undefined, () => undefined);  // keep queue alive
    return run;
  }
  root.Engine.Redirect = { resolve, MAX_HOPS, TIMEOUT_MS };
})(globalThis);