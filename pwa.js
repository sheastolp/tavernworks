// Makes a Tavernworks page installable as its own app (Android: "Install
// app" / "Add to Home screen"). Load it with
//   <script src="/pwa.js" data-sw="/orrery/sw.js" data-scope="/orrery/"></script>
// It registers the app's service worker, and fills any element with
// [data-install] with an "Install app" button, shown only when the browser
// offers installing and the page isn't already running as the app.
(function () {
  const me = document.currentScript;
  const sw = me && me.dataset.sw, scope = me && me.dataset.scope;
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone()) document.documentElement.classList.add("standalone");
  if (sw && "serviceWorker" in navigator) {
    addEventListener("load", () => navigator.serviceWorker.register(sw, scope ? { scope } : undefined).catch(() => {}));
  }
  let deferred = null;
  function buttons() { return document.querySelectorAll("[data-install]"); }
  function show(on) {
    buttons().forEach((el) => {
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
    if (standalone() || document.documentElement.classList.contains("embed")) return;
    deferred = e;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => show(true)); else show(true);
  });
  addEventListener("appinstalled", () => { deferred = null; show(false); });
})();
