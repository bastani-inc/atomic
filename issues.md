# Windows CI failures after #3499 (blocks 0.9.28-alpha.3)

## Timeline (test.yml)
| Run | Commit | Windows result |
| --- | --- | --- |
| 37570271513 | d58e762a (#3498 branch) | ok |
| 37571403781 | d65265f4 main (#3498 merged) | ok |
| 37571427602 | cf2cf343 release PR #3497 | ok (Linux failed: fixed by #3499) |
| 37573627058 | 4db4d06f (#3499 branch) | ok |
| 37574861191 | b938fcdf main (#3499 merged) | **unit-tests (windows-x64) failed** |
| 37574889444 | d5a276e4 release PR #3497 | **integration-tests (windows-x64) failed** |

Windows passed in all four runs before b938fcdf and failed in both runs after it, so #3499 is the prime suspect. Its Windows jobs passed on its own branch, so the failure is intermittent or depends on load.

## Suspect change: b938fcdf (#3499)
`packages/coding-agent/src/modes/rpc/rpc-client-process.ts`
- `terminateRpcClientProcess` grace after SIGTERM: 250 ms -> `ENGINE_SHUTDOWN_GRACE_MS` (5 s) when `processTree` is true (interactive engine).
- All three exit waits now go through `exitsWithin()`, which aborts its `sleep` timer once the race settles.
On Windows `child.kill("SIGTERM")` calls TerminateProcess, so the 5 s grace should rarely apply there. Check that assumption first: if the engine on Windows does not exit on SIGTERM (Bun child, or a grandchild holding the handle), every engine stop now waits about 5.5 s instead of 0.75 s, and reload/replace-heavy tests would time out.

`test/integration/interactive-no-mcp-startup.test.ts` was also changed (1 s `session_shutdown` handler), but it is skipped without tmux (Windows).

## Failures
### unit-tests (windows-x64), main b938fcdf
- `test/unit/workflow-run-state-real-reload.test.ts > user-global agent launch keeps its real publish watcher through resource and installed full reload` timed out at 120000 ms (line 539). This file failed on Windows before #3499 too (runs 37563532538, 37547019855), but with other cases.

### integration-tests (windows-x64), release PR d5a276e4
- `installed-package-node-extensions.test.ts > packed Node consumer types, assets and builtin parity` timed out at 360000 ms (also failed on main 2856a7e8, before #3499).
- `sdk-builtin-host-parity-host-routing.test.ts` (5 cases), not seen failing before #3499:
  - `public factory preserves an initially unbound required gate and continues exactly once` timed out at 45000 ms
  - `Node workflow prompt nodes route true through the factory's human host` timed out at 30000 ms
  - `persisted handoff from node to the other host`: the run stayed `running`/`executing` (test/fixtures/sdk-host-durable-client.ts:85)
  - `persisted handoff from cli to the other host`: same
  - `built non-TTY Node routes the unchanged workflow and exits after public session disposal`: `confirm-readiness` assertion at test/fixtures/sdk-host-built-node.mjs:131

## Pre-existing noise (not the cause)
`TimeoutOverflowWarning: 1791350064395 does not fit into a 32-bit signed integer` appears during `dbos-native-row-guard.test.ts`. An absolute epoch deadline is passed as a setTimeout delay and gets clamped to 1 ms. Passing main run 37566014296 logged it 63 times, so it predates #3499, but it is a real bug and may busy-loop under load.

## Suggested first steps on Windows
1. `npx vitest --run --project integration test/integration/sdk-builtin-host-parity-host-routing.test.ts` on b938fcdf and on d65265f4 (parent). If only b938fcdf fails, #3499 is confirmed.
2. If confirmed, instrument `terminateRpcClientProcess`: log whether the first `exitsWithin` returns true on Windows, and how long it took.
3. A minimal revert candidate: apply `ENGINE_SHUTDOWN_GRACE_MS` only when `process.platform !== "win32"`, or revert `exitsWithin` to the plain `sleep` race, and rerun step 1.

## Release state
- PR #3497 (`prerelease/0.9.28-alpha.3`, head d5a276e4) is a changelog-only commit on b938fcdf. Its coding-agent changelog includes the #3499 shutdown entry under 0.9.28-alpha.3. If #3499 is reverted, drop that entry and rebase the release branch onto the new main.
- publish-release runs f08fea97, d1bbb2b0 and 8e74d032 all stopped at the CI gate. Nothing has been merged, tagged or published.
