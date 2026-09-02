/* ============================================================
   SecondLook — engine/verdict-engine.js  (v1.1)
   The ONLY place a verdict word is chosen. Thin combiner over
   UrlAnalyzer — now passes meta.facts / meta.tags through so
   modules can render richer pills.
   INVARIANT preserved: URL-only scores cap at 39, below
   INTERCEPTED_MIN (40) — links never escalate to red.
   ============================================================ */
(function () {
  'use strict';

  const root = (typeof globalThis !== 'undefined') ? globalThis : window;
  root.SL = root.SL || {};

  /* Tuning knobs */
  const THRESHOLDS = {
    CLEAR_MAX: 12,          // at or below this score -> CLEAR
    INTERCEPTED_MIN: 40     // unreachable from URL analysis alone (cap 39)
  };

  /**
   * Analyze a URL into the shared verdict envelope.
   * @param {string} url - Link target (absolute, or resolvable via context.baseUrl).
   * @param {{linkText?: string, baseUrl?: string, source?: string, escalate?: boolean}} [context]
   * @returns {{verdict: 'CLEAR'|'SECOND LOOK'|'INTERCEPTED', reasons: Array<{signal: string, weight: number, plainText: string}>, score: number, meta: object}}
   */
  function analyze(url, context) {
    context = context || {};
    const SL = root.SL || {};
    let result = { score: 0, reasons: [], meta: { facts: [], tags: [] } };
    if (SL.UrlAnalyzer && typeof SL.UrlAnalyzer.analyze === 'function') {
      try {
        result = SL.UrlAnalyzer.analyze(url, context) || result;
      } catch (e) { /* analyzer failed — fall back to neutral */ }
    }
    let verdict;
    if (context.escalate === true) {
      verdict = 'INTERCEPTED';   // only Form Guardian / Download Guard may pass this
    } else {
      verdict = result.score <= THRESHOLDS.CLEAR_MAX ? 'CLEAR' : 'SECOND LOOK';
    }
    return {
      verdict: verdict,
      reasons: (result.reasons || []).slice(),
      score: Math.min(result.score || 0, 100),
      meta: result.meta || {}
    };
  }

  root.SL.VerdictEngine = { analyze: analyze, THRESHOLDS: THRESHOLDS };
})();