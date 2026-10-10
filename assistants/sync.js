// Game Assistants: sync across browsers with Google.
//
// Once linked, everything the assistants keep in this browser (notes,
// checklists, planners, saved coordinates, the linked game library and each
// game companion's goals, notes and sessions) is copied to assistants.json in
// the hidden app folder of the user's own Google Drive, the same folder the
// Adventurer's Journal syncs to. It goes straight between this browser and
// Google, never through tavernworks.dev.
//
// Each saved value (one localStorage key) is merged on its own: the most
// recently changed copy wins. This script wraps localStorage so it can note
// when an assistant saves, which is why it must load before the page's own
// script. Google's access tokens last an hour; after that, syncing waits for a
// tap on the Sync button.
//
// Needs /bot-sandbox/app/config.js and /google-signin.js loaded first. Pages load
// it as sync.js?v=N; bump N everywhere when this file changes so browsers don't
// keep running an old copy. The
// button goes in #tw-sync if the page has one, else at the bottom of #nav,
// else before the page's <footer>.
(function () {
  "use strict";
  const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3/files";
  const FILE = "assistants.json", FORMAT = "tavernworks-assistants-sync";
  const KEY = "tw.sync", TOKEN_KEY = "tw.sync.token";
  // The assistants' saved data: library, companions, Stationeers, Oddsparks, Icarus, How to Fish, Raft, PEAK, Minecraft.
  const BUILT_IN = /^(tw\.library|tw\.companion\..+|sa_state|osa_state|ica_state|htf_state|raft_state|peak_state|mca_[a-z]+)$/;
  // A page can name its own keys too (<script src=sync.js data-track="a_state b_state">), so a
  // new assistant syncs even before this list learns about it.
  const EXTRA = new Set(((document.currentScript && document.currentScript.dataset.track) || "").split(/[\s,]+/).filter(Boolean));
  const TRACK = { test: (k) => BUILT_IN.test(k) || EXTRA.has(k) };

  let LS = null;
  try { LS = window.localStorage; } catch {}
  if (!LS) return;
  const P = Storage.prototype, rawGet = P.getItem, rawSet = P.setItem;
  const get = (k) => rawGet.call(LS, k);
  const set = (k, v) => { try { rawSet.call(LS, k, v); } catch {} };
  const json = (k, fallback) => { try { const v = get(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

  // {linked, email, last, meta: {key: {h: hash of the value, t: when it became that value}}}
  // t is 0 for a value saved before this script existed, so a synced copy wins over it.
  const state = () => { const s = json(KEY, {}); s.meta = s.meta || {}; return s; };
  const putState = (s) => set(KEY, JSON.stringify(s));
  const hash = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + "." + str.length; };
  const tracked = (store, k) => store === LS && TRACK.test(String(k));

  // Keys this page has read: if a sync changes one, the page reloads to show it.
  const used = new Set();
  P.getItem = function (k) {
    if (tracked(this, k)) used.add(String(k));
    return rawGet.call(this, k);
  };
  P.setItem = function (k, v) {
    const t = tracked(this, k), old = t ? rawGet.call(this, k) : null;
    rawSet.call(this, k, v);
    // Re-saving the same value (some pages save as they load) isn't a change.
    if (t && old !== String(v)) touched(String(k), String(v));
  };
  function touched(k, v) {
    const s = state(), h = hash(v);
    if (s.meta[k] && s.meta[k].h === h) return;
    s.meta[k] = { h, t: Date.now() };
    putState(s);
    soon();
  }

  let token = json(TOKEN_KEY, null);
  const hasToken = () => !!token && token.exp > Date.now() + 30000;
  const dropToken = () => { token = null; try { LS.removeItem(TOKEN_KEY); } catch {} };
  const signInError = () => Object.assign(new Error("Sign in again to sync."), { signIn: true });
  let running = null, busy = false, again = false, timer = 0, needsTap = false, stale = false;

  // ----- UI -----
  const box = document.createElement("div");
  box.className = "tw-sync";
  box.innerHTML = '<button type="button" class="tw-sync-btn"></button><div class="tw-sync-line"></div><button type="button" class="tw-sync-link tw-sync-reload" hidden>Reload to see them</button><button type="button" class="tw-sync-link tw-sync-off" hidden>Stop syncing</button>';
  const css = document.createElement("style");
  css.textContent = `.tw-sync{margin:14px 0 4px;padding:10px;border:1px solid rgba(160,140,110,.35);border-radius:10px;font-size:12.5px;line-height:1.4}
.tw-sync-btn{display:block;width:100%;padding:7px 10px;border-radius:7px;border:1px solid rgba(160,140,110,.5);background:rgba(255,255,255,.06);color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:center}
.tw-sync-btn:hover:not(:disabled){background:rgba(255,255,255,.12)}
.tw-sync-btn:disabled{opacity:.6;cursor:default}
.tw-sync-line{margin-top:6px;opacity:.75;overflow-wrap:anywhere}
.tw-sync-line.bad{color:#f08a7a;opacity:1}
.tw-sync-link{display:inline-block;margin:6px 10px 0 0;padding:0;border:0;background:none;color:inherit;font:inherit;opacity:.75;text-decoration:underline;cursor:pointer}
.tw-sync-link:hover{opacity:1}
.tw-sync [hidden]{display:none!important}
#nav .tw-sync{width:100%}
.wrap>.tw-sync{max-width:360px;margin:32px 0 0}`;
  const $ = (c) => box.querySelector(c);

  function show(line, bad) {
    const s = state();
    $(".tw-sync-btn").textContent = !s.linked ? "☁ Sync with Google" : needsTap ? "☁ Sign in to sync" : "☁ Sync now";
    $(".tw-sync-btn").disabled = busy;
    $(".tw-sync-off").hidden = !s.linked;
    $(".tw-sync-reload").hidden = !stale;
    const el = $(".tw-sync-line");
    el.className = "tw-sync-line" + (bad ? " bad" : "");
    el.textContent = line || (stale ? "Changes came in from another browser."
      : !s.linked ? "Keep your assistants' notes, checklists and games the same in every browser you use."
      : needsTap ? "Tap above to pick up changes from your other browsers."
      : s.last ? `Synced ${new Date(s.last).toLocaleTimeString([], { timeStyle: "short" })}${s.email ? " · " + s.email : ""}`
      : s.email || "");
  }

  function place() {
    const spot = document.getElementById("tw-sync");
    const nav = document.getElementById("nav");
    if (spot) { if (!spot.contains(box)) spot.appendChild(box); return; }
    if (nav) {
      // The assistants redraw their nav on every page change; put the box back.
      const keep = () => { if (!nav.contains(box)) nav.appendChild(box); };
      new MutationObserver(keep).observe(nav, { childList: true });
      keep();
      return;
    }
    const foot = document.querySelector("footer");
    if (foot) foot.before(box); else document.body.appendChild(box);
  }

  // ----- Google -----
  async function signIn() {
    const clientId = window.TBS_GOOGLE_CLIENT_ID;
    if (!clientId || !window.googleLoad) throw new Error("Google sign-in isn't set up on this site yet.");
    await window.googleLoad();
    await new Promise((res, rej) => {
      google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE, login_hint: state().email || undefined,
        callback: (r) => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return rej(new Error("Tick the Google Drive box when Google asks, so the assistants can keep their copy there."));
          token = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          set(TOKEN_KEY, JSON.stringify(token));
          res();
        },
        error_callback: (e) => rej(new Error(
          e && e.type === "popup_failed_to_open" ? "The Google window was blocked. Allow pop-ups for tavernworks.dev and try again."
          : e && e.type === "popup_closed" ? "The Google window was closed before signing in."
          : "Google sign-in failed.")),
      }).requestAccessToken({ prompt: "" });
    });
    needsTap = false;
  }
  async function g(url, opt = {}) {
    if (!hasToken()) throw signInError();
    const r = await fetch(url.startsWith("http") ? url : API + url, { ...opt, headers: { Authorization: "Bearer " + token.value, ...(opt.headers || {}) } });
    if (r.ok) return r;
    let msg = "Google Drive said " + r.status, reason = "";
    try { const j = await r.json(); msg = (j.error && j.error.message) || msg; reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ""; } catch {}
    if (r.status === 401 || /insufficient(Permissions|Scopes)/.test(reason)) { dropToken(); throw signInError(); }
    if (reason === "accessNotConfigured" || /has not been used|is disabled/.test(msg)) throw new Error("Google Drive sync isn't switched on for this site yet.");
    if (reason === "storageQuotaExceeded") throw new Error("Your Google Drive is full, so the assistants can't sync.");
    throw new Error(msg);
  }
  async function findFiles() {
    const q = new URLSearchParams({ spaces: "appDataFolder", q: `name = '${FILE}' and trashed = false`, fields: "files(id,version)", pageSize: "100" });
    return (await (await g("/files?" + q)).json()).files || [];
  }
  async function upload(text, id) {
    const type = "application/json";
    if (id) return g(`${UP}/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": type }, body: text });
    const b = "assistants" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: FILE, parents: ["appDataFolder"] });
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n${text}\r\n--${b}--\r\n`;
    return g(`${UP}?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body });
  }
  const remove = (id) => g(`/files/${id}`, { method: "DELETE" }).catch(() => {});

  // ----- One sync -----
  // Values are {v: the saved string, t: when it was saved}; the newer t wins.
  const newer = (a, b) => !a ? b : !b ? a : b.t > a.t ? b : a;
  function localValues() {
    const s = state(), out = {}, now = Date.now();
    let dirty = false;
    for (let i = 0; i < LS.length; i++) {
      const k = LS.key(i);
      if (!TRACK.test(k)) continue;
      const v = get(k), h = hash(v), m = s.meta[k];
      // Saved without going through the wrapper (another tab mid-update, say).
      if (!m || m.h !== h) { s.meta[k] = { h, t: m ? now : 0 }; dirty = true; }
      out[k] = { v, t: s.meta[k].t };
    }
    if (dirty) putState(s);
    return out;
  }

  async function once(progress) {
    progress("Checking Google Drive…");
    const local = localValues();
    const files = await findFiles();
    let remote = {};
    for (const f of files) {
      const j = await (await g(`/files/${f.id}?alt=media`)).json().catch(() => null);
      if (j && j.format === FORMAT && j.keys) for (const [k, r] of Object.entries(j.keys)) {
        if (TRACK.test(k) && r && typeof r.v === "string") remote[k] = newer(remote[k], { v: r.v, t: Number(r.t) || 0 });
      }
    }

    // Bring this browser up to date, unless a key changed here while we looked.
    const merged = {}, changed = [];
    const s = state();
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const l = local[k], r = remote[k];
      // On a tie (both saved before syncing existed) the copy already in Drive wins.
      const w = l && r ? (l.v === r.v ? { v: l.v, t: Math.max(l.t, r.t) } : l.t > r.t ? l : r) : l || r;
      merged[k] = w;
      if (l && w.v === l.v) { if (w.t !== l.t) s.meta[k] = { h: hash(l.v), t: w.t }; continue; }
      if (get(k) !== (l ? l.v : null)) continue;
      set(k, w.v);
      s.meta[k] = { h: hash(w.v), t: w.t };
      changed.push(k);
    }
    putState(s);

    const [first, ...extra] = files;
    if (first) {
      // Another browser saved meanwhile: go round again with its version.
      const { version } = await (await g(`/files/${first.id}?fields=version`)).json();
      if (String(version) !== String(first.version)) return { again: true, changed };
    }
    const same = Object.keys(merged).length === Object.keys(remote).length && Object.entries(merged).every(([k, w]) => remote[k] && remote[k].v === w.v && remote[k].t === w.t);
    if (!same || extra.length || !first) {
      progress("Saving to Google Drive…");
      await upload(JSON.stringify({ format: FORMAT, version: 1, saved: new Date().toISOString(), keys: merged }), first && first.id);
      await Promise.all(extra.map((f) => remove(f.id)));
    }
    const done = state();
    done.last = Date.now();
    putState(done);
    return { again: false, changed };
  }

  const editing = () => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };

  async function run(interactive) {
    if (running) { again = true; return running; }
    if (!state().linked) return;
    clearTimeout(timer);
    busy = true;
    running = (async () => {
      let msg = "", bad = false;
      try {
        if (!hasToken()) {
          if (!interactive) { needsTap = true; return; }
          show("Waiting for Google…");
          await signIn();
        }
        show("Syncing…");
        for (let i = 0; i < 3; i++) {
          const r = await once((t) => show(t));
          if (r.changed.some((k) => used.has(k))) stale = true;
          if (!r.again) break;
        }
      } catch (err) {
        console.warn("Assistants sync:", err);
        if (err && err.signIn) needsTap = true;
        else { msg = "⚠ " + (err && err.message || err); bad = true; }
      } finally {
        running = null; busy = false;
        show(msg, bad);
      }
      // This page read its data before the sync changed it: reload so it shows
      // (and doesn't later save over) the newer copy. Wait if something's being typed.
      if (stale && !editing()) { location.reload(); return; }
      if (again && !bad) soon(1500);
      again = false;
    })();
    return running;
  }
  function soon(ms = 4000) {
    if (!state().linked || !hasToken()) return;
    clearTimeout(timer);
    timer = setTimeout(() => run(false), ms);
  }

  async function link() {
    try {
      busy = true;
      show("Waiting for Google…");
      await signIn();
      busy = false;
      const s = state();
      s.linked = true;
      try { s.email = (await (await g("/about?fields=user(emailAddress)")).json()).user.emailAddress; } catch {}
      putState(s);
      await run(true);
    } catch (err) {
      busy = false;
      show("⚠ " + (err && err.message || err), true);
    }
  }
  async function unlink() {
    if (!confirm("Stop syncing the Game Assistants in this browser?\n\nEverything stays here, and the copy stays in your Google Drive for your other browsers.")) return;
    const wipe = hasToken() && confirm("Also delete the assistants' copy from your Google Drive?\n\nOK deletes it (other browsers keep their own data but stop syncing). Cancel keeps it.");
    try {
      if (wipe) { show("Deleting the copy in Google Drive…"); await Promise.all((await findFiles()).map((f) => remove(f.id))); }
    } catch (err) { alert("Couldn't delete the Drive copy: " + (err && err.message || err)); }
    // The token isn't revoked: the journal's sync uses the same Google access.
    const s = state();
    putState({ meta: s.meta });
    dropToken(); needsTap = false; stale = false; clearTimeout(timer);
    show(wipe ? "Stopped syncing and deleted the Drive copy." : "Stopped syncing.");
  }

  // Load Google's script before the click, so its window opens straight from
  // the tap (Safari blocks pop-ups that open after a wait).
  const preload = () => { if (window.googleLoad && window.TBS_GOOGLE_CLIENT_ID) window.googleLoad().catch(() => {}); };
  ["pointerenter", "focus", "touchstart"].forEach((ev) => $(".tw-sync-btn").addEventListener(ev, preload, { passive: true, once: true }));
  $(".tw-sync-btn").addEventListener("click", () => state().linked ? run(true) : link());
  $(".tw-sync-off").addEventListener("click", unlink);
  $(".tw-sync-reload").addEventListener("click", () => location.reload());
  setInterval(() => { if (!document.hidden && hasToken()) run(false); }, 120000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && hasToken()) soon(500); });
  // Another tab signed in: use its token.
  addEventListener("storage", (e) => { if (e.key === TOKEN_KEY) { token = json(TOKEN_KEY, null); if (hasToken() && needsTap) { needsTap = false; show(); soon(500); } } });

  function start() {
    document.head.appendChild(css);
    place();
    show();
    if (state().linked) { preload(); if (hasToken()) soon(300); else { needsTap = true; show(); } }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
