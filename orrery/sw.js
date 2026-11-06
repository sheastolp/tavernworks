// Service worker for the installable Orrery Explorer (scope /orrery/),
// which takes in the Orrery control page and the Review Clone too.
self.PWA_CACHE = "orrery-v10";
self.PWA_SHELL = ["/orrery/", "/orrery/control/", "/orrery/control/review/", "/voice-input.js", "/pwa.js", "/orrery-review.js", "/orrery/review-summary.js", "/orrery/manifest.webmanifest", "/orrery/icon-192.png"];
importScripts("/pwa-sw-core.js");

// The number on the app icon: how many changes wait on grand-orrery's review
// branch for the owner to publish. pwa.js only turns this on for a phone
// that holds the owner's token; the browser decides how often it runs.
self.addEventListener("periodicsync", (e) => {
  if (e.tag !== "orrery-review") return;
  e.waitUntil(fetch("https://api.github.com/repos/sheastolp/grand-orrery/compare/main...review", { cache: "no-store", headers: { accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { const n = j.ahead_by || 0; return n ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge(); })
    .catch(() => {}));
});
