/* SecondLook — engine/verdict-engine.js
 * Pure heuristics. No chrome.* calls. Runs in the SW, the popup and
 * content scripts.
 * Contract (unchanged):
 *   Engine.analyze(url, context) -> { verdict, reasons, score, meta }
 *   verdict: 'CLEAR' | 'SECOND_LOOK'   ('INTERCEPTED' is reserved for the
 *   future DNR layer — the engine never claims it.)
 */
(() => {
  'use strict';
  const root = (globalThis.SecondLook = globalThis.SecondLook || {});
  if (root.Engine) return;

  const VERSION = '0.4.0';

  /* ---------- tables ---------- */
  const BRANDS = ['paypal','apple','microsoft','netflix','amazon','google','facebook',
    'instagram','whatsapp','coinbase','binance','kraken','chase','wellsfargo',
    'americanexpress','dhl','fedex','usps','steam','discord','github','linkedin',
    'dropbox','adobe','icloud','outlook','telegram','revolut','hsbc'];

  const BRAND_DOMAINS = new Set(BRANDS.map((b) => b + '.com'));

  const SHORTLINK_HOSTS = new Set(['bit.ly','t.co','tinyurl.com','is.gd','cutt.ly',
    'ow.ly','rebrand.ly','rb.gy','s.id','shorturl.at','lnkd.in','buff.ly','tiny.cc',
    'clc.to','t.ly','bit.do','soo.gd','cur.lv','gg.gg']);

  const FREE_TLDS = new Set(['tk','gq','cf','ml','ga']);

  const RUNTIME_EXTS = ['exe','msi','scr','bat','cmd','jar','apk'];   // weight 2
  const ARCHIVE_EXTS = ['zip','rar','7z','dmg','pkg','deb','rpm'];    // weight 1

  const TORRENT_TOKENS = /torrent|piratebay|1337x|rarbg|kickass|nyaa|eztv|isohunt|limetorrent|torrentgalaxy|yts/i;

  const PIRACY_TOKENS = ['123movies','putlocker','fmovies','solarmovie','primewire',
    'gomovies','gostream','kisscartoon','kissanime','soap2day','yesmovies','watchseries',
    'couchtuner','bflix','vidsrc','streameast','crackstreams','buffstreams'];

  const MULTI_TLDS = new Set(['co.uk','org.uk','ac.uk','com.au','net.au','co.jp',
    'com.br','com.mx','co.in','co.nz','co.za','com.tr','com.ar','com.cn','co.kr']);

  /* ---------- helpers ---------- */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  function deHomoglyph(s) {
    return String(s).replace(/[0]/g, 'o').replace(/[1]/g, 'l').replace(/[3]/g, 'e')
      .replace(/[5]/g, 's').replace(/[7]/g, 't').replace(/[8]/g, 'b').toLowerCase();
  }

  function registrable(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const last2 = labels.slice(-2).join('.');
    if (MULTI_TLDS.has(last2)) return labels.slice(-3).join('.');
    return last2;
  }

  function isShortlinkHost(host) {
    return SHORTLINK_HOSTS.has(registrable(host));
  }

  /* ---------- core ---------- */
  function analyze(inputUrl, context) {
    context = context || {};
    const out = { verdict: 'CLEAR', reasons: [], score: 0, meta: {} };
    const href = inputUrl == null ? '' : String(inputUrl);
    if (!href) return out;

    let u = null;
    try {
      u = context.base ? new URL(href, context.base) : new URL(href);
    } catch (e) {
      out.verdict = 'SECOND_LOOK';
      out.reasons = ['This link could not be read as a normal address.'];
      out.score = 2;
      out.meta.invalid = true;
      return out;
    }

    const sigs = [];
    const add = (w, t) => { if (!sigs.some((s) => s.t === t)) sigs.push({ w, t }); };

    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    const host = u.hostname.toLowerCase();
    out.meta.scheme = scheme;
    out.meta.host = host;

    /* scheme-level signals */
    if (scheme === 'javascript') {
      add(3, 'This link runs code instead of opening a page.');
      out.meta.javascript = true;
    } else if (scheme === 'data') {
      add(3, 'This link carries hidden built-in content (a data: address).');
      out.meta.dataUrl = true;
    } else if (scheme === 'magnet') {
      add(2, 'Magnet/torrent link — the file and its source cannot be checked before you download.');
      out.meta.magnet = true;
    }

    if (host && (scheme === 'http' || scheme === 'https')) {
      const reg = registrable(host);
      out.meta.registrable = reg;
      const regLabels = reg.split('.');
      const core = regLabels[0] || '';
      const coreNorm = deHomoglyph(core.replace(/-/g, ''));
      const tld = regLabels[regLabels.length - 1] || '';

      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
        add(2, 'The address is a raw IP number instead of a name — common in scam links.');
        out.meta.ip = true;
      }
      if (/(^|\.)xn--/.test(host)) {
        add(2, 'The address contains encoded special characters (punycode), which can disguise look-alike names.');
        out.meta.punycode = true;
      }
      if (u.username || u.password) {
        add(2, 'The address contains embedded login details (name:password@site) — a classic phishing trick.');
      }
      if (u.port && u.port !== '80' && u.port !== '443') {
        add(1, 'The address uses an unusual network port (' + u.port + ').');
      }

      /* brand look-alike checks */
      if (!BRAND_DOMAINS.has(reg)) {
        let brandHit = false;
        for (const brand of BRANDS) {
          const d = lev(coreNorm, brand);
          if (d === 0) {
            add(2, 'Uses the "' + brand + '" name, but not the usual "' + brand + '.com" address.');
            out.meta.brand = brand;
            brandHit = true;
            break;
          }
          if (d > 0 && d <= 2 && brand.length >= 5 && coreNorm.length >= 5) {
            add(3, 'This is a near-misspelling of "' + brand + '" (' + core + ') — a common scam trick.');
            out.meta.brand = brand;
            brandHit = true;
            break;
          }
        }
        if (!brandHit) {
          for (const label of host.split('.')) {
            const norm = deHomoglyph(label);
            if (BRANDS.includes(norm)) {
              add(3, 'The "' + norm + '" name sits in an unusual position in this address.');
              out.meta.brand = norm;
              break;
            }
          }
        }
      }

      /* shape anomalies */
      const labels = host.split('.');
      const longest = labels.reduce((a, b) => (b.length > a.length ? b : a), '');
      if (longest.length > 30) {
        add(1, 'Has an unusually long name part (' + longest.length + ' characters) — typical of generated scam domains.');
      }
      if ((core.match(/-/g) || []).length >= 4) {
        add(1, 'Has many hyphens jammed together — typical of generated scam domains.');
      }

      /* TLD signals */
      if (tld === 'zip' || tld === 'mov') {
        add(2, 'Ends in ".' + tld + '" — file-type look-alike endings are a recent phishing trick.');
      } else if (FREE_TLDS.has(tld)) {
        add(1, 'Ends in ".' + tld + '", a free registry often used by short-lived scam sites.');
      }

      /* shorteners */
      if (SHORTLINK_HOSTS.has(reg)) {
        add(1, 'Shortened link — the real destination stays hidden until you commit.');
        out.meta.shortlink = true;
      }

      /* torrent / piracy */
      if (TORRENT_TOKENS.test(host)) {
        add(2, 'Torrent-related address — files from these sources cannot be verified before download.');
        out.meta.torrent = true;
      }
      if (/\.torrent$/i.test(u.pathname)) {
        add(2, 'Points straight at a .torrent file — the download and its source cannot be verified.');
        out.meta.torrent = true;
      }
      const piracyHit = PIRACY_TOKENS.some((t) => host.includes(t)) ||
        (/(movie|film|series|stream)/.test(core) && /(free|full|hd|123|online)/.test(core));
      if (piracyHit) {
        add(2, 'Matches patterns of unlicensed streaming sites — the content is most likely pirated.');
        out.meta.piracy = true;
      }

      /* insecure + login */
      if (scheme === 'http') {
        const pathQ = (u.pathname + u.search).toLowerCase();
        if (/(login|signin|sign-in|verify|account|password|credential|wallet|seed)/.test(pathQ)) {
          add(2, 'Asks for sign-in details but does not use a secure HTTPS connection.');
        } else {
          add(1, 'The connection is plain http — anything you send can be read on the way.');
        }
      }
    }

    /* path-level: downloadable files */
    const ext = (u.pathname.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    if (ext) {
      const e = ext.toLowerCase();
      if (RUNTIME_EXTS.includes(e)) {
        out.meta.file = e;
        add(2, 'Downloads a ".' + e + '" file — make sure you trust the source before opening it.');
      } else if (ARCHIVE_EXTS.includes(e)) {
        out.meta.file = e;
        add(1, 'Downloads a ".' + e + '" archive — make sure you trust the source before opening it.');
      }
    }

    /* link-text signals */
    const text = typeof context.text === 'string' ? context.text.trim() : '';
    if (text) {
      out.meta.text = text.slice(0, 80);
      if (/[\u200B-\u200D\uFEFF\u2060]/.test(text)) {
        add(2, 'The visible link text contains invisible characters — the real destination may be disguised.');
      }
      const claimed = (text.match(/\b([a-z0-9-]{2,}\.(?:com|net|org|io|co|de|uk|ru))\b/i) || [])[1];
      if (claimed && out.meta.registrable) {
        const c = claimed.toLowerCase();
        const r = out.meta.registrable;
        const ok = c === r || r.endsWith('.' + c) || c.endsWith('.' + r);
        if (!ok) {
          add(3, 'The link text says "' + c + '" but it actually goes to "' + r + '".');
        }
      }
    }

    sigs.sort((a, b) => b.w - a.w);
    out.reasons = sigs.map((s) => s.t);
    out.score = sigs.reduce((n, s) => n + s.w, 0);
    out.verdict = out.score > 0 ? 'SECOND_LOOK' : 'CLEAR';
    return out;
  }

  root.Engine = { VERSION, analyze, registrable, isShortlinkHost, BRANDS };
})();