/* ============================================================
   SecondLook — engine/url-analyzer.js  (v1.2)
   WHAT'S NEW
   - P2P / torrent signals: magnet: links, .torrent files,
     tracker announce params, known piracy-associated domains.
   - Release-tag keywords (webrip / 1080p+movie hints / keygen...)
   - meta.facts: neutral "more info about this link" lines the
     pill renders under the reasons (host, file type, params...).
   - meta.tags: risk categories for future modules.
   DESIGN INVARIANT (unchanged): URL-only scoring is capped at
   39, below INTERCEPTED_MIN (40). Link analysis NEVER escalates
   to a red INTERCEPTED verdict — links are looked at, never
   blocked. INTERCEPTED stays reserved for Form Guardian and
   Download Guard via context.escalate.
   Pure, synchronous, on-device. No network, no eval.
   Classic script — attaches to globalThis.SL (works in content
   scripts, the service worker via importScripts, and pages).
   ============================================================ */
(function () {
  'use strict';

  const root = (typeof globalThis !== 'undefined') ? globalThis : window;
  root.SL = root.SL || {};

  /* ---------------- Tuning knobs ---------------- */
  const WEIGHTS = {
    PUNYCODE: 30,
    LOOKALIKE_BRAND: 28,
    BRAND_IN_SUBDOMAIN: 24,
    IP_HOST: 26,
    ODD_PORT: 14,
    USERINFO: 26,
    INVISIBLE_CHARS: 32,
    SHORT_LINK: 16,
    HTTP: 14,
    SUSPICIOUS_TLD: 16,
    DEEP_SUBDOMAINS: 12,
    HOST_NOISE: 10,
    MAGNET_LINK: 26,
    TORRENT_FILE: 24,
    TRACKER_ANNOUNCE: 10,
    PIRACY_DOMAIN: 30,
    PIRACY_KEYWORD: 18,
    EXECUTABLE_FILE: 10
  };

  const SCORE_CAP = 39;              // keep below VerdictEngine's INTERCEPTED_MIN (40)
  const SUBDOMAIN_DEPTH_LIMIT = 3;   // more stacked subdomains than this -> signal
  const LOOKALIKE_DISTANCE = 2;      // Damerau-Levenshtein distance vs known brands
  const MIN_BRAND_LABEL = 4;         // ignore ultra-short brand labels (fp noise)
  const QUERY_PARAM_FACT_AT = 4;     // mention query params at/above this count

  /* Domains whose eTLD+1 (or a close label prefix) is commonly associated
     with pirated media or software. HEURISTIC — extend freely, these churn.
     Never a legal claim, only "deserves a second look". */
  const PIRACY_DOMAINS = [
    'thepiratebay.org', 'piratebay.live', '1337x.to', '1337x.st', 'x1337x.ws',
    'rarbg.to', 'rarbgmirror.org', 'yts.mx', 'yts.lt', 'yts.am',
    'eztv.re', 'eztv.wf', 'kickass.sx', 'kickasstorrents.to',
    'limetorrents.info', 'limetorrents.lol', 'torrentz2.eu', 'torlock.com',
    'torrentgalaxy.to', 'nyaa.si', 'rutracker.org', 'zamunda.net',
    '123movies.to', '123moviesfree.net', 'fmovies.wtf', 'fmoviesz.to',
    'sflix.to', 'lookmovie.io', 'hurawatch.pro', 'putlocker.vip',
    '9anime.to', 'gogoanime.fi',
    'getintopc.com', 'igggames.com', 'skidrowcodex.net', 'skidrow-games.com',
    'fitgirl-repacks.site', 'dodi-repacks.site'
  ];

  /* Release/crack tags that are piracy-typical on their own. */
  const PIRACY_KEYWORDS_STRONG = [
    'torrent', 'webrip', 'web-dl', 'brrip', 'dvdrip', 'hdrip', 'hdcam',
    'camrip', 'dvdscr', 'full-movie', 'fullmovie', 'watch-free',
    'free-movie', 'freemovie', 'cracked', 'keygen', 'nulled',
    'preactivated', 'pre-activated', 'kms-activator', 'serial-key',
    'torrent-download'
  ];

  /* Quality tags only count when a movie/software hint co-occurs
     (avoids flagging "1080p webcam" product pages). */
  const VIDEO_QUALITY_TAGS = ['720p', '1080p', '2160p', 'bluray', 'blu-ray', 'screener'];
  const MEDIA_HINTS = [
    'movie', 'film', 'series', 'episode', 'season', 'watch', 'stream',
    'free', 'download', 'online', 'repack'
  ];

  /* Sites that legitimately discuss torrents/piracy — keyword scan
     is skipped for links pointing at them. */
  const KEYWORD_EXEMPT_DOMAINS = [
    'wikipedia.org', 'torrentfreak.com', 'stackoverflow.com',
    'stackexchange.com', 'archive.org', 'reddit.com', 'mozilla.org'
  ];

  const SHORTLINK_DOMAINS = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly',
    'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 't.ly', 'tiny.cc',
    'lnkd.in', 's.id'
  ];

  const SUSPICIOUS_TLDS = [
    'zip', 'mov', 'top', 'xyz', 'cyou', 'icu', 'click', 'link', 'rest',
    'fit', 'cam', 'gq', 'tk', 'ml', 'cf', 'work', 'buzz'
  ];

  const EXECUTABLE_EXTENSIONS = [
    'exe', 'msi', 'scr', 'bat', 'cmd', 'com', 'pif', 'jar', 'apk',
    'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'vbs', 'ps1'
  ];

  const TWO_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk',
    'com.au', 'net.au', 'org.au',
    'co.nz', 'net.nz', 'org.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
    'co.kr', 'com.br', 'com.mx', 'com.ar',
    'co.in', 'net.in', 'org.in',
    'co.za', 'com.sg', 'com.hk', 'com.tr',
    'com.cn', 'com.tw', 'com.my', 'co.id', 'com.ph', 'com.vn'
  ]);

  const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

  /* ---------------- small helpers ---------------- */

  function safeUrl(href, base) {
    try { return new URL(href, base || undefined); } catch (_) { return null; }
  }

  function etldPlus1(host) {
    const h = String(host || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return h;
    const last2 = parts[parts.length - 2] + '.' + parts[parts.length - 1];
    if (TWO_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
    return last2;
  }

  function isIpHost(host) {
    const h = String(host || '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;                       // IPv4
    return h.startsWith('[') || (/^[0-9a-f:]+$/i.test(h) && h.includes(':')); // IPv6-ish
  }

  function fileExt(pathname) {
    const m = /\/[^/]*\.([A-Za-z0-9]{1,5})$/.exec(String(pathname || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function decodeSafe(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  /* Damerau-Levenshtein (optimal string alignment) with a distance cap. */
  function damerau(a, b, cap) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    const INF = cap + 1;
    if (Math.abs(la - lb) > cap) return INF;
    const d = new Array(la + 1);
    for (let i = 0; i <= la; i++) {
      d[i] = new Array(lb + 1);
      d[i][0] = i;
    }
    for (let j = 0; j <= lb; j++) d[0][j] = j;
    for (let i = 1; i <= la; i++) {
      let rowMin = INF;
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + 1);
        }
        d[i][j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > cap) return INF; // bail out early — already too far
    }
    return d[la][lb] > cap ? INF : d[la][lb];
  }

  /* known-brands.js shipped in Part 0 — read it defensively so this file
     works no matter which list shape is registered alongside it. */
  function knownBrandDomains() {
    const kb = root.SL && root.SL.KnownBrands;
    const out = [];
    const pushDomain = (d) => {
      if (typeof d === 'string' && d.indexOf('.') > 0) out.push(d.toLowerCase());
    };
    const pushEntry = (x) => {
      if (typeof x === 'string') pushDomain(x);
      else if (x && Array.isArray(x.domains)) x.domains.forEach(pushDomain);
      else if (x && typeof x.domain === 'string') pushDomain(x.domain);
    };
    if (Array.isArray(kb)) {
      kb.forEach(pushEntry);
    } else if (kb && typeof kb === 'object') {
      ['domains', 'list', 'DATABASE', 'entries', 'data'].forEach((key) => {
        if (Array.isArray(kb[key])) kb[key].forEach(pushEntry);
      });
      if (typeof kb.getDomains === 'function') {
        try {
          const r = kb.getDomains();
          if (Array.isArray(r)) r.forEach(pushEntry);
        } catch (_) { /* fall through */ }
      }
    }
    return out;
  }

  function parseMagnetParams(u) {
    const raw = String(u.href || '').replace(/^magnet:\??/i, '');
    const xt = [], tr = [];
    let dn = '';
    for (const pair of raw.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).toLowerCase();
      const v = decodeSafe(pair.slice(eq + 1));
      if (k === 'xt') xt.push(v);
      else if (k === 'dn') dn = v;
      else if (k === 'tr') tr.push(v);
    }
    return { xt, dn, tr };
  }

  /* True when the link's eTLD+1 equals a listed domain, or its main label
     starts with one ("123moviesfree" catches "123movies"). */
  function matchesPiracyDomain(etld) {
    if (!etld) return null;
    const label = etld.split('.')[0];
    for (const entry of PIRACY_DOMAINS) {
      if (etld === entry) return entry;
      const entryLabel = entry.split('.')[0];
      if (entryLabel.length >= 6 && label.indexOf(entryLabel) === 0) return entry;
    }
    return null;
  }

  /* ---------------- the analyzer ---------------- */

  /**
   * Score a URL and collect human-readable reasons + neutral facts.
   * @param {string} url - Target href (absolute, or resolvable via context.baseUrl).
   * @param {{linkText?: string, baseUrl?: string, source?: string}} [context]
   * @returns {{score: number, reasons: Array<{signal: string, weight: number, plainText: string}>, meta: {host: string, etld1: string, scheme: string, ext: string, tags: string[], facts: string[], isMagnet: boolean}}}
   */
  function analyze(url, context) {
    context = context || {};
    const reasons = [];
    const facts = [];
    const tags = [];
    let score = 0;

    const add = (signal, weight, plain) => {
      reasons.push({ signal: signal, weight: weight, plainText: plain });
      score += weight;
    };
    const fact = (t) => { facts.push(t); };
    const tag = (t) => { if (tags.indexOf(t) < 0) tags.push(t); };

    const linkText = String(context.linkText || '');
    const u = safeUrl(url, context.baseUrl);

    if (!u) {
      return { score: 0, reasons: [], meta: { host: '', etld1: '', scheme: '', ext: '', tags: [], facts: [], isMagnet: false } };
    }

    const scheme = u.protocol.replace(':', '').toLowerCase();
    const finish = (extraMeta) => {
      reasons.sort((a, b) => b.weight - a.weight);
      const meta = {
        host: host || '',
        etld1: etld || '',
        scheme: scheme,
        ext: ext || '',
        tags: tags,
        facts: facts,
        isMagnet: scheme === 'magnet'
      };
      if (extraMeta) Object.assign(meta, extraMeta);
      return { score: Math.min(score, SCORE_CAP), reasons: reasons, meta: meta };
    };

    let host = '';
    let etld = '';
    let ext = '';

    /* ---- magnet: peer-to-peer ---- */
    if (scheme === 'magnet') {
      const params = parseMagnetParams(u);
      add('MAGNET_LINK', WEIGHTS.MAGNET_LINK,
        'Peer-to-peer (magnet) link — the file comes from other people\u2019s computers, not from a website.');
      tag('p2p');
      tag('magnet');
      if (params.dn) {
        fact('Shared file: ' + truncate(params.dn, 64));
        const dnLower = ' ' + params.dn.toLowerCase() + ' ';
        if (PIRACY_KEYWORDS_STRONG.some((k) => dnLower.indexOf(k) >= 0)) {
          add('PIRACY_KEYWORD', WEIGHTS.PIRACY_KEYWORD,
            'The shared file name is tagged like a pirated release.');
          tag('piracy');
        } else {
          const q = VIDEO_QUALITY_TAGS.find((k) => dnLower.indexOf(k) >= 0);
          if (q) fact('File name looks like a video release (' + q + ').');
        }
      }
      if (params.tr.length) {
        add('TRACKER_ANNOUNCE', WEIGHTS.TRACKER_ANNOUNCE,
          'Coordinates the download through ' + params.tr.length +
          ' tracker' + (params.tr.length === 1 ? '' : 's') + '.');
        fact(params.tr.length + ' tracker' + (params.tr.length === 1 ? '' : 's') + ' listed');
        tag('p2p');
      }
      if (params.xt.length) {
        fact('Info hash: ' + truncate(params.xt[0].replace(/^urn:btih:/i, ''), 20));
      }
      return finish();
    }

    /* ---- other non-http schemes: nothing to judge, just identify ---- */
    if (scheme !== 'http' && scheme !== 'https') {
      fact('Link type: ' + scheme);
      return finish();
    }

    /* ---- http(s) ---- */
    host = (u.hostname || '').toLowerCase();
    etld = etldPlus1(host);
    const hostLabels = host.split('.').filter(Boolean);
    const etldLabels = etld.split('.').filter(Boolean);
    const mainLabel = etldLabels[0] || '';
    const subCount = hostLabels.length - etldLabels.length;
    ext = fileExt(u.pathname);

    if (scheme === 'http') {
      add('HTTP', WEIGHTS.HTTP, 'Not a secure (https) connection.');
    }

    if (host.indexOf('xn--') >= 0) {
      add('PUNYCODE', WEIGHTS.PUNYCODE,
        'The domain contains non-Latin characters written in a coded form (punycode) — a common brand-imitation trick.');
      tag('idn');
    }

    if (isIpHost(host)) {
      add('IP_HOST', WEIGHTS.IP_HOST,
        'Points at a raw numeric address instead of a domain name.');
      tag('ip');
    } else {
      /* brand lookalike / brand-in-subdomain (needs known-brands.js) */
      const brands = knownBrandDomains();
      let isKnownExact = false;
      for (let i = 0; i < brands.length; i++) {
        if (etldPlus1(brands[i]) === etld) { isKnownExact = true; break; }
      }
      if (!isKnownExact && brands.length) {
        for (let i = 0; i < brands.length; i++) {
          const bLabel = etldPlus1(brands[i]).split('.')[0];
          if (!bLabel || bLabel.length < MIN_BRAND_LABEL) continue;
          if (mainLabel === bLabel) continue;
          if (damerau(mainLabel, bLabel, LOOKALIKE_DISTANCE) <= LOOKALIKE_DISTANCE) {
            add('LOOKALIKE_BRAND', WEIGHTS.LOOKALIKE_BRAND,
              'The domain \u201C' + mainLabel + '\u201D looks one or two letters off from \u201C' + bLabel + '\u201D.');
            tag('lookalike');
            break;
          }
        }
        if (subCount > 0) {
          for (let i = 0; i < brands.length; i++) {
            const bLabel = etldPlus1(brands[i]).split('.')[0];
            if (bLabel && bLabel.length >= 5 && hostLabels.indexOf(bLabel) >= 0) {
              add('BRAND_IN_SUBDOMAIN', WEIGHTS.BRAND_IN_SUBDOMAIN,
                'A brand name (\u201C' + bLabel + '\u201D) is in a subdomain, but the site is really ' + etld + '.');
              tag('lookalike');
              break;
            }
          }
        }
        const digits = (mainLabel.match(/[0-9]/g) || []).length;
        const hyphens = (mainLabel.match(/-/g) || []).length;
        if (digits / Math.max(mainLabel.length, 1) > 0.35 || hyphens >= 3) {
          add('HOST_NOISE', WEIGHTS.HOST_NOISE,
            'The domain name mixes digits and hyphens unusually.');
        }
      }
    }

    if (u.username || u.password) {
      add('USERINFO', WEIGHTS.USERINFO,
        'Carries a \u201Cuser@\u201D prefix — a classic disguise trick; the real destination is what follows the @.');
      tag('userinfo');
    }

    const port = u.port;
    if (port && port !== '80' && port !== '443') {
      add('ODD_PORT', WEIGHTS.ODD_PORT, 'Uses a non-standard port (' + port + ').');
      fact('Port ' + port);
    }

    if (SHORTLINK_DOMAINS.indexOf(etld) >= 0) {
      add('SHORT_LINK', WEIGHTS.SHORT_LINK,
        'Shortened link — the real destination is hidden behind a redirect.');
      tag('shortlink');
    }

    const tld = etldLabels.length ? etldLabels[etldLabels.length - 1] : '';
    if (SUSPICIOUS_TLDS.indexOf(tld) >= 0) {
      add('SUSPICIOUS_TLD', WEIGHTS.SUSPICIOUS_TLD,
        'Ends in \u201C.' + tld + '\u201D, a suffix common on throwaway sites.');
    }

    if (subCount > SUBDOMAIN_DEPTH_LIMIT) {
      add('DEEP_SUBDOMAINS', WEIGHTS.DEEP_SUBDOMAINS,
        'Stacks ' + subCount + ' subdomain levels — names like \u201Csecure-login\u201D mean nothing.');
    }

    /* piracy-associated domain? (independent of keyword exemptions) */
    const piracyHit = matchesPiracyDomain(etld);
    if (piracyHit) {
      add('PIRACY_DOMAIN', WEIGHTS.PIRACY_DOMAIN,
        'This site is commonly associated with pirated movies, shows, or software.');
      tag('piracy');
    }

    /* torrent descriptor file */
    if (ext === 'torrent') {
      add('TORRENT_FILE', WEIGHTS.TORRENT_FILE,
        'Downloads a .torrent file — it pulls content from peer-to-peer networks.');
      tag('p2p');
      tag('torrent');
    }

    /* release-tag keywords in path / query / visible text */
    const keywordExempt = KEYWORD_EXEMPT_DOMAINS.some((d) => etld === d || etld.endsWith('.' + d));
    if (!keywordExempt) {
      const haystack = (u.pathname + ' ' + (u.search || '') + ' ' + linkText).toLowerCase();
      const strong = PIRACY_KEYWORDS_STRONG.filter((k) => haystack.indexOf(k) >= 0);
      if (strong.length) {
        add('PIRACY_KEYWORD', WEIGHTS.PIRACY_KEYWORD,
          'Words like \u201C' + strong.slice(0, 2).join('\u201D, \u201C') + '\u201D are typical of pirated media or cracked software.');
        tag('piracy');
      } else {
        const q = VIDEO_QUALITY_TAGS.find((k) => haystack.indexOf(k) >= 0);
        if (q && MEDIA_HINTS.some((h) => haystack.indexOf(h) >= 0)) {
          add('PIRACY_KEYWORD', WEIGHTS.PIRACY_KEYWORD,
            'A \u201C' + q + '\u201D video-release tag together with watch/download wording.');
          tag('piracy');
        } else if (q) {
          fact('Named like a video release (' + q + ').');
        }
      }
    }

    /* invisible characters hidden in the visible text */
    const invisible = (linkText.match(INVISIBLE_RE) || []).length;
    if (invisible > 0) {
      add('INVISIBLE_CHARS', WEIGHTS.INVISIBLE_CHARS,
        'The visible link text hides ' + invisible + ' invisible character' +
        (invisible === 1 ? '' : 's') + ' — what you see is not exactly what is there.');
      tag('invisible');
    }

    /* executable / installer targets */
    if (EXECUTABLE_EXTENSIONS.indexOf(ext) >= 0) {
      add('EXECUTABLE_FILE', WEIGHTS.EXECUTABLE_FILE,
        'Points straight at a program or installer file (.' + ext + ').');
      tag('executable');
    }

    /* ---- neutral facts ("more info about this link") ---- */
    if (host && host !== etld) fact('Full host: ' + host);
    if (subCount >= 2) fact(subCount + ' subdomain levels under ' + etld);
    if (ext && ext !== 'torrent') fact('File type: .' + ext);
    const queryCount = u.search
      ? u.search.slice(1).split('&').filter(Boolean).length : 0;
    if (queryCount >= QUERY_PARAM_FACT_AT) fact(queryCount + ' query parameters attached');

    return finish();
  }

  root.SL.UrlAnalyzer = { analyze: analyze, WEIGHTS: WEIGHTS };
})();