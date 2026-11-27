# Rosin apps

Rosin, the vine-orb AI co-host, outside the browser. Both apps open tavernworks.dev/rosin/, so anything
changed on the site shows up in them too. The laptop key is entered once in each app under ⋯ → Laptop key.

- `rosin-android/`: Android app (Kotlin, WebView) with a resizable home screen widget showing Rosin's face,
  what Rosin is doing and the last reply, plus Talk and Type buttons. Uses the phone's own speech-to-text
  and voice (`assets/rosin-bridge.js` plugs them into the page).
- `rosin-desktop/`: Windows app (Electron). Floating see-through window that stays on top, tray icon,
  hotkeys Ctrl+Alt+R (show/hide), Ctrl+Alt+T (talk), Ctrl+Alt+Y (type). Keeps talking while hidden.

GitHub Actions (`.github/workflows/rosin-apps.yml`) builds both on every push that touches `apps/`.
The APK and the Windows installer are under "Artifacts" on the run's page.
