#!/bin/sh
# Installs a Gloss .deb (or runs an .AppImage) in a fresh Ubuntu 24.04 container, launches the app under Xvfb as an
# ordinary user, checks that its local server answers, and saves a screenshot.
# Usage: sh scripts/linux-smoke.sh release/Gloss-<v>-arm64.deb|.AppImage [out-dir]
set -eu
PKG=${1:?usage: $0 <deb|AppImage> [out-dir]}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$PKG" in /*) ;; *) PKG="$PWD/$PKG" ;; esac
[ -f "$PKG" ] || { echo "not a file: $PKG" >&2; exit 1; }
case "$(basename "$PKG")" in
  *arm64*|*aarch64*) PLATFORM=linux/arm64 ;;
  *amd64*|*x64*|*x86_64*) PLATFORM=linux/amd64 ;;
  *) echo "cannot tell the architecture from $(basename "$PKG")" >&2; exit 1 ;;
esac
case "$(basename "$PKG")" in
  *.deb) KIND=deb ;;
  *.AppImage) KIND=appimage ;;
  *) echo "expected a .deb or .AppImage" >&2; exit 1 ;;
esac
OUT=${2:-$ROOT/release/smoke}
mkdir -p "$OUT"
# Chromium's setuid sandbox creates PID/network namespaces; Docker's default profile forbids that, so the test
# container gets the capability a real host grants. This relaxes the container only, not the packaged app.
docker run --rm --platform "$PLATFORM" --cap-add SYS_ADMIN --security-opt seccomp=unconfined -v "$PKG:/pkg/gloss.$KIND:ro" -v "$OUT:/out" -e KIND="$KIND" ubuntu:24.04 bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
TOOLS="xvfb x11-apps imagemagick curl ca-certificates procps fonts-dejavu-core fonts-noto-core"
if [ "$KIND" = deb ]; then
  apt-get install -y -qq --no-install-recommends /pkg/gloss.deb $TOOLS >/dev/null
  APP=/opt/Gloss/gloss
else
  # The AppImage brings no dependency list; install what the deb declares. No FUSE in a container: extract and run.
  apt-get install -y -qq --no-install-recommends libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 libgbm1 libasound2t64 lsof $TOOLS >/dev/null
  install -m 755 /pkg/gloss.appimage /usr/local/bin/gloss.AppImage
  APP="/usr/local/bin/gloss.AppImage --appimage-extract-and-run"
fi
useradd -m tester
Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99
su tester -c "cd ~ && DISPLAY=:99 $APP > ~/app.log 2>&1 &"
# Electron names the config folder after the app; look for the file rather than assuming the folder name.
CONFIG=""
for i in $(seq 1 60); do CONFIG=$( (find /home/tester/.config -name desktop.json 2>/dev/null || true) | head -1 || true); [ -n "$CONFIG" ] && [ -s "$CONFIG" ] && break; sleep 1; done
if [ -z "$CONFIG" ] || [ ! -s "$CONFIG" ]; then
  echo "no desktop.json after 60 s"; ls -R /home/tester/.config 2>/dev/null | head -40; ps -ef | grep -v grep | grep -c gloss || true; grep -v dbus /home/tester/app.log; exit 1
fi
echo "config: $CONFIG"
PORT=$(sed -n "s/.*\"port\": *\([0-9]*\).*/\1/p" "$CONFIG")
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/")
echo "server answered HTTP $STATUS on port $PORT"
sleep 8
import -window root "/out/smoke-$KIND.png"
echo "--- app.log"; cat /home/tester/app.log
pkill -u tester -f gloss || true
[ "$STATUS" = 200 ]
'
echo "screenshot: $OUT/smoke-$KIND.png"
