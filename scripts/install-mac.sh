#!/bin/sh
# Builds Gloss.app and installs it into /Applications (or ~/Applications when not writable).
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = Darwin ] || { echo "macOS only" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null || { echo "Node.js 24 or newer is required to build" >&2; exit 1; }

[ -d node_modules ] || npm ci
npm run desktop:package

app=$(find release -maxdepth 2 -name 'Gloss.app' -type d | head -n 1)
[ -n "$app" ] || { echo "Build did not produce Gloss.app" >&2; exit 1; }

target=/Applications
[ -w "$target" ] || { target="$HOME/Applications"; mkdir -p "$target"; }
osascript -e 'quit app "Gloss"' >/dev/null 2>&1 || true
rm -rf "$target/Gloss.app"
ditto "$app" "$target/Gloss.app"

echo "Installed $target/Gloss.app"
open "$target/Gloss.app"
