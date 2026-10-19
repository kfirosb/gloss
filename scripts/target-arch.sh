# Sourced by the native build scripts: resolve the target architecture from $1 (or the build Mac).
# Sets ARCH (electron-builder name: arm64 | x64), MACH_ARCH (clang -arch) and HOST_TRIPLE (autoconf --host).
case "${1:-$(uname -m)}" in
  arm64) ARCH=arm64; MACH_ARCH=arm64; HOST_TRIPLE=aarch64-apple-darwin ;;
  x64 | x86_64) ARCH=x64; MACH_ARCH=x86_64; HOST_TRIPLE=x86_64-apple-darwin ;;
  *) echo "unsupported target architecture '$1' (use arm64 or x64)" >&2; exit 1 ;;
esac
