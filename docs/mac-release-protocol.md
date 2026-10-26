# Mac release protocol

Use this procedure when a future session is asked to update Gloss or produce a new Mac version. The deliverable is a pair of local, versioned DMGs, one for Apple Silicon (`-arm64`) and one for Intel (`-x64`), that the user can share with a friend. Online publishing is a separate request.

As of 2026-10-14, version 0.7.0 is installed and in use. Its source is tagged `v0.7.0` at `4fd47cd` on branch `release/0.7.0`; it includes local `main` through `c1501e2` (0.6.0 with the attention-cues work), so `main` was fast-forwarded to it and holds exactly 0.7.0 plus this note. 0.7.0 adds schema 24 (`language_spend`). The DMG, checksum and release notes were delivered to `~/Downloads`, and the pre-install backup is in `~/.language-assistant-backups/2026-10-14-before-0.7.0/`. These are historical references: inspect the current branches, tags, package version, and installed app before every release.

## 1. Establish the source and protect current work

Run from the repository worktree:

```sh
git status --short
git branch --show-current
git worktree list
git remote -v
git log -1 --oneline main
git log -1 --oneline HEAD
git tag --list
```

Work on the release branch or a dedicated release worktree. The desktop packaging was introduced on `mac-local-app-install-9594a3a6`; do not assume a checkout of `main` includes it. Ensure the release includes both current `main` and the desktop packaging before building.

Preserve tracked and untracked work before merging. If a temporary stash is needed, name it, record its object ID, and restore that exact stash after integration. Keep it until restoration has been checked. Do not reset, clean, or overwrite another session's edits. Leave unrelated DMGs and artifacts alone.

Integrate the **local** `main` branch (it tracks `origin/main`; never merge or push `private-history`):

```sh
git merge --ff-only main
```

If branches have diverged because the release branch contains packaging commits, use a normal `git merge main` and resolve conflicts. Do not force a reset to `main`. Updates must be committed on `main` to be included; uncommitted edits in its worktree are separate work. Do not merge the release back into `main` unless requested.

## 2. Preserve desktop compatibility when resolving conflicts

- Keep `desktop/main.mjs`, the desktop scripts and Electron build configuration in `package.json`, and the matching lockfile.
- Preserve the CLI entry-point comparison using `pathToFileURL(process.argv[1]).href`. Concatenating `file://` with a path breaks startup inside `Gloss.app` because of spaces.
- Preserve upstream CLI modes and lazy imports, including Claude channel startup. Do not replace the new CLI with an older desktop copy.
- Bundle runtime dependencies, including `@modelcontextprotocol/sdk`. Do not exclude all `node_modules` from the packaged app.
- Preserve `ELECTRON_RUN_AS_NODE=1` for the desktop backend and generated Claude MCP channel configuration. The bundled executable must run as Node in those processes.
- Preserve storage migrations and related application code together. Never bypass the newer-schema check or edit migration records to make an old build open newer data.

If manifests conflict, reconcile `package.json` first, regenerate its lockfile with npm, then install from that lockfile. Inspect the resulting diff.

## 3. Choose a new version

Inspect `package.json` and existing tags. Follow a user-specified version; otherwise use a patch increment for fixes or a minor increment for new features. Never reuse an already distributed version or move an existing release tag.

Set the selected version without creating a tag yet:

```sh
npm version --no-git-tag-version <new-version>
npm ci
```

Replace placeholders before running commands. Use Node.js 24 or newer for the current project. A worktree created by an agent tool may hold only a stub `node_modules` that resolves packages from the parent checkout; tests and type checks can pass that way, but `electron-builder` packages the worktree's own `node_modules`, so always run `npm ci` in the release worktree before building. Update the Mac release paragraph in `docs/reference.md` with the new version and relevant changes.

## 3a. Signing and notarization prerequisites

Since Gloss 0.18.0 releases are signed with the maintainer's Developer ID and notarized by Apple, so a downloaded copy opens with no Gatekeeper dialog. electron-builder does the signing (hardened runtime, `build/entitlements.mac.plist`) and the notarization (`notarize: true`); both are configured in `package.json` and need nothing from the command line. Before building, check that this Mac has what they rely on:

```sh
security find-identity -v -p codesigning       # must list "Developer ID Application: kfir bechavod (UD3JN5GBRK)"
set -a; . ~/.config/gloss-signing/notarize.env; set +a
env | grep -c '^APPLE_API_' # 3: APPLE_API_KEY (path to the .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER
```

The identity lives in the login keychain with Apple's Developer ID G2 intermediate; `codesign` was granted access without a prompt. If `find-identity` reports 0 valid identities, the intermediate is missing (`~/.config/gloss-signing/DeveloperIDG2CA.cer`, or https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer) or the certificate expired (November 2027; make a new one from the request file in the same folder). The notarization credentials are an App Store Connect API key kept outside the repository in `~/.config/gloss-signing`; never commit the `.p8` file or the env file, and never print their contents.

Run the packaging command from a terminal with keychain access: under the agent sandbox `codesign` fails with `errSecInternalComponent` before signing anything, so an agent session must run `desktop:dmg` outside its sandbox. Signing happens whichever way the build is started, but notarization only when the three `APPLE_API_*` variables are in the environment of the `electron-builder` process. Notarization usually takes a few minutes; the account's first submission (2026-10-19) sat in Apple's queue for 51 minutes, and electron-builder simply waits, so do not interrupt a build that is quiet after `signing`. `xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"` shows the submission's status meanwhile. Without them electron-builder logs `skipped macOS notarization` and the DMG is signed but not notarized, which still shows a Gatekeeper dialog on other Macs; do not deliver such a build as a release. When the keychain has no Developer ID at all, the `afterPack` hook (`scripts/sign-mac.mjs`) falls back to an ad-hoc signature as before 0.18.0 and says so in the build log.

## 4. Validate source and build the DMG

```sh
npm run typecheck
npm test
npm run test:e2e -- --workers=1
npm run build:tmux -- arm64
npm run build:tmux -- x64
npm run build:whisper -- arm64
npm run build:whisper -- x64
npm run desktop:dmg -- --arm64 --x64
git diff --check
```

`build:tmux` and `build:whisper` take the target architecture (`arm64` or `x64`) and cross-compile from either kind of Mac into `vendor/<tool>/<arch>/bin`; the x64 whisper-server is CPU-only (no Metal). `build:whisper` builds the bundled speech engine (whisper-server); the engine is bundled in the app, while the speech model is downloaded by the app on first use. electron-builder's `beforePack` hook (`scripts/check-vendor.mjs`) refuses to package an architecture whose vendor binaries are missing or built for the other one.

Check every exit code and resolve failures before labeling the release ready. Report test counts from this run, not a previous release. Use an isolated test server if a running development server could cause browser tests to exercise a different checkout.

Notes from building on this Mac:

- **Browser tests and other worktrees.** `playwright.config.ts` serves on port 4173 with `reuseExistingServer: true`, so a dev server from another worktree on that port makes the suite test that worktree's code. Check the port's owner first (`lsof -nP -iTCP:4173 -sTCP:LISTEN`, then `lsof -a -p <pid> -d cwd`). Never stop another worktree's server; instead run with a scratch config kept outside Git (for example under the ignored `.superpowers/`) that uses an absolute `testDir`, another port with `--strictPort`, `cwd` set to the release worktree and `reuseExistingServer: false`.
- **Flaky tests.** The real-tmux case in `tests/runtime/tmux.test.ts`, the channel-privacy timing test and `tests/ui/sessions.spec.ts:44` can fail under load. `npx vitest run --maxWorkers=4` is reliable; rerun a failing browser spec on its own once before investigating, and report the rerun.
- **Native builds.** This Mac has Command Line Tools only. `build:whisper` already sets its own flags; the node-pty rebuild inside `desktop:dmg` needs `CXXFLAGS="-nostdinc++ -isystem $(xcrun --show-sdk-path)/usr/include/c++/v1"` (it rebuilds once per architecture).
- **Bundled tmux and whisper.** `build:tmux` downloads and compiles tmux 3.5a. Copying `vendor/tmux/<arch>` and `vendor/whisper/<arch>` from an earlier release worktree is acceptable when `tmux -V` reports 3.5a, `file` reports the expected architecture, `otool -L` lists only `/usr/lib` and `/System` libraries and the whisper build recipe has not changed; say so in the release notes. An x64 binary runs on this Mac through Rosetta (`arch -x86_64 <binary>`).

The expected outputs are `release/Gloss-<version>-arm64.dmg` and `release/Gloss-<version>-x64.dmg`. The same command also writes the update assets the in-app updater downloads: `release/Gloss-<version>-arm64.zip`, `release/Gloss-<version>-x64.zip`, their `.blockmap` files and ONE `release/latest-mac.yml` listing both zips. Rebuilding a single architecture alone (as happened in 0.21.0 when Apple's timestamp service failed for arm64) rewrites `latest-mac.yml` with only that architecture, which would leave the other architecture's users without an update. After such a rebuild, rebuild both, or restore the combined file: keep a copy of `latest-mac.yml` before rebuilding, and verify the final one lists both zips with `sha512` values matching the files (`openssl dgst -sha512 -binary <zip> | base64`). Verify each one's integrity and create a checksum beside it:

```sh
hdiutil verify 'release/Gloss-<version>-arm64.dmg'
hdiutil verify 'release/Gloss-<version>-x64.dmg'
cd release
shasum -a 256 'Gloss-<version>-arm64.dmg' > 'Gloss-<version>-arm64.dmg.sha256'
shasum -a 256 'Gloss-<version>-x64.dmg' > 'Gloss-<version>-x64.dmg.sha256'
```

Run these from the appropriate directory; return to the repository root for subsequent Git commands. Keep older released DMGs available. Read version, architecture, and minimum macOS requirements from the produced app, rather than assuming they stayed unchanged.

Then confirm the signature and the notarization on each packaged app (`release/mac-arm64/Gloss.app` and `release/mac/Gloss.app`), before and independently of the functional checks below:

```sh
codesign --verify --deep --strict --verbose=2 '<app>'
codesign -dv --verbose=2 '<app>' 2>&1 | grep -E 'Authority|TeamIdentifier|flags'   # Developer ID Application, TeamIdentifier=UD3JN5GBRK, flags include runtime
codesign -d --entitlements - '<app>' 2>/dev/null | grep -c 'audio-input'            # 1: the microphone entitlement is present
xcrun stapler validate '<app>'                                                       # "The validate action worked!"
spctl -a -vv -t exec '<app>'                                                         # "accepted" with "source=Notarized Developer ID"
```

The bundled `Contents/Resources/bin/tmux` and `whisper-server` must show the same Developer ID authority (`codesign -dv` on each). Run the same checks on the app inside each zip, since that is what the updater installs: unzip each zip into its own temporary directory outside the repository (`ditto -x -k` or `unzip`), run the `codesign`, `stapler` and `spctl` commands above on the extracted `Gloss.app`, and confirm `Contents/Resources/app-update.yml` exists in each packaged app (without it the app cannot check for updates).

A build whose `spctl` line says `Unnotarized Developer ID` was signed but not notarized: check the `APPLE_API_*` variables and rebuild rather than shipping it.

## 5. Verify the packaged app

Import tests alone are insufficient: the first desktop build imported successfully but failed on actual startup. Verify the real `.app` with its bundled runtime and assets, ideally from the DMG or a temporary installation outside the repository so missing dependencies cannot resolve from the development checkout. Verify both architectures: the x64 app runs on this Apple Silicon Mac under Rosetta (launch its `Contents/MacOS/Gloss` binary through `arch -x86_64`, and check the About panel says Intel), which exercises the x64 Electron, node-pty, tmux and whisper-server but cannot catch Intel-only CPU or GPU issues; say so in the release notes.

Check that:

1. The app reports the intended version and starts its backend without an error dialog.
2. The interface, session sidebar, and composer render without renderer errors.
3. A representative saved conversation and its workspace load successfully.
4. The Claude channel module imports, and its SDK resolves inside the packaged app.
5. Quitting the test app stops its backend; only test-owned processes are cleaned up.

Use isolated test data or a consistent backup of the user's database. A separate Electron `--user-data-dir` isolates window settings and browser storage **but does not isolate** `~/.gloss/state.db`. Ensure a test backend's storage path is genuinely isolated before running it alongside the active app. Do not send coding instructions, create real Claude sessions, or answer native approval prompts just to test a release.

Before testing against real data, compare its applied migrations with the build. A read-only SQLite connection can inspect `schema_migrations`. For a live database backup, use SQLite's backup API; copying only `state.db` while WAL writes are active is not a reliable backup. Validate schema changes against a copy before upgrading the user's data.

## 6. Record and deliver the release

Review the final diff. Stage only the intended source, tests, configuration, lockfile, and documentation. Do not commit installers, secrets, local databases, or unrelated files. After successful verification:

1. Commit the release changes on the release branch.
2. Create a new annotated tag `v<version>` at that commit.
3. Record the commit, included `main` revision, requirements, release changes, verification results (including the signing and notarization checks), and known limitations in `release/RELEASE-NOTES-<version>.txt`.
4. Provide clickable local links to both DMGs and, when useful, their checksums and release notes. If the user asks for the release to be delivered, move the DMGs, their `.sha256` files and the release notes from `release/` to `~/Downloads` (keep earlier DMGs; do not overwrite a file of the same name) and give the new paths.
5. When asked to merge the release into `main`, fast-forward local `main` to the release branch (`git -C <main checkout> merge --ff-only release/<version>`) so the release tag stays on `main`'s history. If `main` moved during the release (another session may merge work at any time), do not rebase or reset: create a temporary branch from `main` in the release worktree, merge `release/<version>` into it, resolve conflicts, run the full test and browser suites, then fast-forward `main` to that branch and delete it. Tell the user that `main` now holds unreleased work alongside the release. Pushing `main` and the tag to `origin` publishes them; do it only on explicit request, and never push `private-history`.

GitHub release (only on the maintainer's explicit request). Create it as a DRAFT with every asset: both DMGs and their `.sha256` files, both zips and their `.blockmap` files, `latest-mac.yml`, and the Linux debs and AppImage with their `.sha256` files (made with `shasum -a 256` as in [linux-build.md](linux-build.md#checksums-for-the-release)). Push the tag first (`git push origin v<version>`, on explicit request): `--verify-tag` refuses to create the draft for a tag that is not on GitHub. From `release/`, with `<notes>` the user-facing release notes:

```sh
gh release create v<version> --draft --verify-tag --title "Gloss <version>" --notes-file <notes> \
  Gloss-<version>-arm64.dmg Gloss-<version>-arm64.dmg.sha256 Gloss-<version>-x64.dmg Gloss-<version>-x64.dmg.sha256 \
  Gloss-<version>-arm64.zip Gloss-<version>-arm64.zip.blockmap Gloss-<version>-x64.zip Gloss-<version>-x64.zip.blockmap \
  latest-mac.yml \
  Gloss-<version>-amd64.deb Gloss-<version>-amd64.deb.sha256 Gloss-<version>-arm64.deb Gloss-<version>-arm64.deb.sha256 \
  Gloss-<version>-x86_64.AppImage Gloss-<version>-x86_64.AppImage.sha256
```

Check the uploaded asset list against that expected set (`gh release view v<version> --json assets`), then publish in one step with `gh release edit v<version> --draft=false`. Never publish a release with assets missing: a published release reaches every 0.23+ user within a week, because Gloss checks for updates at most every 7 days.

Describe the result as a **local DMG release**. Do not claim it was uploaded. Builds are Developer ID signed and notarized; say which `spctl` result each DMG's app gave, and if a build is only signed or only ad-hoc signed say so and do not deliver it as a release. The current app requires macOS 13+ on Apple Silicon (`-arm64.dmg`) or Intel (`-x64.dmg`), and users need their own installed/authenticated Codex or Claude CLI. File search requires ripgrep. Recheck these requirements for later releases.

## 7. Update the Homebrew tap after publishing

Users can install with `brew install --cask kfirosb/tap/gloss`; the cask lives in the separate public repository `kfirosb/homebrew-tap` (checked out at `~/project/homebrew-tap` on this Mac; clone it there if missing). The cask serves both architectures (`arch arm:/intel:` with one checksum each), so update it only after the GitHub release with both DMGs and their `.sha256` assets is published, since the script reads both checksums from that release:

```sh
node scripts/homebrew-cask.mjs --tap ~/project/homebrew-tap
cd ~/project/homebrew-tap
brew style --cask kfirosb/tap/gloss
brew audit --cask --strict --online kfirosb/tap/gloss
git commit -am 'Update gloss to <version>'
git push
```

`brew audit --online` downloads the DMG for this Mac's architecture and verifies its pinned checksum; the other architecture's checksum is only checked against the `.sha256` asset by the script. The cask does not declare `auto_updates true`: with it `brew upgrade` skips Gloss, and Homebrew users on 0.22.x and earlier (which have no in-app updater) would never get a newer version. Consider adding it in a later release, once most users run 0.23 or newer. Pushing the tap publishes the version to every `brew upgrade`, so do it only when the release itself is meant to be public. The cask template is `renderCask` in `scripts/homebrew-cask.mjs`; change requirements, caveats or the zap list there, not in the tap. To try the cask without touching the installed app, install it into a scratch folder: `brew install --cask --appdir=<scratch dir> kfirosb/tap/gloss`, then `brew uninstall --cask gloss`.

## 8. Replace the installed app only when requested

Building a DMG can happen while the user works. Replacing or restarting the installed app interrupts its backend and any Chrome windows connected to it. Announce that interruption before an authorized installation. If this chat is running inside the app, provide the installer and handoff instructions before shutdown; do not terminate the communication channel unexpectedly.

For installation:

1. Let active work finish, then quit the app normally. Identify and stop any separately launched Gloss backend using the same data. Closing a Chrome tab does not stop its server. Do not kill unrelated Node, Codex, Claude, or Electron processes.
2. With all writers stopped, back up the full `~/.gloss` directory and the installed `.app` to a private, timestamped location. Processes running `cli.js --claude-channel` from the installed app belong to open Claude sessions (possibly the one doing the release): pause them with `kill -STOP` during the copy and resume them with `kill -CONT` afterwards; never kill them. In zsh, pass several pids as an array (`${(f)"$(pgrep -f …)"}`), not an unquoted string. Preserve desktop settings separately if changing them. Backups include private conversations and attachments and must not be packaged or shared.
3. Copy the verified app from this release to `/Applications/Gloss.app` (or the established per-user installation path). Copy from the mounted DMG with `rsync -a <volume>/Gloss.app/ /Applications/Gloss.app/`; `ditto` has failed partway under the agent sandbox and left a bundle that fails `codesign --verify`. Check `codesign --verify --deep --strict` on the result. Do not rebuild a different artifact during replacement. Keep the previous app until the new version is verified.
4. Launch the installed copy. Confirm the version, backend startup, saved conversations, and composer. Check from an Applications/Dock launch too, since shell PATH differs from terminal launches.
5. Keep the backup and report the installed version and location.

The current `desktop:install` script rebuilds and removes the previous installed bundle without making a backup; do not use it as a substitute for this verified replacement procedure.

Chrome and the Mac app may be open together when they use the **same backend URL**. Independent backends share the database but retain separate in-memory state; do not run two against the same user data during normal use or verification. Treat authenticated local URLs as private.

## Recovery

If startup fails, retain the failing artifact and capture the exact error before changing anything. A newer-schema error means the executable and database versions are incompatible; restore the matching application code rather than disabling the check.

If the new release migrated the database, replacing only the app with an older version may not work. Stop all writers and assess the matching pre-upgrade backup. Restoring it discards changes made since the backup, so explain that loss and obtain the user's decision before restoring data. Preserve the current data as well. Never delete the database as a startup fix.
