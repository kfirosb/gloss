# Product task list

Captured from the user's request on 2026-09-28. These are separate workstreams, not one implementation plan. Task 1 was authorized with preview-first browsing and explicit attachment; tasks 2 and 3 remain separate.

## 19. lsof storm in Claude session liveness checks

Status: fixed on branch `lsof`; Gloss 0.10.5 installed on 2026-10-16.

Gloss 0.10.4 ran one `/usr/sbin/lsof` per Claude socket on every session refresh and status poll: 155 runs in 5 s with 9 sessions, load average 7.7, and the full browser suite took 22 minutes.

- [x] One batched `lsof -Fpcfn +c 0 -- <sockets…>` call per refresh, with strict output parsing and bounded batches.
- [x] 3 s cache per PID/socket/version with alive / not-alive / failed states; identity changes are rechecked at once; failures fail closed.
- [x] `kill(pid, 0)` pre-check; checks in the same tick and the recent working set share one call.
- [x] A failed probe keeps discovery incomplete; one bad record cannot fail the others; every send re-checks without the cache.
- [x] Measured: built backend 2–3 Claude `lsof` runs per 10 s; packaged 0.10.5 1 Claude run per 6 s. Browser suite 279/279 in about 5 minutes.
- [x] Installed 0.10.5 (9 Claude records, 93 catalog entries): all `lsof` runs fell from 143 per 5 s to 42–52 per 10 s; Claude's share is 6 per 10 s. Load average fell from 12–14 to about 4. Unit 1102/1102; browser 279/279 in 4.7 min.
- [x] Codex probes (`ps`, `lsof -Fpcfn` on writer locks, `lsof -a -d cwd`) share one round across discovery, status and sends for 3 s (Gloss 0.10.6). Installed 2026-10-16: per 15 s, Codex fell from 16 writer `lsof` + 15 `cwd` `lsof` + 16 `ps` to 4 + 1 + 4; all `lsof` together about 1/s (30 in 30 s).
- [ ] Possible follow-up (seen only in a logged-out test home): language workers re-run `claude auth status` about 5 times a second when Claude is not logged in.

## 15. Claude discovery accepts invalid `entrypoint` values

Status: complete (urgent); fixed in e3cfd90 and released in Gloss 0.10.4.

Regression from commit a061535 (refactor co-authored with Claude). `registries()` in `src/agents/claude/index.ts` now normalizes `entrypoint: optional(r.entrypoint, 'string')`, which turns `null`, numbers, booleans, objects, and arrays into `undefined`. The filter in `discoverOpenClaude` then sees them as a missing field and lets them through as terminal sessions. Before a061535 the original value reached the filter unchanged. A missing field has a special meaning here, so this field alone needs stricter validation.

- [x] Reject invalid `entrypoint` values before normalization: if the field exists, it must be a string.
- [x] Preserve compatibility: a missing field is allowed, `"cli"` is allowed, and unsupported strings (e.g. `"sdk-cli"`) are rejected.
- [x] Add regression tests for a missing field, `"cli"`, `"sdk-cli"`, `null`, numbers, booleans, objects, and arrays.
- [x] Keep the broader cleanup and the shared `optional` helper; do not revert a061535.

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

## 16. Terminal inside the Live Conversation

Status: implemented on branch `terminal-to-live` on 2026-10-17; checked by the user in the Electron app; the Hebrew line shows only in the expanded pane.

- [x] Show the session's terminal as part of the Live Conversation panel, so the user can view the terminal instead of the conversation in the same place.
- [x] Replace the terminal pop-up there with a switch between "Coding agent · translated", the regular (original) conversation, and the terminal.
- [x] Decide how the switch fits next to the existing Expand, History, Summarize in Hebrew, and Original controls.

## 17. Files panel and file preview

Status: design task captured on 2026-10-16; needs a design pass.

- [ ] Let the user move the Files panel to another place in the window (not only the current side panel).
- [ ] Add an option to expand an open file preview from the pop-up to full screen.
- [ ] Remember Translate / TL;DR results per file: closing the preview and reopening the same file shows the result without clicking again.
- [ ] Show the file list beside the preview pop-up, so the user can pick other files and move between them without closing the preview.

## 18. Editing and creating files

Status: discussion needed; not urgent.

- [ ] Talk through letting the user edit existing files and create new ones from Gloss, for cases such as `.env`.
- [ ] Decide scope, safety (secrets, unsaved changes, files the agent is also editing), and whether the agent is told about the change.

## Shared constraints

- Keep terminal output and instructions delivered to coding agents in English; Hebrew discussion and translations stay in the panel.
- Preserve each session's conversation, composer, selections, files, prepared work, and layout.
- Keep the core independent of Superset.
- Treat all pending design questions as open; do not silently turn suggestions into requirements.
