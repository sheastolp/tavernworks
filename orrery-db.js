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
  const CLIENT = "https://cdn.jsdelivr.net/gh/sheastolp/grand-orrery@d36189e0b485d1db062b57d3182b5d6f3091654a/client/orrery.js";
  const open = {};
  // One client per branch, shared by everything on the page.
  function get(branch = "main") {
    if (!open[branch]) {
      open[branch] = import(CLIENT)
        .then(({ Orrery }) => { const o = new Orrery({ branch, refreshMinutes: 0 }); return o.ready().then(() => o); })
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
