#!/bin/sh
# Build the Linux native pieces Gloss bundles (tmux, whisper-server, node-pty) inside Docker, for one architecture.
# Usage: sh scripts/build-linux-vendor.sh x64|arm64
# Output: vendor/linux-<arch>/bin/{tmux,whisper-server}, vendor/linux-<arch>/node-pty/{pty.node,spawn-helper}, licenses.
# Debian 11 (glibc 2.31) keeps the binaries loadable on Ubuntu 20.04+, Debian 11+, Fedora 33+ and similar.
set -eu
ARCH=${1:-}
case "$ARCH" in
  x64) PLATFORM=linux/amd64 ;;
  arm64) PLATFORM=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/vendor/linux-$ARCH"
mkdir -p "$OUT"
# Same upstream versions and tarball checksums as the Mac scripts (build-tmux.sh, build-whisper.sh).
docker run --rm --platform "$PLATFORM" -v "$OUT:/out" -e TMUX_VERSION=3.5a -e LIBEVENT_VERSION=2.1.12-stable -e WHISPER_TAG=v1.9.5 -e NODE_PTY_VERSION=1.1.0 node:24-bullseye bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
# Bullseye left regular support; use the dated snapshot sources the image ships commented out.
sed -i -e "s|^deb http://deb.debian.org|# &|" -e "s|^# deb http://snapshot|deb http://snapshot|" /etc/apt/sources.list
apt-get -o Acquire::Check-Valid-Until=false update -qq >/dev/null
apt-get install -y -qq --no-install-recommends cmake pkg-config bison libncurses-dev >/dev/null
WORK=$(mktemp -d); cd "$WORK"
curl --proto =https --tlsv1.2 -fsSL "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" -o libevent.tar.gz
curl --proto =https --tlsv1.2 -fsSL "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" -o tmux.tar.gz
curl --proto =https --tlsv1.2 -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_TAG.tar.gz" -o whisper.tar.gz
sha256sum -c <<SUMS
92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb  libevent.tar.gz
16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951  tmux.tar.gz
ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720  whisper.tar.gz
SUMS
JOBS=$(nproc)
# Only glibc, libm/pthread/dl/rt/resolv and the distro terminfo library may be dynamic.
check_deps() {
  if ldd "$1" | awk "{print \$1}" | sed "s|.*/||" | grep -Ev "^(linux-vdso|ld-linux|libc|libm|libpthread|libdl|librt|libutil|libresolv|libtinfo|libncurses|libncursesw|libstdc[+][+]|libgcc_s)[.-]" ; then
    echo "$1 has a non-system shared library dependency" >&2; exit 1
  fi
}
# Finished pieces are kept; delete vendor/linux-<arch> to rebuild everything.
mkdir -p /out/bin /out/node-pty
if [ ! -x /out/bin/tmux ]; then
# tmux: static libevent, dynamic libtinfo so the distro terminfo database is used.
PREFIX="$WORK/prefix"
tar xzf libevent.tar.gz
(cd "libevent-$LIBEVENT_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --disable-openssl --disable-samples --disable-libevent-regress >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
tar xzf tmux.tar.gz
(cd "tmux-$TMUX_VERSION" && PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" --disable-utf8proc CFLAGS="-O2 -I$PREFIX/include" LDFLAGS="-L$PREFIX/lib" >/dev/null && make -j"$JOBS" >/dev/null)
check_deps "tmux-$TMUX_VERSION/tmux"
install -m 755 "tmux-$TMUX_VERSION/tmux" /out/bin/tmux
strip /out/bin/tmux
install -m 644 "tmux-$TMUX_VERSION/COPYING" /out/TMUX-LICENSE
install -m 644 "libevent-$LIBEVENT_VERSION/LICENSE" /out/LIBEVENT-LICENSE
fi
/out/bin/tmux -V
if [ ! -x /out/bin/whisper-server ]; then
# whisper-server: CPU only, static C++ runtime, no OpenMP so libgomp is not required at runtime.
tar xzf whisper.tar.gz
SRC=$(find . -maxdepth 1 -type d -name "whisper.cpp-*" | head -1)
cmake -S "$SRC" -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_FFMPEG=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" >/dev/null
cmake --build build --config Release --target whisper-server -j"$JOBS" >/dev/null
check_deps build/bin/whisper-server
install -m 755 build/bin/whisper-server /out/bin/whisper-server
strip /out/bin/whisper-server
install -m 644 "$SRC/LICENSE" /out/WHISPER-LICENSE
fi
# node-pty: N-API addon built from source with Node 24, loadable by Electron.
mkdir pty && cd pty && npm init -y >/dev/null
npm_config_build_from_source=true npm install --no-audit --no-fund "node-pty@$NODE_PTY_VERSION" >/dev/null
check_deps node_modules/node-pty/build/Release/pty.node
install -m 755 node_modules/node-pty/build/Release/pty.node /out/node-pty/pty.node
[ -f node_modules/node-pty/build/Release/spawn-helper ] && install -m 755 node_modules/node-pty/build/Release/spawn-helper /out/node-pty/spawn-helper
install -m 644 node_modules/node-pty/LICENSE /out/NODE-PTY-LICENSE
echo "built: $(ls /out/bin /out/node-pty | tr "\n" " ")"
'
echo "Linux $ARCH vendor binaries are in $OUT"
