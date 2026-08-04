# Issue #2188 slices 0–2 implementation report

## Scope and contract

Implemented the requested Slice 0 N-API declaration fix, Slice 1 additive in-process doors/runner, and the foreground portion of Slice 2. Work stayed on `spec/issue-2188-subagent-inprocess`; no other checkout, push, PR, tag, release, or version bump was made.

The repository tree is clean except for the pre-existing untracked blueprint:
`research/docs/2026-08-04-issue-2188-ts-migration-blueprint.md`.

## Slice 0 — N-API string unions

### Changes

- `packages/natives/scripts/build-native.ts`
  - Added the generated-binding flag `--no-const-enum`.
  - This is reproducible through the documented native build; `index.d.ts` was not hand-edited.
- `packages/natives/native/index.d.ts`
  - Regenerated through `packages/natives/scripts/build-native.ts`.
  - `AdmissionRefusalKind`, `AgentStatus`, and `TerminationCause` now emit literal TypeScript unions rather than ambient `const enum`s.
- `packages/natives/CHANGELOG.md`
  - Added an `[Unreleased]` Changed entry.

### Evidence

- Native regeneration command:
  `cd packages/natives && PATH="$PWD/node_modules/.bin:$PATH" bun scripts/build-native.ts`
  - exited 0.
- Generated declaration inspection:
  - `export type AdmissionRefusalKind = 'depthExceeded' | 'capacityExhausted' | 'dispatchGuardBusy' | 'invalidCwd' | 'unknownAgent'`.
  - `export type AgentStatus = 'pending' | 'running' | 'ok' | 'error' | 'interrupted' | 'continued'`.
  - `export type TerminationCause = 'abort' | 'interrupt' | 'fail-fast-skip' | 'parent-shutdown'`.
  - No `const enum` remains for these three types.
- Temporary strict TypeScript value-assignment probe using all three aliases passed with `tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --ignoreConfig`.
- `cargo fmt --check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `cargo test`: 43 passed, 0 failed; one existing doctest ignored.
- `npm run check`: passed.

Commit: `d5867ee5c fix(natives): emit consumable string union types`

## Slice 1 — in-process doors and runner

### Added files

- `packages/subagents/src/runs/inprocess/runner.ts`
- `packages/subagents/src/runs/inprocess/index.ts`
- `packages/subagents/src/runs/inprocess.ts`
- `test/unit/subagents-inprocess-runner.test.ts`

### Implemented behavior

- Rust-backed admission through `SubagentControl`, with typed refusal propagation and canonical child identity.
- Trusted session-root/path checks for admission and cold reload.
- The admitted-child constructor is private and its runtime factory rejects identities over the maximum depth.
- Typed `ChildPolicy` carrying cwd, tools/exclusions, MCP direct-tool selection, skills, custom tools, model/thinking policy, group, and depth.
- In-process `createAgentSession` construction using `SettingsManager`, `DefaultResourceLoader`, and `SessionManager` JSONL backing stores.
- Session event subscription and optional JSONL event mirroring.
- Rust attempt-token retention and abort/interrupt signal handling through the single termination door.
- `SessionStats` collection on all terminal outcomes.
- Typed `AttemptOutcome` statuses (`ok`, `error`, `interrupted`, `continued`) and typed terminal envelopes.
- `continue_in_background` rejects attempts that are not running.
- Cold reload validates trusted path, identity, session directory, session file, and routes through Rust reload/admission state.
- `deliver_child_result` is in-memory exactly-once per child path, writes bounded output/metadata, and appends typed `run-history.jsonl` when an artifact directory is supplied.

### Focused regression evidence

`npx vitest --run --project unit test/unit/subagents-inprocess-runner.test.ts`:

- 3 tests passed:
  - parent depth 5 refuses a depth-6 admission;
  - an untrusted cold-reload path is refused;
  - continuation of a non-running attempt is rejected.

Commit: `f9598a537 feat(subagents): add in-process runner doors`

## Slice 2 — foreground cutover

### Changes

- Added `packages/subagents/src/runs/foreground/inprocess-run-sync.ts`.
- Replaced the old `execution-run-sync.ts` implementation with the in-process runner facade.
- Replaced `execution-structured-retries.ts` with a typed in-process adapter; no process/stdout parser remains on the foreground path.
- Deleted the foreground process-attempt modules authorized by the Slice 2 allowlist:
  - `packages/subagents/src/runs/foreground/execution-attempt.ts`
  - `packages/subagents/src/runs/foreground/execution-attempt-control.ts`
  - `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts`
  - `packages/subagents/src/runs/foreground/execution-attempt-types.ts`
- Deleted `test/unit/subagents-execution-attempt-lifecycle.test.ts`, whose subject exclusively exercised the deleted process-attempt/detach implementation.
- Added typed `status: "skipped"` to foreground fail-fast/detached-group placeholder results.
- Foreground run-history writes now accept typed status values (`ok`, `error`, `skipped`, `interrupted`, `continued`) rather than synthesizing history status from an exit code.
- Added `status`, `cause`, `stats`, `path`, and `envelope` fields to `SingleResult` as the typed-result transition surface. The legacy `exitCode` field remains temporarily because the later background/TUI clean-break slices still compile against it; it is explicitly deferred and not used to construct the new runner's status.
- Added the `[Unreleased]` subagents changelog entry.

Commit: `39e97ce72 refactor(subagents): route foreground attempts in process`

Documentation follow-up commit: `722a4903e docs(subagents): note in-process foreground semantics`

## Validation after Slice 2

- `npm run check`: passed (Biome, repo-wide `tsc --noEmit`, shrinkwrap check).
- Focused changed-surface run:
  `npx vitest --run --project unit test/unit/subagents-inprocess-runner.test.ts test/unit/subagents-depth-guard.test.ts test/unit/subagents-get-final-output.test.ts`
  - 3 files passed, 18 tests passed.
- `git diff --check`: passed.
- `git status --porcelain`: only the pre-existing untracked blueprint remains.

## Full-suite result and known blocker

The required repository-wide `npm run test:unit` was attempted. The checkout's baseline run already had a load/environment-sensitive workflow failure (628 files passed, 1 failed); subsequent full runs under the same loaded environment produced 625 files passed, 4 failed and 5,862 tests passed / 16 failed. The failures are in workflow durable/reload/tool-graph suites and report cross-test workflow-stage state (`workflows cannot invoke workflows from workflow stages`), not in the changed in-process runner tests. The focused changed tests pass. The pre-existing failure was not modified or masked.

## Exact stopping point / remaining slices

Slices 0–2 are complete to the foreground boundary. I did **not** start Slices 3–5.

The shared process helper files remain intentionally deferred because the still-existing background process runner imports them:

- `packages/subagents/src/runs/shared/pi-args.ts`
- `packages/subagents/src/runs/shared/pi-spawn.ts`
- `packages/subagents/src/runs/shared/spawn-env.ts`
- `packages/subagents/src/runs/shared/attempt-watchdog.ts`
- `packages/subagents/src/runs/shared/final-drain.ts`
- `packages/subagents/src/shared/post-exit-stdio-guard.ts`
- `packages/subagents/src/runs/shared/subagent-prompt-runtime.ts`

Deleting those now would make the repo-wide gate fail before the background cutover. The next run must first unify async/detach onto the live in-process continuation, then delete the background runner/result-claim/PID machinery and these remaining shared process helpers; after that it must complete cold reload/resume, nested-event and cross-package env cleanup, TUI typed-status rendering, CI grep guards, full docs/changelog updates, and the spec's remaining integration/E2E tests.

## Commits in order

1. `d5867ee5c` — `fix(natives): emit consumable string union types`
2. `f9598a537` — `feat(subagents): add in-process runner doors`
3. `39e97ce72` — `refactor(subagents): route foreground attempts in process`
4. `722a4903e` — `docs(subagents): note in-process foreground semantics`
5. `1883d1cc2` — `docs(natives): note consumable status unions`
