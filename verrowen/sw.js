// Service worker for the installable Wake in Verrowen (scope /verrowen/,
// which takes in the Codex too).
self.PWA_CACHE = "verrowen-v9";
self.PWA_SHELL = ["/verrowen/", "/verrowen/codex/", "/voice-input.js", "/ai-model-note.js", "/pwa.js", "/orrery-review.js", "/verrowen/manifest.webmanifest", "/verrowen/icon-192.png"];
importScripts("/pwa-sw-core.js");
