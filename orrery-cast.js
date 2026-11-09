// Fills a page's example chat with the Grand Orrery's own people, so no
// Tavernworks page keeps names of its own: the Orrery is the only copy.
//
//   <div data-orrery-cast hidden>
//     <span data-person="doric" data-handle></span> … <span data-person="tansy-ninefingers" data-peddler></span>
//   </div>
//
// Each data-person is a person's id in the Orrery. Their current name goes in
// (data-handle: written as a Twitch handle, no spaces). Someone no longer in
// the canon is played by someone else from the roster (data-peddler: another
// peddler). The box shows once it's filled; it stays hidden if the Orrery
// can't be read (needs /orrery-db.js first).
(function () {
  const boxes = [...document.querySelectorAll("[data-orrery-cast]")];
  if (!boxes.length || !window.OrreryDB) return;
  const handle = (n) => String(n).replace(/[^A-Za-z0-9]/g, "");
  OrreryDB.get("main").then((o) => {
    const canon = (e) => e && e.type === "person" && e.status === "decided" && e.name;
    const peddler = (e) => /peddlers/i.test(e.group || "");
    const people = o.list("person").filter((e) => canon(e) && !e.kind && !/^The /.test(e.name) && !peddler(e));
    const peddlers = o.list("person").filter((e) => canon(e) && peddler(e));
    for (const box of boxes) {
      const chosen = {}, used = new Set();
      const els = [...box.querySelectorAll("[data-person]")];
      for (const el of els) { const e = o.get(el.dataset.person); if (canon(e)) { chosen[el.dataset.person] = e; used.add(e.id); } }
      let ok = true;
      for (const el of els) {
        const id = el.dataset.person;
        if (!chosen[id]) chosen[id] = (el.hasAttribute("data-peddler") ? peddlers : people).find((e) => !used.has(e.id));
        const e = chosen[id];
        if (!e) { ok = false; break; }
        used.add(e.id);
        el.textContent = el.hasAttribute("data-handle") ? handle(e.name) : e.name;
      }
      if (ok) box.hidden = false;
    }
  }).catch(() => {});
})();
