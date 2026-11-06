// Shared service-worker logic for the installable Tavernworks apps
// (/orrery/ and /verrowen/). Each app's own sw.js sets self.PWA_CACHE and
// self.PWA_SHELL, then importScripts this file.
//
// Strategy: network first, cache as the fallback. Pages and the lore read
// from GitHub are always fresh when there's a connection, and the last copy
// still opens when there isn't. Calls to the AI on the laptop are never
// cached: they pass straight through.
const CACHE = self.PWA_CACHE;
const SHELL = self.PWA_SHELL || [];
const CACHEABLE_HOSTS = ["raw.githubusercontent.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE.split("-v")[0] + "-v") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !CACHEABLE_HOSTS.includes(url.hostname)) return;
  // Pages are cached without their query/hash, so ?clone=review and #chat
  // still open offline from the one cached copy.
  const key = req.mode === "navigate" ? url.origin + url.pathname : req;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: req.mode === "navigate" })
      .then((hit) => hit || (req.mode === "navigate" ? caches.match(SHELL[0]) : undefined))
      .then((hit) => hit || Response.error()))
  );
});
