// Sending things to the Grand Orrery's review process from any Tavernworks
// page: the Orrery Explorer's lore-keeper, the Verrowen Codex and Wake in
// Verrowen. Everything ends up as a section of working-notes.md on
// grand-orrery's review branch, where the owner reads it on the Review Clone
// page (/orrery/control/review/) and publishes it or throws it away.
//
// On a device with the owner's token it's filed on the review branch at once.
// Anyone else's goes to the laptop's review queue first, and the owner files
// it (always as a pitch) or turns it down from the same review page.
//
//   OrreryReview.send({ source: "lore-keeper" | "codex" | "verrowen", title, body,
//                       key, about, name, decided, loreLine, chatId })
//     -> { filed: true, updated } | { queued: true }   (throws an Error with a message to show)
(function () {
  const SERVER = "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443";
  const OWNER_KEY = "verrowen-owner";
  const token = () => { try { return localStorage.getItem(OWNER_KEY) || ""; } catch { return ""; } };
  async function post(path, body, auth) {
    let r;
    try {
      r = await fetch(SERVER + path, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth ? { authorization: "Bearer " + auth } : {}), body: JSON.stringify(body) });
    } catch { throw new Error(navigator.onLine ? "Couldn't reach the laptop. It may be asleep; try again later." : "You're offline. Send it again once you have a connection."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error("The laptop's server needs updating first (see verrowen/server/README.md).");
    return { r, j };
  }
  async function send(item) {
    const t = token();
    if (t) {
      const { r, j } = await post("/admin/review-item", item, t);
      if (r.ok) { if (window.tavernPWA) checkBadgeSoon(); return { filed: true, updated: !!j.updated, sha: j.sha || "" }; }
      if (r.status !== 401) throw new Error(j.error || "The laptop answered " + r.status + ".");
      // A wrong or old owner token: send it in like anyone else's.
    }
    const { r, j } = await post("/suggest", item, "");
    if (!r.ok) throw new Error(j.error || "The laptop answered " + r.status + ".");
    return { queued: true };
  }
  // The Orrery app's icon count goes up by one; recheck it from GitHub.
  function checkBadgeSoon() { try { localStorage.removeItem("orrery-review-checked"); } catch {} }
  window.OrreryReview = { send, isOwner: () => !!token(), SERVER };
})();
