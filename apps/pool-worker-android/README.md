# AI Pool worker for Android

One tap joins the pool. No Termux. The app does what `pool/m5b/pool-worker.py` does, with the same
enrollment and relay protocol:

1. enrolls the phone with the pool (named after its model, offering a third of its RAM, 1-6 GB) and
   waits for the operator's approval in the pool's Roster;
2. runs llama.cpp's own `ggml-rpc-server` at the pool's pin (`engine-pin.txt`, now b12359), bound to
   127.0.0.1 only, shipped inside the APK (`fetch-engine.sh` puts upstream's release binaries in);
3. holds one relay WebSocket to the pool front, which carries the host's RPC traffic;
4. stays running with the screen off behind a notification ("Leave the pool" is on it), and pauses
   when the phone is unplugged (setting), the battery passes 42 °C, or Android reports severe heat.

Which engine:
- **Adreno 7xx/8xx** (Snapdragon 8 Gen 2 and newer, some 8 Gen 1 / 7-series): the Snapdragon build on
  the GPU through the phone's OpenCL driver, but only while the pool's model is MXFP4, Q4_0 or Q8_0
  (llama.cpp's Adreno kernels can't run the other quants' expert layers). With any other model it
  serves on the CPU and switches by itself when the model changes.
- **Every other phone** (Mali, PowerVR, older Adreno): the CPU build, lending CPU and RAM.
- If the GPU engine won't start, the app falls back to the CPU and remembers that.

## Install

1. On the phone, open the newest release on GitHub (tag `pool-worker-v…`) and download `PoolWorker.apk`,
   or take it from the newest "Pool worker apps" run's Artifacts.
2. Open it and allow installing from your browser when Android asks.
3. Open Pool Worker, tap **Join the pool**, allow notifications, and tap **Let it run in the background**.
4. Approve the phone in the pool's Roster. It joins by itself.

If the Termux worker is running on the same phone, stop it first (both use port 50052).

## Build

GitHub Actions (`.github/workflows/pool-worker-apps.yml`) runs `fetch-engine.sh` then
`gradle assembleRelease`. Locally: run `./fetch-engine.sh`, then build with Gradle 8.14 and JDK 17.
To change the pin, edit `engine-pin.txt` and `engine-sha256.txt` together.

Signing: without the `POOL_KEYSTORE_B64` / `POOL_KEYSTORE_PASSWORD` secrets each build is signed with
the runner's throwaway debug key, so a new build can't update the old one: uninstall first, then
approve the phone again. Add the secrets once to make updates install over the top.
