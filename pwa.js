// Makes a Tavernworks page installable as its own app (Android: "Install
// app" / "Add to Home screen"). Load it with
//   <script src="/pwa.js" data-sw="/orrery/sw.js" data-scope="/orrery/"></script>
//
// - Registers the app's service worker.
// - Fills any element with [data-install] with an "Install app" button,
//   shown only when the browser offers installing and the page isn't already
//   running as the app.
// - In the app, links into the same app that would open a new tab
//   (target=_blank) open in the app instead, so the Review Clone and the
//   review page stay inside the Orrery app.
// - Shows a bar when offline: pages open from the last saved copy, but the
//   AI, the review list, publishing and the Codex's lore need a connection.
// - data-badge="review" (Orrery pages): on a device holding the owner's
//   token, the app icon shows how many changes wait on grand-orrery's review
//   branch. data-badge="manual": the page reports the number itself through
//   tavernPWA.badge(n), because it already asks GitHub.
//
// Storage is shared: the installed apps and the browser are one site, so the
// Codex, the owner's token, saved characters and lore-keeper pitches are the
// same in all of them.
(function () {
  const me = document.currentScript;
  const sw = me && me.dataset.sw, scope = me && me.dataset.scope, badgeMode = me && me.dataset.badge;
  const OWNER_KEY = "verrowen-owner";
  const COMPARE = "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443/db/compare";
  const root = document.documentElement;
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  const owner = () => { try { return !!localStorage.getItem(OWNER_KEY); } catch { return false; } };
  if (standalone()) root.classList.add("standalone");

  // ── Service worker ──
  // Every browser must converge on the same app: ask for the newest worker
  // on every open (and again when a long-lived window comes back to the
  // front), and when a new worker takes over, reload once so the page the
  // person is looking at is the new one, not the one the old worker served.
  let reg = null;
  if (sw && "serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    addEventListener("load", () => navigator.serviceWorker.register(sw, scope ? { scope } : undefined)
      .then((r) => { reg = r; r.update().catch(() => {}); syncBackground(); }).catch(() => {}));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && reg) reg.update().catch(() => {}); });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return;                       // first install: the page is already the new one
      try { if (sessionStorage.getItem("pwa-reloaded")) return; sessionStorage.setItem("pwa-reloaded", "1"); } catch { return; }
      location.reload();
    });
  }

  // ── Install button ──
  let deferred = null;
  function show(on) {
    document.querySelectorAll("[data-install]").forEach((el) => {
      if (!el.firstChild) {
        const b = document.createElement("button");
        b.type = "button"; b.className = el.dataset.install || "btn";
        b.textContent = "📲 Install app";
        b.title = "Add this to your home screen as its own app";
        b.addEventListener("click", install);
        el.appendChild(b);
      }
      el.hidden = !on;
    });
  }
  async function install() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch {}
    deferred = null; show(false);
  }
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (standalone() || root.classList.contains("embed")) return;
    deferred = e;
    ready(() => show(true));
  });
  addEventListener("appinstalled", () => { deferred = null; show(false); });

  // ── Keep the app's own links inside the app ──
  document.addEventListener("click", (e) => {
    if (!standalone() || !scope) return;
    const a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (!a || !a.href) return;
    const u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname.startsWith(scope)) a.removeAttribute("target");
  }, true);

  // ── Offline bar ──
  function offline() {
    let bar = document.getElementById("pwaOffline");
    if (navigator.onLine) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "pwaOffline"; bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:999;background:#3a2410;border-top:1px solid #e0a84a;color:#f1e6d6;font:14px/1.4 Inter,system-ui,sans-serif;padding:8px 16px calc(8px + env(safe-area-inset-bottom));text-align:center";
      bar.innerHTML = "<b style=\"color:#f5c873\">Offline.</b> This is the last saved copy. The AI, the review list, publishing and fresh lore come back with a connection.";
      document.body.appendChild(bar);
    }
    bar.hidden = false;
  }
  addEventListener("online", offline); addEventListener("offline", offline);
  ready(offline);

  // ── Review badge on the app icon ──
  function badge(n) {
    if (!("setAppBadge" in navigator)) return;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  function syncBackground() {
    if (!badgeMode || !reg || !("periodicSync" in reg)) return;
    if (!owner()) { reg.periodicSync.unregister("orrery-review").catch(() => {}); return; }
    navigator.permissions.query({ name: "periodic-background-sync" }).then((p) => {
      if (p.state === "granted") return reg.periodicSync.register("orrery-review", { minInterval: 6 * 60 * 60 * 1000 });
    }).catch(() => {});
  }
  // GitHub allows 60 unsigned calls an hour per address, so check at most
  // every ten minutes, and never for visitors without the owner's token.
  function checkReview() {
    if (badgeMode !== "review" || !navigator.onLine) return;
    if (!owner()) { badge(0); return; }
    let last = 0; try { last = +localStorage.getItem("orrery-review-checked") || 0; } catch {}
    if (Date.now() - last < 10 * 60 * 1000) return;
    try { localStorage.setItem("orrery-review-checked", String(Date.now())); } catch {}
    fetch(COMPARE, { cache: "no-store", headers: { accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => badge(j.ahead_by || 0)).catch(() => {});
  }
  if (badgeMode) {
    ready(checkReview);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkReview(); });
  }

  window.tavernPWA = { standalone, badge: (n) => { if (owner()) badge(n || 0); syncBackground(); } };
})();
