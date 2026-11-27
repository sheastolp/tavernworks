#!/usr/bin/env bash
# Puts llama.cpp's own Android rpc-server (at the pool's pinned build) inside the app.
# Runs before Gradle, in GitHub Actions or on your PC. It downloads the two upstream
# release archives, checks their SHA-256, and lays them out like this:
#
#   app/src/main/jniLibs/arm64-v8a/   (installed by Android in the app's native library
#                                      folder, the one place an app may run programs from)
#     libpoolrpc_cpu.so       ggml-rpc-server, CPU build (every phone)
#     libggml*.so             its libraries + the CPU variants it picks from at start
#     libpoolrpc_gpu.so       ggml-rpc-server, Snapdragon build (Adreno GPU via OpenCL)
#   app/src/main/assets/engine-gpu/   the Snapdragon build's libraries; the app copies them
#                                      to its own storage the first time the GPU is used
#                                      (their names clash with the CPU build's).
set -euo pipefail
cd "$(dirname "$0")"
PIN="$(tr -d ' \n' < engine-pin.txt)"           # e.g. b12359
CPU_TGZ="llama-${PIN}-bin-android-arm64.tar.gz"
GPU_TGZ="llama-${PIN}-bin-android-arm64-snapdragon.tar.gz"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/${PIN}"
WORK="${RUNNER_TEMP:-/tmp}/pool-engine-${PIN}"
mkdir -p "$WORK"

for f in "$CPU_TGZ" "$GPU_TGZ"; do
  if [ ! -f "$WORK/$f" ]; then
    echo "Downloading $f"
    curl -fsSL --retry 3 -o "$WORK/$f.tmp" "$BASE/$f"
    mv "$WORK/$f.tmp" "$WORK/$f"
  fi
done
( cd "$WORK" && sha256sum -c "$OLDPWD/engine-sha256.txt" )

rm -rf "$WORK/cpu" "$WORK/gpu"
mkdir -p "$WORK/cpu" "$WORK/gpu"
tar xzf "$WORK/$CPU_TGZ" -C "$WORK/cpu"
tar xzf "$WORK/$GPU_TGZ" -C "$WORK/gpu"

JNI=app/src/main/jniLibs/arm64-v8a
ASSETS=app/src/main/assets/engine-gpu
rm -rf "$JNI" "$ASSETS"
mkdir -p "$JNI" "$ASSETS"

# CPU build: the binary and its ggml libraries (the archive keeps them side by side).
CPU_DIR="$(dirname "$(find "$WORK/cpu" -type f -name ggml-rpc-server | head -1)")"
cp "$CPU_DIR/ggml-rpc-server" "$JNI/libpoolrpc_cpu.so"
for lib in "$CPU_DIR"/libggml*.so; do cp "$lib" "$JNI/"; done

# Snapdragon build: binary into jniLibs under its own name, libraries into assets.
GPU_BIN="$(find "$WORK/gpu" -type f -name ggml-rpc-server | head -1)"
GPU_LIB="$(dirname "$(find "$WORK/gpu" -type f -name libggml-opencl.so | head -1)")"
cp "$GPU_BIN" "$JNI/libpoolrpc_gpu.so"
for lib in "$GPU_LIB"/libggml*.so; do cp "$lib" "$ASSETS/"; done
echo "$PIN" > "$ASSETS/PIN"

echo "Engine ${PIN} in place:"
ls -la "$JNI" "$ASSETS"
