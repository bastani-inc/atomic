# Atomic Exit Confirmation Manual Test Report

Date: 2026-06-26

## Scope

Manually exercised the real Atomic TUI exit-confirmation behavior while a workflow was running. This was not limited to smoke tests or static review.

## Environment and preflight

Preflight confirmed the checkout was initialized and usable:

- `bun --version` -> `1.3.14`
- `bun pm ls --depth 0` -> passed
- `bun packages/coding-agent/src/cli.ts --help` -> passed
- `tmux` -> `3.6b` available
- `bun run typecheck` -> passed
- `bun test test/unit/session-overlays.test.ts` -> passed

Relevant exit paths identified: `/quit`, `/exit`, empty-editor Ctrl-D, double Ctrl-C, workflow graph `q`, and expected process/signal bypass. Active-workflow prompt title: `Quit with active workflows?`; default action: Cancel.

## Initial real TUI E2E run

Launched Atomic in tmux:

```sh
tmux new-session -d -s atomic-exit-e2e -x 140 -y 40 'cd /Users/norinlavaee/atomic-exit-confirmation && bun packages/coding-agent/src/cli.ts --approve --session-dir /tmp/atomic-exit-e2e-sessions --name exit-confirmation-e2e'
```

Started workflow in the TUI:

```text
/workflow deep-research-codebase prompt="map exit confirmation" max_partitions=1 max_concurrency=1
```

Observed workflow run `e0d22d0c` running.

| Scenario | Steps | Expected | Result |
| --- | --- | --- | --- |
| `/quit` cancel by default | Enter `/quit`, press Enter at confirmation | Active-workflow prompt appears; default Cancel keeps app/workflow running | PASS |
| `/exit` explicit cancel | Enter `/exit`, press `n` | Active-workflow prompt appears; cancel keeps app/workflow running | PASS |
| Empty-editor Ctrl-D cancel | Press Ctrl-D with empty editor, press Esc | Active-workflow prompt appears; cancel keeps app/workflow running | PASS |
| Graph quit cancel | Open workflow graph, press `q`, press Enter | Confirmation defaults to cancel; graph/workflow stays running | PASS |
| Graph quit confirm | In graph, press `q`, press `y` | Workflow quits from graph and becomes resumable | PASS: showed quit/resumable |
| Main quit after graph quit | After graph `q` then `y`, enter `/quit` | No active-workflow warning for already graph-quit/resumable run | FAIL: active-workflow prompt still appeared with 0/1 stages running |
| Double Ctrl-C | Press Ctrl-C twice while workflow running | Should follow quit confirmation path or leave app/workflow safe | INCONCLUSIVE: tmux capture did not reliably show a visible confirmation, but app/workflow stayed running |
| Process bypass | Kill tmux session | No in-app confirmation expected for external termination | PASS |

## In-scope bug fixed

Bug: after confirming graph `q`, the workflow displayed as quit/resumable, but a later main `/quit` still showed `Quit with active workflows?` for that quit/resumable workflow with 0/1 stages running.

Root cause: `packages/workflows/src/extension/extension-lifecycle.ts` counted all top-level workflow runs with `endedAt === undefined` as app-shutdown blockers. Graph quit records the run as `status: paused`, `exitReason: quit`, `resumable: true`, and `endedAt: undefined`, so it was incorrectly treated as active.

Fix: `packages/workflows/src/extension/extension-lifecycle.ts` now uses a narrow app-shutdown blocking predicate that excludes only graph-quit/resumable paused runs (`paused` + `resumable` + `exitReason=quit` + no `endedAt`). Regression coverage was added in `test/unit/extension-shutdown.test.ts`.

`issues.md` was created during debugging and deleted after the bug was fixed.

## Validation after fix

- `bun test test/unit/extension-shutdown.test.ts` -> passed, 2/2 tests
- `bun test test/unit/extension.test.ts test/unit/extension-shutdown.test.ts` -> passed, 22/22 tests
- `bun run typecheck` -> passed
- `bun run check:file-length` -> passed

## Real TUI retest after fix

Launched a fresh Atomic TUI session:

```sh
cd /Users/norinlavaee/atomic-exit-confirmation && bun packages/coding-agent/dist/cli.js --approve --session-dir /tmp/atomic-exit-retest-sessions --name exit-confirmation-retest
```

Started workflow:

```text
/workflow deep-research-codebase prompt="Retest exit confirmation behavior; keep workflow running briefly" max_partitions=1 max_concurrency=1
```

Observed workflow run `3b3e2e44-a8d2-437c-973c-805baeb2bd71`.

| Scenario | Steps | Expected | Result |
| --- | --- | --- | --- |
| Active main quit still guarded | Enter `/quit`, press `n` | Active-workflow prompt appears; cancel keeps app/workflow running | PASS |
| Graph quit confirm | In graph, press `q`, press `y` | Workflow becomes quit/resumable | PASS: showed `quit · resumable via /workflow resume` |
| Main quit after graph quit | After graph quit/resumable state, enter `/quit` | App exits without active-workflow warning | PASS |

## Remaining risks and tangential observations

- Graph `q` confirmation copy says `Quit & kill` / killed, but the resulting state is resumable. This is wording/UX mismatch and was not changed as part of the shutdown-blocking fix.
- Double Ctrl-C remains inconclusive from tmux capture; the app/workflow stayed running, but the prompt was not reliably visible in captured output.
- Signal/process termination bypasses in-app confirmation as expected; no code change was made for signal behavior.

## Files changed by the completed work

- `packages/workflows/src/extension/extension-lifecycle.ts`
- `test/unit/extension-shutdown.test.ts`
- `exit-confirmation-manual-test-report.md`
