# Split-1 readiness report

- **Branch:** `herdr-split-1-block-door`
- **Base:** `origin/main` at `6c769a85717ad5a22c844fce5de9be8dff121984`
- **HEAD:** `7108186645dfddcb9284429d06cf9adcdcca6572`
- **Commits:** `7108186` feat(extensions): add the user-decision block door
- **Diff:** 14 files, +705/-0. Source +280, tests +360, extension docs +60, changelog +5. No dependency or lockfile changes.

## Validation

The commands below were run sequentially at final HEAD `7108186645dfddcb9284429d06cf9adcdcca6572`; the async end-to-end capture from the preceding commit remains under `validation-r5/`, unchanged by this commit's test-only addition.

- `npm run check`: exit 0 — `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/check.log`
- `npm run test --workspace=@bastani/atomic`: exit 0 — 472 files, 3893 tests; `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/package-tests.log`
- Block-door package tests: exit 0 — 1 file, 12 tests; `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/pkg-blockdoor.log`
- Targeted import-consistency/public-API tests: exit 0 — 2 files, 2 tests; `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/targeted-unit.log`
- `npm run test:unit`: exit 0 — 669 files passed (669), 6544 tests passed, 2 skipped, in 86.45s; capture: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/test-unit-orchestrator.log`. Measured in an ordinary shell. Runs of this same command from inside a subagent execution environment report five workflow/DBOS files failing; those files are untouched by this diff, and the command is green here, at the four preceding commits, and in three independent reviewer runs.
- Async real CLI + real extension-loader E2E: exit 0; `agent_blocked` precedes `agent_unblocked`, final `open=0 active=undefined`; `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/e2e-async.log`
- Diffstat: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/diffstat.txt`
- Reproducible import census script/output: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/respell-census.log` (48 modules, 486 sites, 203 files).

## Ordering fix and fail-first evidence

Before the fix, the real-loader regression at `12b3eb109` failed: an async
`agent_blocked` handler caused observed `agent_unblocked open=0 active=undefined`
to arrive first, followed by stale `agent_blocked open=1 active=Approve deploy?`.
After serializing per-runner delivery, the same test passes 11/11. Captures:

- Fail-first: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/fail-first.log`
- After fix: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/pass-after.log`

The runner queue also keeps later events flowing after a handler rejection,
rechecks stale/detached runners before queued delivery, and catches detached
emission failures so no unhandled rejection is produced. The public extension
docs and changelog now state the lifecycle-order guarantee.

## Runtime-rebuild detach regression

The block-door suite now rebuilds a real `AgentSession` runtime twice, opens and
releases one block, and asserts exactly one `agent_blocked` / `agent_unblocked` pair.
With the `_buildRuntime` detach call temporarily removed, the assertion failed with
three `blocked` and three `unblocked` deliveries while the other 11 tests passed. With
the call restored, all 12 tests pass. Captures:

- Fail-first: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/fail-first.log`
- After restore: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/pass-after.log`

## Maintainer guidance and plan impact

Read-only `gh` checks of #2415/#2416 confirm lavaman131's 2026-08-17 comments require: four separate phase-1 PRs (this is slice 1, block-door core); every PR correct at merge; full suites rerun per split PR; `.js` import spelling settled; fork CI runs require maintainer approval; and the heartbeat-suppression accept-by-design pinning test belongs with the later replacement/reporter behavior. **None changes this split plan.** The current split remains block-door core only; UI wrapping, trust prompts, and the Herdr reporter stay in later slices.

The file-scoped criterion-2 `.js` requirement remains a contract conflict requiring a user decision. The reproducible six-root census reports 48 target modules, 486 `.ts`-spelled static import/require sites, and 203 unique importer files; test trees and type-query/dynamic `import("...")` expressions are excluded. Full respelling would exceed the split's line/scope budget.

## Hygiene and external actions

Both new changelog entries are under `[Unreleased]` → `### Added`; the released `0.9.14-alpha.2` section is byte-identical to `git show origin/main:packages/coding-agent/CHANGELOG.md`. The research artifact is absent, and the heartbeat pinning test is recorded for the later slice. No PR, issue, or GitHub comment was created; nothing was pushed to any remote.
