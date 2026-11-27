/* rosin-self.js: Rosin changing its own app, with Sheamus's OK (load after rosin-web.js).
 *
 * Ask for a change under ⋯ → Changes, or just ask Rosin in conversation ("can you make the Talk button bigger?").
 * The laptop's gate has a model draft it as small edits to Rosin's own files (rosin/*.js, *.css, *.html only), checks
 * them, and opens a pull request on GitHub. Here you see what it'll do and the exact changes, then Approve (it goes live
 * on tavernworks.dev/rosin and in the apps), Reject, or later Undo. Nothing goes live without your Approve.
 * The GitHub token stays on the laptop; this page only ever talks to the gate with the laptop key.
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R) return;
  const { store } = H;
  const SEC = 1000, MIN = 60 * SEC;
  let on = store.get("self.on", true);
  let items = [], ready = null, gateOld = false, lastErr = "";
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
      announce();
    } catch (e) { if (!gateOld) lastErr = e.message; }
    draw();
  }
  // Tell Sheamus once when a draft is ready (or couldn't be made), in Rosin's own voice. Never on air.
  function announce() {
    for (const it of items) {
      const key = it.pr ? "pr" + it.pr : it.state === "failed" ? "f" + it.id : "";
      if (!key || seen.has(key) || !(it.state === "ready" || it.state === "failed")) continue;
      seen.add(key); store.set("self.seen", [...seen].slice(-200));
      if (H.onAir() || Date.now() - it.at > 30 * MIN) continue;
      const cue = it.state === "ready"
        ? `App change: you've drafted "${clean(it.title)}" and it's waiting for their OK under the ⋯ menu, Changes. Tell them in one short, cheerful sentence. Don't say it's done.`
        : `App change: you couldn't draft "${clean(it.request)}". The reason: ${clean(it.error)}. Tell them in one short sentence, and that they can reword it under the ⋯ menu, Changes.`;
      H.speakUp(cue);
      break;
    }
  }
  const clean = (t) => String(t || "").replace(/[\[\]{}<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

  // Rosin offering a change in conversation ("[change: …]" at the end of its reply).
  window.addEventListener("rosin-change", async (e) => {
    if (!on || !H.selfReady()) return;
    const want = String(e.detail?.want || "").trim();
    if (want.length < 4) return;
    const context = H.recent(6).map((m) => `${m.role === "user" ? m.who || "Sheamus" : "Rosin"}: ${m.text}`).join("\n");
    try { await call("/api/self/draft", { request: want, from: "chat", context }); R.status("Drafting that change on the laptop. It'll wait for your OK under ⋯ → Changes."); }
    catch (err) { R.status(err.message, true); }
    refresh();
  });

  // ---------- the Changes panel (⋯ → Changes) ----------
  const panel = document.createElement("div"); panel.id = "changes"; panel.className = "tray"; panel.hidden = true;
  panel.setAttribute("aria-label", "Changes to Rosin's app");
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

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, fn, cls) => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  const intro = el("p", "chg-dim", "Ask for a change to Rosin's own app, here or just by asking Rosin. The laptop drafts it, and nothing goes live until you approve it here.");
  const setup = el("p", "chg-note");
  const wantIn = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "e.g. make the Talk button bigger, or add a Stop button next to Send", maxLength: 600 });
  const draftBtn = button("Draft it", async () => {
    const request = wantIn.value.trim();
    if (request.length < 4) { wantIn.focus(); return; }
    draftBtn.disabled = true;
    try { await call("/api/self/draft", { request, from: "panel" }); wantIn.value = ""; lastErr = ""; }
    catch (e) { lastErr = e.message; }
    draftBtn.disabled = false; refresh();
  }, "chg-primary");
  const [onChk, onBox] = H.check("Rosin offers changes when we chat");
  onBox.checked = on;
  onBox.addEventListener("change", () => { on = onBox.checked; store.set("self.on", on); });
  const errEl = el("p", "chg-note");
  const list = el("div", "chg-list");
  const closeBtn = button("Close", () => { openPanel(false); btn.focus(); }, "chg-close");
  panel.append(intro, setup, H.field("What should change?", wantIn), draftBtn, onChk, errEl, list, closeBtn);

  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / SEC)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
  async function act(kind, it, ask) {
    if (ask && !confirm(ask)) return;
    errBox.delete(it.pr || it.id);
    busyOn.add(it.pr || it.id); draw();
    try {
      await call("/api/self/" + kind, it.pr ? { pr: it.pr } : { id: it.id });
      if (kind === "approve") justApproved.add(it.pr);
    } catch (e) { errBox.set(it.pr || it.id, e.message); }
    busyOn.delete(it.pr || it.id);
    await refresh();
  }
  const errBox = new Map(), busyOn = new Set(), diffs = new Map();
  async function toggleDiff(it, box, b) {
    if (!box.hidden) { box.hidden = true; b.textContent = "Show changes"; return; }
    b.textContent = "Loading…";
    try {
      if (!diffs.has(it.pr)) diffs.set(it.pr, (await call("/api/self/diff", { pr: it.pr })).diff || "");
      box.replaceChildren(...diffs.get(it.pr).split("\n").slice(0, 400).map((l) => el("span", /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@|^diff |^index |^\+\+\+|^---/.test(l) ? "meta" : "", l + "\n")));
      box.hidden = false; b.textContent = "Hide changes";
    } catch (e) { b.textContent = "Show changes"; errBox.set(it.pr, e.message); draw(); }
  }
  function card(it) {
    const c = el("div", "chg-item " + it.state), key = it.pr || it.id, busy = busyOn.has(key);
    const head = el("b", "", it.title || it.request);
    const row = el("div", "chg-btns");
    if (it.state === "queued" || it.state === "drafting") {
      c.append(el("b", "", "Drafting: " + it.request), el("div", "chg-dim", `${it.step || "Waiting its turn"} · ${ago(it.started || it.at)}`));
      return c;
    }
    if (it.state === "failed") {
      c.append(el("b", "", "Couldn't draft: " + it.request), el("div", "chg-why", it.error));
      row.append(button("Try again", () => act("retry", it)), button("Dismiss", () => act("dismiss", it)));
    } else if (it.state === "ready") {
      c.append(head, el("div", "", it.summary));
      if (it.request) c.append(el("div", "chg-dim", "You asked: " + it.request));
      const box = el("pre", "chg-diff"); box.hidden = true;
      const show = button("Show changes", () => toggleDiff(it, box, show));
      row.append(show,
        button("Approve", () => act("approve", it, `Put "${it.title}" live on Rosin? It reaches the site and the apps in about a minute.`), "chg-primary"),
        button("Reject", () => act("reject", it, `Turn down "${it.title}"?`)));
      c.append(row, box);
      if (busy) row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      if (errBox.get(key)) c.append(el("div", "chg-why", errBox.get(key)));
      return c;
    } else if (it.state === "live") {
      c.append(head, el("div", "chg-dim", (justApproved.has(it.pr) ? "Going live now. Reload Rosin in about a minute to get it." : `Live for ${ago(it.doneAt || it.at)}.`)));
      if (justApproved.has(it.pr)) row.append(button("Reload Rosin", () => location.reload(), "chg-primary"));
      row.append(button("Undo", () => act("undo", it, `Undo "${it.title}"? Rosin goes back to how it was before it.`)));
    } else {
      c.append(head, el("div", "chg-dim", it.state === "undone" ? "Undone." : "Turned down."));
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
  // Every few seconds while the panel is open or something is drafting, otherwise every couple of minutes for the count.
  let lastPoll = 0;
  H.tick(5000, () => {
    const active = !panel.hidden || items.some((x) => x.state === "queued" || x.state === "drafting");
    if (Date.now() - lastPoll < (active ? 5000 : 2 * MIN) - 200) { if (!panel.hidden) draw(); return; }
    lastPoll = Date.now(); refresh();
  });
  H.later(4000, refresh);

  B.self = { refresh, items: () => items.slice(), open: () => openPanel(true), draw };
})();
