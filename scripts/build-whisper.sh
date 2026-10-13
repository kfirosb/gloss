#!/bin/sh
# Build whisper.cpp's server with Metal, statically linked, with only macOS system-library dependencies.
set -eu
unset CPATH C_INCLUDE_PATH LIBRARY_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "whisper packaging requires Apple Silicon macOS" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || PATH="$PATH:/opt/homebrew/bin"; command -v cmake >/dev/null 2>&1 || { echo "cmake is required (brew install cmake)" >&2; exit 1; }
WHISPER_TAG=v1.9.5
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/la-whisper.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
OUT="$ROOT/vendor/whisper/bin"
# The Command Line Tools ship an incomplete libc++ header dir next to clang; use the SDK copy.
SDK=$(xcrun --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET=13.0
cd "$WORK"
curl --proto =https --tlsv1.2 -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_TAG.tar.gz" -o whisper.tar.gz
# SHA-256 of the GitHub tag tarball, recorded from the downloaded asset.
cat > SHA256SUMS <<'SUMS'
ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720  whisper.tar.gz
SUMS
shasum -a 256 -c SHA256SUMS
tar xzf whisper.tar.gz
SRC=$(find . -maxdepth 1 -type d -name 'whisper.cpp-*' | head -1)
cmake -S "$SRC" -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$(xcrun --find clang)" -DCMAKE_CXX_COMPILER="$(xcrun --find clang++)" -DCMAKE_OSX_SYSROOT="$SDK" "-DCMAKE_CXX_FLAGS=-nostdinc++ -isystem $SDK/usr/include/c++/v1" -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_FFMPEG=OFF -DGGML_NATIVE=OFF
cmake --build build --config Release --target whisper-server -j8
BIN=build/bin/whisper-server
otool -L "$BIN" > dependencies.txt
if sed '1d' dependencies.txt | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)' ; then echo "whisper-server has a non-system shared library dependency" >&2; exit 1; fi
lipo "$BIN" -verify_arch arm64
mkdir -p "$OUT"; cp "$BIN" "$OUT/whisper-server"; strip "$OUT/whisper-server"; chmod 755 "$OUT/whisper-server"
cp "$SRC/LICENSE" "$OUT/../WHISPER-LICENSE"
"$OUT/whisper-server" --help >/dev/null 2>&1 || true
echo "built $OUT/whisper-server from whisper.cpp $WHISPER_TAG"
