/* rosin-self.js: Rosin changing its own app, with Sheamus's OK (load after rosin-web.js).
 *
 * Ask for a change under ⋯ → Changes, or ask Rosin in conversation ("can you make the Talk button bigger?"): Rosin
 * says what it would change and waits, and it is drafted only once you tap Draft it or say yes.
 * It can be Rosin's own app or any other repo the laptop's GitHub token reaches: pick one, or let Rosin work it out
 * from what you asked (the card always says which). The laptop's gate has a model draft it as small edits, checks
 * them (never workflows, secrets or settings files), and opens a pull request on GitHub. Here you see what it'll do
 * and the exact changes, then Approve (it merges), Reject, or later Undo. Nothing merges without your Approve.
 * The GitHub token stays on the laptop; this page only ever talks to the gate with the laptop key.
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R) return;
  const { store } = H;
  const SEC = 1000, MIN = 60 * SEC;
  let on = store.get("self.on", true);
  let items = [], repos = [], ready = null, gateOld = false, lastErr = "";
  const seen = new Set(store.get("self.seen", []));   // changes Rosin has already told you about
  const justApproved = new Set();

  async function call(path, body) {
    const r = await fetch(H.GATE + path, H.gopts(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: H.timeout(60000) } : { signal: H.timeout(20000), cache: "no-store" }));
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && !body) { gateOld = true; throw new Error("The laptop's gate needs its update for this."); }
    if (!r.ok) throw new Error(j.error || `The laptop answered ${r.status}.`);
    return j;
  }
  async function refresh() {
    if (!H.ready()) return;
    try {
      const j = await call("/api/self");
      gateOld = false; ready = !!j.ready; items = j.items || []; lastErr = "";
      if (Array.isArray(j.repos) && j.repos.length) { repos = j.repos; drawRepos(); }
      announce();
    } catch (e) { if (!gateOld) lastErr = e.message; }
    draw();
  }
  // Tell Sheamus once when a draft is ready (or couldn't be made), in Rosin's own voice. Never on air.
  function announce() {
    for (const it of items) {
      const key = it.pr ? "pr:" + keyOf(it) : it.state === "failed" ? "f" + it.id : "";
      if (!key || seen.has(key) || !(it.state === "ready" || it.state === "failed")) continue;
      seen.add(key); store.set("self.seen", [...seen].slice(-200));
      if (H.onAir() || Date.now() - it.at > 30 * MIN) continue;
      const cue = it.state === "ready"
        ? `${it.self === false ? `Change to their ${clean(it.repoName)} project` : "App change"}: you've drafted "${clean(it.title)}" and it's waiting for their OK under the ⋯ menu, Changes. Tell them in one short, cheerful sentence. Don't say it's done.`
        : `App change: you couldn't draft "${clean(it.request)}". The reason: ${clean(it.error)}. Tell them in one short sentence, and that they can reword it under the ⋯ menu, Changes.`;
      H.speakUp(cue);
      break;
    }
  }
  const keyOf = (it) => (it.pr ? `${it.repo || ""}#${it.pr}` : it.id);
  const clean = (t) => String(t || "").replace(/[\[\]{}<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // Rosin offering a change in conversation ("[change: …]" at the end of its reply). Nothing is drafted until
  // Sheamus says yes: a bar above the chat box shows the offer with Draft it and No thanks, and saying or typing
  // "yes" (or "no") in the next few minutes answers it too.
  const OFFER_FOR = 5 * MIN;
  let offer = null, answered = { want: "", at: 0 }, skipReply = false;   // offer: { want, context, at }
  const offerBar = el("div", "chg-offer"); offerBar.id = "chg-offer"; offerBar.hidden = true;
  offerBar.setAttribute("role", "group"); offerBar.setAttribute("aria-label", "Rosin offers a change");
  const offerText = el("p", "chg-offer-text");
  const offerYes = Object.assign(el("button", "chg-primary", "Draft it"), { type: "button" });
  const offerNo = Object.assign(el("button", "", "No thanks"), { type: "button" });
  const offerBtns = el("div", "chg-offer-btns"); offerBtns.append(offerYes, offerNo);
  offerBar.append(offerText, offerBtns);
  document.getElementById("controls").insertBefore(offerBar, document.getElementById("say"));
  function showOffer(o) {
    offer = o; offerBar.hidden = !o;
    if (o) offerText.textContent = `Rosin offers a change: ${o.want}`;
    H.fit();
  }
  async function takeOffer() {
    const o = offer; if (!o) return;
    showOffer(null); answered = { want: o.want.toLowerCase(), at: Date.now() };
    try { await call("/api/self/draft", { request: o.want, from: "chat", context: o.context, repo: "auto" }); R.status("Drafting that change on the laptop. It'll wait for your OK under ⋯ → Changes."); }
    catch (err) { R.status(err.message, true); }
    refresh();
  }
  offerYes.addEventListener("click", takeOffer);
  function dropOffer() { if (offer) answered = { want: offer.want.toLowerCase(), at: Date.now() }; showOffer(null); }
  offerNo.addEventListener("click", () => { dropOffer(); R.status("Okay, no change."); });
  window.addEventListener("rosin-change", (e) => {
    if (!on || !H.selfReady()) return;
    const want = String(e.detail?.want || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (want.length < 4) return;
    // Rosin's reply to a "yes" or "no" often tags the same change again: that isn't a new offer.
    if (skipReply) { skipReply = false; return; }
    if (want.toLowerCase() === answered.want && Date.now() - answered.at < 10 * MIN) return;
    const context = H.recent(6).map((m) => `${m.role === "user" ? m.who || "Sheamus" : "Rosin"}: ${m.text}`).join("\n");
    showOffer({ want, context, at: Date.now() });
  });
  // A short yes or no from this person, said or typed, answers the offer. Anything else leaves it waiting.
  const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|go for it|draft it|please do|sounds good|absolutely|definitely)\b[\s\S]{0,40}$/i;
  const NO = /^\s*(no|nope|nah|never ?mind|no thanks|don'?t|not now|skip it|cancel)\b[\s\S]{0,40}$/i;
  window.addEventListener("rosin-turn", (e) => {   // rosin-web.js: something this person said or typed
    skipReply = false;
    if (!offer) return;
    if (Date.now() - offer.at > OFFER_FOR) { showOffer(null); return; }
    const t = String(e.detail?.text || "");
    if (YES.test(t)) { skipReply = true; takeOffer(); }
    else if (NO.test(t)) { skipReply = true; dropOffer(); }
  });
  H.tick(30 * SEC, () => { if (offer && Date.now() - offer.at > OFFER_FOR) showOffer(null); });

  // ---------- the Changes panel (⋯ → Changes) ----------
  const panel = document.createElement("div"); panel.id = "changes"; panel.className = "tray"; panel.hidden = true;
  panel.setAttribute("aria-label", "Changes to Rosin's app and your repos");
  document.getElementById("controls").insertBefore(panel, document.getElementById("say"));
  const btn = Object.assign(document.createElement("button"), { type: "button", id: "btn-changes", textContent: "Changes" });
  btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "changes");
  H.quick.append(btn);
  function openPanel(open) {
    panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) {
      for (const id of ["more", "compass"]) {   // one tray at a time keeps a phone screen usable
        const el = document.getElementById(id);
        if (el && !el.hidden) { el.hidden = true; document.querySelector(`[aria-controls="${id}"]`)?.setAttribute("aria-expanded", "false"); }
      }
      draw(); refresh();
    }
    H.fit();
  }
  btn.addEventListener("click", () => openPanel(panel.hidden));

  const button = (label, fn, cls) => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  const intro = el("p", "chg-dim", "Ask for a change to Rosin's app or any of your repos, here or just by asking Rosin. The laptop drafts it, and nothing merges until you approve it here.");
  const setup = el("p", "chg-note");
  const wantIn = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "e.g. make the Talk button bigger, or add a Stop button next to Send", maxLength: 600 });
  // Which repo: "Let Rosin pick" works it out from the words (Rosin's own app when nothing else is named).
  const repoIn = document.createElement("select"); repoIn.id = "chg-repo";
  function drawRepos() {
    const want = store.get("self.repo", "auto");
    repoIn.replaceChildren(new Option("Let Rosin pick", "auto"), ...repos.map((r) => new Option(r.self ? `${r.name} (Rosin's app)` : r.name, r.full)));
    repoIn.value = repos.some((r) => r.full === want) ? want : "auto";
  }
  drawRepos();
  repoIn.addEventListener("change", () => store.set("self.repo", repoIn.value));
  const draftBtn = button("Draft it", async () => {
    const request = wantIn.value.trim();
    if (request.length < 4) { wantIn.focus(); return; }
    draftBtn.disabled = true;
    try { await call("/api/self/draft", { request, from: "panel", repo: repoIn.value || "auto" }); wantIn.value = ""; lastErr = ""; }
    catch (e) { lastErr = e.message; }
    draftBtn.disabled = false; refresh();
  }, "chg-primary");
  const [onChk, onBox] = H.check("Rosin offers changes when we chat");
  onBox.checked = on;
  onBox.addEventListener("change", () => { on = onBox.checked; store.set("self.on", on); });
  const errEl = el("p", "chg-note");
  const list = el("div", "chg-list");
  const closeBtn = button("Close", () => { openPanel(false); btn.focus(); }, "chg-close");
  panel.append(intro, setup, H.field("Where", repoIn), H.field("What should change?", wantIn), draftBtn, onChk, errEl, list, closeBtn);

  // A running clock (7 s, 1:05, 1:02:03; days after that), redrawn in place every second by the tick below.
  const ago = (t) => {
    const s = Math.max(0, Math.floor((Date.now() - t) / SEC)), mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)}:${ss}` : s < 86400 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 86400)} d`;
  };
  const clock = (t, before = "", after = "") => { const e = el("span", "chg-t", before + ago(t) + after); e.dataset.since = t; e.dataset.before = before; e.dataset.after = after; return e; };
  const openDiffs = new Set();   // diffs left open stay open when the list is redrawn
  async function act(kind, it, ask) {
    if (ask && !confirm(ask)) return;
    const key = keyOf(it);
    if (tryingKey === key && (kind === "approve" || kind === "reject")) stopTry();
    errBox.delete(key);
    busyOn.add(key); draw();
    try {
      await call("/api/self/" + kind, it.pr ? { repo: it.repo, pr: it.pr } : { id: it.id });
      if (kind === "approve") justApproved.add(key);
    } catch (e) { errBox.set(key, e.message); }
    busyOn.delete(key);
    await refresh();
  }
  const errBox = new Map(), busyOn = new Set(), diffs = new Map();
  // "Try it on": a change to Rosin's look (rosin-look.css, look.json, art) shows on Rosin before it's approved. The
  // panel closes so Rosin can be seen, and a small bar at the top stops it or goes back to the change.
  const tryBar = el("div", "", ""); tryBar.id = "look-try"; tryBar.hidden = true;
  const tryText = el("span", "look-try-text", "");
  let tryingKey = "";
  const stopTry = () => { window.RosinLook?.stop(); tryingKey = ""; tryBar.hidden = true; };
  tryBar.append(tryText, button("Back to the change", () => { openPanel(true); draw(); }), button("Stop", () => { stopTry(); draw(); }, "chg-primary"));
  document.body.append(tryBar);
  async function tryOn(it, b) {
    const key = keyOf(it);
    if (tryingKey === key) { stopTry(); draw(); return; }
    b.textContent = "Loading…"; b.disabled = true;
    try {
      const j = await call("/api/self/files", { repo: it.repo, pr: it.pr });
      const tried = window.RosinLook.preview(j.files || {});
      if (!tried.length && !Object.keys(j.files || {}).length) throw new Error("This change has nothing to try on: it only changes how Rosin works. Show changes to read it.");
      tryingKey = key;
      const rest = (j.skipped || []).map((p) => p.split("/").pop());
      tryText.textContent = `Trying on: ${it.title}` + (rest.length ? ` (${rest.join(", ")} only shows after Approve)` : "");
      tryBar.hidden = false;
      openPanel(false);
    } catch (e) { errBox.set(key, e.message); }
    draw();
  }
  async function toggleDiff(it, box, b) {
    if (!box.hidden) { box.hidden = true; b.textContent = "Show changes"; openDiffs.delete(keyOf(it)); return; }
    b.textContent = "Loading…";
    try {
      const key = keyOf(it);
      if (!diffs.has(key)) diffs.set(key, (await call("/api/self/diff", { repo: it.repo, pr: it.pr })).diff || "");
      box.replaceChildren(...diffs.get(key).split("\n").slice(0, 400).map((l) => el("span", /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@|^diff |^index |^\+\+\+|^---/.test(l) ? "meta" : "", l + "\n")));
      box.hidden = false; b.textContent = "Hide changes"; openDiffs.add(key);
    } catch (e) { b.textContent = "Show changes"; errBox.set(keyOf(it), e.message); draw(); }
  }
  function card(it) {
    const c = el("div", "chg-item " + it.state), key = keyOf(it), busy = busyOn.has(key);
    const head = el("b", "", it.title || it.request);
    // Which repo, always, so a change Rosin aimed at the wrong place is easy to spot before Approve.
    const where = it.repoName ? el("div", "chg-repo" + (it.self === false ? " other" : ""), it.self === false ? "In " + it.repoName : "Rosin's app") : null;
    const row = el("div", "chg-btns");
    if (it.state === "queued" || it.state === "drafting") {
      const line = el("div", "chg-dim", `${it.step || "Waiting its turn"} · `); line.append(clock(it.started || it.at));
      c.append(el("b", "", "Drafting: " + it.request), ...(where ? [where] : []), line);
      return c;
    }
    if (it.state === "failed") {
      c.append(el("b", "", "Couldn't draft: " + it.request), el("div", "chg-why", it.error));
      row.append(button("Try again", () => act("retry", it)), button("Dismiss", () => act("dismiss", it)));
    } else if (it.state === "ready") {
      c.append(head, ...(where ? [where] : []), el("div", "", it.summary));
      if (it.request) c.append(el("div", "chg-dim", "You asked: " + it.request));
      for (const w of it.warnings || []) c.append(el("div", "chg-why", "Look closely: " + w));
      const box = el("pre", "chg-diff"); box.hidden = true;
      const show = button("Show changes", () => toggleDiff(it, box, show));
      if (openDiffs.has(key) && diffs.has(key)) { box.hidden = true; toggleDiff(it, box, show); }
      if (it.look && it.self !== false && window.RosinLook) {
        const t = button(tryingKey === key ? "Stop trying on" : "Try it on", () => tryOn(it, t));
        row.append(t);
      }
      row.append(show,
        button("Approve", () => act("approve", it, it.self === false ? `Merge "${it.title}" into ${it.repoName}?` : `Put "${it.title}" live on Rosin? It reaches the site and the apps in about a minute.`), "chg-primary"),
        button("Reject", () => act("reject", it, `Turn down "${it.title}"?`)));
      c.append(row, box);
      if (busy) row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      if (errBox.get(key)) c.append(el("div", "chg-why", errBox.get(key)));
      return c;
    } else if (it.state === "live") {
      const fresh = justApproved.has(key), other = it.self === false;
      const line = el("div", "chg-dim", fresh ? (other ? `Merged into ${it.repoName}.` : "Going live now. Reload Rosin in about a minute to get it.") : "");
      if (!fresh) line.append(clock(it.doneAt || it.at, `${other ? "Merged" : "Live"} for `, "."));
      c.append(head, ...(where ? [where] : []), line);
      if (fresh && !other) row.append(button("Reload Rosin", () => location.reload(), "chg-primary"));
      row.append(button("Undo", () => act("undo", it, other ? `Undo "${it.title}"? ${it.repoName} goes back to how it was before it.` : `Undo "${it.title}"? Rosin goes back to how it was before it.`)));
    } else {
      c.append(head, ...(where ? [where] : []), el("div", "chg-dim", it.state === "undone" ? "Undone." : "Turned down."));
    }
    if (row.childNodes.length) c.append(row);
    if (busy) row.querySelectorAll("button").forEach((b) => (b.disabled = true));
    if (errBox.get(key)) c.append(el("div", "chg-why", errBox.get(key)));
    return c;
  }
  function draw() {
    const waiting = items.filter((x) => x.state === "ready").length;
    btn.textContent = waiting ? `Changes (${waiting})` : "Changes";
    if (panel.hidden) return;
    setup.textContent = gateOld || ready === false ? "This needs the laptop's gate update and a GitHub token on the laptop. Steps: tavernworks.dev/local-ai/#changes" : !H.ready() ? "Rosin can't reach the laptop right now." : "";
    setup.hidden = !setup.textContent;
    draftBtn.disabled = !ready || !H.ready();
    errEl.textContent = lastErr; errEl.hidden = !lastErr;
    // Waiting and in-progress first, then the last few done ones.
    const open = items.filter((x) => ["queued", "drafting", "failed", "ready"].includes(x.state));
    const done = items.filter((x) => !open.includes(x)).slice(0, 6);
    list.replaceChildren(...(open.length || done.length ? [...open, ...done].map(card) : [el("p", "chg-dim", ready ? "No changes yet." : "")]));
  }
  // The laptop is asked every 2 s while something is drafting, every 5 s while the panel is open, else every 2 minutes for the count.
  let lastPoll = 0;
  // The clocks on the cards move every second (in place, so an open diff or a tap isn't disturbed).
  H.tick(1000, () => {
    if (!panel.hidden) for (const t of panel.querySelectorAll(".chg-t")) t.textContent = t.dataset.before + ago(Number(t.dataset.since)) + t.dataset.after;
    const drafting = items.some((x) => x.state === "queued" || x.state === "drafting"), active = drafting || !panel.hidden;
    if (Date.now() - lastPoll < (drafting ? 2000 : active ? 5000 : 2 * MIN) - 200) return;   // a draft's step shows within 2 s
    lastPoll = Date.now(); refresh();
  });
  H.later(4000, refresh);

  B.self = { refresh, items: () => items.slice(), repos: () => repos.slice(), open: () => openPanel(true), draw };

  // ---------- picking up a new version of this page ----------
  // The Android app keeps this page running for hours, so a change pushed to the site (an approved draft included)
  // would never reach it. Every 10 minutes it asks the site whether Rosin's files changed, and reloads itself once
  // nothing is going on: not talking or listening, nothing typed, no tray or offer open, quiet for a minute.
  const FILES = ["index.html", "rosin.js", "rosin-look.js", "rosin-look.css", "look.json", "rosin-web.js", "rosin-self.js", "rosin-compass.js", "rosin-eyes.js", "rosin-google.js", "rosin-video.js", "rosin-initiative.js", "rosin-spotify.js", "rosin.css", "layers.js"];
  let shipped = null, newer = false;
  async function version() {
    const base = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
    const tags = await Promise.all(FILES.map((f) => fetch(base + f, { method: "HEAD", cache: "no-store" })
      .then((r) => (r.ok ? r.headers.get("etag") || r.headers.get("last-modified") || "" : "")).catch(() => "")));
    return tags.some(Boolean) ? tags.join("|") : null;
  }
  const calm = () => !H.busy() && H.quietFor() > MIN && !document.getElementById("say-text")?.value.trim() && !offer
    && !H.onCall() && [...document.querySelectorAll(".tray")].every((t) => t.hidden) && !B.eyes?.pending().length;
  if (location.protocol === "https:") {
    H.later(15 * SEC, async () => { shipped = await version(); });
    let n = 0;
    H.tick(MIN, async () => {   // checks the site every 10 minutes; once there's an update, looks for a calm minute
      if (!newer && ++n % 10 === 0) { const v = await version(); newer = !!(shipped && v && v !== shipped); if (!shipped) shipped = v; }
      if (newer && calm()) { R.status("Rosin got an update. Reloading…"); setTimeout(() => location.reload(), 800); }
    });
  }
})();
