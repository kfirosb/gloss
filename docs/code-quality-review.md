# Code quality review

This pass improves the existing architecture without replacing product workflows,
changing database schemas, upgrading agent protocols, or preparing a release.
The large diff is predominantly formatting of previously compressed code.

## Latest integration status — 2026-10-16

Merged public `origin/main` at `e43d4f6` (Gloss 0.10.2) into `reorder`, preserving
the reviewed refactor in checkpoint `a124bf3`. Local merge commit: `3c5d1d2`.
The merge retains dark mode and its three palettes, UTF-8 tmux behavior for Dock
launches, approval version floors, the agent-launch/reconcile race fix, and saved
Claude channel configuration repair after app relocation. The repair code uses
validated JSON object fields to match the refactor's stricter types.

Formatting-normalized three-way comparison resolved the formatting-only conflicts;
the remaining import conflicts were combined explicitly. Package and lockfile retain
version 0.10.2 and the existing pinned formatter. The upstream consent-screen fixture
is preserved byte-for-byte, including its captured trailing blank line.

Cleanup groups imports left between declarations by the earlier module extraction.
Production source has no unused-local/parameter diagnostics; an optional stricter
check still reports eight pre-existing unused parameters in test fixtures. Those
unrelated test signatures were not changed. Future sessions should follow
`docs/clean-code-guidelines.md`, linked from `AGENTS.md`.

**Integrated-version unit/browser tests and build are pending at the user's request.**
The historical passing results below describe the pre-merge refactor only, not
the integrated version. Integration verification is limited to TypeScript checking,
formatting, whitespace/conflict checks, ancestry confirmation and semantic review.

## Changes worth reviewing first

| Concern | Ownership after this refactor |
| --- | --- |
| Attachment, upload, text and media limits | `src/core/content-policy.ts`, shared by UI and server |
| Ordered attachment selection and membership validation | `selectFileReferences` in `src/core/file-references.ts` |
| Launch settings, defaults, validation and argument serialization | `src/core/launch-settings.ts` |
| Bounded asynchronous caching | `src/core/async-cache.ts` |
| Session update envelope | `src/core/session-contracts.ts` |
| JSON server-sent event decoding and cancellation | `src/ui/server-events.ts` |
| Session workspace UI | `src/ui/session-workspace.tsx`, separated from application navigation |
| Existing SQLite migrations | `src/storage/migrations.ts`, moved without changing SQL or versions |

The cache shares pending reads, starts expiry when a read completes, retries failed
reads, bounds retained entries, and supports targeted invalidation. Inventory,
project metadata and nested-worktree lookups use it where their semantics match.
The catalog's separate cache remains local because it also supports synchronous
projection of previously read metadata.

Navigation uses sets and rank maps for membership and ordering. Duplicate persisted
tab keys no longer duplicate tabs. File search stops after collecting its result
limit, and query normalization happens outside the per-file comparison.

Launch argument formatting now round-trips empty arguments and values containing
either or both quote styles. This is argument serialization, not shell evaluation.

Both live-update clients use the same reader for CRLF framing, multiline JSON data,
split UTF-8 chunks and cancellation, while retaining their own session/epoch checks.
Response summaries reset when the assistant language changes, so an old-language
summary cannot remain displayed with the new language's label.

Composer insertion cursors now update synchronously with React's committed text.
Previously, an animation-frame callback could overwrite a selection made by the
next edit. A deterministic browser regression holds frame callbacks to exercise
this ordering. The saved-session browser test also waits for initial workspace
readiness before navigating.

The follow-up type audit removed all explicit `any` types from `src`. External JSON
is narrowed through shared object/text-block guards instead of being asserted to
match a provider schema. Launch responses, terminal messages, asynchronous queues,
folder callbacks and SQLite rows now use their specific result/value types.
`unknown` remains at genuine validation boundaries (untrusted JSON, persisted
preferences, caught errors and extensible metadata). Historical test fixtures still
contain explicit `any`; this is not a claim that the entire repository is free of it.

## Maintenance

Run `npm run format` to format first-party source and tests, or
`npm run format:check` to check without writing. Prettier is pinned in the lockfile.
Generated output, vendored code, fixtures and release artifacts are excluded.

Browser tests now refuse to reuse a possibly unrelated worktree's server. Override
the default port with, for example, `PLAYWRIGHT_PORT=4287 npm run test:e2e`.
The CLI entrypoint test resolves the installed TypeScript compiler instead of
assuming a particular package layout. Real tmux tests poll for the expected output
instead of relying on short fixed sleeps.

## Review boundaries

The production review covered core workflows and contracts, persistence, runtime
services, file handling, agent discovery and transports, language workers, dictation,
UI state and components, desktop startup, and build/test configuration. Tests were
examined around changed behavior and run as complete suites; this is not a claim
that every test or historical research script received an independent line review.

External protocol limits, version checks, security restrictions, schema versions,
and UI design values were not turned into arbitrary runtime settings. Equal numeric
values do not necessarily represent the same policy. In particular, native channel
limits and product composer limits can evolve independently.

The first independent reviewer could not finish because its service quota was
exhausted. Its preliminary translation-language concern does not establish a
current product bug: validated settings support Hebrew and English, and English
replies bypass translation. Adding more languages will require revisiting stored
translation identity and invalidation.

A second independent reviewer completed the semantic review and found one cursor
edge case: replacing a selected newline with Alt+Enter leaves the text unchanged,
so a text-dependent layout effect does not consume the pending caret position.
A browser regression reproduced the next-edit cursor jump (expected position 4,
actual position 2), then passed after handling unchanged text immediately. That
reviewer also checked the subsequent type cleanup and reported no material findings.

## Remaining opportunities

- Split the large UI bundle, especially terminal dependencies. The production build
  still warns about its approximately 902 kB main JavaScript chunk (258 kB gzip).
- Continue extracting cohesive operations from the workflow and session workspace;
  both remain substantial modules even after formatting and the initial split.
- Add targeted fault-injection coverage for desktop backend startup errors/timeouts
  and dictation engine startup cancellation before changing their lifecycle code.
- Profile large-history persistence and registry restoration before adding more
  caching; ownership checks and durable delivery behavior must remain intact.

No live subscription-consuming agent probes, app installation, DMG build, release,
push or merge was performed. The installed app and user data were not modified.

## Historical verification before main integration

The initial unit run exposed the compiler-path assumption and timing-sensitive tmux
checks; both were corrected. After installing local development dependencies, the
existing `fix-node-pty` script restored the native helper's executable permission,
and the real PTY tests passed.

Verification on 2026-10-15, followed by the type-audit recheck on 2026-10-16:

- `npm run format:check`: passed.
- `npm run typecheck`: passed.
- `npm test`: 1,029 passed; one real-engine dictation integration test skipped
  because its local binary/model/audio prerequisites were not all present.
- `npm run build`: passed, with the UI chunk-size warning noted above.
- `caffeinate -i env PLAYWRIGHT_PORT=4287 npm run test:e2e -- --workers=1`: 279 passed.
- Picker/session suites repeated three times after the timing fixes: 57 passed.
- All 24 extracted migrations compared equal to their original versions and SQL.
- `git diff --check`: passed.

An earlier browser rerun had two failures (the picker edit and saved-session
readiness cases described above). They were investigated and corrected before the
final complete run; they were not hidden by enabling automatic retries.

The first full browser run after the type audit recorded 276 passes and three
timeouts. macOS power logs show 972-, 620- and 541-second sleep intervals matching
those tests' 16.3-, 10.3- and 9-minute stalls despite their 30-second deadlines.
No application changes were made for those failures. The affected file and session
switcher suites then passed three consecutive repetitions (81 tests). The fresh full
run passed all 279 tests in 4.9 minutes, using `caffeinate -i` to prevent idle sleep
only while the command ran.
