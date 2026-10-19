#!/bin/sh
# Build whisper.cpp's server, statically linked, with only macOS system-library dependencies.
# Usage: build-whisper.sh [arm64|x64]   (default: the build Mac's own architecture)
# arm64 uses Metal; x64 is CPU-only (ggml's Metal backend targets Apple GPUs, so an Intel Mac
# transcribes noticeably slower with the same model).
set -eu
unset CPATH C_INCLUDE_PATH LIBRARY_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$(uname -s)" = Darwin ] || { echo "whisper packaging requires macOS" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; command -v cmake >/dev/null 2>&1 || { echo "cmake is required (brew install cmake)" >&2; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/target-arch.sh"
WHISPER_TAG=v1.9.5
# Oldest macOS the binary runs on; also the compiler's deployment target.
TARGET=13.0
case "$ARCH" in
  arm64) METAL=ON ;;
  x64) METAL=OFF ;;
esac
WORK=$(mktemp -d "${TMPDIR:-/tmp}/la-whisper.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
OUT="$ROOT/vendor/whisper/$ARCH/bin"
# The Command Line Tools ship an incomplete libc++ header dir next to clang; use the SDK copy.
SDK=$(xcrun --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET="$TARGET"
cd "$WORK"
curl --proto =https --tlsv1.2 -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_TAG.tar.gz" -o whisper.tar.gz
# SHA-256 of the GitHub tag tarball, recorded from the downloaded asset.
cat > SHA256SUMS <<'SUMS'
ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720  whisper.tar.gz
SUMS
shasum -a 256 -c SHA256SUMS
tar xzf whisper.tar.gz
SRC=$(find . -maxdepth 1 -type d -name 'whisper.cpp-*' | head -1)
# GGML_NATIVE=OFF keeps the x64 build at ggml's portable baseline (AVX2/FMA/F16C, no AVX-512): every Intel Mac
# that runs macOS 13 has at least a Kaby Lake CPU, so that baseline is safe on all of them.
cmake -S "$SRC" -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$(xcrun --find clang)" -DCMAKE_CXX_COMPILER="$(xcrun --find clang++)" -DCMAKE_OSX_SYSROOT="$SDK" "-DCMAKE_CXX_FLAGS=-nostdinc++ -isystem $SDK/usr/include/c++/v1" -DCMAKE_OSX_ARCHITECTURES="$MACH_ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL="$METAL" -DGGML_METAL_EMBED_LIBRARY="$METAL" -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_FFMPEG=OFF -DGGML_NATIVE=OFF
cmake --build build --config Release --target whisper-server -j"$(sysctl -n hw.ncpu)"
BIN=build/bin/whisper-server
otool -L "$BIN" > dependencies.txt
if sed '1d' dependencies.txt | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)' ; then echo "whisper-server has a non-system shared library dependency" >&2; exit 1; fi
lipo "$BIN" -verify_arch "$MACH_ARCH"
mkdir -p "$OUT"; cp "$BIN" "$OUT/whisper-server"; strip "$OUT/whisper-server"; chmod 755 "$OUT/whisper-server"
cp "$SRC/LICENSE" "$ROOT/vendor/whisper/WHISPER-LICENSE"
"$OUT/whisper-server" --help >/dev/null 2>&1 || true
echo "built $OUT/whisper-server for $ARCH from whisper.cpp $WHISPER_TAG"
