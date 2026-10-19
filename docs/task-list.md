# Product task list

Captured from the user's request on 2026-09-28. These are separate workstreams, not one implementation plan. Task 1 was authorized with preview-first browsing and explicit attachment; tasks 2 and 3 remain separate.

## 20. Activity view

Status: implemented on branch `subagents` (not merged); spec [2026-10-18-activity-view-design](superpowers/specs/2026-10-18-activity-view-design.md).

A Claude session gets an Activity tab beside Translated, Original, Split and Terminal. It lists running subagents and background commands (with a live tail of the command's output) and every tool call as a timeline, all derived from the transcript. (First version, 2026-10-18; the live page below replaced the timeline and the translated reports.)

- [x] 1. In a connected Claude session, ask Claude to run a long command in the background and spawn a subagent. Within a few seconds the Activity tab shows "2", the view lists both as running, the background card tails the output, and the subagent card shows its tool rows. When each finishes, the cards grey out and the report appears, translated when translation is on.
- [x] 2. The timeline lists the session's tool calls newest first, with failed commands marked; clicking a row shows the full command and result.
- [x] 3. The Translated, Original, Split and Terminal views and the translation stream behave exactly as before (existing unit and browser suites pass unchanged).
- [x] 4. A Codex session shows the Activity tab disabled with a tooltip.
- [x] 5. Switching sessions while a tail or a subagent read is open leaves no stale rows in the newly selected session and closes the previous session's file reads.

Verification (2026-10-18):

- Unit: `npm run typecheck && npx vitest run`: 1234 passed, 1 skipped (129 files); after the fix below, 1236 passed, 1 skipped.
- Browser: `PLAYWRIGHT_PORT=4301 npx playwright test` (4291 was held by another worktree): 304/304 in 2.2 min. After the fix: 300/304 in 5.5 min at load average 8.5; the 4 failures (live-terminal, session-switcher, session-tabs, sessions-sidebar, all outside Activity) passed on one rerun together with `activity.spec.ts` (10/10).
- `npm run build` succeeds with Vite's existing advisory "Some chunks are larger than 500 kB after minification" (main chunk 922.66 kB).
- Manual, isolated instance (fake `HOME`, built backend on port 4302, throwaway Claude 2.1.302 session in this worktree, driven with Playwright): badge read "Activity2" with both cards running about 2 s after the tool calls; the subagent card showed its Grep and SubagentHandback rows; the background tail stayed empty during `sleep 30`, then showed `done` and `[exited with code 0]`; the badge fell to 1 when the subagent ended and both cards went grey (finished, with durations 7 s and 30 s). A real `ls /nonexistent-gloss-check` row was marked failed at the top of the timeline and expanded to the command and `Exit code 1` output. Switching to a Codex session aborted both open streams at once, showed no Activity rows and a disabled Activity tab titled "Activity is available for Claude sessions"; switching back showed the right cards with tails closed, and a reload kept the correct badge.
- [x] Fix found by manual acceptance (9d0ea41): Claude 2.1.302 runs subagents async and hands the report back as a peer record, so finished async cards had no report. The report is now read from the hand-back's structured `origin` fields; afterwards both real subagent cards showed their reports translated into Hebrew.

- Live page (2026-10-19): spec [2026-10-19-activity-live-page-design](superpowers/specs/2026-10-19-activity-live-page-design.md). This round was verified by the unit and browser suites only; there was no fresh manual run. It supersedes the timeline and translated-report wording above.
  - [x] 1. With one running subagent and one running background command: the strip shows the command and its last output line; two cards show (Claude, the subagent), each with at most 5 rows, newest on top; the newest row carries the highlight class briefly; the badge shows 2. No request to `translate-activity-report` exists anywhere. Covered by `tests/ui/activity.spec.ts`: "shows the strip, the active cards and the last five actions newest first", "the newest row is highlighted briefly" and "five running commands take three slots and the rest show an ellipsis". The absence of `translate-activity-report` is by removal of the action (no spec asserts the missing request).
  - [x] 2. "Show earlier actions (N)" on the Claude card reveals the older rows; "Show fewer" collapses them. Covered by the "Show earlier actions (3)" and "Show fewer" assertions in "shows the strip, the active cards and the last five actions newest first".
  - [x] 3. When the subagent finishes, its card disappears from the active list and History reads `1 finished subagent`; opening History shows its card with the English report and its last actions. Covered by "a finished subagent moves to History and keeps its actions".
  - [x] 4. Translated, Original, Split and Terminal views and reply translation behave as before; the full unit and browser suites pass. Covered by the full suites below.
  - [x] 5. A Codex session shows the Activity tab disabled; a disconnected Claude session shows no live dots and opens no streams. Covered by "Activity is only for Claude sessions" and "a disconnected session greys everything and opens no stream".

  Verification (2026-10-19):

  - Unit: `npm run typecheck && npx vitest run`: 1652 passed, 1 skipped (139 files passed, 1 skipped).
  - Browser: `PLAYWRIGHT_PORT=4321 npx playwright test`: 315/315 in 2.1 min, no reruns needed.
  - `npm run build` succeeds with Vite's existing chunk-size advisory.

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

Status: implemented on `make-pop-up-smaller`; not released.

- [x] Ending a session opens a huge popup; the user does not want it.
- [x] Hovering a session or terminal tab swaps its activity dot for an X; clicking it ends the session or terminal at once. The tab's context menu "End session" also ends at once, and a failure is shown in the error line.

## 8. Smaller usage-limit notice

Status: implemented on `make-pop-up-smaller`; not released.

- [x] When tokens run out and the usage limit is hit, the window that opens is too big and too long. Make it short and compact.
- [x] The quota break dialog stretched to the full window height and laid its English text out right to left; it is now a 320px card sized to its content, left to right, with the same content and buttons.

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
