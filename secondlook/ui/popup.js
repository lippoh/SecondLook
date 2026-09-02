/* ui/popup.js - renders pillars/rows from the registry; every mutation
 * goes through the router so the SW stays the single settings writer. */
(function () {
  'use strict';
  const send = SL.msg.send;
  const $ = (id) => document.getElementById(id);
  const state = { tabId: null, snapshot: null, settings: null };
  /* one 16x16 stroke icon per module - SVG only, never emoji */
  const ICONS = {
    demoGreeting: eyeIcon(), linkSniper: eyeIcon(),
    redirectDetective: chainIcon(), trustBadge: sealIcon(),
    formGuardian: formIcon(), ghostClick: ghostIcon(),
    fakeDownload: dlIcon(), downloadGuard: shieldIcon(),
    tabGuard: tabsIcon(), cookieTamer: cookieIcon(), avIndicator: camIcon()
  };
  function svgWrap(inner) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" ' +
      'aria-hidden="true">' + inner + '</svg>';
  }
  function eyeIcon() {
    return svgWrap('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"' +
      ' fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="12" cy="12" r="2.6" fill="currentColor"/>');
  }
  function chainIcon() {
    return svgWrap('<path d="M9 15l6-6M8 12l-2 2a3 3 0 004 4l2-2' +
      'M16 12l2-2a3 3 0 00-4-4l-2 2" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8"/>');
  }
  function sealIcon() {
    return svgWrap('<path d="M12 3l2.5 2 3 .5.5 3L20 12l-2 2.5-.5 3-3 .5' +
      '-2.5 2-2.5-2-3-.5-.5-3L4 12l2-2.5.5-3 3-.5z" fill="none" stroke=' +
      '"currentColor" stroke-width="1.6"/><path d="M9 12l2 2 4-4" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/>');
  }
  function formIcon() {
    return svgWrap('<rect x="4" y="6" width="16" height="12" rx="2" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/><path d="M7 10h10' +
      'M7 14h6" stroke="currentColor" stroke-width="1.8"/>');
  }
  function ghostIcon() {
    return svgWrap('<rect x="4" y="4" width="16" height="16" rx="3" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8" stroke-dasharray=' +
      '"3 2"/>');
  }
  function dlIcon() {
    return svgWrap('<path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/>');
  }
  function shieldIcon() {
    return svgWrap('<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/><path d="M12 9v4" ' +
      'stroke="currentColor" stroke-width="1.8"/>');
  }
  function tabsIcon() {
    return svgWrap('<rect x="3" y="7" width="18" height="13" rx="2" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/><path d="M3 7l3-4h8' +
      'l3 4" fill="none" stroke="currentColor" stroke-width="1.8"/>');
  }
  function cookieIcon() {
    return svgWrap('<circle cx="12" cy="12" r="8" fill="none" stroke=' +
      '"currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="1.2"' +
      ' fill="currentColor"/><circle cx="14" cy="13" r="1.2" fill=' +
      '"currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>');
  }
  function camIcon() {
    return svgWrap('<rect x="3" y="7" width="12" height="10" rx="2" fill=' +
      '"none" stroke="currentColor" stroke-width="1.8"/><path d="M15 11l6-' +
      '3v8l-6-3z" fill="none" stroke="currentColor" stroke-width="1.8"/>');
  }
  async function init() {
    const [tab] = await chrome.tabs.query({ active: true,
                                            currentWindow: true });
    state.tabId = tab ? tab.id : null;
    const res = await send('core', 'getSnapshot', { tabId: state.tabId });
    state.snapshot = res.ok ? res.data : null;
    state.settings = state.snapshot && state.snapshot.settings;
    renderSite();
    renderPillars();
    renderGlobal();
    chrome.storage.onChanged.addListener(onStorage);
  }
  function onStorage(changes, area) {
    if (area === 'local' && changes['sl.settings']) {
      state.settings = changes['sl.settings'].newValue;
      renderPillars();
      renderGlobal();
    }
    if (area === 'session' && changes['sl.status']) {
      // DEVIATION from guide Part 0: guard null snapshot (guide's own
      // Part 11 popup.js adds the same guard); without it a failed
      // getSnapshot + later status update threw on null.
      if (state.snapshot) state.snapshot.statusLines =
        (changes['sl.status'].newValue || {})[state.tabId] || {};
      renderPillars();
    }
  }
  function renderGlobal() {
    const on = !!(state.settings && state.settings.globalEnabled !== false);
    $('slp-global').checked = on;
    $('slp-paused').hidden = on;
  }
  function renderSite() {
    const snap = state.snapshot;
    const isHttp = snap && /^https?:/i.test(snap.url || '');
    $('slp-site').hidden = !isHttp;
    $('slp-empty').hidden = !!isHttp;
    if (!isHttp) return;
    $('slp-host').textContent = snap.host || '(this page)';
    const holder = $('slp-verdict');
    holder.textContent = '';
    if (snap.pageVerdict) {
      const v = snap.pageVerdict;
      const pill = SLVerdict.pill(v.verdict,
        v.verdict === 'CLEAR' ? 'OK' : 'Take a look');
      if (v.reasons && v.reasons.length) {
        pill.title = v.reasons.join(' ');
      }
      holder.appendChild(pill);
    }
    updateSafeModeButton();
  }
  function updateSafeModeButton() {
    const btn = $('slp-safemode');
    const on = !!(state.snapshot && state.snapshot.safeModeOn);
    btn.textContent = on ? 'Safe Mode is ON - unfreeze' : 'Safe Mode this tab';
    btn.classList.toggle('sl-btn--primary', on);
  }
  function renderPillars() {
    const nav = $('slp-pillars');
    nav.textContent = '';
    const collapsed = {};
    SL.Registry.PILLARS.forEach((pillar, idx) => {
      const section = document.createElement('section');
      section.className = 'sl-pillar';
      section.dataset.collapsed = idx > 0 ? 'true' : 'false';
      const head = document.createElement('button');
      head.className = 'slp-pillar__head';
      head.type = 'button';
      head.setAttribute('aria-expanded', idx > 0 ? 'false' : 'true');
      head.innerHTML = '<span>' + pillar.name + '</span>' +
        '<svg class="slp-pillar__chev" viewBox="0 0 24 24" width="12" ' +
        'height="12" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" ' +
        'stroke="currentColor" stroke-width="2"/></svg>';
      head.addEventListener('click', () => {
        const now = section.dataset.collapsed !== 'true';
        section.dataset.collapsed = String(now);
        head.setAttribute('aria-expanded', String(!now));
        collapsed[pillar.id] = now;
      });
      section.appendChild(head);
      const rows = document.createElement('div');
      rows.className = 'slp-pillar__rows';
      for (const mod of SL.Registry.MODULES) {
        if (mod.pillar !== pillar.id) continue;
        rows.appendChild(makeRow(mod));
      }
      section.appendChild(rows);
      nav.appendChild(section);
    });
  }
  function makeRow(mod) {
    const row = document.createElement('div');
    row.className = 'sl-row';
    row.dataset.module = mod.id;
    const icon = document.createElement('div');
    icon.className = 'sl-row__icon';
    icon.innerHTML = ICONS[mod.id] || eyeIcon();
    row.appendChild(icon);
    const body = document.createElement('div');
    body.className = 'sl-row__body';
    const name = document.createElement('div');
    name.className = 'sl-row__name';
    name.textContent = mod.name;
    if (mod.devOnly) {
      const tag = document.createElement('span');
      tag.className = 'sl-row__dev-tag';
      tag.textContent = 'DEV';
      tag.style.marginLeft = '6px';
      name.appendChild(tag);
    }
    const status = document.createElement('div');
    status.className = 'sl-row__status';
    status.textContent = statusText(mod.id);
    body.appendChild(name);
    body.appendChild(status);
    row.appendChild(body);
    const toggle = document.createElement('label');
    toggle.className = 'sl-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', mod.name + ' on this browser');
    input.checked = isOn(mod.id);
    input.addEventListener('change', () => onToggle(mod.id, input.checked,
                                                    row));
    const track = document.createElement('span');
    track.className = 'sl-toggle__track';
    toggle.appendChild(input);
    toggle.appendChild(track);
    row.appendChild(toggle);
    row.title = mod.blurb;
    return row;
  }
  function isOn(moduleId) {
    return !!(state.settings &&
      SL.Settings.isModuleOn(state.settings, moduleId, null));
  }
  function statusText(moduleId) {
    const lines = state.snapshot && state.snapshot.statusLines;
    const line = lines && lines[moduleId];
    if (line) return line;
    return isOn(moduleId) ? 'Idle' : 'Off';
  }
  async function onToggle(moduleId, enabled, rowEl) {
    rowEl.classList.add('sl-row--syncing');
    const statusEl = rowEl.querySelector('.sl-row__status');
    if (statusEl) statusEl.textContent = 'syncing';
    await send('core', 'setModuleEnabled', { moduleId, enabled });
    // settings change event clears the syncing state via renderPillars()
  }
  $('slp-global').addEventListener('change', async (e) => {
    await send('core', 'setGlobalEnabled', { enabled: e.target.checked });
  });
  $('slp-safemode').addEventListener('click', async () => {
    const on = !(state.snapshot && state.snapshot.safeModeOn);
    await send('core', 'safeMode', { tabId: state.tabId, on });
    state.snapshot.safeModeOn = on;
    renderSite();
  });
  $('slp-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  $('slp-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('/ui/dashboard.html') });
  });
  init();
})();