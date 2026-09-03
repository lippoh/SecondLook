/* SecondLook — ui/popup.js
 * All toggle writes go through Settings.setModule() — a fresh, serialized
 * read-modify-write. This popup NEVER saves a stale snapshot and NEVER
 * writes from a change listener. That combination was the bug.
 */
(() => {
  'use strict';
  const S = globalThis.SecondLook.Settings;
  const Engine = globalThis.SecondLook.Engine;
  const $ = (id) => document.getElementById(id);

  /* ---------- modules ---------- */
  function renderModules(settings) {
    const listEl = $('moduleList');
    listEl.textContent = '';
    for (const m of S.MODULES) {
      const li = document.createElement('li');
      li.className = 'module' + (m.implemented ? '' : ' soon');

      const row = document.createElement('label');
      row.className = 'module-row';

      const info = document.createElement('span');
      info.className = 'module-info';

      const nameRow = document.createElement('span');
      nameRow.className = 'name-row';
      const name = document.createElement('strong');
      name.textContent = m.name;
      nameRow.appendChild(name);
      if (m.pillar) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = m.pillar;
        nameRow.appendChild(chip);
      }
      if (!m.implemented) {
        const soon = document.createElement('span');
        soon.className = 'chip chip-soon';
        soon.textContent = 'not yet built';
        nameRow.appendChild(soon);
      }

      const desc = document.createElement('span');
      desc.className = 'module-desc';
      desc.textContent = m.desc;

      info.append(nameRow, desc);

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'switch';
      toggle.checked = S.isModuleOn(settings, m.id) === true;
      toggle.disabled = !m.implemented;
      toggle.setAttribute('aria-label', 'Enable ' + m.name);
      if (!m.implemented) toggle.title = 'This module arrives in a later part of the build';

      toggle.addEventListener('change', async () => {
        try {
          await S.setModule(m.id, toggle.checked);
          /* Authoritative re-render arrives via Settings.onChange. */
          /* Wake the service worker so scripts re-register NOW —
           * storage events are not a guaranteed SW wake-up. */
          chrome.runtime.sendMessage({ type: 'SL_SYNC_NOW' },
            () => void chrome.runtime.lastError);
        } catch (e) {
          toggle.checked = !toggle.checked;
        }
      });

      row.append(info, toggle);
      li.appendChild(row);
      listEl.appendChild(li);
    }
  }

  S.get().then(renderModules).catch(() => renderModules(S.defaults()));
  S.onChange(renderModules);   // cross-context truth; echoes of our own writes are deduped inside

  /* ---------- snapshot: page verdict + route + stats ---------- */
  async function loadSnapshot() {
    let tabId = -1;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) tabId = tab.id;
    } catch (e) {}
    let snap = null;
    try {
      snap = await chrome.runtime.sendMessage({ type: 'SL_GET_SNAPSHOT', tabId });
    } catch (e) {}
    renderVerdict(snap);
    renderRoute(snap);
    renderStats(snap);
    $('verTag').textContent = 'engine v' + ((snap && snap.engineVersion) || '?');
  }

  function renderVerdict(snap) {
    const holder = $('pageVerdict');
    holder.textContent = '';
    const v = snap && snap.pageVerdict;
    if (v) {
      const pill = SLVerdict.pill(v.verdict, v.verdict === 'CLEAR' ? 'OK' : 'Take a look');
      if (v.reasons && v.reasons.length) pill.title = v.reasons.join(' ');
      holder.appendChild(pill);
      if (v.reasons && v.reasons.length) {
        const ul = document.createElement('ul');
        ul.className = 'pv-reasons';
        for (const t of v.reasons.slice(0, 3)) {
          const li = document.createElement('li');
          li.textContent = t;
          ul.appendChild(li);
        }
        holder.appendChild(ul);
      }
    } else {
      const none = document.createElement('span');
      none.className = 'pv-none';
      none.textContent = 'Nothing to look at here';
      holder.appendChild(none);
    }
  }

  function renderRoute(snap) {
    const panel = $('routePanel');
    const hopsEl = $('routeHops');
    const whyEl = $('routeReasons');
    const chain = snap && snap.chain;
    if (!chain || !Array.isArray(chain.hops) || chain.hops.length < 2) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    hopsEl.textContent = '';
    whyEl.textContent = '';

    chain.hops.forEach((h, i) => {
      const li = document.createElement('li');
      let host = h;
      try { host = new URL(h).hostname.replace(/^www\./, ''); } catch (e) {}
      const v = Engine.analyze(h);
      const dot = document.createElement('span');
      dot.className = 'hop-dot ' + (v.verdict === 'CLEAR' ? 'hop-clear' : 'hop-warn');
      dot.title = v.reasons && v.reasons.length ? v.reasons.join(' ') : 'No signals';
      const span = document.createElement('span');
      span.className = 'hop-host';
      span.textContent = host;
      span.title = h;
      li.append(dot, span);
      if (i === chain.hops.length - 1) li.classList.add('hop-final');
      hopsEl.appendChild(li);
    });

    for (const t of (chain.reasons || [])) {
      const li = document.createElement('li');
      li.textContent = t;
      whyEl.appendChild(li);
    }
    whyEl.hidden = !(chain.reasons || []).length;
  }

  function renderStats(snap) {
    const row = $('statsRow');
    const mods = snap && snap.stats && snap.stats.modules ? snap.stats.modules : {};
    const ls = mods['link-sniper'] || {};
    const rd = mods['redirect-detective'] || {};
    const tb = mods['trust-badge'] || {};
    const parts = [];
    if (ls.scanned) parts.push(ls.scanned.toLocaleString() + ' links checked');
    if (ls.flagged) parts.push(ls.flagged.toLocaleString() + ' flagged');
    if (rd.routes) parts.push(rd.routes.toLocaleString() + ' routes traced');
    if (tb.chips) parts.push(tb.chips.toLocaleString() + ' trust badges displayed');
    if (!parts.length) { row.hidden = true; return; }
    row.textContent = parts.join(' · ');
    row.hidden = false;
  }

  /* ---------- restore defaults (two-step, no confirm() dialogs) ---------- */
  let armed = false;
  let armTimer = 0;
  $('resetDefaults').addEventListener('click', async () => {
    const btn = $('resetDefaults');
    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to confirm';
      armTimer = setTimeout(() => {
        armed = false;
        btn.textContent = 'Restore defaults';
      }, 2500);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    btn.textContent = 'Restore defaults';
    try { await S.reset(); } catch (e) {}
  });

  loadSnapshot();
})();