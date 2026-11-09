// The Grand Orrery's database, for every Tavernworks page.
//
// grand-orrery's build compiles every document (the roster, resources,
// bestiary, lore and the notes, including what's been sent for review from
// the chat, the Codex or the lore-keeper) into one record per thing, on its
// `data` branch. Every page reads it through the same client, pinned here so
// they all read it the same way. Bump the commit to pick up a newer client.
//
//   const orrery = await OrreryDB.get();          // main: the live Orrery
//   const review = await OrreryDB.get("review");  // what's waiting on review
//   orrery.list("person"); orrery.get("murrow"); orrery.loreText();
//   await OrreryDB.fresh();                        // re-read now, then use it
//
// The client never throws: before its first good read, lookups return nothing.
(function () {
  const CLIENT = "https://cdn.jsdelivr.net/gh/sheastolp/grand-orrery@d91122f2f80a0f98644f9c473142be268c9a9530/client/orrery.js";
  const open = {};
  // One client per branch, shared by everything on the page.
  function get(branch = "main") {
    if (!open[branch]) {
      open[branch] = import(CLIENT)
        // The browser keeps the Orrery's last good read, so a page opened
        // while GitHub is out of reach still shows the Orrery (never a
        // hand-written copy of it).
        .then(({ Orrery, storageCache }) => { const o = new Orrery({ branch, refreshMinutes: 0, cache: storageCache("orrery-db-" + branch) }); return o.ready().then(() => o); })
        .catch((e) => { delete open[branch]; throw e; });
    }
    return open[branch];
  }
  // The branch's client after checking for a newer build.
  async function fresh(branch = "main") {
    const o = await get(branch);
    if (!o.lastRead || Date.now() - o.lastRead.getTime() > 5000) await o.refresh();
    return o;
  }
  window.OrreryDB = { get, fresh, CLIENT };
})();
