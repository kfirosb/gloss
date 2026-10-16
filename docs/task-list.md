# Product task list

Captured from the user's request on 2026-09-28. These are separate workstreams, not one implementation plan. Task 1 was authorized with preview-first browsing and explicit attachment; tasks 2 and 3 remain separate.

## 1. Improve file browsing and display

Status: complete. Independent review and live-panel acceptance passed; see [verification](superpowers/reports/2026-09-28-file-browser-interactions-verification.md).

- [x] Replace the cumbersome file interaction with an IDE-style sidebar option.
- [x] Scope browsing to the active session's own folder/worktree and its descendants, not other sessions or the wider repository.
- [x] Allow browsing the folder's files and searching by filename or file contents.
- [x] Drag sidebar files into the composer to attach them and insert stable text references without sending.
- [x] Avoid displaying full paths for files inside the session folder. Use filenames and folder context; show a full path only for an external file when its original path is known.
- [x] Preserve session ownership, stable file/image indices, attachment removal, failure recovery, and references in discussion, Prepare instruction, and direct sending.
- [x] Single click/keyboard activation opens read-only preview; preview Attach is the touch-friendly attachment path.
- [x] Define handling of duplicate filenames, ignored/hidden files, large folders, content-search results, external uploads with unknown original paths, and small windows.
- [x] User selected and authorized preview-first UX before implementation.

## 2. Configurable command buttons

Status: captured; brainstorm separately.

- [ ] Let users create buttons for text they frequently send to the coding agent.
- [ ] Provide an **Add button** action that opens a prompt asking what text the button should send.
- [ ] Clicking a configured button sends its saved instruction to the agent.
- [ ] Example instructions: “Show me an example as an HTML file,” “Run tests,” and “Read the server logs.”
- [ ] Define button naming, placement, editing/removal, persistence, and whether buttons are global or scoped to a project/session.
- [ ] Define translation and busy/failure behavior using the existing exact-destination and duplicate-prevention guarantees.

## 3. Claude Code parity with Codex

Status: requirements definition first; implementation scope not yet agreed.

- [ ] Define what “works the same as Codex” means from the user's perspective.
- [ ] Compare current behavior and gaps in session discovery/switching, live capture and translation, Language Assistant discussion, direct sends, prepared instructions, files/images, delivery status, and recovery.
- [ ] Preserve the preference for the existing account/subscription instead of requiring a separate API key.
- [ ] Identify native integration limitations and distinguish verified capabilities from desired behavior.
- [ ] Agree on parity requirements and end-to-end acceptance scenarios before implementation.

## 4. Sidebar, folders, worktrees, and version display

Status: visual design and product decisions approved on 2026-10-12; implemented on branch `feature/sidebar-worktrees`; not yet merged or released.

See the [decisions and session handoff](handoffs/2026-10-12-sidebar-worktrees.md) and [interactive preview](previews/folders-and-worktrees.html).

- [x] Make the approved folder-based sidebar and existing compact conversation view the defaults; retain Show full Assistant.
- [x] Resize the sidebar; collapse, hide/restore, and reorder projects.
- [x] Make Connect folder prominent, with computer folder search and browsing.
- [x] Support ordinary non-Git folders and optional explicit Git initialization.
- [x] Create, open, and delete worktrees; default to `<project>/.worktrees/<name>` with a remembered per-project override.
- [x] Add `/.worktrees/` to the root `.gitignore` when needed, preserving existing entries and avoiding duplicates.
- [x] Show the actual running version beside Settings, with an About panel.
- [ ] Plan and verify persistence, session isolation, and safe worktree operations before a future Mac release.

## 5. Terminals from Gloss

Status: designed and approved on 2026-10-14; implemented on branch `terminal`. See the [feature preview](previews/terminal-feature.html).

- [x] Plain shell terminals as tabs, started from "+" or by Run, surviving restarts.
- [x] First message field on the New session dialog, replacing the setup prompt.
- [x] Run button on shell code blocks, reusing the folder's idle terminal.
- [x] Popup and full-workspace views with Expand/Shrink and the "Terminal tabs open as" setting.

## 6. Session-to-session updates across worktrees

Status: idea captured on 2026-10-16; benefits and feasibility still to be worked out.

- [ ] Use a Gloss channel/MCP server so every session in a project tells the others what it is working on, including sessions in other worktrees.
- [ ] Work out the concrete advantages (avoiding overlapping edits, sharing findings, coordinating merges) before designing.
- [ ] Check whether the same can work for Codex sessions, not only Claude.

## 7. Remove the large end-of-session popup

Status: captured.

- [ ] Ending a session opens a huge popup; the user does not want it.

## 8. Smaller usage-limit notice

Status: captured.

- [ ] When tokens run out and the usage limit is hit, the window that opens is too big and too long. Make it short and compact.

## 9. Redesign the whole window

Status: captured; needs its own design pass.

- [ ] Redesign the full app window.

## 10. "Summarize in Hebrew" is not working

Status: captured; reproduce and find the cause.

- [ ] Something in "Summarize in Hebrew" does not work for the user; details still needed.

## 11. Terminal scrollback reaches the top

Status: captured.

- [ ] Scrolling up in a terminal session stops before the beginning; let the user scroll all the way to the top.

## 12. Show running Claude subagents

Status: captured; check what Claude Code exposes.

- [ ] If possible, show the subagents a Claude session is running.

## 13. Logs of background servers

Status: captured.

- [ ] When a session runs a server in the background, let the user see its logs.

## 14. Local DevOps tools and their permissions

Status: idea captured; brainstorm separately.

- [ ] Show the CLIs installed on the computer (AWS, Docker, GitHub, and others), let the user connect to them, and show what permissions each one has.

## Shared constraints

- Keep terminal output and instructions delivered to coding agents in English; Hebrew discussion and translations stay in the panel.
- Preserve each session's conversation, composer, selections, files, prepared work, and layout.
- Keep the core independent of Superset.
- Treat all pending design questions as open; do not silently turn suggestions into requirements.
