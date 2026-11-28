/* rosin-sync.js: one Rosin across Sheamus's devices (load after the other rosin-*.js files).
 *
 *   - Settings: a change on one device (the phone, the Windows app, a browser) shows up on the others within a second or
 *     two. They go through his own laptop's gate (GET /api/sync waits for the next change), never through anyone else.
 *     Only settings that make sense everywhere sync; this device's name, microphone, chat history and OBS password stay here.
 *   - Twitch chat: only one device answers chat at a time (the Windows app takes over from a phone or a browser), and
 *     every device shows which channel Rosin is watching, whether Twitch confirmed it, and the last line it saw.
 *     ⋯ → Twitch sets how it answers (best line, only when named, or one line in every N) and, once an account is
 *     linked on the laptop, also types the answers in chat.
 *   - Spotify: a sign-in on one device is handed to the laptop, which keeps it for all of them (rosin-spotify.js).
 *   - Site updates: when tavernworks.dev/rosin changes, an open Rosin reloads itself the next time it's idle.
 *
 * Nothing here holds a secret: the laptop keeps the Spotify and Twitch sign-ins, and devices only use what it hands out.
 * URL: ?sync=0 keeps this page to itself (its Twitch chip and ⋯ → Twitch still work, just for this page).
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R || window.ROSIN_MIRROR) return;
  const params = new URLSearchParams(location.search);
  const ALONE = params.get("sync") === "0";
  const OBS = !!R.OBS || H.device() === "obs";
  const SEC = 1000, MIN = 60 * SEC;
  const store = H.store, GATE = H.GATE;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / SEC)); return s < 5 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

  // The same list as the gate's SYNC_KEYS: the gate ignores anything else.
  const KEYS = new Set(["name", "modelv", "model", "voice", "rate", "pitch", "moodAuto", "callBarge", "web", "channel", "twitchOn",
    "awake", "stt", "pause", "chatter", "chatterPace", "chat.mode", "chat.every", "chat.gap", "chat.post", "chat.pick",
    "init.level", "init.quietOn", "init.quietFrom", "init.quietTo", "init.hushUntil", "init.stream", "init.topics", "init.nudges",
    "init.mod", "init.modOnly", "init.modWords", "google.on", "self.on", "self.repo", "spotify.clientId", "spotify.antennae",
    "spotify.duck", "compass.calUrl", "compass.track", "compass.things", "compass.suggest", "compass.remind", "compass.pace",
    "ear.words", "update.auto"]);
  // A device voice's name only means something in the browser that has it; "" (automatic) and the laptop's voices go everywhere.
  const shareable = (k, v) => KEYS.has(k) && !(k === "voice" && typeof v === "string" && v && !v.startsWith("laptop:"));
  // The OBS overlay takes its settings from its link (?channel=…), so it follows along but never changes the others.
  const SEND = !OBS && !ALONE;

  const id = (() => { let v = store.get("sync.id", ""); if (!/^[\w-]{8,40}$/.test(v)) { v = "d" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set("sync.id", v); } return v; })();
  const LABELS = { "android-widget": "phone", "android-app": "phone app", phone: "phone", tablet: "tablet", "windows-app": "Windows app",
    handheld: "Legion Go", obs: "OBS", desktop: "a browser" };
  const kind = () => { const k = H.device(); return k === "android-widget" ? "android-app" : k; };
  const label = () => (B.settings?.deviceName || "").trim() || LABELS[kind()] || "a device";

  // ---------- settings ----------
  const sync = { rev: 0, persist: null, ok: false, fails: 0, snap: null, known: {} };   // known: when each value last changed, as the gate tells it
  const queue = new Map(); let pushTimer = null, applying = false;
  const rawSet = store.set.bind(store);
  store.set = (k, v) => {
    rawSet(k, v);
    if (applying || !SEND || !shareable(k, v)) return;
    queue.set(k, v);
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 300);
  };
  async function push() {
    if (!queue.size) return;
    const set = Object.fromEntries(queue); queue.clear();
    try {
      const r = await fetch(GATE + "/api/sync", H.gopts({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set, from: id }), signal: H.timeout(15 * SEC) }));
      if (!r.ok) throw new Error("gate " + r.status);
    } catch { for (const [k, v] of Object.entries(set)) if (!queue.has(k)) queue.set(k, v); pushTimer = setTimeout(push, 5 * SEC); }
  }
  function apply(k, v) {
    if (JSON.stringify(store.get(k, undefined)) === JSON.stringify(v)) return;
    applying = true;
    try { rawSet(k, v); H.applySynced?.(k, v); } catch (e) { console.warn("sync", k, e); } finally { applying = false; }
    window.dispatchEvent(new CustomEvent("rosin-synced", { detail: { k, v } }));
  }
  function take(snap, first) {
    sync.snap = snap; sync.persist = !!snap.persist;
    const vals = snap.values || {}, seed = {};
    for (const [k, e] of Object.entries(vals)) {
      if (!KEYS.has(k) || !e || queue.has(k)) continue;   // a change made here that's still on its way wins
      if (sync.known[k] === e.at) continue;
      sync.known[k] = e.at;
      if (first || e.by !== id) apply(k, e.v);
    }
    if (first && SEND) {
      // The first device to meet the laptop shares what it has, so the others start from Sheamus's settings, not blanks.
      for (const k of KEYS) { if (vals[k]) continue; const v = store.get(k, undefined); if (v !== undefined && shareable(k, v)) seed[k] = v; }
      if (Object.keys(seed).length) { for (const [k, v] of Object.entries(seed)) queue.set(k, v); push(); }
    }
    siteCheck(snap.site);
    window.dispatchEvent(new CustomEvent("rosin-sync-state", { detail: { persist: sync.persist, spotify: snap.spotify || {}, twitch: snap.twitch || {} } }));
    drawTwitch();
  }
  let pulling = false, first = true;
  async function pull() {
    if (pulling) return; pulling = true;
    while (true) {
      try {
        const wait = first ? 0 : 25;
        const r = await fetch(`${GATE}/api/sync?since=${sync.rev}&wait=${wait}`, H.gopts({ cache: "no-store", signal: H.timeout((wait + 15) * SEC) }));
        if (r.status === 404) { sync.ok = false; sync.fails = 99; drawTwitch(); break; }   // an older gate: nothing to sync with yet
        if (!r.ok) throw new Error("gate " + r.status);
        const snap = await r.json();
        sync.ok = true; sync.fails = 0;
        const changed = snap.rev !== sync.rev; sync.rev = snap.rev;
        if (changed || first) take(snap, first);
        first = false;
      } catch {
        sync.ok = false; sync.fails++; drawTwitch();
        await new Promise((done) => setTimeout(done, Math.min(30, 2 + sync.fails * 3) * SEC));
      }
      if (document.hidden && sync.fails > 3) await new Promise((done) => setTimeout(done, 20 * SEC));
    }
    pulling = false;
  }

  // ---------- Twitch: which device answers, and what it sees ----------
  const tw = { you: true, holder: null, status: null, poster: { linked: false }, beat: 0, takeNext: false, lastPost: "" };
  H.answerHere = () => !sync.ok || tw.you;   // laptop out of reach: each device decides for itself, as before
  async function heartbeat() {
    if (OBS || ALONE) { drawTwitch(); return; }   // the overlay reads chat for show, the apps and browsers answer it
    const st = H.twitchStatus(), want = !!st.on;
    if (!want && !tw.you && !tw.wanted) return;
    tw.wanted = want;
    try {
      const status = { channel: st.channel, state: st.state, joinedAt: st.joinedAt, seen: st.seen, answered: st.answered, lastMsg: st.lastMsg,
        lastAnswer: st.lastAnswer, mode: st.mode, posting: !!(store.get("chat.post", false) && tw.poster.linked), error: st.error };
      const r = await fetch(GATE + "/api/twitch/here", H.gopts({ method: "POST", headers: { "Content-Type": "application/json" }, signal: H.timeout(10 * SEC),
        body: JSON.stringify({ id, label: label(), kind: kind(), want, take: tw.takeNext, status }) }));
      if (r.status === 404) return;
      const j = await r.json();
      tw.takeNext = false;
      tw.you = !!j.you; tw.holder = j.holder; tw.status = j.status; tw.poster = j.poster || { linked: false };
      if (tw.poster.login) H.extraBots.add(tw.poster.login.toLowerCase());
    } catch {}
    drawTwitch();
  }
  H.tick(15 * SEC, heartbeat);
  window.addEventListener("rosin-twitch-state", () => { if (Date.now() - tw.beat > 3 * SEC) { tw.beat = Date.now(); heartbeat(); } else drawTwitch(); });

  // Typing the answer in Twitch chat too (once an account is linked on the laptop and "Also type answers" is on).
  window.addEventListener("rosin-chat-answered", async (e) => {
    const d = e.detail || {}, st = H.twitchStatus();
    if (!store.get("chat.post", false) || !tw.poster.linked || !tw.you || !st.channel || !d.answer) return;
    const who = d.chat?.user ? "@" + d.chat.user + " " : "";
    try {
      const r = await fetch(GATE + "/api/twitch/say", H.gopts({ method: "POST", headers: { "Content-Type": "application/json" }, signal: H.timeout(20 * SEC),
        body: JSON.stringify({ channel: st.channel, text: who + d.answer }) }));
      const j = await r.json().catch(() => ({}));
      tw.lastPost = r.ok ? "" : j.error || "Twitch didn't take it.";
    } catch (err) { tw.lastPost = "Couldn't reach the laptop to post in chat."; }
    drawTwitch();
  });

  // ---------- the chip: is Rosin watching chat? ----------
  const chip = el("button", "tw-chip"); chip.type = "button"; chip.id = "twchip"; chip.hidden = true;
  chip.setAttribute("aria-controls", "twitch"); chip.setAttribute("aria-expanded", "false");
  const status = document.getElementById("status");
  status.parentNode.insertBefore(chip, status.nextSibling);

  // ---------- ⋯ → Twitch ----------
  const panel = el("div", "tray"); panel.id = "twitch"; panel.hidden = true; panel.setAttribute("aria-label", "Twitch chat");
  document.getElementById("controls").insertBefore(panel, document.getElementById("say"));
  const openBtn = el("button", "", "Twitch"); openBtn.type = "button"; openBtn.id = "btn-twitch";
  openBtn.setAttribute("aria-expanded", "false"); openBtn.setAttribute("aria-controls", "twitch");
  H.quick.append(openBtn);
  const TRAYS = ["more", "changes", "compass", "faces", "log", "initiative", "music"];
  function openPanel(open) {
    panel.hidden = !open; openBtn.setAttribute("aria-expanded", String(open)); chip.setAttribute("aria-expanded", String(open));
    if (open) for (const t of TRAYS) {
      const n = document.getElementById(t);
      if (n && !n.hidden) { n.hidden = true; document.querySelectorAll(`[aria-controls="${t}"]`).forEach((b) => b.setAttribute("aria-expanded", "false")); }
    }
    drawTwitch(); H.fit();
  }
  openBtn.addEventListener("click", () => openPanel(panel.hidden));
  chip.addEventListener("click", () => openPanel(panel.hidden));
  document.addEventListener("click", (e) => {   // opening another tray closes this one
    const b = e.target.closest?.("[aria-controls]");
    if (b && b !== openBtn && b !== chip && !panel.hidden && TRAYS.includes(b.getAttribute("aria-controls"))) openPanel(false);
  }, true);

  const nowP = el("p", "tw-now"), lastP = el("p", "tw-dim"), whoP = el("p", "tw-dim");
  const takeBtn = el("button", "", "Answer chat from here"); takeBtn.type = "button";
  const modeSel = document.createElement("select");
  modeSel.append(new Option("Pick the best line to answer", "pick"), new Option("Only lines that name Rosin (@rosin, !rosin)", "mention"), new Option("One line in every few", "every"));
  const everyIn = Object.assign(document.createElement("input"), { type: "number", min: 2, max: 50, step: 1, inputMode: "numeric" });
  const gapSel = document.createElement("select");
  for (const [s, t] of [[10, "10 seconds"], [20, "20 seconds"], [45, "45 seconds"], [90, "1.5 minutes"], [180, "3 minutes"]]) gapSel.append(new Option(t, String(s)));
  const everyField = H.field("Answer one line in every", everyIn);
  const [postChk, postBox] = H.check("Also type the answers in Twitch chat");
  const postNote = el("p", "tw-dim");
  const idIn = Object.assign(document.createElement("input"), { type: "text", placeholder: "Client ID from dev.twitch.tv/console", autocomplete: "off", spellcheck: false, autocapitalize: "off" });
  const linkBtn = el("button", "", "Link the chat account"); linkBtn.type = "button";
  const unlinkBtn = el("button", "", "Unlink"); unlinkBtn.type = "button";
  const codeBox = el("div", "tw-code"); codeBox.hidden = true;
  const syncP = el("p", "tw-dim");
  const closeBtn = el("button", "", "Close"); closeBtn.type = "button";
  const linkBox = el("div", "tw-link"); linkBox.append(H.field("Twitch app Client ID", idIn), linkBtn, codeBox);
  panel.append(nowP, lastP, whoP, takeBtn, el("p", "tw-h", "How Rosin answers"), H.field("Answer", modeSel), everyField, H.field("At most one answer every", gapSel),
    el("p", "tw-dim", "Rosin always skips bots, chat commands (!so and the like) and anything that looks like spam, and never answers the same viewer twice in 90 seconds."),
    el("p", "tw-h", "In chat"), postChk, postNote, linkBox, unlinkBtn, el("p", "tw-h", "Your devices"), syncP, closeBtn);
  closeBtn.addEventListener("click", () => { openPanel(false); openBtn.focus(); });
  modeSel.addEventListener("change", () => { store.set("chat.mode", modeSel.value); drawTwitch(); H.fit(); });
  everyIn.addEventListener("change", () => { const n = Math.min(50, Math.max(2, Math.round(Number(everyIn.value) || 5))); everyIn.value = n; store.set("chat.every", n); });
  gapSel.addEventListener("change", () => store.set("chat.gap", Number(gapSel.value)));
  postBox.addEventListener("change", () => { store.set("chat.post", postBox.checked); drawTwitch(); H.fit(); heartbeat(); });
  takeBtn.addEventListener("click", () => { tw.takeNext = true; heartbeat(); });
  window.addEventListener("rosin-synced", (e) => { if (/^chat\.|^channel$|^twitchOn$/.test(e.detail?.k || "")) drawTwitch(); });

  // Linking the account Rosin types as: Twitch's device code. The laptop asks Twitch for a code, Sheamus enters it at
  // twitch.tv/activate while signed in as that account, and the laptop keeps the sign-in. This page never sees a token.
  let linkPoll = null;
  async function linkCall(kind, body = {}) {
    const r = await fetch(GATE + "/api/twitch/" + kind, H.gopts({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: H.timeout(20 * SEC) }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "The laptop answered " + r.status);
    return j;
  }
  function showCode(code, uri) {
    codeBox.hidden = false; codeBox.replaceChildren();
    const a = el("a", "", "twitch.tv/activate"); a.href = /^https:\/\/(www\.)?twitch\.tv\/activate/.test(uri || "") ? uri : "https://www.twitch.tv/activate"; a.target = "_blank"; a.rel = "noopener";
    const p1 = el("p", ""); p1.append("Open ", a, " signed in as the account Rosin should type as, and enter:");
    codeBox.append(p1, el("p", "tw-big", code || ""), el("p", "tw-dim", "This waits here until you've done it (the code lasts 30 minutes)."));
    H.fit();
  }
  linkBtn.addEventListener("click", async () => {
    linkBtn.disabled = true; postNote.textContent = "";
    try {
      const j = await linkCall("link", { clientId: idIn.value.trim() });
      showCode(j.code, j.uri);
      clearInterval(linkPoll);
      linkPoll = setInterval(async () => {
        try {
          const c = await linkCall("check");
          if (c.linked) { clearInterval(linkPoll); codeBox.hidden = true; tw.poster = { linked: true, login: c.login }; H.extraBots.add(String(c.login || "").toLowerCase()); heartbeat(); }
          else if (c.expired) { clearInterval(linkPoll); codeBox.hidden = true; postNote.textContent = "The code ran out. Press Link again."; }
        } catch (e) { clearInterval(linkPoll); codeBox.hidden = true; postNote.textContent = e.message; }
        drawTwitch();
      }, 5 * SEC);
    } catch (e) { postNote.textContent = e.message; }
    linkBtn.disabled = false; drawTwitch();
  });
  unlinkBtn.addEventListener("click", async () => {
    unlinkBtn.disabled = true;
    try { await linkCall("unlink"); tw.poster = { linked: false }; store.set("chat.post", false); } catch (e) { postNote.textContent = e.message; }
    unlinkBtn.disabled = false; drawTwitch();
  });

  const STATE_WORDS = { connecting: "Connecting to Twitch…", joining: "Joining", watching: "Watching", lost: "Lost the connection, reconnecting", error: "Problem", off: "Off" };
  function chipText(st) {
    if (!st.on) return "";
    if (st.state === "watching") return `● #${st.channel}`;
    if (st.state === "error") return `⚠ #${st.channel}`;
    return `○ #${st.channel}…`;
  }
  function drawTwitch() {
    const st = H.twitchStatus();
    // The chip: on every device with Twitch on. Green once Twitch has confirmed the channel.
    chip.hidden = !st.on;
    chip.textContent = chipText(st);
    chip.dataset.state = st.state;
    const answering = !st.on ? "" : !sync.ok ? "this device" : tw.you ? "this device" : tw.holder ? tw.holder.label : "nobody yet";
    chip.title = st.on ? `${STATE_WORDS[st.state] || st.state} #${st.channel}. Answering: ${answering}. Tap for Twitch.` : "";
    chip.setAttribute("aria-label", chip.title || "Twitch");
    if (panel.hidden) return;

    const mode = store.get("chat.mode", "pick");
    modeSel.value = ["pick", "mention", "every"].includes(mode) ? mode : "pick";
    everyIn.value = store.get("chat.every", 5); everyField.hidden = modeSel.value !== "every";
    const gap = String(store.get("chat.gap", 20)); gapSel.value = [...gapSel.options].some((o) => o.value === gap) ? gap : "20";
    if (!st.on) {
      nowP.textContent = "Off. Set the Twitch channel and tick “Answer this Twitch chat” under ⋯.";
      nowP.dataset.state = "off"; lastP.textContent = whoP.textContent = ""; takeBtn.hidden = true;
    } else {
      nowP.dataset.state = st.state;
      nowP.textContent = st.state === "watching" ? `Watching #${st.channel}. Twitch confirmed the channel ${ago(st.joinedAt)}.`
        : st.state === "error" ? st.error || `Something's wrong with #${st.channel}.`
        : st.state === "joining" ? `Joining #${st.channel}, waiting for Twitch to confirm it…`
        : `${STATE_WORDS[st.state] || "Connecting"} (#${st.channel})`;
      // The device that answers is the one whose view counts; the others show what it reported.
      const src = !tw.you && tw.status && tw.status.channel === st.channel ? tw.status : st;
      const m = src.lastMsg, a = src.lastAnswer;
      lastP.textContent = (m ? `Last message seen ${ago(m.at)}: ${m.user}: “${m.text}”` : "No chat messages yet since Rosin joined.")
        + (a ? ` Last answer ${ago(a.at)}${a.user ? " to " + a.user : ""}.` : "") + ` Seen ${src.seen || 0}, answered ${src.answered || 0}.`;
      whoP.textContent = ALONE ? "Answering chat from this device." : !sync.ok ? "Answering chat from this device (the laptop isn't reachable, so devices can't share who answers)."
        : tw.you ? `Answering chat from this device (${label()}). Your other devices just watch.`
        : tw.holder ? `${tw.holder.label} is answering chat. This device just watches.` : "Waiting to see which device answers.";
      takeBtn.hidden = !sync.ok || tw.you || OBS;
    }
    postBox.checked = !!store.get("chat.post", false);
    const linked = !!tw.poster.linked;
    postChk.hidden = !linked; linkBox.hidden = linked; unlinkBtn.hidden = !linked;
    unlinkBtn.textContent = linked ? `Unlink @${tw.poster.login || "account"}` : "Unlink";
    postNote.textContent = tw.lastPost || (linked
      ? (postBox.checked ? `Rosin types its answers in chat as @${tw.poster.login}, at most one every few seconds.` : `Linked as @${tw.poster.login}. Rosin only says its answers out loud until you tick this.`)
      : sync.persist === false ? "Typing in chat needs the laptop's gate update first (tavernworks.dev/local-ai/#sync)."
      : !sync.ok ? "Typing in chat needs the laptop, and it isn't reachable right now."
      : "Rosin says its answers out loud (on stream). To have it type them in chat too, link the Twitch account it should type as. A separate bot account is best, so viewers can tell Rosin's lines from yours.");
    syncP.textContent = ALONE ? "Sync is off on this page, so its settings stay here." : !sync.ok ? (sync.fails >= 99 ? "The laptop's gate is older than this page, so settings don't sync yet. Update the gate (tavernworks.dev/local-ai/#sync)." : "Can't reach the laptop right now, so changes here stay on this device until it's back.")
      : sync.persist ? "Settings sync between your devices through the laptop, within a second or two."
      : "Settings sync between your devices, but the laptop forgets them when it restarts. Finish the gate update (tavernworks.dev/local-ai/#sync) to keep them.";
  }
  H.tick(15 * SEC, () => { if (!panel.hidden) drawTwitch(); });

  // ---------- site updates ----------
  // A self-made change approved under Changes (the laptop says so), or any new version of the page (its ETag): reload
  // once Rosin's idle, so the Windows app and the phone pick it up without anyone pressing reload.
  const SITE_FILES = ["rosin-web.js", "index.html"];
  let siteRev = null, tags = null, reloadWanted = false;
  function siteCheck(site) { if (!site) return; if (siteRev === null) siteRev = site.rev; else if (site.rev !== siteRev) { siteRev = site.rev; reloadWanted = true; } }
  async function etags() {
    const base = location.pathname.replace(/[^/]*$/, "");
    try { return (await Promise.all(SITE_FILES.map((f) => fetch(base + (f === "index.html" ? "" : f), { method: "HEAD", cache: "no-store" }).then((r) => r.headers.get("etag") || r.headers.get("last-modified") || "")))).join("|"); }
    catch { return null; }
  }
  H.later(20 * SEC, async () => { tags = await etags(); });
  H.tick(3 * MIN, async () => { if (tags === null || reloadWanted) return; const t = await etags(); if (t && tags && t !== tags) reloadWanted = true; });
  H.tick(5 * SEC, () => {
    if (!reloadWanted || !store.get("update.auto", true) || H.busy() || H.onCall()) return;
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.value) return;   // don't throw away something half typed
    if (Date.now() - H.lastTurnAt() < 30 * SEC) return;
    reloadWanted = false;
    location.reload();
  });

  B.sync = { id, state: () => ({ ok: sync.ok, persist: sync.persist, rev: sync.rev, you: tw.you, holder: tw.holder }), drawTwitch, heartbeat };
  if (!ALONE) pull();
  H.later(2 * SEC, heartbeat);
  drawTwitch();
})();
