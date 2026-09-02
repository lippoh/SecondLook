/* engine/verdict-engine.js - the ONLY place a verdict is produced. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  root.Engine = root.Engine || {};
  if (root.Engine.analyze) return;
  const THRESHOLDS = {
    SECOND_LOOK: 20,   // score at or above this earns an amber pill
    INTERCEPT: 40,     // never reachable from URL signals alone
    URL_CAP: 39        // hard clamp for URL-only analysis
  };
  const VERDICT = {
    CLEAR: 'CLEAR',
    SECOND_LOOK: 'SECOND_LOOK',
    INTERCEPTED: 'INTERCEPTED'
  };
  /**
   * Analyze a URL and produce a SecondLook verdict.
   * @param {string} url - the URL to judge.
   * @param {object} [context] - extra evidence from the calling module:
   *   displayText  visible text of the link/anchor, if any
   *   credentials  true when credentials are about to be sent (P4)
   *   escalate     true when the module has hard evidence and is
   *                allowed to request INTERCEPTED
   *   resolvedUrl  final URL after redirect resolution (P1/P2)
   * @returns {Promise<{verdict:string, reasons:Array, score:number,
   *                    meta:object}>} reasons are plain-language,
   *                    strongest first, already capped to three.
   */
  function analyze(url, context) {
    const ctx = context || {};
    const Url = root.Engine.Url;
    const Domain = root.Engine.Domain;
    const first = Url.analyzeUrl(url, ctx);
    const signals = first.signals.slice();
    let meta = Object.assign({}, first.meta,
      { host: first.host, registrable: first.registrable,
        isIp: Domain.isIpLiteral(first.host) });
    // Shortlinks: judge the resolved destination too, if provided.
    if (ctx.resolvedUrl && ctx.resolvedUrl !== url) {
      const second = Url.analyzeUrl(ctx.resolvedUrl, ctx);
      for (const sig of second.signals) {
        if (sig.signal === 'KNOWN_SHORTENER') continue;
        const dupe = signals.find((s) => s.signal === sig.signal);
        if (!dupe) signals.push(sig);
      }
      meta.resolvedHost = second.host;
    }
    // Score: additive, then clamped for URL-only analysis.
    let score = 0;
    for (const sig of signals) score += sig.weight;
    if (!ctx.escalate) score = Math.min(score, THRESHOLDS.URL_CAP);
    else score = Math.min(score, 100);
    let verdict;
    if (ctx.escalate && ctx.credentials && score >= THRESHOLDS.INTERCEPT) {
      verdict = VERDICT.INTERCEPTED;
    } else if (score >= THRESHOLDS.SECOND_LOOK) {
      verdict = VERDICT.SECOND_LOOK;
    } else {
      verdict = VERDICT.CLEAR;
    }
    // One visible warning per event: top reasons only, plain text.
    const reasons = signals
      .filter((s) => s.weight >= 10)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((s) => s.plainText);
    return Promise.resolve({ verdict, reasons, score, meta });
  }
  root.Engine.analyze = analyze;
  root.Engine.VERDICT = VERDICT;
  root.Engine.THRESHOLDS = THRESHOLDS;
})(globalThis);