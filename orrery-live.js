// Keeping every Orrery page in step with the Orrery, without a reload.
//
// Two halves:
//   - A cheap check of a grand-orrery branch's newest commit. It sends the
//     last ETag back, and GitHub's 304 answers don't count against its
//     hourly limit, so pages can check every few seconds.
//   - A ping between open tabs of this browser (the Explorer, the Review
//     Clone, the review page): whatever writes to the Orrery pings, and every
//     other page checks at once, then keeps checking fast for a few minutes
//     while the database build catches up.
//
//   OrreryLive.head("review")          -> the branch's commit sha, or ""
//   OrreryLive.ping("review", "why")   tell the other tabs something changed
//   OrreryLive.on((m) => …)            m = { branch, what, at }
(function () {
  const REPO = "sheastolp/grand-orrery";
  // Branch heads come from the laptop that hosts the database now (the
  // gate's mirror); GitHub's API is only the fallback.
  const HOST = "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443";
  const KEY = "orrery-live-ping";
  const fns = new Set();
  const fire = (m) => { for (const f of fns) { try { f(m); } catch (e) { console.error("orrery live", e); } } };
  let ch = null;
  try { ch = new BroadcastChannel("orrery-live"); ch.onmessage = (e) => e.data && fire(e.data); } catch { ch = null; }
  // Without BroadcastChannel, a localStorage write reaches the other tabs.
  if (!ch) window.addEventListener("storage", (e) => { if (e.key === KEY && e.newValue) { try { fire(JSON.parse(e.newValue)); } catch {} } });

  function ping(branch = "review", what = "") {
    const m = { branch, what, at: Date.now() };
    if (ch) { try { ch.postMessage(m); } catch {} } else { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {} }
    fire(m);   // this tab too
  }
  const on = (fn) => { fns.add(fn); return () => fns.delete(fn); };

  const tags = {}, heads = {};
  async function head(branch = "main") {
    try {
      const headers = {};
      if (tags[branch] && heads[branch]) headers["if-none-match"] = tags[branch];
      const r = await fetch(HOST + "/head/" + branch, { cache: "no-store", headers });
      if (r.status === 304) return heads[branch] || "";
      if (r.ok) {
        const sha = (await r.text()).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) { tags[branch] = r.headers.get("etag") || ""; heads[branch] = sha; return sha; }
      }
    } catch { }
    return headGithub(branch);
  }
  async function headGithub(branch = "main") {
    try {
      const headers = { accept: "application/vnd.github.sha" };
      if (tags[branch] && heads[branch]) headers["if-none-match"] = tags[branch];
      const r = await fetch("https://api.github.com/repos/" + REPO + "/commits/" + branch, { cache: "no-store", headers });
      if (r.status === 304) return heads[branch] || "";
      if (!r.ok) return heads[branch] || "";
      const sha = (await r.text()).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) return heads[branch] || "";
      tags[branch] = r.headers.get("etag") || ""; heads[branch] = sha;
      return sha;
    } catch { return heads[branch] || ""; }
  }
  window.OrreryLive = { ping, on, head };
})();
