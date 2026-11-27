# AI Pool worker for iPhone and iPad

The same worker as the Android app, but iOS can't run other programs, so llama.cpp's RPC server is
built into the app (`build-ggml.sh`: ggml at the pool's pin with Metal + RPC, one static library).
It computes on the device's GPU through Metal, which runs every quant the pool uses (IQ4_XS included).

## What iOS allows

- **Foreground only.** iOS suspends apps seconds after they leave the screen and doesn't let
  background apps use the GPU. The worker leaves the split cleanly when you switch away and rejoins
  when you come back. Keep it open, plugged in, screen on (the app keeps the screen awake).
  On an iPad, Guided Access (Settings → Accessibility) keeps it locked in the app.
- **Memory.** iOS caps how much one app may hold, well below the device's RAM. The app offers a third
  of RAM by default, never more than 70% of what iOS lets it use at that moment, and shows that figure.

## Install (no Mac needed)

GitHub Actions builds an **unsigned** IPA on a Mac runner. Apple only runs apps signed for your
device, so you sign it yourself with your own Apple ID:

1. Download `PoolWorker-unsigned.ipa` from the newest `pool-worker-v…` release (or the run's Artifacts).
2. On a Windows PC or Mac, install **Sideloadly** (or AltStore), plug in the iPhone/iPad, drop the IPA
   in, and sign in with your Apple ID when it asks.
3. On the device: Settings → Privacy & Security → **Developer Mode** on (iOS 16+, restarts the device),
   then Settings → General → VPN & Device Management → trust your Apple ID.
4. Open Pool Worker, tap **Join the pool**, and approve it in the pool's Roster.

With a **free** Apple ID the signature lasts 7 days (re-sign in Sideloadly to renew; up to 3 sideloaded
apps). A **paid Apple Developer account** ($99/year) makes it last a year and opens TestFlight, which
needs the signing certificate added to Actions as secrets.

## Build locally (Mac with Xcode 16)

    brew install xcodegen
    ./build-ggml.sh
    xcodegen generate
    open PoolWorker.xcodeproj   # pick your team under Signing, run on the device
