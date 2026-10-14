# Mac release protocol

Use this procedure when a future session is asked to update Gloss or produce a new Mac version. The deliverable is a local, versioned Apple Silicon DMG that the user can share with a friend. Online publishing is a separate request.

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

## 4. Validate source and build the DMG

```sh
npm run typecheck
npm test
npm run test:e2e -- --workers=1
npm run build:tmux
npm run build:whisper
npm run desktop:dmg -- --arm64
git diff --check
```

`build:whisper` builds the bundled speech engine (whisper-server); the engine is bundled in the app, while the speech model is downloaded by the app on first use.

Check every exit code and resolve failures before labeling the release ready. Report test counts from this run, not a previous release. Use an isolated test server if a running development server could cause browser tests to exercise a different checkout.

Notes from building on this Mac:

- **Browser tests and other worktrees.** `playwright.config.ts` serves on port 4173 with `reuseExistingServer: true`, so a dev server from another worktree on that port makes the suite test that worktree's code. Check the port's owner first (`lsof -nP -iTCP:4173 -sTCP:LISTEN`, then `lsof -a -p <pid> -d cwd`). Never stop another worktree's server; instead run with a scratch config kept outside Git (for example under the ignored `.superpowers/`) that uses an absolute `testDir`, another port with `--strictPort`, `cwd` set to the release worktree and `reuseExistingServer: false`.
- **Flaky tests.** The real-tmux case in `tests/runtime/tmux.test.ts`, the channel-privacy timing test and `tests/ui/sessions.spec.ts:44` can fail under load. `npx vitest run --maxWorkers=4` is reliable; rerun a failing browser spec on its own once before investigating, and report the rerun.
- **Native builds.** This Mac has Command Line Tools only. `build:whisper` already sets its own flags; the node-pty rebuild inside `desktop:dmg` needs `CXXFLAGS="-nostdinc++ -isystem $(xcrun --show-sdk-path)/usr/include/c++/v1"`.
- **Bundled tmux.** `build:tmux` downloads and compiles tmux 3.5a. Copying `vendor/tmux` from an earlier release worktree is acceptable when `vendor/tmux/bin/tmux -V` reports 3.5a, `file` reports arm64 and `otool -L` lists only `/usr/lib` libraries; say so in the release notes.

The expected output is `release/Gloss-<version>-arm64.dmg`. Verify its integrity and create a checksum beside it:

```sh
hdiutil verify 'release/Gloss-<version>-arm64.dmg'
cd release
shasum -a 256 'Gloss-<version>-arm64.dmg' > 'Gloss-<version>-arm64.dmg.sha256'
```

Run these from the appropriate directory; return to the repository root for subsequent Git commands. Keep older released DMGs available. Read version, architecture, and minimum macOS requirements from the produced app, rather than assuming they stayed unchanged.

## 5. Verify the packaged app

Import tests alone are insufficient: the first desktop build imported successfully but failed on actual startup. Verify the real `.app` with its bundled runtime and assets, ideally from the DMG or a temporary installation outside the repository so missing dependencies cannot resolve from the development checkout.

Check that:

1. The app reports the intended version and starts its backend without an error dialog.
2. The interface, session sidebar, and composer render without renderer errors.
3. A representative saved conversation and its workspace load successfully.
4. The Claude channel module imports, and its SDK resolves inside the packaged app.
5. Quitting the test app stops its backend; only test-owned processes are cleaned up.

Use isolated test data or a consistent backup of the user's database. A separate Electron `--user-data-dir` isolates window settings and browser storage **but does not isolate** `~/.language-assistant/state.db`. Ensure a test backend's storage path is genuinely isolated before running it alongside the active app. Do not send coding instructions, create real Claude sessions, or answer native approval prompts just to test a release.

Before testing against real data, compare its applied migrations with the build. A read-only SQLite connection can inspect `schema_migrations`. For a live database backup, use SQLite's backup API; copying only `state.db` while WAL writes are active is not a reliable backup. Validate schema changes against a copy before upgrading the user's data.

## 6. Record and deliver the release

Review the final diff. Stage only the intended source, tests, configuration, lockfile, and documentation. Do not commit installers, secrets, local databases, or unrelated files. After successful verification:

1. Commit the release changes on the release branch.
2. Create a new annotated tag `v<version>` at that commit.
3. Record the commit, included `main` revision, requirements, release changes, verification results, and known limitations in `release/RELEASE-NOTES-<version>.txt`.
4. Provide clickable local links to the DMG and, when useful, its checksum and release notes. If the user asks for the release to be delivered, move the DMG, its `.sha256` and the release notes from `release/` to `~/Downloads` (keep earlier DMGs; do not overwrite a file of the same name) and give the new paths.
5. When asked to merge the release into `main`, fast-forward local `main` to the release branch (`git -C <main checkout> merge --ff-only release/<version>`) so the release tag stays on `main`'s history. If `main` moved during the release (another session may merge work at any time), do not rebase or reset: create a temporary branch from `main` in the release worktree, merge `release/<version>` into it, resolve conflicts, run the full test and browser suites, then fast-forward `main` to that branch and delete it. Tell the user that `main` now holds unreleased work alongside the release. Pushing `main` and the tag to `origin` publishes them; do it only on explicit request, and never push `private-history`.

Describe the result as a **local DMG release**. Do not claim it was uploaded. Current builds are unsigned and not notarized; say so when delivering them. The current app requires Apple Silicon and macOS 13+, and users need their own installed/authenticated Codex or Claude CLI. File search requires ripgrep. Recheck these requirements for later releases.

## 7. Replace the installed app only when requested

Building a DMG can happen while the user works. Replacing or restarting the installed app interrupts its backend and any Chrome windows connected to it. Announce that interruption before an authorized installation. If this chat is running inside the app, provide the installer and handoff instructions before shutdown; do not terminate the communication channel unexpectedly.

For installation:

1. Let active work finish, then quit the app normally. Identify and stop any separately launched Gloss backend using the same data. Closing a Chrome tab does not stop its server. Do not kill unrelated Node, Codex, Claude, or Electron processes.
2. With all writers stopped, back up the full `~/.language-assistant` directory and the installed `.app` to a private, timestamped location. Processes running `cli.js --claude-channel` from the installed app belong to open Claude sessions (possibly the one doing the release): pause them with `kill -STOP` during the copy and resume them with `kill -CONT` afterwards; never kill them. In zsh, pass several pids as an array (`${(f)"$(pgrep -f …)"}`), not an unquoted string. Preserve desktop settings separately if changing them. Backups include private conversations and attachments and must not be packaged or shared.
3. Copy the verified app from this release to `/Applications/Gloss.app` (or the established per-user installation path). Copy from the mounted DMG with `rsync -a <volume>/Gloss.app/ /Applications/Gloss.app/`; `ditto` has failed partway under the agent sandbox and left a bundle that fails `codesign --verify`. Check `codesign --verify --deep --strict` on the result. Do not rebuild a different artifact during replacement. Keep the previous app until the new version is verified.
4. Launch the installed copy. Confirm the version, backend startup, saved conversations, and composer. Check from an Applications/Dock launch too, since shell PATH differs from terminal launches.
5. Keep the backup and report the installed version and location.

The current `desktop:install` script rebuilds and removes the previous installed bundle without making a backup; do not use it as a substitute for this verified replacement procedure.

Chrome and the Mac app may be open together when they use the **same backend URL**. Independent backends share the database but retain separate in-memory state; do not run two against the same user data during normal use or verification. Treat authenticated local URLs as private.

## Recovery

If startup fails, retain the failing artifact and capture the exact error before changing anything. A newer-schema error means the executable and database versions are incompatible; restore the matching application code rather than disabling the check.

If the new release migrated the database, replacing only the app with an older version may not work. Stop all writers and assess the matching pre-upgrade backup. Restoring it discards changes made since the backup, so explain that loss and obtain the user's decision before restoring data. Preserve the current data as well. Never delete the database as a startup fix.
