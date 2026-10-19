<p align="center"><img src="assets/logo.svg" alt="Gloss" width="120"></p>

# Gloss

**Talk to Claude Code and Codex in Hebrew (or any language) without leaving your terminal sessions.**

Gloss is a local macOS app that sits next to the coding-agent sessions already running in your terminal. It shows the agent's replies in your language as they arrive, lets you write back in your language, and turns that into a concise English instruction you review before anything is sent. Nothing is sent on its own.

> Built by a developer who reads Hebrew faster than English and got tired of copying agent output into another chat to translate it. It started as a small translation panel and grew into the IDE he now works in all day.

## What it does

- **Finds your sessions.** Open Codex sessions are discovered automatically and grouped by project and worktree. Closed sessions stay available under *Saved*. You can also start new sessions from inside the app.
- **Translates the conversation live.** Completed agent replies are translated into your language as they arrive. No separate chat, no copy-paste.
- **You write Hebrew, the agent gets English.** The app prepares a short English instruction from what you wrote. You see it, you can edit it, and only an explicit *Send* delivers it to the terminal.
- **Dictation.** Press the mic button and speak Hebrew or English. Speech is transcribed on your Mac, with no cloud and no extra account, and the text lands in the composer for you to review and send.
- **Files and images.** A project file sidebar with search, read-only previews, *TL;DR* and full translation of files, and image or screenshot paste straight into the conversation.
- **Sees what the agent is doing.** An Activity view shows the Claude agents working right now, each with its last actions, background commands with their live output, and a History of what finished. Nothing in it is translated.
- **Skills and MCP at your fingertips.** Type `/` in the composer to search the skills your agent can use, or `$` to search its MCP servers. Global, project and plugin entries are listed together, and Gloss sends your pick in the form the agent understands.
- **Uses the accounts you already have.** Translation runs on an inexpensive model in the same ecosystem as your agent (Claude or OpenAI). No extra API key.
- **Everything stays local.** Conversations, drafts and translations live under `~/.language-assistant` on your Mac. Native approval prompts stay in the coding tool and are never answered by Gloss.

Translation costs a few extra tokens. You can turn it off per session, and you can pick the language.

## Status

Gloss is an early open-source release. What is verified today:

| Area | Status |
|------|--------|
| Platform | macOS 13 or newer, Apple Silicon (`-arm64.dmg`) or Intel (`-x64.dmg`) |
| Codex CLI | Fully supported. Automatic session discovery is pinned to Codex 0.154.0, 0.157.1 and 0.158.0 |
| Claude Code | Experimental. Sessions are connected manually and delivery uses an experimental channel |
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

The app is ad-hoc signed and not notarized, so macOS will say it cannot verify the app on first launch. Choose *Done*, then open *System Settings > Privacy & Security* and click *Open Anyway*. If macOS instead says the app is damaged, run this once in Terminal:

```sh
xattr -cr "/Applications/Gloss.app"
```

### Requirements

- [Codex CLI](https://github.com/openai/codex) and/or [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in. Gloss uses their existing authentication.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH` for file search. `brew install ripgrep`.

### First run

1. Start a Codex session in your terminal as usual.
2. Open Gloss. The session appears in the sidebar within a few seconds. Select it.
3. The agent's replies start appearing translated. Type in Hebrew in the composer, press *Send to Codex in English*, and review the English text before it goes.

For Claude Code, use *Connect folder* in the session picker and follow the setup and consent flow shown in the app.

## Run from source

Node.js 24 or newer is required.

```sh
git clone https://github.com/kfirosb/gloss.git
cd gloss
npm ci
npm run build
npm run desktop          # run the desktop app from source
```

To build the installer:

```sh
npm run build:tmux -- arm64      # or x64; each writes vendor/tmux/<arch>/bin/tmux
npm run build:whisper -- arm64   # or x64; x64 is CPU-only (no Metal)
npm run desktop:dmg -- --arm64   # or --x64, or both flags for two DMGs
# the DMGs are written to release/ as Gloss-<version>-<arch>.dmg
```

`npm run desktop:install` builds and installs the app into *Applications* locally.

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

Issues and pull requests are welcome. Try it, break it, challenge it. Please include your macOS version, the Codex or Claude Code version, and what the sidebar showed when reporting discovery problems.

## License

[MIT](LICENSE)
