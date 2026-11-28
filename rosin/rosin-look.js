/* Rosin's look layer: what lets Changes (⋯ → Changes, or asking Rosin) change how Rosin looks, not only how it acts.
 *
 * Rosin is painted art (img/*.webp), and a model can't repaint pixels. So on top of the painting there are:
 *   - surfaces: empty boxes over the body, each masked to one part of the painting (img/mask-*.webp):
 *       orb    the whole vine orb (not the eye)
 *       vines  the woven vines and bark
 *       leaves the leaves on the vines
 *     rosin-look.css gives them a texture, colour or animation; it shows only on that part and moves with Rosin.
 *   - stickers: vector art (art/*.svg) laid over Rosin at canvas positions, listed in look.json. A sticker "on" a
 *     moving part (antenna-l, crystal-r, charms…) moves with it.
 * The canvas is 1382 x 1698 px (layers.js), so look.json uses the same numbers as the parts in layers.js.
 *
 * Try it on: window.RosinLook.preview(files) swaps in a change's new rosin-look.css / rosin.css / look.json / art
 * before it's approved (the Changes card's "Try it on"); RosinLook.stop() puts the live look back.
 */
(() => {
  "use strict";
  const L = window.ROSIN_LAYERS, rig = document.getElementById("rig");
  if (!L || !rig) return;
  const SURFACES = ["orb", "vines", "leaves"];
  const pct = (v, of) => (100 * v / of).toFixed(3) + "%";
  const partEl = (name) => rig.querySelector(`.part[data-part="${CSS.escape(name)}"]`);
  const body = partEl("body");

  // ---------- surfaces (always there, empty until rosin-look.css styles them) ----------
  if (body) for (const s of SURFACES) {
    const d = document.createElement("div");
    d.className = "look-surface"; d.dataset.surface = s;
    body.appendChild(d);
  }

  // ---------- stickers from look.json ----------
  const num = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
  const artOk = (p) => typeof p === "string" && /^(art\/[a-z0-9][a-z0-9-]{0,40}\.svg|img\/[a-z0-9][a-z0-9-]{0,40}\.(webp|png|svg))$/.test(p);
  function clean(j) {
    const list = Array.isArray(j?.stickers) ? j.stickers.slice(0, 60) : [];
    return list.filter((s) => s && artOk(s.art)).map((s) => ({
      art: s.art, on: typeof s.on === "string" && L.parts[s.on] ? s.on : "body",
      x: num(s.x, -400, L.W + 400, 0), y: num(s.y, -400, L.H + 400, 0), w: num(s.w, 4, L.W, 60), h: num(s.h, 4, L.H, 60),
      rotate: num(s.rotate, -360, 360, 0), opacity: num(s.opacity, 0, 1, 1), behind: s.behind === true,
      cls: typeof s.class === "string" ? s.class.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().slice(0, 60) : "",
    }));
  }
  let live = [], shownStickers = [];
  function placeStickers(list, urlFor = (p) => p) {
    for (const el of shownStickers) el.remove();
    shownStickers = [];
    for (const s of list) {
      const part = partEl(s.on) || body, b = L.parts[s.on] || L.parts.body;
      if (!part) continue;
      const d = document.createElement("div");
      d.className = "look-sticker" + (s.cls ? " " + s.cls : "");
      d.dataset.art = s.art.replace(/^.*\/|\.\w+$/g, "");
      d.style.left = pct(s.x - b.x, b.w); d.style.top = pct(s.y - b.y, b.h);
      d.style.width = pct(s.w, b.w); d.style.height = pct(s.h, b.h);
      if (s.opacity < 1) d.style.opacity = String(s.opacity);
      const img = document.createElement("img");
      img.src = urlFor(s.art); img.alt = ""; img.draggable = false; img.decoding = "async";
      if (s.rotate) img.style.transform = `rotate(${s.rotate}deg)`;
      d.appendChild(img);
      // A sticker on a part that sways or bobs moves the same way: same pivot, same animation as the part's picture.
      const pic = part.querySelector(":scope > img");
      if (pic && s.on !== "body") {
        const cs = getComputedStyle(pic), [ox, oy] = (part.dataset.origin || "50% 50%").split(" ");
        const px = (parseFloat(ox) / 100) * b.w - (s.x - b.x), py = (parseFloat(oy) / 100) * b.h - (s.y - b.y);
        d.style.transformOrigin = `${pct(px, s.w)} ${pct(py, s.h)}`;
        for (const k of ["animationName", "animationDuration", "animationDelay", "animationTimingFunction", "animationIterationCount"]) d.style[k] = cs[k];
      }
      if (s.behind && pic) part.insertBefore(d, pic); else part.appendChild(d);
      shownStickers.push(d);
    }
  }
  async function load() {
    try {
      const r = await fetch("look.json", { cache: "no-cache" });
      live = r.ok ? clean(await r.json()) : [];
    } catch { live = []; }
    if (!previewing) placeStickers(live);
  }

  // ---------- try a change on before approving it ----------
  // files: { "rosin/rosin-look.css": text, "rosin/look.json": text, "rosin/art/leaf.svg": text, ... } (new versions)
  let previewing = false, blobs = [];
  const svgSafe = (t) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t) && !/<script|<foreignObject|<!ENTITY|<!DOCTYPE|javascript:|\son\w+\s*=/i.test(t);
  function preview(files) {
    stop();
    previewing = true;
    const art = {};
    for (const [path, text] of Object.entries(files || {})) {
      const rel = path.replace(/^rosin\//, "");
      if (/^art\/[\w-]+\.svg$/.test(rel) && typeof text === "string" && svgSafe(text)) {
        const u = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
        art[rel] = u; blobs.push(u);
      }
    }
    const urlFor = (p) => art[p] || p;
    const tried = [];
    for (const [path, text] of Object.entries(files || {})) {
      const rel = path.replace(/^rosin\//, "");
      if (!/^[\w-]+\.css$/.test(rel) || typeof text !== "string") continue;
      const css = text.replace(/url\(\s*(['"]?)(?:\.\/)?(art\/[\w-]+\.svg)\1\s*\)/g, (m, q, p) => (art[p] ? `url("${art[p]}")` : m));
      for (const l of document.querySelectorAll(`link[rel="stylesheet"]`)) if (new URL(l.href).pathname.endsWith("/" + rel)) { l.disabled = true; l.dataset.lookOff = "1"; }
      const st = document.createElement("style");
      st.dataset.lookPreview = rel; st.textContent = css;
      const after = document.querySelector(`link[data-look-off][href$="${CSS.escape(rel)}"]`) || document.head.lastChild;
      after.after(st);
      tried.push(rel);
    }
    let list = live;
    const json = files?.["rosin/look.json"];
    if (typeof json === "string") { try { list = clean(JSON.parse(json)); tried.push("look.json"); } catch {} }
    placeStickers(list, urlFor);
    document.documentElement.classList.add("look-preview");
    return tried;
  }
  function stop() {
    for (const st of document.querySelectorAll("style[data-look-preview]")) st.remove();
    for (const l of document.querySelectorAll("link[data-look-off]")) { l.disabled = false; delete l.dataset.lookOff; }
    for (const u of blobs) URL.revokeObjectURL(u);
    blobs = [];
    if (previewing) { previewing = false; placeStickers(live); }
    document.documentElement.classList.remove("look-preview");
  }

  window.RosinLook = { surfaces: SURFACES.slice(), preview, stop, reload: load, get previewing() { return previewing; } };
  load();
})();
