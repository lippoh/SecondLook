/* engine/known-brands.js - brand tokens + official domains.
 * Reference data for typo-squat detection. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  root.Engine = root.Engine || {};
  if (root.Engine.Brands) return;
  function b(brand, ...domains) { return { brand, domains }; }
  const KNOWN_BRANDS = [
    b('google', 'google.com', 'youtube.com', 'googleapis.com'),
    b('apple', 'apple.com', 'icloud.com'),
    b('microsoft', 'microsoft.com', 'live.com', 'office.com'),
    b('outlook', 'outlook.com'),
    b('bing', 'bing.com'),
    b('paypal', 'paypal.com'),
    b('ebay', 'ebay.com'),
    b('amazon', 'amazon.com', 'amzn.to'),
    b('alibaba', 'alibaba.com'),
    b('aliexpress', 'aliexpress.com'),
    b('temu', 'temu.com'),
    b('shein', 'shein.com'),
    b('wish', 'wish.com'),
    b('facebook', 'facebook.com', 'fb.com'),
    b('instagram', 'instagram.com'),
    b('whatsapp', 'whatsapp.com'),
    b('meta', 'meta.com'),
    b('threads', 'threads.net'),
    b('twitter', 'twitter.com', 'x.com'),
    b('tiktok', 'tiktok.com'),
    b('snapchat', 'snapchat.com'),
    b('pinterest', 'pinterest.com'),
    b('reddit', 'reddit.com'),
    b('tumblr', 'tumblr.com'),
    b('twitch', 'twitch.tv'),
    b('discord', 'discord.com', 'discord.gg'),
    b('steam', 'steampowered.com', 'steamcommunity.com'),
    b('epicgames', 'epicgames.com'),
    b('blizzard', 'blizzard.com', 'battle.net'),
    b('roblox', 'roblox.com'),
    b('minecraft', 'minecraft.net'),
    b('ubisoft', 'ubisoft.com'),
    b('ea', 'ea.com'),
    b('nintendo', 'nintendo.com'),
    b('playstation', 'playstation.com'),
    b('spotify', 'spotify.com'),
    b('netflix', 'netflix.com'),
    b('hulu', 'hulu.com'),
    b('disney', 'disney.com', 'disneyplus.com'),
    b('linkedin', 'linkedin.com'),
    b('adobe', 'adobe.com'),
    b('dropbox', 'dropbox.com'),
    b('box', 'box.com'),
    b('zoom', 'zoom.us', 'zoom.com'),
    b('slack', 'slack.com'),
    b('notion', 'notion.so', 'notion.com'),
    b('figma', 'figma.com'),
    b('canva', 'canva.com'),
    b('atlassian', 'atlassian.com'),
    b('jira', 'atlassian.com'),
    b('trello', 'trello.com'),
    b('asana', 'asana.com'),
    b('github', 'github.com'),
    b('gitlab', 'gitlab.com'),
    b('stackoverflow', 'stackoverflow.com'),
    b('openai', 'openai.com', 'chatgpt.com'),
    b('anthropic', 'anthropic.com', 'claude.ai'),
    b('perplexity', 'perplexity.ai'),
    b('coinbase', 'coinbase.com'),
    b('binance', 'binance.com'),
    b('kraken', 'kraken.com'),
    b('robinhood', 'robinhood.com'),
    b('vanguard', 'vanguard.com'),
    b('fidelity', 'fidelity.com'),
    b('schwab', 'schwab.com'),
    b('chase', 'chase.com'),
    b('bankofamerica', 'bankofamerica.com'),
    b('wellsfargo', 'wellsfargo.com'),
    b('citi', 'citi.com', 'citibank.com'),
    b('hsbc', 'hsbc.com'),
    b('barclays', 'barclays.com', 'barclays.co.uk'),
    b('lloyds', 'lloydsbank.com', 'lloydsbank.co.uk'),
    b('santander', 'santander.com', 'santander.co.uk'),
    b('revolut', 'revolut.com'),
    b('klarna', 'klarna.com'),
    b('stripe', 'stripe.com'),
    b('square', 'squareup.com'),
    b('shopify', 'shopify.com'),
    b('intuit', 'intuit.com'),
    b('turbotax', 'turbotax.intuit.com'),
    b('quickbooks', 'quickbooks.intuit.com'),
    b('irs', 'irs.gov'),
    b('govuk', 'gov.uk', 'www.gov.uk'),
    b('canada', 'canada.ca'),
    b('dhl', 'dhl.com'),
    b('fedex', 'fedex.com'),
    b('ups', 'ups.com'),
    b('usps', 'usps.com'),
    b('royalmail', 'royalmail.com'),
    b('booking', 'booking.com'),
    b('airbnb', 'airbnb.com'),
    b('expedia', 'expedia.com'),
    b('tripadvisor', 'tripadvisor.com'),
    b('marriott', 'marriott.com'),
    b('hilton', 'hilton.com'),
    b('ryanair', 'ryanair.com'),
    b('delta', 'delta.com'),
    b('united', 'united.com'),
    b('americanairlines', 'aa.com'),
    b('lufthansa', 'lufthansa.com'),
    b('ems', 'ems.com'),
    b('docusign', 'docusign.com'),
    b('wetransfer', 'wetransfer.com'),
    b('mediafire', 'mediafire.com'),
    b('mega', 'mega.nz'),
    b('rapidshare', 'rapidshare.com')
  ];
  const DOMAIN_SET = new Set();
  const TOKEN_MAP = new Map();
  for (const entry of KNOWN_BRANDS) {
    TOKEN_MAP.set(entry.brand, entry);
    for (const d of entry.domains) DOMAIN_SET.add(d);
  }
  /** True when host's registrable domain is an official brand domain. */
  function isOfficialDomain(registrable) {
    return DOMAIN_SET.has(registrable);
  }
  /** Exact brand whose token equals the registrable label, if any. */
  function brandForToken(label) {
    return TOKEN_MAP.get(label) || null;
  }
  /** Damerau-Levenshtein distance, capped for speed. */
  function damerau(a, bToken, cap) {
    const la = a.length, lb = bToken.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
    for (let i = 0; i <= la; i++) d[i][0] = i;
    for (let j = 0; j <= lb; j++) d[0][j] = j;
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === bToken[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                           d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === bToken[j - 2] &&
            a[i - 2] === bToken[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);  // transposition
        }
      }
    }
    return d[la][lb];
  }
  /** Brand whose token is within edit distance 2 of label (typo-squat). */
  function typoBrandFor(label) {
    if (!label || label.length < 4) return null;
    const cap = label.length <= 4 ? 1 : 2;
    for (const entry of KNOWN_BRANDS) {
      if (Math.abs(entry.brand.length - label.length) > cap) continue;
      const dist = damerau(label, entry.brand, cap);
      // DEVIATION from guide: distance 0 is the brand's own name in
      // an unlisted TLD (amazon.de), not a typo. Guide FP table:
      // "exact match is exempt".
      if (dist >= 1 && dist <= cap) return entry;
    }
    return null;
  }
  root.Engine.Brands = {
    KNOWN_BRANDS, isOfficialDomain, brandForToken, typoBrandFor, damerau
  };
})(globalThis);