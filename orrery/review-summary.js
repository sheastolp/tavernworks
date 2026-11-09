// What's in the review, in plain words. Used by the review page
// (/orrery/control/review/) and the Review Clone's bar (/orrery/?clone=review).
//
// GitHub's compare (main...review) gives files and line diffs. This reads
// each changed Markdown file at both ends, the point review branched from
// and review's newest commit, splits them into sections by heading, and
// reports what a reader would notice: which entries are new, changed,
// removed or newly decided, where each came from (the Codex, Wake in
// Verrowen, the lore-keeper), and what the narrator will learn.
//
//   const s = await ReviewSummary.build(compareJson)
//   s.html   the full summary        s.short  one line for the clone bar
//   s.items  [{ doc, file, kind, title, parent, tag, oldTag, from, added, removed }]
(function () {
  const REPO = "sheastolp/grand-orrery";
  // Each document's name, in the Orrery's own order, from its database
  // (filled in by build(); a document it doesn't list shows by its file name).
  const DOCS = {};
  const SOURCES = [
    [/From the Verrowen Codex/i, "📜 Codex"],
    [/From a Wake in Verrowen story/i, "🕯 Wake in Verrowen"],
    [/From a lore-keeper chat/i, "🪶 Lore-keeper"],
  ];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const plain = (s) => String(s).replace(/!\[[^\]]*\]\([^)]*\)/g, "[picture]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/[*_`>]+/g, "").replace(/^\s*[-#]+\s*/, "").replace(/\s+/g, " ").trim();
  const cut = (s, n = 160) => (s.length > n ? s.slice(0, n - 1).trim() + "…" : s);
  const raw = (ref, file) => fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${file.split("/").map(encodeURIComponent).join("/")}`)
    .then((r) => (r.ok ? r.text() : "")).catch(() => "");

  // ── Markdown into sections ──
  // Keyed by the heading's path without its tag, so "(Pitch)" becoming
  // "(Your idea)" reads as the same entry being decided.
  function sections(md) {
    const out = new Map();
    let h2 = "", cur = { title: "The opening", parent: "", tag: "", body: [] }, n = 0;
    const put = () => { const k = (cur.parent ? cur.parent + " › " : "") + cur.title; out.set(out.has(k) ? k + " #" + ++n : k, { ...cur, body: cur.body.join("\n").trim() }); };
    for (const line of md.replace(/\r/g, "").replace(/<!--[\s\S]*?-->\n?/g, "").split("\n")) {
      const m = line.match(/^(#{1,4})\s+(.*?)\s*$/);
      if (!m) { cur.body.push(line); continue; }
      put();
      const t = m[2].match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      const title = (t ? t[1] : m[2]).trim(), tag = t ? t[2].trim() : "";
      if (m[1].length <= 2) h2 = m[1].length === 2 ? title : "";
      cur = { title, tag, parent: m[1].length > 2 ? h2 : "", body: [] };
    }
    put();
    return out;
  }
  // Lines in one text and not the other: what was written in, and taken out.
  function lineDiff(a, b, split = (s) => s.split("\n")) {
    const A = split(a).map(plain).filter(Boolean), B = split(b).map(plain).filter(Boolean);
    const setA = new Set(A), setB = new Set(B);
    return { added: B.filter((l) => !setA.has(l)), removed: A.filter((l) => !setB.has(l)) };
  }
  // A line edited in place: show only the part that changed, with "…" for
  // the untouched start and end, instead of the whole line twice.
  function narrow(d) {
    const add = [], rem = [], used = new Set();
    for (const a of d.added) {
      let best = -1, score = 0;
      d.removed.forEach((r, i) => {
        if (used.has(i)) return;
        let p = 0; while (p < a.length && p < r.length && a[p] === r[p]) p++;
        let q = 0; while (q < a.length - p && q < r.length - p && a[a.length - 1 - q] === r[r.length - 1 - q]) q++;
        const sc = (p + q) / Math.max(a.length, r.length);
        if (sc > score) { score = sc; best = i; }
      });
      if (best < 0 || score < 0.35) { add.push(a); continue; }
      used.add(best);
      const r = d.removed[best];
      let p = 0; while (p < a.length && p < r.length && a[p] === r[p]) p++;
      let q = 0; while (q < a.length - p && q < r.length - p && a[a.length - 1 - q] === r[r.length - 1 - q]) q++;
      while (p > 0 && a[p - 1] !== " ") p--;          // keep whole words
      const mid = (t) => (p > 0 ? "…" : "") + t.slice(p, t.length - q).trim() + (q > 0 ? "…" : "");
      // Only added to, or only cut down: show just the one side.
      const ca = a.slice(p, a.length - q).trim(), cr = r.slice(p, r.length - q).trim();
      if (ca && !(cr && cr.includes(ca))) add.push(mid(a));
      if (cr && !(ca && ca.includes(cr))) rem.push(mid(r));
    }
    d.removed.forEach((r, i) => { if (!used.has(i)) rem.push(r); });
    return { added: add, removed: rem };
  }
  const sourceOf = (body) => {
    const by = (body.match(/^_(From [^\n]*?)\._\s*$/m) || [])[1] || "";
    const src = SOURCES.find(([re]) => re.test(by));
    const who = (by.match(/sent by ([^·]+)/) || [])[1];
    return { from: src ? src[1] : "", who: who ? who.trim() : "" };
  };
  const dropByline = (body) => body.replace(/^_From [^\n]*\._\s*$/m, "");

  function mdItems(file, before, after) {
    const A = sections(before), B = sections(after), items = [];
    for (const [k, s] of B) {
      const o = A.get(k);
      const src = sourceOf(s.body);
      const base = { file, doc: DOCS[file] || file, title: s.title, parent: s.parent, tag: s.tag, ...src };
      if (!o) { items.push({ ...base, kind: "new", added: lineDiff("", dropByline(s.body)).added, removed: [] }); continue; }
      const d = lineDiff(dropByline(o.body), dropByline(s.body));
      if (o.tag !== s.tag) items.push({ ...base, kind: /your idea/i.test(s.tag) ? "decided" : "retagged", oldTag: o.tag, ...d });
      else if (d.added.length || d.removed.length) items.push({ ...base, kind: "changed", ...narrow(d) });
    }
    for (const [k, s] of A) if (!B.has(k)) items.push({ file, doc: DOCS[file] || file, title: s.title, parent: s.parent, tag: s.tag, kind: "removed", added: [], removed: lineDiff(s.body, "").removed });
    // A new heading like "From the Codex" is only a container: its entries say it all.
    return items.filter((i) => !(i.kind === "new" && !i.parent && items.some((x) => x.kind === "new" && x.parent === i.title)));
  }
  // lore.md is one "KEY: text" line per topic. CODEX lines are keyed by the
  // note's title. Changes are shown sentence by sentence, since lines are long.
  function loreItems(before, after) {
    const lines = (md) => {
      const out = new Map();
      for (const l of md.replace(/\r/g, "").split("\n")) {
        const m = l.match(/^([A-Z][A-Z ]*(?:\([^)]*\))?):\s*(.*)$/); if (!m) continue;
        let key = m[1].trim(), text = m[2];
        if (key === "CODEX") { const t = (text.match(/^([^(.]+)/) || [])[1]; key = "CODEX · " + (t || text).trim(); }
        out.set(key, text);
      }
      return out;
    };
    const A = lines(before), B = lines(after), items = [];
    const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/);
    const name = (k) => k.startsWith("CODEX · ") ? k.slice(8) : k.charAt(0) + k.slice(1).toLowerCase();
    const base = (k) => ({ file: "lore.md", doc: DOCS["lore.md"] || "lore.md", title: name(k), parent: k.startsWith("CODEX · ") ? "From the Codex" : "", tag: "" });
    for (const [k, t] of B) {
      if (!A.has(k)) items.push({ ...base(k), kind: "new", added: [plain(t)], removed: [] });
      else if (A.get(k) !== t) { const d = lineDiff(A.get(k), t, sentences); if (d.added.length || d.removed.length) items.push({ ...base(k), kind: "changed", ...d }); }
    }
    for (const [k, t] of A) if (!B.has(k)) items.push({ ...base(k), kind: "removed", added: [], removed: [plain(t)] });
    return items;
  }

  async function build(j) {
    if (window.OrreryDB) {
      try {
        const o = await OrreryDB.get("review");
        for (const d of o.list("document").sort((a, b) => (a.order || 0) - (b.order || 0))) DOCS[d.file] = d.name;
      } catch (e) { /* names stay file names */ }
    }
    const files = j.files || [];
    const from = j.merge_base_commit && j.merge_base_commit.sha;
    const commits = j.commits || [];
    const to = commits.length ? commits[commits.length - 1].sha : "review";
    const items = [];
    // Read at fixed commits, so GitHub's raw-file cache can't show an older copy.
    await Promise.all(files.map(async (f) => {
      const name = f.filename;
      if (/\.md$/i.test(name) || name === "lore.md") {
        const [a, b] = await Promise.all([f.status === "added" ? "" : raw(from || "main", f.previous_filename || name), f.status === "removed" ? "" : raw(to, name)]);
        items.push(...(name === "lore.md" ? loreItems(a, b) : mdItems(name, a, b)));
      } else {
        const what = /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? (/^maps\//.test(name) ? "Map" : "Picture") : "File";
        items.push({ file: name, doc: "Other files", title: `${what}: ${name}`, parent: "", tag: "", kind: f.status === "added" ? "new" : f.status === "removed" ? "removed" : "changed", added: [], removed: [] });
      }
    }));
    const order = Object.keys(DOCS);
    const rank = (f) => { const i = order.indexOf(f); return i < 0 ? 99 : i; };
    items.sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
    return { items, html: render(items, j), short: short(items) };
  }

  // ── Words ──
  const LABEL = { new: "New", changed: "Changed", removed: "Removed", decided: "Now decided", retagged: "Re-tagged" };
  const count = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  function list(names) { return names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]; }
  // The narrator's lore mostly repeats entries from the documents, so it
  // only counts here when nothing else changed; impact() covers it.
  function headline(items) {
    const docItems = items.filter((i) => i.file !== "lore.md");
    if (docItems.length) items = docItems;
    const by = (k) => items.filter((i) => i.kind === k).length;
    const bits = [by("new") && `adds ${count(by("new"), "entry", "entries")}`, by("changed") && `changes ${by("changed")}`, by("decided") && `decides ${by("decided")}`, by("retagged") && `re-tags ${by("retagged")}`, by("removed") && `removes ${by("removed")}`].filter(Boolean);
    const docs = [...new Set(items.map((i) => i.doc))];
    return bits.length ? `Publishing this ${list(bits)}, in ${list(docs)}.` : "The files differ, but no entry reads differently.";
  }
  function impact(items) {
    const out = [];
    const lore = items.filter((i) => i.file === "lore.md");
    if (lore.length) out.push(`🕯 <b>The Wake in Verrowen narrator</b> reads the new lore from the next story on: ${esc(list(lore.slice(0, 6).map((i) => i.title)))}${lore.length > 6 ? " and more" : ""}.`);
    else out.push("🕯 The Wake in Verrowen narrator isn't affected: <code>lore.md</code> doesn't change.");
    const shown = items.filter((i) => i.file !== "lore.md" && i.file !== "README.md");
    if (shown.length) out.push(`🪐 <b>The Orrery Explorer and the lore-keeper</b> see ${count(shown.length, "change")} in the documents, roster and maps.`);
    const fresh = items.filter((i) => i.kind === "new" && i.file !== "lore.md");
    const decided = fresh.filter((i) => /your idea|decided/i.test(i.tag)).length + items.filter((i) => i.kind === "decided").length;
    const pitches = fresh.filter((i) => /pitch|not decided/i.test(i.tag)).length;
    if (decided || pitches) out.push(`⚖️ ${decided ? `<b>${count(decided, "entry", "entries")}</b> ${decided === 1 ? "becomes" : "become"} canon (Your idea)` : "Nothing becomes canon"}${pitches ? `; <b>${count(pitches, "pitch", "pitches")}</b> ${pitches === 1 ? "stays an idea" : "stay ideas"} to weigh, not canon` : ""}.`);
    const srcs = {};
    for (const i of items) if (i.from) srcs[i.from] = (srcs[i.from] || 0) + 1;
    const s = Object.entries(srcs);
    if (s.length) out.push(`📨 Sent in from ${list(s.map(([k, n]) => `${k} (${n})`))}${items.some((i) => !i.from && i.file !== "lore.md") ? ", plus edits made to the files directly" : ""}.`);
    return out;
  }
  function render(items, j) {
    if (!items.length) return "";
    const docs = [...new Set(items.map((i) => i.doc))];
    const lines = (arr, cls, sign) => arr.slice(0, 3).map((l) => `<div class="${cls}">${sign} ${esc(cut(l))}</div>`).join("") + (arr.length > 3 ? `<div class="more">…and ${arr.length - 3} more line${arr.length - 3 > 1 ? "s" : ""}</div>` : "");
    return `<p class="lead">${esc(headline(items))}</p>
      <ul class="impact">${impact(items).map((t) => `<li>${t}</li>`).join("")}</ul>
      ${docs.map((d) => `<h3>${esc(d)}</h3><ul class="entries">${items.filter((i) => i.doc === d).map((i) => {
        const meta = [i.parent, i.kind === "decided" || i.kind === "retagged" ? `${i.oldTag || "untagged"} → ${i.tag || "untagged"}` : i.tag, i.from, i.who && "sent by " + i.who].filter(Boolean).map(esc).join(" · ");
        return `<li><span class="kind ${i.kind}">${LABEL[i.kind]}</span> <b>${esc(i.title)}</b>${meta ? ` <small>${meta}</small>` : ""}
          ${i.kind === "removed" ? lines(i.removed, "minus", "−") : lines(i.added, "plus", "+") + (i.kind === "changed" ? lines(i.removed, "minus", "−") : "")}</li>`;
      }).join("")}</ul>`).join("")}
      <p class="note">${esc(count((j.commits || []).length, "commit"))} and ${esc(count((j.files || []).length, "file"))} behind this. The commit list and line-by-line diffs are further down.</p>`;
  }
  // "Waiting: 2 new (Brinna Holt, Wren Alder), 1 changed (Healers)."
  function short(items) {
    if (!items.length) return "";
    const docItems = items.filter((i) => i.file !== "lore.md");
    const use = docItems.length ? docItems : items;
    const parts = ["new", "decided", "changed", "retagged", "removed"].map((k) => {
      const names = [...new Set(use.filter((i) => i.kind === k).map((i) => i.title))];
      return names.length ? `${names.length} ${LABEL[k].toLowerCase()} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})` : "";
    }).filter(Boolean);
    return "Waiting: " + parts.join(", ") + (docItems.length && items.length > docItems.length ? ", and the narrator's lore changes" : "") + ".";
  }

  window.ReviewSummary = { build };
})();
