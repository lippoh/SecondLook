/* ============================================================
   SecondLook — ui/popup.js  (v1.2)
   Readable popup + live Link Sniper counters.
   Writes go through SL.Settings with a triple fallback
   (Settings.set(obj) -> Settings.set(key, value) -> direct
   chrome.storage.local write to "sl.settings"), so the toggle
   lifecycle in bootstrap.js can never silently break.
   ============================================================ */
(function () {
  'use strict';

  const SL = window.SL || {};
  const SETTINGS_KEY = 'sl.settings';
  const STATS_KEY = 'sl.stats';

  const PILLARS = [
    { id: 'click', title: 'What you click', hint: 'links · buttons · downloads' },
    { id: 'land',  title: 'Where you land', hint: 'redirects · sites · tabs' },
    { id: 'share', title: 'What you share', hint: 'forms · files' },
    { id: 'yours', title: 'What\u2019s yours', hint: 'cookies · camera · mic' }
  ];

  /* part: which guide part delivers the module — used for the
     "not fake" rule: no toggle is shown as usable before its
     module exists. Update BUILT as you complete parts. */
  const MODULES = [
    { id: 'link-sniper',        pillar: 'click', name: 'Link Sniper',            desc: 'Previews where a link really goes before you click.', part: 1, stats: 'linkSniper' },
    { id: 'fake-download',      pillar: 'click', name: 'Fake Download Button',   desc: 'Flags decoy download buttons next to real ones.', part: 6 },
    { id: 'ghost-click',        pillar: 'click', name: 'Ghost Click Blocker',    desc: 'Neutralizes invisible overlays that hijack clicks.', part: 5 },
    { id: 'redirect-detective', pillar: 'land',  name: 'Redirect Detective',     desc: 'Unrolls redirect chains to the final stop.', part: 2 },
    { id: 'trust-badge',        pillar: 'land',  name: 'Trust Badge',            desc: 'Checks site claims against what the browser knows.', part: 3 },
    { id: 'tab-guard',          pillar: 'land',  name: 'Tab Guard',              desc: 'Quarantines runaway pop-ups and link bursts.', part: 8 },
    { id: 'form-guardian',      pillar: 'share', name: 'Form Guardian',          desc: 'Warns before passwords leave for the wrong site.', part: 4 },
    { id: 'download-guard',     pillar: 'share', name: 'Download Guard',         desc: 'Sniffs what a downloaded file really is.', part: 7 },
    { id: 'cookie-tamer',       pillar: 'yours', name: 'Cookie Tamer',           desc: 'Points out consent walls, keeps login cookies tidy.', part: 9 },
    { id: 'media-indicator',    pillar: 'yours', name: 'Webcam & Mic Indicator', desc: 'Lights up when a site uses camera or mic.', part: 10 }
  ];
  const BUILT = { 'link-sniper': true };

  let settings = { modules: {} };
  let activeTab = null;
  let pageHost = '';

  /* ---------------- helpers ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function getSettings() {
    if (SL.Settings && typeof SL.Settings.get === 'function') {
      try { return await SL.Settings.get(); } catch (_) { /* fall through */ }
    }
    return { pausedAll: false, modules: {}, siteDisabled: {} };
  }

  function moduleOn(id) {
    if (SL.Settings && typeof SL.Settings.isModuleOn === 'function') {
      try { return SL.Settings.isModuleOn(settings, id, pageHost); } catch (_) { return false; }
    }
    if (settings.pausedAll === true) return false;
    return !settings.modules || settings.modules[id] !== false;
  }

  /* Defensive write: works with set(object), set(key, value), or neither. */
  async function persistSettings(next) {
    if (SL.Settings && typeof SL.Settings.set === 'function') {
      try { await SL.Settings.set(next); return; } catch (e) { /* try next shape */ }
      try { await SL.Settings.set(SETTINGS_KEY, next); return; } catch (e) { /* fall through */ }
    }
    try { await chrome.storage.local.set({ [SETTINGS_KEY]: next }); }
    catch (e) { console.warn('[sl:popup] could not save settings', e); }
  }

  async function setModuleOn(id, on) {
    const s = await getSettings();
    const target = (s.modules && typeof s.modules === 'object') ? s.modules : s;
    target[id] = on;
    await persistSettings(s);
    settings = await getSettings();
    syncRowStates();
  }

  /* ---------------- rendering ---------------- */
  function renderSite() {
    const hostEl = document.getElementById('slSiteHost');
    const noteEl = document.getElementById('slSiteNote');
    let host = '';
    try { host = activeTab && activeTab.url ? new URL(activeTab.url).hostname : ''; } catch (_) {}
    pageHost = host;
    hostEl.textContent = host || 'No site access here';
    hostEl.title = (activeTab && activeTab.url) || '';
    let note = 'watching';
    if (!host) note = 'internal page';
    else if (settings.pausedAll === true) note = 'paused';
    else if (!moduleOn('link-sniper')) note = 'off here';
    noteEl.textContent = note;
  }

  async function renderVerdict() {
    const holder = document.getElementById('slVerdict');
    holder.textContent = '';
    const strip = el('div', 'sl-vstrip');
    const text = el('div', 'sl-vstrip__text');

    let live = null;
    if (activeTab && activeTab.id != null && moduleOn('link-sniper') && pageHost) {
      try {
        live = await chrome.tabs.sendMessage(activeTab.id, {
          module: 'link-sniper', type: 'getPageVerdict'
        });
      } catch (_) { live = null; }
    }

    if (settings.pausedAll === true) {
      strip.appendChild(SLVerdict.pill('NEUTRAL', 'Paused'));
      text.textContent = 'Everything is paused. Flip the switch below to resume.';
    } else if (live && live.verdict) {
      const pill = SLVerdict.pill(live.verdict,
        live.verdict === 'CLEAR' ? 'All clear' : 'Take a look');
      pill.title = (live.reasons || []).join(' ');
      strip.appendChild(pill);
      text.textContent = live.verdict === 'CLEAR'
        ? 'Nothing unusual reported on this page.'
        : ((live.reasons && live.reasons[0]) || 'Something on this page deserves a second look.');
    } else if (pageHost && !moduleOn('link-sniper')) {
      strip.appendChild(SLVerdict.pill('NEUTRAL', 'Off'));
      text.textContent = 'Link Sniper is switched off. Turn it on below to preview links.';
    } else {
      strip.appendChild(SLVerdict.pill('NEUTRAL', 'Watching'));
      text.textContent = pageHost
        ? 'Hover any link to see where it really goes.'
        : 'Nothing to watch on browser-internal pages.';
    }
    strip.appendChild(text);
    holder.appendChild(strip);
  }

  function prettifyId(id) {
    if (id === 'demo') return 'Part 0 demo module';
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* Module ids present in settings but not in the registry
     (e.g. the Part 0 demo) still get an honest row. */
  function findExtras() {
    const known = {};
    MODULES.forEach((m) => { known[m.id] = true; });
    const mods = (settings && settings.modules) || {};
    return Object.keys(mods)
      .filter((id) => !known[id])
      .map((id) => ({
        id: id,
        pillar: 'click',
        name: prettifyId(id),
        desc: 'Early scaffold module — safe to switch off.',
        part: 0,
        builtin: true
      }));
  }

  function buildRow(m) {
    const row = el('div', 'sl-row');
    row.dataset.module = m.id;

    const main = el('div', 'sl-row__main');
    const title = el('div', 'sl-row__title', m.name);
    const built = m.builtin || BUILT[m.id];
    if (!built) title.appendChild(el('span', 'sl-chip', 'Part ' + m.part));
    main.appendChild(title);
    main.appendChild(el('div', 'sl-row__desc', m.desc));
    if (m.stats) {
      const stat = el('div', 'sl-row__stat', 'No links checked yet');
      stat.id = 'sl-stat-' + m.id;
      main.appendChild(stat);
    }

    const label = document.createElement('label');
    label.className = 'sl-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.module = m.id;
    input.checked = moduleOn(m.id);
    /* Honesty rule: a toggle that does nothing yet is disabled,
       not fake. Enable it as each part is completed. */
    input.disabled = !built;
    input.title = built
      ? (m.name + ' — switch ' + (input.checked ? 'off' : 'on'))
      : 'Delivered in Part ' + m.part;
    const track = el('span', 'sl-toggle__track');
    track.appendChild(el('span', 'sl-toggle__thumb'));
    label.appendChild(input);
    label.appendChild(track);

    row.appendChild(main);
    row.appendChild(label);
    return row;
  }

  function renderModules() {
    const list = document.getElementById('slModules');
    list.textContent = '';
    const extras = findExtras();
    PILLARS.forEach((p) => {
      const mods = MODULES.filter((m) => m.pillar === p.id)
        .concat(extras.filter((m) => m.pillar === p.id));
      if (!mods.length) return;
      const group = document.createElement('details');
      group.className = 'sl-group';
      group.open = true;
      const sum = el('summary');
      sum.appendChild(el('span', null, p.title));
      sum.appendChild(el('span', 'sl-group__hint', p.hint));
      group.appendChild(sum);
      const rows = el('div', 'sl-group__rows');
      mods.forEach((m) => rows.appendChild(buildRow(m)));
      group.appendChild(rows);
      list.appendChild(group);
    });
  }

  function syncRowStates() {
    document.querySelectorAll('input[data-module]').forEach((input) => {
      input.checked = moduleOn(input.dataset.module);
    });
    const pause = document.getElementById('slPauseAll');
    if (pause) pause.checked = settings.pausedAll === true;
    renderSite();
  }

  /* ---------------- stats (lifetime counters) ---------------- */
  function applyStats(data) {
    const node = document.getElementById('sl-stat-link-sniper');
    if (!node) return;
    const s = data && data.linkSniper;
    if (s && (Number(s.scans) || 0) > 0) {
      node.textContent = Number(s.scans).toLocaleString() + ' links checked \u00B7 ' +
        Number(s.flagged || 0).toLocaleString() + ' flagged';
    } else {
      node.textContent = 'No links checked yet';
    }
  }

  async function renderStats() {
    try {
      const stored = await chrome.storage.local.get(STATS_KEY);
      applyStats(stored && stored[STATS_KEY]);
    } catch (_) { /* ignore */ }
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    document.getElementById('slModules').addEventListener('change', (e) => {
      const input = e.target.closest('input[data-module]');
      if (!input || input.disabled) return;
      setModuleOn(input.dataset.module, input.checked);
    });

    document.getElementById('slPauseAll').addEventListener('change', async (e) => {
      const s = await getSettings();
      s.pausedAll = e.target.checked;
      await persistSettings(s);
      settings = await getSettings();
      syncRowStates();
      renderVerdict();
    });

    document.getElementById('slOptions').addEventListener('click', () => {
      try {
        const p = chrome.runtime.openOptionsPage();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* no options page declared */ }
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[STATS_KEY]) applyStats(changes[STATS_KEY].newValue);
        if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
          settings = changes[SETTINGS_KEY].newValue;
          syncRowStates();
        }
      });
    } catch (_) { /* ignore */ }

    if (SL.Settings && typeof SL.Settings.subscribe === 'function') {
      try {
        SL.Settings.subscribe(() => { getSettings().then((s) => { settings = s; syncRowStates(); }); });
      } catch (_) { /* ignore */ }
    }
  }

  /* ---------------- boot ---------------- */
  async function init() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tabs && tabs[0];
    } catch (_) { activeTab = null; }
    settings = await getSettings();
    renderSite();
    renderModules();
    await renderVerdict();
    renderStats();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();