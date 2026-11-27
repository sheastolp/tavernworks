#!/usr/bin/env bash
# Builds llama.cpp's ggml (CPU + Metal + RPC server) for iPhone/iPad at the pool's pinned build,
# as one static library the app links. Runs on a Mac (GitHub Actions macos runner or your own).
#   vendor/lib/libggml-all.a
#   vendor/include/*.h
set -euo pipefail
cd "$(dirname "$0")"
PIN="$(tr -d ' \n' < ../pool-worker-android/engine-pin.txt)"
WORK="${RUNNER_TEMP:-/tmp}/pool-ggml-ios-${PIN}"
rm -rf "$WORK" vendor
mkdir -p "$WORK" vendor/lib vendor/include

git clone --depth 1 --branch "$PIN" https://github.com/ggml-org/llama.cpp "$WORK/llama.cpp"

cmake -S "$WORK/llama.cpp/ggml" -B "$WORK/build" -G Xcode \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphoneos \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 \
  -DCMAKE_XCODE_ATTRIBUTE_ONLY_ACTIVE_ARCH=NO \
  -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO \
  -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED=NO \
  -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY="" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_RPC=ON \
  -DGGML_BLAS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_BUILD_TESTS=OFF \
  -DGGML_BUILD_EXAMPLES=OFF

cmake --build "$WORK/build" --config Release -- -quiet CODE_SIGNING_ALLOWED=NO

LIBS=$(find "$WORK/build" -name 'libggml*.a' -path '*Release-iphoneos*')
echo "Static libraries:"; echo "$LIBS"
# shellcheck disable=SC2086
libtool -static -o vendor/lib/libggml-all.a $LIBS
cp "$WORK/llama.cpp/ggml/include/"*.h vendor/include/
echo "$PIN" > vendor/PIN
nm -g vendor/lib/libggml-all.a | grep -q ggml_backend_rpc_start_server
nm -g vendor/lib/libggml-all.a | grep -q ggml_backend_metal_reg
echo "ggml ${PIN} for iOS ready (Metal + RPC server)."
