<p align="center"><img src="assets/logo.svg" alt="Gloss" width="120"></p>

# Gloss

**Talk to Claude Code and Codex in Hebrew (or any language) without leaving your terminal sessions.**

Gloss is a local desktop app for macOS and Linux that sits next to the coding-agent sessions already running in your terminal. It shows the agent's replies in your language as they arrive, lets you write back in your language, and turns that into a concise English instruction you review before anything is sent. Nothing is sent on its own.

> Built by a developer who reads Hebrew faster than English and got tired of copying agent output into another chat to translate it. It started as a small translation panel and grew into the IDE he now works in all day.

## What it does

- **Finds your sessions.** Open Claude Code and Codex sessions are discovered automatically and grouped by project and worktree. Closed sessions stay available under *Saved*. You can also start new sessions from inside the app.
- **Translates the conversation live.** Completed agent replies are translated into your language as they arrive. No separate chat, no copy-paste.
- **You write Hebrew, the agent gets English.** The app prepares a short English instruction from what you wrote. You see it, you can edit it, and only an explicit *Send* delivers it to the terminal.
- **Dictation.** Press the mic button and speak Hebrew or English. Speech is transcribed on your computer, with no cloud and no extra account, and the text lands in the composer for you to review and send.
- **Files and images.** A project file sidebar with search, read-only previews, *TL;DR* and full translation of files, and image or screenshot paste straight into the conversation.
- **Sees what the agent is doing.** An Activity view shows the Claude agents working right now, each with its last actions, background commands with their live output, and a History of what finished. Nothing in it is translated.
- **Skills and MCP at your fingertips.** Type `/` in the composer to search the skills your agent can use, or `$` to search its MCP servers. Global, project and plugin entries are listed together, and Gloss sends your pick in the form the agent understands.
- **Uses the accounts you already have.** Translation runs on an inexpensive model in the same ecosystem as your agent (Claude or OpenAI). No extra API key.
- **Everything stays local.** Conversations, drafts and translations live under `~/.language-assistant` on your computer. Native approval prompts stay in the coding tool and are never answered by Gloss.

Translation costs a few extra tokens. You can turn it off per session, and you can pick the language.

## See it in action

Two short videos with narration and captions.

**The product**: sessions appear on launch, several agents in parallel across projects and worktrees, your language in and the agent's language out in the real terminal, Split and Terminal views, Activity, notifications when an agent finishes, Files with a TL;DR or translation of a long spec, new sessions, Move to Gloss, and the Language Assistant.

https://github.com/user-attachments/assets/aa567fa8-fcd5-45b7-bd42-795ac7e1de72

**Install and first use**: Homebrew or DMG, connecting a folder, the first Codex session, the first Hebrew message, Claude Code sessions, language settings.

https://github.com/user-attachments/assets/0b630cf1-e079-458d-a25e-8fafd20463f5

## Status

Gloss is an early open-source release. What is verified today:

| Area | Status |
|------|--------|
| Platform | macOS 13 or newer. Every release ships two builds: Apple Silicon (`-arm64.dmg`, tested on the maintainer's Mac) and Intel (`-x64.dmg`, verified under Rosetta only; reports from Intel Macs are welcome). Linux x64 (deb, AppImage) and arm64 (deb), so far verified only in a container |
| Codex CLI | Fully supported. Open sessions are discovered automatically; Gloss checks each session's local protocol and fails closed when it cannot read one |
| Claude Code | Supported. Open sessions are discovered automatically. Sessions started from Gloss are ready to send to at once; a session started in your own terminal can be moved into Gloss with its history (*Move to Gloss*) |
| Languages | Hebrew is the default and the most tested. Any language the translation model handles can be selected |

## Install the Mac app

With [Homebrew](https://brew.sh):

```sh
brew install --cask kfirosb/tap/gloss
```

The cask installs the build for your chip (Apple Silicon or Intel); later releases arrive with `brew upgrade --cask gloss`. Or by hand:

1. Download the latest `.dmg` from the [Releases](../../releases) page: `-arm64` for an Apple Silicon Mac, `-x64` for an Intel Mac (Apple menu > About This Mac shows which chip you have). Check its `.sha256` if you like.
2. Open the DMG and drag the app into *Applications*.
3. Launch it from Spotlight or the Dock.

Releases are signed with the maintainer's Apple Developer ID and notarized by Apple, so macOS opens them without a security prompt. Releases before 0.19.0 were ad-hoc signed: if you still have one and macOS says it cannot verify the app, choose *Done*, then open *System Settings > Privacy & Security* and click *Open Anyway*.

## Install on Linux

1. Download `Gloss-<version>-amd64.deb` or `Gloss-<version>-arm64.deb` (or, for x64, `Gloss-<version>-x86_64.AppImage`) from the [Releases](../../releases) page.
2. `sudo apt install ./Gloss-<version>-<arch>.deb` installs it to `/opt/Gloss` with a launcher entry; the AppImage needs only `chmod +x` and runs in place.
3. Launch *Gloss* from your application menu, or run `/opt/Gloss/gloss`.

Prefer the deb when you use Claude Code channels: the channel configuration Gloss writes points at the installed executable, and an AppImage is mounted at a new path on every launch (Gloss repairs those files at startup). Session discovery needs `lsof` (the deb depends on it); alert sounds use the freedesktop sound theme through `paplay` or `pw-play` and stay silent without them. Wayland and X11 have been exercised only in a container so far; please report what you see.

### Requirements

- [Codex CLI](https://github.com/openai/codex) and/or [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in. Gloss uses their existing authentication.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH` for file search. `brew install ripgrep` or `apt install ripgrep`.
- On Linux, `lsof` for session discovery (`apt install lsof`).

### First run

1. Start a Claude Code or Codex session in your terminal as usual.
2. Open Gloss. The session appears in the sidebar within a few seconds. Select it.
3. The agent's replies start appearing translated. Type in Hebrew in the composer, send it, and the agent receives a concise English instruction. *Discuss first* lets you review and refine it before it goes.

To send to a Claude Code session started in your own terminal, press *Move to Gloss* in the session's connection panel, or start new sessions from Gloss with the **+** button.

## Run from source

Node.js 24 or newer is required.

```sh
git clone https://github.com/kfirosb/gloss.git
cd gloss
npm ci
npm run build
npm run desktop          # run the desktop app from source
```

To build the installers (a release is always both architectures; each step cross-compiles from either kind of Mac):

```sh
npm run build:tmux -- arm64 && npm run build:tmux -- x64          # vendor/tmux/<arch>/bin/tmux
npm run build:whisper -- arm64 && npm run build:whisper -- x64    # x64 is CPU-only (no Metal)
npm run desktop:dmg -- --arm64 --x64
# the DMGs are written to release/ as Gloss-<version>-arm64.dmg and Gloss-<version>-x64.dmg
```

`npm run desktop:install` builds and installs the app into *Applications* locally.

Linux packages are built from a Mac (or any machine with Docker): `npm run build:linux-vendor` compiles tmux, whisper-server and node-pty for both architectures in Debian containers, then `npm run desktop:linux` writes the deb files and the x64 AppImage to `release/`. `sh scripts/linux-smoke.sh release/Gloss-<version>-arm64.deb` installs and launches the result in an Ubuntu container. See [docs/linux-build.md](docs/linux-build.md).

There is also a browser mode: `node dist/server/runtime/cli.js --agent codex --session <thread-id> --language he --project "$PWD"` prints an authenticated local URL you can open in any browser or embedded pane.

### Verify

```sh
npm run format:check
npm run typecheck
npm test
npm run test:e2e -- --workers=1
```

Use `npm run format` to apply the shared code style. Browser tests start their own
server and fail if the port is busy; set `PLAYWRIGHT_PORT` to use another port.
See [the code quality review](docs/code-quality-review.md) for shared module
ownership, refactoring notes, and remaining opportunities.

## How it works, briefly

Gloss runs a local HTTP server and a React UI. Per-agent adapters observe the native session (Codex's SQLite metadata and writer locks, Claude Code's session files), post completed replies to the panel, and deliver reviewed English instructions back into the native session. Adapters are version-gated and fail closed when the tool's local protocol changes, rather than guessing. The full behaviour reference, including every edge case the UI handles, is in [docs/reference.md](docs/reference.md).

## Contributing

Issues and pull requests are welcome. Try it, break it, challenge it. Please include your macOS or Linux version, the Codex or Claude Code version, and what the sidebar showed when reporting discovery problems.

## License

[MIT](LICENSE)
