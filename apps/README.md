# Rosin apps

Rosin, the vine-orb AI co-host, outside the browser. Both apps open tavernworks.dev/rosin/, so anything
changed on the site shows up in them too. The laptop key is entered once in each app under ⋯ → Laptop key.

- `rosin-android/`: Android app (Kotlin, WebView) with a resizable home screen widget that is just Rosin
  on a see-through background, with speech bubbles while Rosin talks (tap Rosin to open the app). Uses the
  phone's own speech-to-text and voice (`assets/rosin-bridge.js` plugs them into the page).
- Both apps tell the page which device it's on (`?device=windows-app`, `android-app`, or `android-widget`
  while the Android app is in the background and replies only show in the widget's bubbles), also as
  `window.RosinDevice` and a `rosin-device` event, so Rosin can fit its replies to the device.
- `rosin-desktop/`: Windows app (Electron). Floating see-through window that stays on top, tray icon,
  hotkeys Ctrl+Alt+R (show/hide), Ctrl+Alt+T (talk), Ctrl+Alt+Y (type). Keeps talking while hidden.

GitHub Actions (`.github/workflows/rosin-apps.yml`) builds both on every push that touches `apps/`.
The APK and the Windows installer are under "Artifacts" on the run's page.

Direct downloads (newest release):
- Android: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin.apk
- Windows installer: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin-Setup.exe
- Windows portable: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin-Portable.exe

To publish a new release: Actions → Rosin apps → Run workflow, tick "release" and give a new version (or push a tag like `rosin-v1.0.2`).
