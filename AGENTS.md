# Release work

For requests to update the Mac app, create a new version, or build a DMG, read and follow [docs/mac-release-protocol.md](docs/mac-release-protocol.md).

The public repository is `origin` (github.com/kfirosb/gloss). Local `main` tracks `origin/main` and is the source of updates; the full pre-release history is kept on the local `private-history` branch and must never be pushed. Preserve the running app and saved data while preparing a release. Repository-root DMGs and other unrelated untracked files are not source changes to stage.
