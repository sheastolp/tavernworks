/* rosin-eyes.js: show Rosin a photo (load after rosin-web.js).
 *
 * The 📷 button by the chat box takes a photo or picks one (up to 3), and pasting or dropping an image works too.
 * Photos wait above the box until you next say or type something (or just tap Send), then go with that message.
 * Each one is shrunk to 896 px on its longest side first, which keeps it quick for the laptop to look at.
 * Rosin can only see them when the laptop's model has its vision file (tavernworks.dev/local-ai/#eyes).
 * 🎥 next to it does the same for a video (one at a time; pasting or dropping one works too): rosin-video.js watches it
 * and hands over its frames and what's said in it.
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R) return;
  const MAX_SIDE = 896, MAX_PICS = 3, QUALITY = 0.85;
  const STEPS = "The laptop's model can't see photos yet. Steps: tavernworks.dev/local-ai/#eyes";
  const form = document.getElementById("say"), box = document.getElementById("say-text");
  if (!form || !box) return;
  let pending = [];   // { b64, url }

  // ---------- the button, the hidden picker and the strip of waiting photos ----------
  const pick = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true, hidden: true });
  pick.id = "pic-file";
  const btn = Object.assign(document.createElement("button"), { type: "button", id: "pic-btn", textContent: "📷" });
  btn.setAttribute("aria-label", "Show Rosin a photo"); btn.title = "Show Rosin a photo (or paste or drop one)";
  // 🎥: pick a video, or record one (phones offer the camera in the same picker).
  const vpick = Object.assign(document.createElement("input"), { type: "file", accept: "video/*", hidden: true });
  vpick.id = "vid-file";
  const vbtn = Object.assign(document.createElement("button"), { type: "button", id: "vid-btn", textContent: "🎥" });
  vbtn.setAttribute("aria-label", "Show Rosin a video"); vbtn.title = "Show Rosin a video (pick or record one, or paste or drop one)";
  form.prepend(btn, vbtn, pick, vpick);
  const strip = document.createElement("div"); strip.id = "pics"; strip.hidden = true;
  strip.setAttribute("aria-label", "Photos and videos waiting to send");
  form.parentNode.insertBefore(strip, form);

  btn.addEventListener("click", () => { if (pending.length >= MAX_PICS) { R.status(`Up to ${MAX_PICS} photos at a time.`); return; } pick.click(); });
  pick.addEventListener("change", () => { add([...pick.files]); pick.value = ""; });
  vbtn.addEventListener("click", () => vpick.click());
  vpick.addEventListener("change", () => { add([...vpick.files]); vpick.value = ""; });
  // Pasting a screenshot into the chat box, or anywhere on the page.
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file" && /^(image|video)\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); add(files); }
  });
  // Dropping an image file on the page (desktop, or the Legion Go with a mouse).
  document.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => /^(image|video)\//.test(i.type))) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
    if (files.length) { e.preventDefault(); add(files); }
  });

  // A photo on its own can be sent with an empty box: Rosin gets "Take a look at this."
  form.addEventListener("submit", (e) => {
    if (box.value.trim() || !pending.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    B.say("");
  }, true);

  async function add(files) {
    const vids = files.filter((f) => f.type.startsWith("video/"));
    files = files.filter((f) => !f.type.startsWith("video/"));
    for (const f of vids.slice(0, 1)) {
      if (!B.video) { R.status("Videos need this page reloaded.", true); break; }
      const err = B.video.check(f);
      if (err) { R.status(err, true); continue; }
      pending = pending.filter((p) => !p.job);   // one video at a time: a new one replaces the waiting one
      const job = B.video.watch(f);
      const p = { job, url: "", name: f.name || "video", dur: 0 };
      job.then((v) => { p.url = v.thumb; p.dur = v.dur; draw(); }, () => {});
      job.catch((e) => { pending = pending.filter((x) => x !== p); draw(); R.status(e.message || "That video didn't open here.", true); });
      pending.push(p);
    }
    for (const f of files.slice(0, MAX_PICS - pending.length)) {
      try { pending.push(await shrink(f)); }
      catch { R.status("That picture didn't open here. Try a JPEG or PNG.", true); }
    }
    if (files.length > MAX_PICS) R.status(`Up to ${MAX_PICS} photos at a time.`);
    draw();
    if (!pending.length) return;
    if (pending.some((p) => p.job)) { R.status("Watching your video… ask Rosin about it, or just tap Send."); return; }
    R.status(canSee() ? "Photo ready. Say or type something, or just tap Send." : STEPS, !canSee());
  }
  const canSee = () => !H.usingPool() || H.eyes();

  // Down to MAX_SIDE on the longest side, as JPEG. Phone photos are 3,000 to 4,000 px; the model needs far less.
  async function shrink(file) {
    const img = await load(file);
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error("empty");
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);   // a see-through PNG gets a white back
    g.drawImage(img, 0, 0, c.width, c.height);
    img.close?.();
    const url = c.toDataURL("image/jpeg", QUALITY);
    return { b64: url.slice(url.indexOf(",") + 1), url };
  }
  async function load(file) {
    // createImageBitmap turns a phone photo the right way up; an <img> is the fallback for older browsers.
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {} }
    const url = URL.createObjectURL(file);
    try {
      const im = new Image(); im.decoding = "async"; im.src = url;
      await im.decode();
      return im;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function draw() {
    strip.hidden = !pending.length;
    strip.replaceChildren(...pending.map((p, i) => {
      const fig = document.createElement("div"); fig.className = "pic-wait" + (p.job ? " vid" : "");
      const im = document.createElement("img"); if (p.url) im.src = p.url; im.alt = p.job ? "Video waiting to send" : `Photo ${i + 1} waiting to send`;
      if (p.job) fig.dataset.label = p.dur ? `🎞 ${Math.floor(p.dur / 60)}:${String(Math.round(p.dur % 60)).padStart(2, "0")}` : "🎞 …";
      const x = Object.assign(document.createElement("button"), { type: "button", textContent: "✕" });
      x.setAttribute("aria-label", p.job ? "Remove the video" : `Remove photo ${i + 1}`);
      x.addEventListener("click", () => { pending.splice(i, 1); draw(); box.focus(); });
      fig.append(im, x);
      return fig;
    }));
    if (pending.length && !canSee() && pending.some((p) => !p.job)) {
      const note = document.createElement("span"); note.className = "pic-note"; note.textContent = "Rosin can't see photos yet.";
      strip.append(note);
    }
    H.fit();
  }

  // rosin-web.js asks for the waiting photos when this person says something.
  // A waiting video always goes (what's said in it still helps when the laptop can't see); photos wait for eyes.
  H.takePics = async () => {
    if (!pending.length) return [];
    const vid = pending.find((p) => p.job);
    if (!canSee() && !vid) return Object.assign([], { note: STEPS });   // they stay, for when the laptop can see
    const going = canSee() ? pending : [vid];
    pending = pending.filter((p) => !going.includes(p)); draw();
    const out = [];
    let extra = "";
    for (const p of going) {
      if (!p.job) { out.push(p.b64); continue; }
      R.status("Rosin is watching your video…");
      try {
        const v = await p.job;
        if (canSee() && v.sheet) out.unshift(v.sheet);
        extra = B.video.describe(v, canSee());
      } catch { extra = "[App: the person tried to send a video, but it couldn't be opened here, so you haven't seen it. Say so.]"; }
    }
    return Object.assign(out, { extra, media: vid ? "video" : "", note: !canSee() && pending.length ? STEPS : "" });
  };

  B.eyes = { add, pending: () => pending.slice(), draw };
})();
