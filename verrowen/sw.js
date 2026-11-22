// Service worker for the installable Wake in Verrowen (scope /verrowen/,
// which takes in the Codex too).
self.PWA_CACHE = "verrowen-v20";
self.PWA_SHELL = ["/verrowen/", "/verrowen/codex/", "/verrowen/voices/", "/voice-input.js", "/ai-model-note.js", "/pwa.js", "/orrery-review.js", "/orrery-db.js", "/verrowen/manifest.webmanifest", "/verrowen/icon-192.png"];
importScripts("/pwa-sw-core.js");
