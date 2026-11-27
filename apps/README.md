# Rosin apps

Rosin, the vine-orb AI co-host, outside the browser. Both apps open tavernworks.dev/rosin/, so anything
changed on the site shows up in them too. The laptop key is entered once in each app under ⋯ → Laptop key.

- `rosin-android/`: Android app (Kotlin, WebView). Rosin floats over the home screen and other apps with no
  box ("Display over other apps"), speaks up on its own and talks in speech bubbles; tap Rosin to open the app,
  drag to move. A foreground service keeps Rosin's page running with the app closed. Uses the phone's own
  speech-to-text and voice (`assets/rosin-bridge.js` plugs them into the page). `emulator-test.sh` is run by CI.
- Both apps tell the page which device it's on (`?device=windows-app`, `android-app`, or `android-widget`
  while the Android app is in the background and replies only show in the widget's bubbles), also as
  `window.RosinDevice` and a `rosin-device` event, so Rosin can fit its replies to the device.
- `rosin-desktop/`: Windows app (Electron). Just Rosin on the desktop with no box, talking in speech bubbles;
  clicks pass through everywhere except Rosin. Click Rosin to open the app, drag to move, Esc or clicking away
  goes back to just Rosin. Tray icon, hotkeys Ctrl+Alt+R (show/hide), Ctrl+Alt+T (talk), Ctrl+Alt+Y (type).
  Keeps talking while hidden.

GitHub Actions (`.github/workflows/rosin-apps.yml`) builds both on every push that touches `apps/`.
The APK and the Windows installer are under "Artifacts" on the run's page.

Direct downloads (newest release):
- Android: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin.apk
- Windows installer: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin-Setup.exe
- Windows portable: https://github.com/sheastolp/tavernworks/releases/latest/download/Rosin-Portable.exe

To publish a new release: Actions → Rosin apps → Run workflow, tick "release" and give a new version (or push a tag like `rosin-v1.0.2`).

# AI Pool worker apps

- `pool-worker-android/`: phones join the AI Pool with one tap (Kotlin, Compose). Bundles llama.cpp's
  rpc-server at the pool's pin; Adreno 7xx/8xx GPUs compute, other phones lend CPU and RAM.
- `pool-worker-ios/`: iPhone and iPad (SwiftUI), the RPC server built in with Metal. Foreground only.

Built by `.github/workflows/pool-worker-apps.yml`; releases are tagged `pool-worker-v…` and never
marked "latest", so the Rosin links above keep pointing at Rosin.
