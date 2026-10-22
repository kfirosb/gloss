# Linux build

Gloss ships for Linux as a `.deb` for x64 and arm64 and an `.AppImage` for x64 (the arm64 AppImage runtime that electron-builder 26 bundles, appimage 12.0.1, is linked against `libz.so`, the development symlink, so it fails to start on a stock Ubuntu; the arm64 build is therefore deb only until that runtime is fixed). Both are built from this Mac (or any machine with Docker and Node.js 24); no Linux host is needed to build, and a container stands in for one to test.

## 1. Native pieces

```sh
npm run build:linux-vendor        # or: sh scripts/build-linux-vendor.sh x64 | arm64
```

Each architecture runs in a `node:24-bullseye` container (Debian 11, glibc 2.31, so the output loads on Ubuntu 20.04, Debian 11 and newer) and writes `vendor/linux-<arch>/`:

- `bin/tmux` 3.5a with libevent linked statically and the distribution's `libtinfo` dynamically, so the system terminfo database is used. Same tarballs and checksums as `scripts/build-tmux.sh`.
- `bin/whisper-server` from whisper.cpp v1.9.5, CPU only (no Metal, no OpenMP), with the C++ runtime linked statically.
- `node-pty/pty.node`, the N-API addon node-pty 1.1.0 does not publish for Linux, built from source with Node 24. Electron loads it from `node_modules/node-pty/prebuilds/linux-<arch>/`, where `scripts/stage-linux-node-pty.mjs` copies it before packaging.
- The upstream licenses, bundled next to the binaries.

The script checks with `ldd` that only glibc, the terminfo library and the GCC runtime are dynamic. x64 runs under qemu on an Apple Silicon Mac and takes much longer than arm64. Finished pieces are kept; delete `vendor/linux-<arch>` to rebuild.

## 2. Packages

```sh
npm run desktop:linux             # every Linux target: x64 AppImage, x64 and arm64 deb
```

`predesktop:linux` refuses to run without the vendor binaries. The run writes `release/Gloss-<version>-x86_64.AppImage`, `release/Gloss-<version>-amd64.deb` and `release/Gloss-<version>-arm64.deb`. `-c.npmRebuild=false` keeps electron-builder from trying to compile node-pty for Linux on the Mac. The `linux` block in `package.json` bundles `vendor/linux-${arch}` into `resources/bin`, and the deb depends on `lsof`, which session discovery needs, and recommends `ripgrep`, the freedesktop sound theme and `pulseaudio-utils`.

Nothing is signed. The Mac packaging is unchanged; its vendor entries simply moved under the `mac` key.

## 3. Smoke test in a container

```sh
sh scripts/linux-smoke.sh release/Gloss-<version>-arm64.deb
```

This installs the deb (or, for an AppImage, the deb's dependency list and the file itself, run with `--appimage-extract-and-run` because containers have no FUSE) in a fresh `ubuntu:24.04` container, starts Xvfb, launches `/opt/Gloss/gloss` as an unprivileged user, waits for the app's `desktop.json` under `~/.config` (Electron names that folder `gloss`, after the package name), checks that the local server answers on the recorded port, saves `release/smoke/smoke-<kind>.png` and prints the app log. The container runs with `--cap-add SYS_ADMIN --security-opt seccomp=unconfined` so Chromium's setuid sandbox can create namespaces as it does on a real host; the packaged app is not changed. It exits non-zero when the server never answers. Use the arm64 deb on an Apple Silicon Mac. The x64 packages cannot be launched here: Chromium is not reliable under qemu and qemu refuses to load the AppImage runtime at all, so the x64 deb and AppImage are checked for their contents and for the runtime's shared-library needs (`readelf -d`), not launched. The script also accepts an `.AppImage` (installing the deb's dependency list and running it with `--appimage-extract-and-run`) for when a usable arm64 AppImage runtime exists.

## What differs from macOS at runtime

- `lsof` is read from `/usr/bin/lsof` and must be installed; discovery reports "unavailable" without it.
- Claude records carry `pidDomain: darwin:<machine-id>:<pid namespace>` on Linux; Gloss computes the same label (`src/agents/claude/pid-domain.ts`) and only trusts process start times from its own domain.
- Managed Claude policy is read from `/etc/claude-code`.
- Folder search walks home (depth 8, time-bounded) instead of Spotlight.
- Alert sounds are freedesktop theme files played by `paplay` or `pw-play`; the attention cue flashes the window; the unread badge uses `app.setBadgeCount`.
- The bundled tmux is tried before `/usr/bin/tmux`.
- The AppImage mounts at a new path per launch, so Claude channel configurations written while it ran are repaired at the next start; the deb's `/opt/Gloss/gloss` is stable and preferred for channel users.

## Known limitations

- No human has run it on Linux hardware yet: Wayland and X11 input, Hebrew rendering, clipboard and microphone capture are untested beyond the container.
- Desktop notifications, like on macOS, are in-window banners and sounds, not system notifications.
