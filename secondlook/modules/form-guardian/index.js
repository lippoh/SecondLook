/* ============================================================
 * SecondLook - content/form-guardian/index.js  (v1.0)
 * Pillar 2: Guard what you type.
 *
 * Watches forms that carry passwords / card details / ID numbers
 * and answers one question before you submit:
 *   "Where is this really going?"
 *
 *   CLEAR        stays on this site, encrypted, POST
 *   SECOND LOOK  what you type is sent somewhere else (amber)
 *   INTERCEPTED  credentials over http / in the URL / to a raw IP -
 *                submission is held, "Send anyway" is revocable
 *
 * Self-start module: arms only if the module is ON in settings and
 * detaches live when toggled off (OFF must be real OFF).
 * UI is self-contained (no SLVerdict dependency) so the bundle only
 * needs shared/settings.js to work.
 * ============================================================ */
(() => {
  "use strict";

  const NS = (globalThis.SecondLook = globalThis.SecondLook || {});
  const __version = 1.0;
  if (NS.FG && typeof NS.FG.__version === "number" && NS.FG.__version >= __version) return;

  const MODULE_ID = "form-guardian";
  const ANALYZE_MSG = "sl:engine:analyze"; // optional engine hook - change if your Engine uses another message type
  const HOST = location.hostname;

  if (!/^https?:$/.test(location.protocol)) return; // http(s) pages only

  /* ---------- small helpers -------------------------------- */
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const clsFor = (v) =>
    ({ CLEAR: "slfg-clear", "SECOND LOOK": "slfg-warn", INTERCEPTED: "slfg-bad" }[v] || "slfg-warn");
  const LEVELS = { CLEAR: 0, "SECOND LOOK": 1, INTERCEPTED: 2 };

  /* ---------- state ---------------------------------------- */
  const state = {
    started: false,
    enabled: false,
    engaged: false,
    unsub: null,
    pill: null,
    card: null,
    pillTimer: null,
    bypassForms: new WeakSet(),   // forms the user explicitly allowed this page-load
    bypassActions: new Set(),     // action URLs the user explicitly allowed
    engineCache: new Map(),       // action URL -> engine verdict (page session)
    stats: { clear: 0, warn: 0, blocked: 0, sentAnyway: 0, muted: 0 },
    last: null,
  };

  /* ---------- site comparison (eTLD+1 approximation) ------ */
  const MULTI_TLD = new Set([
    "co.uk","org.uk","ac.uk","gov.uk","net.uk",
    "com.au","net.au","org.au","edu.au","gov.au",
    "co.nz","net.nz","org.nz",
    "co.jp","or.jp","ne.jp",
    "com.br","com.mx","com.cn","com.tw","com.ar","com.co","com.sg","com.hk",
    "co.in","net.in","org.in","co.za"
  ]);
  function registrable(host) {
    host = String(host || "").toLowerCase().replace(/^\.+/, "");
    if (!host || host === "localhost" || !host.includes(".")) return host; // single label / localhost
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host; // IP literal
    const parts = host.split(".");
    const last2 = parts.slice(-2).join(".");
    if (MULTI_TLD.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
    return last2;
  }
  function sameSite(a, b) {
    const ra = registrable(a), rb = registrable(b);
    return !!ra && !!rb && ra === rb;
  }

  /* ---------- field scanning ------------------------------- */
  const RX_CARD = /card|cvc|cvv|csc|expir|ccnum|\bpan\b/i;
  const RX_SSN = /ssn|social.?security|tax.?id/i;
  const RX_EMAIL = /(^|[^a-z])e-?mail([^a-z]|$)/i;

  function scanFields(inputs) {
    const f = { password: 0, card: 0, ssn: 0, email: 0, total: inputs.length };
    for (const n of inputs) {
      const auto = n.getAttribute("autocomplete") || "";
      const hints = [n.name, n.id, auto, n.getAttribute("placeholder") || ""].filter(Boolean).join(" ");
      const type = (n.getAttribute("type") || "text").toLowerCase();
      if (type === "password" || /password/i.test(auto)) f.password++;
      if (type === "email" || RX_EMAIL.test(hints)) f.email++;
      if (auto.startsWith("cc-") || RX_CARD.test(hints)) f.card++;
      if (RX_SSN.test(hints)) f.ssn++;
    }
    return f;
  }

  /* ---------- action resolution ---------------------------- */
  function actionOf(form) {
    if (!form) {
      return {
        url: location.href, host: HOST,
        scheme: location.protocol.replace(":", ""),
        method: "POST", local: false, formless: true,
      };
    }
    const raw = (form.getAttribute("action") || "").trim();
    const method = (form.getAttribute("method") || "GET").trim().toUpperCase();
    if (method === "DIALOG" || /^javascript:/i.test(raw)) {
      return { url: location.href, host: HOST, scheme: "local", method: method, local: true, formless: false };
    }
    let u = null;
    try { u = new URL(raw || location.href, document.baseURI || location.href); } catch (e) { u = null; }
    return {
      url: u ? u.href : location.href,
      host: u ? u.hostname : HOST,
      scheme: u ? u.protocol.replace(":", "") : location.protocol.replace(":", ""),
      method: method === "GET" ? "GET" : "POST",
      local: false, formless: false,
    };
  }

  /* ---------- verdict -------------------------------------- */
  function classify(f, a) {
    const sensitive = f.password > 0 || f.card > 0 || f.ssn > 0;
    const v = {
      verdict: "CLEAR",
      reasons: [],
      silent: false,
      meta: {
        sensitive: sensitive, identity: f.email > 0,
        page: HOST, action: a.host, actionUrl: a.url,
        method: a.method, scheme: a.scheme,
      },
    };
    if (a.local) { v.silent = true; return v; } // stays on this page - nothing to say

    const what = f.password > 0 ? "your password"
      : f.card > 0 ? "your card details"
      : f.ssn > 0 ? "your ID number" : "what you type";

    if (sensitive) {
      const cross = !!a.host && !!HOST && !sameSite(a.host, HOST);
      const insecure = a.scheme === "http";
      const getLeak = a.method === "GET";
      const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(a.host) || String(a.host || "").includes(":");

      if (cross) v.reasons.push("It sends " + what + " to " + a.host + " - not " + (HOST || "this site") + ", the site you're on.");
      if (insecure) v.reasons.push("The connection isn't encrypted (http) - anyone in between can read it.");
      if (getLeak) v.reasons.push("It would put " + what + " into the page URL itself (GET) - URLs get saved in logs and history.");
      if (isIP) v.reasons.push("It sends to a raw IP address (" + a.host + ") instead of a named site.");

      if (v.reasons.length === 0) {
        if (a.formless) {
          v.verdict = "SECOND LOOK";
          v.reasons.push("This password/card field has no form - page scripts will send it somewhere that can't be verified.");
        } else {
          v.reasons.push("Stays on " + (HOST || "this site") + ", over an encrypted connection.");
        }
      } else if (!a.formless && (insecure || getLeak || isIP)) {
        v.verdict = "INTERCEPTED";
      } else {
        v.verdict = "SECOND LOOK";
      }
      return v;
    }

    if (f.email > 0 && !!a.host && !!HOST && !sameSite(a.host, HOST)) {
      v.verdict = "SECOND LOOK";
      v.reasons.push("It shares your email with " + a.host + " - not " + (HOST || "this site") + ".");
      return v;
    }

    v.silent = true; // nothing sensitive, nothing off - stay quiet
    return v;
  }

  function verdictFor(input, form) {
    const a = actionOf(form);
    const inputs = form ? Array.from(form.querySelectorAll("input, select, textarea")) : [input];
    return classify(scanFields(inputs), a);
  }

  /* ---------- optional engine enrichment (never required) -- */
  function mergeEngine(v, engine) {
    if (!engine || typeof engine !== "object") return;
    const reasons = Array.isArray(engine.reasons) ? engine.reasons.filter((r) => typeof r === "string") : [];
    for (const r of reasons) if (!v.reasons.includes(r)) v.reasons.push(r);
    if (LEVELS[engine.verdict] > LEVELS[v.verdict]) v.verdict = engine.verdict; // engine can only escalate
  }
  function enrich(v, actionUrl, input) {
    const cached = state.engineCache.get(actionUrl);
    if (cached) { mergeEngine(v, cached); return; }
    const p = (async () => {
      try {
        const res = await Promise.race([
          chrome.runtime.sendMessage({ type: ANALYZE_MSG, url: actionUrl, context: { source: MODULE_ID } }),
          new Promise((r) => setTimeout(() => r(null), 450)),
        ]);
        if (res && typeof res === "object" && (res.verdict || res.reasons)) {
          state.engineCache.set(actionUrl, res);
          return res;
        }
      } catch (e) { /* no engine handler - local heuristics are enough */ }
      return null;
    })();
    p.then((engine) => {
      if (!engine) return;
      mergeEngine(v, engine);
      if (state.pill && state.pill.__anchor === input) showPill(v, input); // refresh in place
    });
  }

  /* ---------- UI: pill ------------------------------------- */
  function showPill(v, input) {
    hidePill(true);
    const pill = document.createElement("div");
    pill.className = "slfg-pill " + clsFor(v.verdict);
    pill.setAttribute("role", "status");
    pill.title = "Click for details";
    const dot = el("span", "slfg-dot");
    const label = el("strong", null, v.verdict);
    const msg = el("span", "slfg-msg", v.reasons[0] || "");
    pill.append(dot, label, msg);
    pill.__v = v;
    pill.__anchor = input;
    // preventDefault keeps focus on the field while the user reads the pill
    pill.addEventListener("mousedown", (e) => { e.preventDefault(); openCardFromPill(pill); }, true);
    document.documentElement.appendChild(pill);
    positionPill(pill, input);
    state.pill = pill;
    if (v.verdict === "CLEAR") state.pillTimer = setTimeout(hidePill, 2600);
  }
  function positionPill(pill, input) {
    let r = null;
    try { r = input.getBoundingClientRect(); } catch (e) {}
    if (!r || (!r.bottom && !r.top)) r = { left: 12, top: 12, bottom: 44, width: 240, height: 32 };
    const pw = pill.offsetWidth || 260, ph = pill.offsetHeight || 30;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = clamp(r.left, 8, Math.max(8, vw - pw - 8));
    let top = r.bottom + 8;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 8);
    pill.style.left = Math.round(left) + "px";
    pill.style.top = Math.round(top) + "px";
  }
  function hidePill() {
    clearTimeout(state.pillTimer);
    state.pillTimer = null;
    if (state.pill) { state.pill.remove(); state.pill = null; }
  }

  /* ---------- UI: card ------------------------------------- */
  function showCard(v, opts) {
    opts = opts || {};
    hideCard();
    const card = document.createElement("div");
    card.className = "slfg-card " + clsFor(v.verdict);
    card.setAttribute("role", "alert");

    const head = el("div", "slfg-head");
    head.append(
      el("span", "slfg-dot"),
      el("strong", "slfg-title",
        v.verdict === "CLEAR" ? "Form Guardian - all clear"
        : v.verdict === "SECOND LOOK" ? "Form Guardian - second look"
        : "Form Guardian - held this submission")
    );

    const route = el("div", "slfg-route",
      "on: " + (HOST || "(this page)") + "   sends to: " + (v.meta.action || "(same page)") +
      "  |  " + (v.meta.method || "POST") + " - " + (v.meta.scheme || "https"));

    const ul = el("ul", "slfg-reasons");
    (v.reasons.length ? v.reasons : ["Nothing unusual - this form keeps what you type on " + (HOST || "this site") + "."])
      .forEach((r) => ul.appendChild(el("li", null, r)));

    const actions = el("div", "slfg-actions");
    if (v.verdict === "INTERCEPTED" && opts.form) {
      const send = el("button", "slfg-btn slfg-btn-danger", "Send anyway");
      send.type = "button";
      send.addEventListener("click", () => sendAnyway(v, opts.form));
      const hold = el("button", "slfg-btn slfg-btn-ghost", "Hold on");
      hold.type = "button";
      hold.addEventListener("click", hideCard);
      actions.append(send, hold);
    } else if (v.verdict === "SECOND LOOK") {
      const ok = el("button", "slfg-btn slfg-btn-primary", "Got it");
      ok.type = "button";
      ok.addEventListener("click", hideCard);
      const mute = el("button", "slfg-btn slfg-btn-ghost", "Mute on this site");
      mute.type = "button";
      mute.addEventListener("click", muteHere);
      actions.append(ok, mute);
    } else {
      const ok = el("button", "slfg-btn slfg-btn-primary", "OK");
      ok.type = "button";
      ok.addEventListener("click", hideCard);
      actions.append(ok);
    }

    card.append(head, route, ul, actions);
    document.documentElement.appendChild(card);
    state.card = card;
  }
  function hideCard() {
    if (state.card) { state.card.remove(); state.card = null; }
  }
  function openCardFromPill(pill) {
    const v = pill.__v;
    const input = pill.__anchor;
    const form = input && (input.form || input.closest("form"));
    hidePill();
    showCard(v, { form: form });
  }

  /* ---------- actions -------------------------------------- */
  function sendAnyway(v, form) {
    hideCard();
    if (!form) return;
    state.bypassForms.add(form);
    state.bypassActions.add(v.meta.actionUrl);
    state.stats.sentAnyway++;
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit(); // fires submit -> our bypass lets it pass
      else form.submit();
    } catch (e) {
      try { form.submit(); } catch (e2) {}
    }
  }
  async function muteHere() {
    const S = NS.Settings;
    if (S && S.set) {
      try { await S.set({ perSite: { [HOST]: { [MODULE_ID]: false } } }); } catch (e) {}
    }
    state.stats.muted++;
    hideCard();
    hidePill();
    disengage();
    console.info("[SL:FG] muted on " + HOST + " - re-enable with: SecondLook.FG.enableHere()");
  }

  /* ---------- events --------------------------------------- */
  function onFocusIn(ev) {
    const t = ev.target;
    if (!(t && t.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    if ((t.getAttribute("type") || "").toLowerCase() === "hidden" || t.disabled) return;
    if (state.card) hideCard();
    const form = t.form || t.closest("form");
    const v = verdictFor(t, form);
    state.last = v;
    if (v.silent) { hidePill(); return; }
    showPill(v, t);
    state.stats[v.verdict === "CLEAR" ? "clear" : "warn"]++;
    if (v.verdict !== "CLEAR") enrich(v, v.meta.actionUrl, t);
  }
  function onFocusOut() {
    if (state.card) return;
    if (state.pill) {
      clearTimeout(state.pillTimer);
      state.pillTimer = setTimeout(hidePill, 900);
    }
  }
  function onSubmit(ev) {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    const a = actionOf(form);
    if (a.local) return;
    if (state.bypassForms.has(form) || state.bypassActions.has(a.url)) return;
    const v = classify(scanFields(Array.from(form.querySelectorAll("input, select, textarea"))), a);
    mergeEngine(v, state.engineCache.get(a.url)); // only cached engine input: the decision must be synchronous
    state.last = v;
    if (v.verdict === "INTERCEPTED") {
      ev.preventDefault();
      ev.stopPropagation();
      state.stats.blocked++;
      hidePill();
      showCard(v, { form: form });
    }
  }
  function onKeydown(ev) {
    if (ev.key === "Escape" && state.card) hideCard();
  }

  function engage() {
    if (state.engaged) return;
    state.engaged = true;
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("keydown", onKeydown, true);
  }
  function disengage() {
    if (!state.engaged) return;
    state.engaged = false;
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("submit", onSubmit, true);
    document.removeEventListener("keydown", onKeydown, true);
    hidePill();
    hideCard();
  }

  /* ---------- settings integration ------------------------- */
  function waitForSettings(timeout) {
    timeout = timeout || 2000;
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function tick() {
        if (NS.Settings && NS.Settings.isModuleOn) return resolve(NS.Settings);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 100);
      })();
    });
  }
  async function start() {
    if (state.started) return;
    state.started = true;
    const S = await waitForSettings();
    if (!S) { console.warn("[SL:FG] settings core unavailable - Form Guardian idle"); return; }
    state.enabled = await S.isModuleOn(MODULE_ID);
    if (state.enabled) engage();
    state.unsub = S.onChange(async () => {
      const now = await S.isModuleOn(MODULE_ID);
      if (now !== state.enabled) {
        state.enabled = now;
        if (now) engage(); else disengage();
      }
    });
    console.info("[SL:FG] Form Guardian v" + __version + " " + (state.enabled ? "armed" : "idle (module off)") + " on " + (HOST || "this page"));
  }
  function stop() {
    if (state.unsub) state.unsub();
    state.unsub = null;
    disengage();
    state.started = false;
  }
  async function enableHere() {
    const S = NS.Settings;
    if (!S || !S.set) return { ok: false };
    const r = await S.set({ perSite: { [HOST]: { [MODULE_ID]: true } } });
    state.enabled = true;
    engage();
    return r;
  }
  async function debug() {
    return {
      module: MODULE_ID,
      version: __version,
      enabled: state.enabled,
      engaged: state.engaged,
      host: HOST,
      stats: Object.assign({}, state.stats),
      last: state.last ? { verdict: state.last.verdict, action: state.last.meta.action } : null,
      listeners: { focusin: state.engaged, submit: state.engaged },
      moduleOn: NS.Settings ? await NS.Settings.isModuleOn(MODULE_ID).catch(() => "error") : "core-missing",
    };
  }

  /* ---------- export + boot -------------------------------- */
  NS.FG = {
    __version: __version,
    start: start,
    stop: stop,
    debug: debug,
    enableHere: enableHere,
    analyzeForm: (form) => verdictFor(
      (form && (form.querySelector("input:not([type=hidden]), select, textarea") || form)) || form, form),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  } else {
    start();
  }
})();