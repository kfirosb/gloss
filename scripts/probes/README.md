# Disposable integration probes

Run `node scripts/doctor.mjs` first. It reports versions/account-mode booleans without printing credentials. It does not send model requests.

Live probes consume the coding subscription. Always create a new scratch directory and a new interactive agent session. Never infer a target from the most recently active conversation.

For Claude, use the explicit channel harness below. `capture-claude.mjs` is historical research, not a recommended setup path; do not install a SessionStart hook for this workflow.

For Codex, select the disposable session by exact scratch `cwd` in the read-only local `threads` metadata table. Confirm a unique match and use its source thread ID and transcript path. Do not read unrelated transcript files.

Verify an exact marker in the **original** interactive session and its transcript. A queue receipt alone does not prove that the running session consumed the message. A Claude socket write alone does not prove acceptance. Detach the assistant and verify the original agent remains alive.

On completion, exit only the disposable terminal processes and delete their scratch directory, settings and pointers. Native clients may retain test histories and normal trust entries. See the dated evidence report in `docs/superpowers/research/` for observed versions and remaining gaps.

## Native Claude channel assembled-app harness

`node scripts/probes/claude-channel-e2e.mjs prepare` creates a private temporary ROOT and runs actual tsc/Vite builds there, never over the user's dist. It creates two same-name scratch projects with exact native UUIDs. Keep ROOT/config.json and browser.json private: the latter contains the isolated app capability. Never publish launch/config/registry files.

In separate terminals run `node scripts/probes/claude-channel-e2e.mjs serve ROOT`, then `node scripts/probes/claude-channel-e2e.mjs launch ROOT ordinary` and `node scripts/probes/claude-channel-e2e.mjs launch ROOT bypass`. Do not launch another client for an already running target. Accept scratch trust/development-channel consent interactively. New sessions alone receive the READY prompt. The real catalog is filtered BEFORE restore to exact scratch paths/UUIDs, while process identity and readiness checks remain enabled.

The harness resolves the absolute native Claude binary, strips Superset from PATH/environment, and disables auto-update. Disposable-only overrides isolate settings/MCP servers, disable built-in tools/slash commands, select Haiku, expose MCP tools upfront with ENABLE_TOOL_SEARCH=false, and explicitly select ordinary/default or bypass mode. They are NOT changes to normal generated setup commands, which preserve other MCP/settings. A trusted wrapper supplies stateDir to the actual built startClaudeChannel; the generated exact-target resume command and shell quoting are checked independently.

Use `status ROOT MODE`, `setup ROOT MODE`, and `boundaries ROOT MODE` before sending. `send ROOT MODE UNIQUE_MARKER` invokes real app HTTP translation/send. `evidence ROOT MODE` checks real ledger, exact native transcript receipt counts, reply display source IDs, SSE/DB/transcript credential absence, and unchanged settings hashes. HTTP 202 alone is never delivery evidence. `duplicate ROOT MODE ORIGINAL_COMPOSER_ID` checks duplicate requests without a new model send. Ordinary reply approval remains in the native client; no permission relay is used.

For lifecycle tests stop only the verified scratch native PID, then `launch ROOT ordinary resume`; never run resume beside its original client. Recheck notification counts before any additional send. The optional `reference` launch variant enables only Read for an explicitly authorized harmless scratch reference.txt; `reference ROOT ordinary` attaches it through the real app. Do not enable shell tools. `action ROOT MODE PRIVATE_ACTION.json` is a trusted operator escape hatch for explicit app actions such as releasing an unconfirmed composer, not an automated replay mechanism.

Open only the isolated app URL in Chrome MCP. Verify exact-target selection, double click dedup, translated reply/history order, draft preservation after release/late reply, and channel-credential absence in UI/storage/logs. Keep the tab visible for browser actionability checks. Never modify browser state to fake app behavior. Preserve other tabs. Retain clients for controller checks if requested; otherwise exit only verified disposable PIDs, preserve sanitized evidence, and remove their temporary secrets. Do not touch the user's panel, global settings, working sessions, or rollback artifacts.

Privacy coverage: evidence observes SSE for 1000 ms from reader attachment, up to 4 MiB, requiring a complete exact-session initial snapshot and complete subsequent frames received during that window. Its sseCoverage records actual frames/bytes and bounds. Transport chunks are never treated as events. Incomplete frames, early EOF, malformed data, read errors and bound overflow fail the probe rather than report absence. Events outside that window (including earlier sends) are not covered. WAL absence is accepted only on ENOENT; other errors fail. The dated report corrects older single-chunk/blanket-catch claims; retained old booleans must not be interpreted as corrected live evidence. Run `npm test -- tests/runtime/claude-channel-privacy.test.ts` for deterministic real HTTP/SSE checker regression coverage without native/model requests.
