// Service worker for the installable Orrery Explorer (scope /orrery/).
self.PWA_CACHE = "orrery-v1";
self.PWA_SHELL = ["/orrery/", "/orrery/control/", "/voice-input.js", "/pwa.js", "/orrery/manifest.webmanifest", "/orrery/icon-192.png"];
importScripts("/pwa-sw-core.js");
