/* engine/domain-intel.js - registrable domains + host shape helpers. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  root.Engine = root.Engine || {};
  if (root.Engine.Domain) return;
  /* Curated multi-label public suffixes (subset of the PSL).
   * Single-label TLDs (com, net, org, io, ...) need no entry here. */
  const MULTI_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk',
    'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'co.za', 'org.za', 'net.za', 'web.za', 'gov.za',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
    'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
    'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
    'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
    'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
    'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in',
    'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
    'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
    'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il',
    'com.ru', 'net.ru', 'org.ru',
    'co.kr', 'or.kr', 'ne.kr', 'go.kr',
    'com.vn', 'net.vn', 'org.vn', 'gov.vn',
    'com.ph', 'net.ph', 'org.ph',
    'com.co', 'net.co', 'org.co', 'gov.co',
    'com.pe', 'org.pe', 'net.pe', 'gob.pe',
    'com.ve', 'net.ve', 'org.ve', 'gob.ve',
    'com.eg', 'net.eg', 'org.eg', 'gov.eg',
    'com.sa', 'net.sa', 'org.sa', 'gov.sa',
    'com.ae', 'net.ae', 'org.ae', 'gov.ae',
    'com.qa', 'net.qa', 'org.qa', 'gov.qa',
    'com.kw', 'net.kw', 'org.kw',
    'com.pk', 'net.pk', 'org.pk', 'gov.pk',
    'com.bd', 'net.bd', 'org.bd',
    'com.ng', 'net.ng', 'org.ng', 'gov.ng',
    'co.ke', 'or.ke', 'go.ke', 'ac.ke',
    'com.gh', 'org.gh', 'gov.gh',
    'com.th', 'net.th', 'org.th', 'go.th',
    'co.th', 'in.th', 'or.th', 'go.th'
  ]);
  function splitHost(hostname) {
    return String(hostname || '').toLowerCase().replace(/\.$/, '').split('.');
  }
  /** eTLD+1: 'login.paypal.co.uk' -> 'paypal.co.uk'. Falls back to the
   *  full host when nothing matches (single-label or odd TLD). */
  function eTLDPlus1(hostname) {
    const labels = splitHost(hostname);
    if (labels.length <= 2) return labels.join('.');
    // longest matching multi-label suffix wins
    // DEVIATION from guide: loop starts at take=2, because entries
    // like 'co.uk' are TWO labels; with take=3 the whole suffix set
    // was dead code and eTLD+1 fell through to the last-2 fallback.
    for (let take = 2; take <= Math.min(labels.length, 5); take++) {
      const suffix = labels.slice(-take).join('.');
      if (MULTI_SUFFIXES.has(suffix)) {
        return labels.slice(-(take + 1)).join('.');
      }
    }
    return labels.slice(-2).join('.');
  }
  /** The brand-carrying label of the registrable domain. */
  function registrableLabel(hostname) {
    const reg = eTLDPlus1(hostname);
    return reg.split('.')[0] || reg;
  }
  function isIpLiteral(host) {
    if (!host) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;       // IPv4
    if (host.startsWith('[') && host.endsWith(']')) return true; // IPv6
    if (host.includes(':') && host.includes('::')) return true;  // bare IPv6
    return false;
  }
  /** Labels to the left of the registrable domain. */
  function subdomainDepth(hostname) {
    const labels = splitHost(hostname);
    const regLabels = eTLDPlus1(hostname).split('.').length;
    return Math.max(0, labels.length - regLabels);
  }
  function hyphenCount(str) {
    return (String(str).match(/-/g) || []).length;
  }
  /** Heuristic for DGA-style labels: long + almost vowel-free. */
  function looksMachineGenerated(label) {
    if (!label || label.length < 13) return false;
    const vowels = (label.match(/[aeiou]/g) || []).length;
    return vowels / label.length < 0.30;
  }
  root.Engine.Domain = {
    MULTI_SUFFIXES, splitHost, eTLDPlus1, registrableLabel,
    isIpLiteral, subdomainDepth, hyphenCount, looksMachineGenerated
  };
})(globalThis);