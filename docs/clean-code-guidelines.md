# Clean code in Gloss

Read this before changing source code. These are maintenance expectations, not a
request to rewrite unrelated code. Keep changes focused and preserve user data,
session identity, delivery semantics and native-agent consent boundaries.

## Clear ownership and useful reuse

- Give each module one cohesive responsibility. Keep UI rendering, host operations,
  persistence and protocol validation separate. Extract a module when it gives a
  responsibility a clear owner, not to satisfy an arbitrary line limit.
- Reuse existing contracts rather than copying their shapes. `src/core` owns shared
  domain contracts and policies; `src/runtime` owns host services; `src/agents` owns
  provider integration; `src/storage` owns persistence; `src/ui` owns presentation.
- `src/ui/main.tsx` owns application navigation and bootstrap;
  `src/ui/session-workspace.tsx` owns the selected conversation workspace. Do not
  grow a second copy of workspace behavior in the application entrypoint.
- Prefer small, named functions with explicit inputs and outputs. Extract repeated
  behavior when its meaning and lifecycle are genuinely shared. Two similar lines
  do not necessarily justify a generic framework or a new dependency.

## Types that describe what is known

- Avoid new explicit `any`, including in tests. Use domain types, discriminated
  unions, generics, `Pick`, and typed fixture builders. Existing loosely typed test
  fixtures are technical debt, not a pattern to copy.
- Use `unknown` for genuinely untrusted values: parsed JSON, external protocol data,
  persisted preferences and caught errors. Narrow it before reading fields. Do not
  replace it with an asserted domain type just to make a type search look clean.
- Reuse `recordOf` and `textBlocks` from `src/core/json-record.ts` where appropriate.
  An object guard validates only the object shape; individual fields still need
  validation. `JSON.parse`, HTTP response generics and `as SomeType` do not validate
  data at runtime. Identity-sensitive records must fail closed when malformed.
- Known outputs should have specific types: `Promise<void>` for completion-only
  operations, concrete API response types, `SQLOutputValue` for SQLite values.
  Avoid widening a known result to `unknown` or using double assertions to bypass
  an incompatible contract.
- Keep strict compiler settings. Prefer narrowing and control-flow checks over
  non-null assertions. Explain unavoidable assertions at their trust boundary.

## Constants and configuration

- Share policy, not coincidentally equal numbers. Upload/attachment/text limits live
  in `src/core/content-policy.ts`; launch defaults, validation and argument handling
  live in `src/core/launch-settings.ts`. Update callers through those owners.
- Make a value configurable only when users, deployments or tests need that choice.
  Name fixed policy values and explain their units and purpose. Do not turn schema
  versions, protocol identifiers, security restrictions or consent requirements
  into arbitrary settings.
- Keep provider-specific constraints with their adapter. Do not assume a native
  transport limit and a product input limit are the same policy.
- Keep SQL migrations in `src/storage/migrations.ts`. Never rewrite an applied
  migration to implement a schema change; add a new version with migration coverage.

## Async behavior, performance and safety

- Preserve cancellation, ownership and ordering across every awaited operation.
  A late result must not change a newly selected session or overwrite newer edits.
  Preserve request IDs, epochs and sequence checks when sharing transport code.
- Never retry an uncertain delivery automatically. A timeout after a possible send
  is not proof that nothing was delivered. Preserve the user's unsent work.
- Use `src/ui/server-events.ts` for shared SSE decoding, while keeping each client's
  identity and reconnect rules explicit.
- Measure before optimizing. Avoid repeated work in hot loops; use sets/maps for
  repeated membership/ranking. Bound cache size and lifetime, retry failed reads,
  and preserve in-flight deduplication where required. Reuse `src/core/async-cache.ts`
  only when its eviction and completion-based TTL semantics fit the caller.
- Close streams, timers, listeners, sockets and files at the owning lifecycle
  boundary. Handle rejected promises deliberately; do not silently swallow errors
  unless the operation is intentionally best-effort and the reason is clear.
- Preserve path, ownership, symlink, private-file permission and target-identity
  checks. Never log credentials or raw configuration parser diagnostics. Do not
  shell-interpolate untrusted input; pass arguments as structured arrays.

## Readability, styles and cleanup

- Use descriptive names and early returns. Comments should explain intent,
  invariants, non-obvious constraints or tradeoffs, not paraphrase the next line.
- Keep imports together at the top; use type-only imports where possible. Remove
  unused imports, unreachable branches and obsolete helpers in the code you touch.
- Run `npm run format`; do not hand-maintain a competing formatting style.
  Keep mass formatting separate from behavioral changes when practical.
- Dark palettes are generated by `scripts/dark-styles.mjs`. Edit the source light
  colors/palette rules, regenerate with `node scripts/dark-styles.mjs`, then format.
  Preserve CSS `color-scheme` declarations and theme initialization; preview content
  must retain its own document styling.
- Remove only artifacts you can attribute to the task. Never broadly clean a
  worktree, discard someone else's edits, or stage root DMGs and unrelated files.
  Keep refactors recoverable before merging upstream changes.

## Tests and honest handoff

For a behavior change, add a focused regression test and watch it fail for the
intended reason before fixing it. Test public behavior, not implementation details
or the mock itself. Cover malformed inputs and async races where relevant. Prefer
deterministic readiness/condition checks over fixed sleeps; do not hide failures
with retries or weaker assertions.

Before claiming a change is verified, run and inspect:

```sh
npm run typecheck
npm run format:check
git diff --check
npm test
PLAYWRIGHT_PORT=4287 npm run test:e2e -- --workers=1
npm run build
```

Choose an unused browser-test port; the runner deliberately refuses to reuse an
unrelated server. On macOS, optionally prefix the long browser command with
`caffeinate -i env` to prevent idle sleep for that command only. Do not normalize
captured protocol/terminal fixtures just to remove meaningful whitespace.

If the user defers tests, honor that instruction and state exactly what remains
unverified. Never carry a passing result from before a merge forward as proof of
the merged code. Report failures, skips, warnings and review limitations explicitly.
Before handing off, inspect the diff for accidental deletions, duplicate owners,
conflict markers, unsafe assertions and unintended dependency changes.

Source integration is not a release. For app installation, version creation or DMG
work, follow `docs/mac-release-protocol.md`; preserve the running app and saved data
and never push the local `private-history` branch.
