/* shared/module-registry.js - catalog + content-script specs.
 * PURE DATA: no chrome.* access at load time, safe in every runtime. */
(function (global) {
  'use strict';
  const root = global.SL = global.SL || {};
  if (root.Registry) return;
  const PILLARS = [
    { id: 'linkIntel',  name: 'Link & Site Intel' },
    { id: 'clickSafe',  name: 'Form & Click Safety' },
    { id: 'files',      name: 'Files & Downloads' },
    { id: 'annoyance',  name: 'Annoyance & Privacy' }
  ];
  const HTTP = ['http://*/*', 'https://*/*'];
  /* DEVIATION from guide: storage.js + settings.js added because
   * cs-bridge.js calls SL.Settings / SL.Storage in content scripts
   * (its enabledFor() threw TypeError at line 50 without them). */
  const BRIDGE_FILES = [
    'shared/storage.js',
    'shared/settings.js',
    'shared/messaging.js',
    'shared/cs-bridge.js',
    'ui/toast.js',
    'ui/verdict-card.js'
  ];
  const BASE_CSS = ['ui/tokens.css', 'ui/components.css'];
  /* Registration spec fields:
   *   id        unique script id used by chrome.scripting (persisted!)
   *   matches   URL patterns this script set runs on
   *   js/css    files injected, root-relative paths
   *   runAt     document_start | document_end | document_idle
   *   world     ISOLATED (default) | MAIN (only av-indicator uses MAIN)
   *   allFrames boolean
   */
  const MODULES = [
    {
      id: 'demoGreeting', name: 'Demo Greeting', pillar: 'annoyance',
      blurb: 'Dev-only chip that proves toggles are real (removed in Part 13).',
      defaultEnabled: true, devOnly: true,
      scripts: [{
        id: 'sl-cs-demo2', matches: HTTP, runAt: 'document_idle',
        // id bumped from sl-cs-demo: persisted registrations survive
        // extension reloads, and the old id held the stale file list
        world: 'ISOLATED', allFrames: false,
        js: [...BRIDGE_FILES, 'modules/demo-greeting/demo-greeting.js'],
        css: [...BASE_CSS, 'modules/demo-greeting/demo-greeting.css']
      }]
    },
    { id: 'linkSniper', name: 'Link Sniper', pillar: 'linkIntel',
      blurb: 'Hover any link to see where it really goes.',
      defaultEnabled: true,
      scripts: [{
        id: 'sl-cs-link-sniper', matches: HTTP, runAt: 'document_idle',
        world: 'ISOLATED', allFrames: false,
        js: [...BRIDGE_FILES, 'modules/link-sniper/link-sniper.js'],
        css: [...BASE_CSS, 'modules/link-sniper/link-sniper.css']
      }] },
    { id: 'redirectDetective', name: 'Redirect Detective', pillar: 'linkIntel',
      blurb: 'Follows redirect chains hop by hop.',
      defaultEnabled: true, scripts: null },          // <- Part 2
    { id: 'trustBadge', name: 'Trust Badge', pillar: 'linkIntel',
      blurb: 'Flags trust seals that are just images.',
      defaultEnabled: true, scripts: null },          // <- Part 3
    { id: 'formGuardian', name: 'Form Guardian', pillar: 'clickSafe',
      blurb: 'Stops passwords leaving for the wrong domain.',
      defaultEnabled: true, scripts: null },          // <- Part 4
    { id: 'ghostClick', name: 'Ghost Click Blocker', pillar: 'clickSafe',
      blurb: 'Neutralizes invisible click-stealing overlays.',
      defaultEnabled: true, scripts: null },          // <- Part 5
    { id: 'fakeDownload', name: 'Fake Download Button', pillar: 'clickSafe',
      blurb: 'Marks competing download buttons.',
      defaultEnabled: true, scripts: null },          // <- Part 6
    { id: 'downloadGuard', name: 'Download Guard', pillar: 'files',
      blurb: 'Checks file bytes against their extension.',
      defaultEnabled: true, scripts: null },          // <- Part 7
    { id: 'tabGuard', name: 'Tab Guard', pillar: 'annoyance',
      blurb: 'Contains popup storms in an isolation group.',
      defaultEnabled: true, scripts: null },          // <- Part 8 (SW-only)
    { id: 'cookieTamer', name: 'Cookie Tamer', pillar: 'annoyance',
      blurb: 'Parks consent banners; never clicks Accept.',
      defaultEnabled: true, scripts: null },          // <- Part 9
    { id: 'avIndicator', name: 'Webcam/Mic Indicator', pillar: 'annoyance',
      blurb: 'A chip whenever camera or mic is in use.',
      defaultEnabled: true, scripts: null }           // <- Part 10
  ];
  function byId(id) {
    return MODULES.find((m) => m.id === id) || null;
  }
  function allScriptSpecs() {
    const out = [];
    for (const m of MODULES) if (m.scripts) out.push(...m.scripts);
    return out;
  }
  function scriptIdsFor(moduleId) {
    const m = byId(moduleId);
    return m && m.scripts ? m.scripts.map((s) => s.id) : [];
  }
  root.Registry = {
    PILLARS, MODULES, byId, allScriptSpecs, scriptIdsFor,
    BRIDGE_FILES, BASE_CSS
  };
})(globalThis);