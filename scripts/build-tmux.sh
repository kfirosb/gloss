#!/bin/sh
# Build tmux with static libevent and only macOS system-library dependencies.
set -eu
# Hermetic toolchain: keep Homebrew headers, libraries and tools out of the build.
unset CPATH C_INCLUDE_PATH LIBRARY_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "tmux packaging requires Apple Silicon macOS" >&2; exit 1; }
TMUX_VERSION=3.5a
LIBEVENT_VERSION=2.1.12-stable
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/la-tmux.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
PREFIX="$WORK/prefix"
OUT="$ROOT/vendor/tmux/bin"
SDK=$(xcrun --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET=13.0
export CC="$(xcrun --find clang)"
export CPP="$CC -E"
export CPPFLAGS="-isysroot $SDK"
export CFLAGS="-arch arm64 -isysroot $SDK -mmacosx-version-min=13.0"
export LDFLAGS="-arch arm64 -isysroot $SDK -mmacosx-version-min=13.0"
# Do not let a Homebrew pkg-config inject non-system runtime dependencies.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
cd "$WORK"
curl --proto =https --tlsv1.2 -fsSL "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" -o libevent.tar.gz
curl --proto =https --tlsv1.2 -fsSL "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" -o tmux.tar.gz
# SHA-256 of the GitHub release tarballs. Neither project publishes a hash on its release page
# (libevent publishes a .asc signature only), so these were recorded from the downloaded assets.
cat > SHA256SUMS <<'SUMS'
92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb  libevent.tar.gz
16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951  tmux.tar.gz
SUMS
shasum -a 256 -c SHA256SUMS
tar xzf libevent.tar.gz
(cd "libevent-$LIBEVENT_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --disable-openssl --disable-samples --disable-libevent-regress && make -j8 && make install)
tar xzf tmux.tar.gz
(cd "tmux-$TMUX_VERSION" && ./configure --prefix="$PREFIX" --disable-utf8proc CFLAGS="$CFLAGS -I$PREFIX/include" LDFLAGS="$LDFLAGS -L$PREFIX/lib" && make -j8)
# Validate before replacing an existing known-good bundle artifact.
otool -L "tmux-$TMUX_VERSION/tmux" > dependencies.txt
if sed '1d' dependencies.txt | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)' ; then
  echo "tmux has a non-system shared library dependency" >&2
  exit 1
fi
lipo "tmux-$TMUX_VERSION/tmux" -verify_arch arm64
mkdir -p "$OUT"
cp "tmux-$TMUX_VERSION/tmux" "$OUT/tmux"
strip "$OUT/tmux"
chmod 755 "$OUT/tmux"
# Keep upstream licenses with the redistributable binary.
cp "tmux-$TMUX_VERSION/COPYING" "$OUT/../TMUX-LICENSE"
cp "libevent-$LIBEVENT_VERSION/LICENSE" "$OUT/../LIBEVENT-LICENSE"
"$OUT/tmux" -V
