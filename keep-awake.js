/* keep-awake.js: keeps tavernworks.dev/rosin/ and /local-ai/chat/ working when the tab isn't in front.
 *
 *   KeepAwake.ticker(ms, fn)   like setInterval, but runs from a tiny worker, so Chrome and Edge don't slow it
 *                              to once a minute when the tab is in the background. Returns a stop function.
 *   KeepAwake.after(ms, fn)    like setTimeout, from the same worker. Returns a cancel function.
 *   KeepAwake.hold(name)       holds a Web Lock, so Chrome doesn't freeze or discard the tab to save memory.
 *                              Returns a release function.
 *   KeepAwake.screen(on)       keeps the screen from sleeping while this tab is showing (Screen Wake Lock).
 *                              The browser drops it when the tab is hidden; it comes back when the tab does.
 *   KeepAwake.onWake(fn)       runs fn when the tab comes back to the front, the network comes back,
 *                              or the page is restored from the back/forward cache.
 *
 * Phones (iPhone Safari above all) still pause a tab once it's in the background or the screen locks;
 * nothing a page can do stops that. These keep it alive on PCs and the Legion Go 2, and keep phones awake
 * while the page is on screen.
 */
(() => {
  // ---------- a timer the browser won't throttle ----------
  let worker = null;
  const jobs = new Map();
  let nextId = 1;
  function startWorker() {
    if (worker !== null) return worker;
    try {
      const src = "const t=new Map();onmessage=e=>{const d=e.data;if(d.stop){clearInterval(t.get(d.id));t.delete(d.id);}else t.set(d.id,setInterval(()=>postMessage(d.id),d.ms));};";
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      worker.onmessage = (e) => { const fn = jobs.get(e.data); if (fn) try { fn(); } catch (err) { console.error(err); } };
    } catch { worker = false; }   // no workers (or blocked): plain timers
    return worker;
  }
  function ticker(ms, fn) {
    const w = startWorker();
    if (!w) { const t = setInterval(fn, ms); return () => clearInterval(t); }
    const id = nextId++;
    jobs.set(id, fn);
    w.postMessage({ id, ms });
    return () => { jobs.delete(id); w.postMessage({ id, stop: true }); };
  }

  function after(ms, fn) {
    let stop = null, fired = false;
    stop = ticker(ms, () => { if (fired) return; fired = true; stop?.(); fn(); });
    return () => { fired = true; stop?.(); };
  }

  // ---------- don't let the tab be frozen or discarded ----------
  function hold(name) {
    if (!navigator.locks?.request) return () => {};
    let release;
    const held = new Promise((r) => (release = r));
    navigator.locks.request("tavernworks-" + name + "-" + Math.random().toString(36).slice(2), () => held).catch(() => {});   // one per tab, so every tab holds its own
    return () => release();
  }

  // ---------- keep the screen on while the page is showing ----------
  let wantScreen = false, sentinel = null;
  async function grab() {
    if (!wantScreen || sentinel || document.visibilityState !== "visible" || !navigator.wakeLock?.request) return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { sentinel = null; });
    } catch { sentinel = null; }   // battery saver, or no permission: the screen may sleep as usual
  }
  function screen(on) {
    wantScreen = !!on;
    if (wantScreen) grab();
    else if (sentinel) { sentinel.release().catch(() => {}); sentinel = null; }
    return !!navigator.wakeLock?.request;
  }

  // ---------- notice when the page comes back ----------
  const wakers = [];
  const wake = (why) => { for (const fn of wakers) try { fn(why); } catch (e) { console.error(e); } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { grab(); wake("visible"); } });
  window.addEventListener("online", () => wake("online"));
  window.addEventListener("pageshow", (e) => { if (e.persisted) wake("restored"); });
  window.addEventListener("focus", () => grab());

  window.KeepAwake = { ticker, after, hold, screen, onWake: (fn) => wakers.push(fn), screenSupported: () => !!navigator.wakeLock?.request };
})();
