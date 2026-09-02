/* engine/url-analyzer.js - weighted signal extraction for one URL. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  root.Engine = root.Engine || {};
  if (root.Engine.Url) return;
  /* All weights are named constants - the tuning knobs of the engine.
   * Any single URL-only combination must stay below the engine's
   * URL_CAP (39) so pure URL shape can never trigger INTERCEPTED. */
  const SIGNAL_WEIGHTS = {
    PUNYCODE_IDN: 45,
    BRAND_TYPO: 40,
    BRAND_IN_SUBDOMAIN: 30,
    INVISIBLE_CHARS: 50,
    MAGNET_LINK: 30,
    TORRENT_FILE: 30,
    PIRACY_MEDIA: 24,
    IP_LITERAL: 30,
    USERINFO_URL: 25,
    NONSTD_PORT: 15,
    SUSPICIOUS_KEYWORD: 15,
    SUSPICIOUS_TLD: 12,
    DEEP_SUBDOMAINS: 12,
    HYPHEN_STUFFED: 10,
    LONG_RANDOM_LABEL: 10,
    KNOWN_SHORTENER: 10,
    PLAIN_HTTP: 8
  };
  const SUSPICIOUS_TLDS = [
    'zip', 'mov', 'top', 'gq', 'tk', 'cf', 'ml', 'ga', 'work', 'click',
    'link', 'country', 'stream', 'download', 'loan', 'review', 'icu',
    'cam', 'rest', 'bs'
  ];
  const SHORTENERS = [
    'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'cutt.ly', 'shorturl.at',
    'rebrand.ly', 'buff.ly', 'ow.ly', 's.id', 'v.gd', 'rb.gy', 'tiny.cc',
    'shrtco.de', 't.ly', 'soo.gd', 'clck.ru', 'shorte.st', 'gg.gg',
    'short.gy', 'budurl.com', 'qr.ae'
  ];
  /* Torrent / unlicensed-media hints. Wording stays neutral on purpose:
   * the engine says "looks like", never "this is illegal". */
  const PIRACY_DOMAINS = new Set([
    'thepiratebay.org', '1337x.to', '1337x.st', 'yts.mx', 'yts.lt',
    'rarbg.to', 'rarbg.is', 'eztv.re', 'eztv.it', 'limetorrents.info',
    'torrentgalaxy.to', 'katcr.to', 'fmovies.to', 'fmovies.wtf',
    'putlocker.to', 'putlockers.net', 'soap2day.to', 'soap2day.rs',
    'solarmovie.to', '123movies.net', 'cineb.net', 'openload.co',
    'rapidgator.net', 'sendspace.com'
  ]);
  const PIRACY_KEYWORDS = [
    'torrent', 'magnet', 'warez', 'cracked', 'pirate', 'piracy',
    '123movies', 'putlocker', 'soap2day', 'solarmovie', 'watchfree',
    'freemovie', 'freemovies', 'fullmovie', 'hdfull', 'cineb', 'fmovies',
    'watchseries', 'subscene', 'yts', '1337x', 'thepiratebay', 'eztv',
    'openload', 'rarbg', 'extratorrent'
  ];
  const HARVEST_KEYWORDS = [
    'login', 'signin', 'verify', 'verification', 'secure', 'account',
    'update', 'confirm', 'recovery', 'wallet', 'billing', 'invoice',
    'password', 'support'
  ];
  /* Zero-width + bidi control characters that can disguise link text
   * or hostnames when rendered. Checked in both display text and URL. */
  const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
  function analyzeUrl(url, context) {
    const ctx = context || {};
    const signals = [];
    const add = (signal, plainText) => signals.push({
      signal, weight: SIGNAL_WEIGHTS[signal] || 0, plainText
    });
    let u = null;
    try { u = new URL(url); } catch (e) {
      add('PUNYCODE_IDN', 'This is not a well-formed address.');
      return { signals, host: '', registrable: '', meta: { parsed: false } };
    }
    const host = (u.hostname || '').toLowerCase();
    const D = root.Engine.Domain, B = root.Engine.Brands;
    const registrable = D.eTLDPlus1(host);
    const regLabel = D.registrableLabel(host);
    const labels = D.splitHost(host);
    // 0. torrent / unlicensed-media hints. Neutral wording on purpose:
    //    the engine flags a "second look", never asserts illegality.
    if (u.protocol === 'magnet:') {
      add('MAGNET_LINK',
          'This is a torrent magnet link - it starts a peer-to-peer ' +
          'download of untrusted content.');
    } else if (/\.torrent(?:\/|$)/i.test(u.pathname || '')) {
      add('TORRENT_FILE',
          'This points to a .torrent file - a peer-to-peer download of ' +
          'potentially unlicensed content.');
    }
    if (!D.isIpLiteral(host)) {
      const mediaText = (host + ' / ' + (u.pathname || '')).toLowerCase();
      if (PIRACY_DOMAINS.has(registrable)) {
        add('PIRACY_MEDIA',
            'This site is commonly associated with torrenting or ' +
            'unlicensed streaming.');
      } else if (PIRACY_KEYWORDS.some((kw) => mediaText.includes(kw))) {
        add('PIRACY_MEDIA',
            'This address looks like it points to torrenting or ' +
            'unlicensed media.');
      }
    }
    // 1. punycode / non-ASCII host
    if (host.startsWith('xn--') || labels.some((l) => l.startsWith('xn--')) ||
        /[^\x00-\x7f]/.test(host)) {
      add('PUNYCODE_IDN',
          'The address contains encoded characters that can be used ' +
          'to imitate real sites.');
    }
    // 2. typo-squat of a known brand. DEVIATION from guide: also try
    // hyphen-split tokens, so 'paypa1-secure-login.com' (the guide's
    // own 0.14 demo URL) actually yields the typo-squat reason the
    // guide promises instead of only the keyword signal.
    if (!D.isIpLiteral(host) && !B.isOfficialDomain(registrable)) {
      let typo = B.typoBrandFor(regLabel);
      if (!typo && regLabel.includes('-')) {
        for (const token of regLabel.split('-')) {
          if (token.length < 4) continue;
          typo = B.typoBrandFor(token);
          if (typo) break;
        }
      }
      if (typo) {
        add('BRAND_TYPO', 'Looks similar to ' + typo.brand +
            '.com - the official domain is ' + typo.domains[0] + '.');
      }
    }
    // 3. brand name parked in a subdomain of someone else. DEVIATION
    // from guide: skip the registrable domain's own labels (could be
    // 3 for co.uk-style hosts), not always exactly two.
    if (!B.isOfficialDomain(registrable)) {
      const regLabelCount = registrable.split('.').length;
      for (const label of labels.slice(0, -regLabelCount)) {
        const exact = B.brandForToken(label);
        if (exact) {
          add('BRAND_IN_SUBDOMAIN', 'Uses \'' + exact.brand +
              '\' in the subdomain, but the site is really ' +
              registrable + '.');
          break;
        }
      }
    }
    // 4. invisible characters in display text (spec: text vs href)
    if (ctx.displayText && INVISIBLE_RE.test(ctx.displayText)) {
      add('INVISIBLE_CHARS',
          'The visible link text contains invisible characters that ' +
          'can disguise where it leads.');
    }
    // 5. raw IP host
    if (D.isIpLiteral(host)) {
      add('IP_LITERAL',
          'Points to a raw numeric address instead of a named website.');
    }
    // 6. userinfo trick - http://paypal.com@evil.example/
    if (u.username || u.password) {
      add('USERINFO_URL',
          'Everything before the \'@\' in this address is decoration; ' +
          'the real destination is after it.');
    }
    // 7. unusual port
    const port = u.port ? Number(u.port) : null;
    if (port && port !== 80 && port !== 443 && port !== 8080) {
      add('NONSTD_PORT', 'Uses an unusual port number (' + port + ').');
    }
    // 8. keyword-stuffed registrable label
    if (!D.isIpLiteral(host)) {
      for (const kw of HARVEST_KEYWORDS) {
        if (regLabel.includes(kw) && regLabel !== kw) {
          add('SUSPICIOUS_KEYWORD', 'The domain name contains \'' + kw +
              '\', typical of credential-harvesting sites.');
          break;
        }
      }
    }
    // 9. TLD reputation
    const tld = labels[labels.length - 1];
    if (SUSPICIOUS_TLDS.includes(tld)) {
      add('SUSPICIOUS_TLD',
          'Uses the .' + tld + ' ending, which is common in scam sites.');
    }
    // 10. subdomain depth
    if (D.subdomainDepth(host) >= 4) {
      add('DEEP_SUBDOMAINS',
          'Unusually deep subdomains can imitate official site names.');
    }
    // 11. hyphen stuffing
    if (D.hyphenCount(regLabel) >= 3) {
      add('HYPHEN_STUFFED',
          'The domain name packs together many dashes, a disguise pattern.');
    }
    // 12. machine-generated label
    if (D.looksMachineGenerated(regLabel)) {
      add('LONG_RANDOM_LABEL',
          'The domain name looks machine-generated rather than human-named.');
    }
    // 13. shortener
    if (SHORTENERS.includes(registrable)) {
      add('KNOWN_SHORTENER',
          'Shortened link - its destination is not shown.');
    }
    // 14. plain http
    if (u.protocol === 'http:') {
      add('PLAIN_HTTP', 'The connection is not encrypted (http).');
    }
    return {
      signals,
      host, registrable,
      meta: {
        parsed: true, protocol: u.protocol.replace(':', ''),
        isShortener: SHORTENERS.includes(registrable),
        port, labels
      }
    };
  }
  root.Engine.Url = { SIGNAL_WEIGHTS, analyzeUrl, SHORTENERS };
})(globalThis);