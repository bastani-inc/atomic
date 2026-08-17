# PR title

feat(extensions): add the user-decision block door (split 1/4 of #2415)

# PR body

This is **split 1 of 4** of #2415, following the split plan @lavaman131 laid out in
[that PR's review](https://github.com/bastani-inc/atomic/pull/2415#issuecomment-5310888061).
#2415 will be closed and superseded once the four splits land. Feature issue: #2210.

The plan's four slices:

1. **Block-door core** — this PR (~400 lines, no consumers)
2. UI-context wrapping (`runner-ui-blocks.ts`, `settlement-observer.ts`)
3. Trust-prompt blocks (`runner-project-trust.ts` / `withTrustPromptBlocks`)
4. Herdr pane reporter (`src/extensions/herdr/*`, `docs/herdr.md`)

**Size, flagged up front:** slices 1 and 3 sit inside the ~300–1000-line band (+705, +541). Slices 2 and 4 exceed it as carved — +1326/−44 and +3306/−24 — and the overage is almost entirely their tests (slice 4 is +1066 source / +2077 tests / +163 docs). Scope follows the slice definitions above exactly; no tests were dropped to fit the band. If you'd rather either one be sub-split further, tell us here and we'll carve it before submitting that slice.

## What this adds

The core primitive that lets Atomic say "a human is being waited on" — nothing could
report `blocked` before, which is the gap you identified.

- **`src/core/extensions/block-types.ts`** — `UserBlock`, `UserBlockSnapshot`,
  `AgentBlockedEvent`, `AgentUnblockedEvent`, `UserBlockChange`, `UserBlockListener`,
  and the `UserBlockReason` union (`"dialog" | "project_trust" | "workflow_prompt" |
  "supervisor_ask"`).
- **`src/core/extensions/user-blocks.ts`** — a session-scoped registry keyed by the
  canonical event bus: `openUserBlock`, `subscribeUserBlocks`, `getOpenUserBlocks`,
  and `getActiveUserBlockLabel`. `/reload` successors on one bus share open state;
  concurrent sessions stay isolated.
- **`pi.awaitUserDecision(label, reason)`** on `ExtensionAPI`, implemented in
  `loader-api.ts`.
- **`agent_blocked` / `agent_unblocked`** events, published from `ExtensionRunner` as
  ordinary lifecycle events so extensions observe them through `pi.on()` like any
  other. Each runner serializes delivery, so an async handler cannot reorder a
  block-open and block-close event; a rejected handler cannot break later delivery.
  `ExtensionRunner.detachUserBlocks()` (called on invalidate, and by
  `agent-session-tool-registry.ts` when a reload replaces the runner) prevents a stale
  subscriber from publishing to dead extensions after every `/reload`.

- Public type exports from `src/index-extensions.ts` and the extensions barrel.
- Docs: `docs/extensions.md` gains an `agent_blocked / agent_unblocked` event section
  and a `pi.awaitUserDecision(label, reason)` API section.
- Changelog: two `[Unreleased] → Added` entries.

### Contract

A block ends **only** through the handle that opened it. There is deliberately no
release-by-id, release-by-label, or release-all entry point, so one caller can never
end another caller's wait. `release()` is idempotent and safe in a `finally`. Blocks
are reference counted, and the oldest open block's label is the reported wait.

`test/unit/extension-block-door-public-api.test.ts` pins that contract with
`@ts-expect-error` negative compile assertions, so adding a release-by-id method or
widening the reason union fails the typecheck rather than silently passing.

## No consumers yet — this PR is correct standing alone

Per your "every PR has to be correct at merge" point: nothing in the host opens a
block in this PR. No `ctx.ui` wrapping, no project-trust blocks, no reporter. That is
intentional — it keeps this slice reviewable and means the diff cannot regress
existing behavior. `pi.awaitUserDecision()` is immediately usable by extensions that
render their own waits; Atomic's own dialogs adopt the door in split 2 and split 3.

I deliberately **scrubbed the forward references** from the phase-1 prose while
carving this slice, so nothing in the shipped docs, changelog, or doc comments claims
behavior this PR does not have. Specifically, the phase-1 text asserting that every
blocking `ctx.ui` dialog auto-opens a block, and that the startup project-trust prompt
opens one, is removed here and returns with the PRs that actually introduce it.

The defect fixes disclosed on #2415 (A and B) belong to the overlay/reporter behavior
in later slices, not to this one; they are folded into the split that introduces what
they fix, as requested.

### Ordering regression and fail-first evidence

The async-handler ordering defect disclosed during review was reproduced before the
fix through the real extension loader: the unfixed `12b3eb109` delivered
`agent_unblocked` before `agent_blocked`, leaving the observed state at the stale
`openBlocks: 1` value. The focused regression then passed after the queue fix:

```
Before fix: 1 failed, 10 passed (11); actual ["unblocked", 0, undefined] preceded ["blocked", 1, "Approve edit?"]
After fix:  1 file passed; 11 tests passed (11)
```

Fail-first capture: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/fail-first.log`.
Passing capture: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/pass-after.log`.

### Runtime-rebuild detach regression

The focused block-door suite now rebuilds a real `AgentSession` runtime twice, opens
and releases a block, and asserts that the replacement runner delivers exactly one
`agent_blocked` / `agent_unblocked` pair. Removing the `_buildRuntime` detach call
first made the assertion fail with three `blocked` and three `unblocked` deliveries
(11 other tests passed); restoring it passes all 12 tests. Captures:

- Fail-first without the call-site detach: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/fail-first.log`
- After restoring the call: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r6/pass-after.log`

## Review response

Both verified Greptile P1 findings are fixed.

### Block events are isolated per session

`user-blocks.ts` now stores each registry and listener set in a `globalThis` +
`Symbol.for`-backed `WeakMap` keyed by the canonical session event bus. The loader
records that bus on the shared runtime, so `ExtensionRunner` subscribes to its own
session scope; a bus-less runner gets a private fallback scope. Distinct buses no
longer cross-deliver `agent_blocked` or `agent_unblocked`, while a `/reload`
successor using the same bus retains the open-block set.

Regression evidence (real tests against unfixed and fixed source):

- Fail first: `.validation-p1fix/isolation-fail-first.txt` — Session B received
  `blocked:only-session-a-label` and the zero-event assertion failed.
- Pass after: `.validation-p1fix/isolation-pass-after.txt` — 1 test passed, 13
  skipped; the same-bus successor replay and per-bus counts passed.

### Factory-opened blocks replay their opening event

`subscribeUserBlocks()` replays each currently open block to the newly attached
runner, feeding the existing per-runner serialized queue. The factory-registration
regression opens a block after registering both handlers, attaches the runner, then
releases it; the handler observes exactly `blocked`, `unblocked`.

- Fail first: `.validation-p1fix/factory-fail-first.txt` — the opening event was
  lost and the lifecycle wait timed out.
- Pass after: `.validation-p1fix/factory-pass-after.txt` — 1 test passed, 13
  skipped; the opening count is exactly one and lifecycle order is preserved.

The standalone Greptile-style two-runner/factory reproduction is captured at
`.validation-p1fix/greptile-harness-repro.txt`:

```text
Session A: blocked then unblocked; Session B: [] and open state: []
same-bus successor: [blocked:only-session-a-label]
factory lifecycle: [blocked, unblocked]
```

The final branch diff is **17 files, 999 insertions**, below the 1000-insertion
cap. Full final-tip validation logs are `.validation-p1fix-r2/check.txt`,
`.validation-p1fix-r2/test-unit.txt`, and `.validation-p1fix-r2/test-workspace.txt`.
The public API test remains unmodified and passes with the full unit suite.

### Round 2 response: transient factory-lifetime block pair

The verified Greptile P1 is fixed with **shape B (ordered pre-attach buffering)**.
Factories execute while the resource loader is loading extensions, before
`_buildRuntime()` constructs the `ExtensionRunner`; therefore shape A would need
an early subscription with a deferred sink and extra runner plumbing. Shape B is
the smaller root fix: the canonical factory scope retains exact open/close
payloads until its first runner subscription, which replays that sequence once
and then switches to live delivery. The first attach consumes the buffer instead
of also replaying `openBlocks`, while later/replacement runners receive only the
currently-open state and never stale transient events.

Round-2 evidence:

- Fail-first transient factory regression: `.validation-p1fix-r2/factory-transient-fail-first.txt`
- Passing transient factory regression: `.validation-p1fix-r2/factory-transient-pass-after.txt`
- Final full-suite logs: `.validation-p1fix-r2/check.txt`, `.validation-p1fix-r2/test-unit.txt`, `.validation-p1fix-r2/test-workspace.txt`
- Final diff/import evidence: `.validation-p1fix-r2/diffstat.txt`, `.validation-p1fix-r2/import-consistency.txt`
- Final round-2 commit: `ab90047aef32c4c6748b1bd2b5db5f737d41840c`; branch total is 906 insertions versus `origin/main` (under the 1000-line cap).

### Round 3 response: generation-scoped factory lifecycle buffering

Review found that the round-2 latch handled only the first runner on a bus, and
the round-3 boundary initially erased a retained project-trust generation. The
final-extension boundary now runs only when no pre-trust result exists; retained
pre-trust factories keep their ordered buffer through final-set assembly. Each
generation starts at the outer loader boundary, merges synthesized currently-open
replays with ordered transitions, and caps retained transitions at 1024 earliest
changes so an abandoned load cannot retain an unbounded history.

The regressions now use real `DefaultResourceLoader` inline factories: plain loads
run twice to prove discarded prior transitions do not leak, and project-trust loads
run twice to prove retained pre-trust transient pairs replay exactly once.
The exact pre-fix retained-generation failure is captured at
`.validation-p1fix-r2/real-loader-p0-fail-first.txt`; the fixed test passes in
`.validation-p1fix-r2/wiring-production-pass-after.txt`. The two production
boundary mutations each fail the real-loader test:
`.validation-p1fix-r2/wiring-production-{final,project-trust}-fail-first.txt`;
the generic combined capture is `.validation-p1fix-r2/wiring-production-fail-first.txt`.
The removed `discoverAndLoadExtensions` hook had no production callers and no
longer serves as the wiring proof. The cap regression is in `extensions-user-blocks.test.ts`.

Final round-3 commit: `2001017b7ef1b20fbbeaacdf99776e5cbd94eb75`; branch total is 999 insertions versus
`origin/main`, below the 1000-insertion cap.

## Diff

```
 packages/coding-agent/CHANGELOG.md                 |   5 +
 packages/coding-agent/docs/extensions.md           |  66 +++
 .../src/core/agent-session-tool-registry.ts        |   7 +
 .../coding-agent/src/core/extensions/api-types.ts  |  26 ++
 .../src/core/extensions/block-types.ts             |  77 ++++
 .../src/core/extensions/event-types.ts             |   3 +
 .../coding-agent/src/core/extensions/index.ts      |   8 +
 .../coding-agent/src/core/extensions/loader-api.ts |   8 +
 .../coding-agent/src/core/extensions/runner.ts     |  37 ++
 .../src/core/extensions/runtime-types.ts           |   5 +
 .../src/core/extensions/types.ts                   |   1 +
 .../src/core/extensions/user-blocks.ts             | 207 +++++++++
 .../src/core/resource-loader-extensions.ts         |   2 +
 .../src/core/resource-loader-reload.ts             |   2 +
 packages/coding-agent/src/index-extensions.ts      |   7 +
.../test/extensions-user-blocks.test.ts            | 488 +++++++++++++++++++++
test/unit/extension-block-door-public-api.test.ts  |  50 +++
17 files changed, 999 insertions(+).
```

999 lines: 538 tests, 66 extension-doc lines, 5 changelog lines, and 390 source
lines. No dependency or lockfile changes.

## Validation

Round 1's tip was `26312fb69`; round 2's tip was `ab90047ae`; round 3's final tip
is `2001017b7ef1b20fbbeaacdf99776e5cbd94eb75`. The full validation below was re-run at the round-3 final tip.
Round-1 captures remain under `.validation-p1fix/`; current evidence is under
`.validation-p1fix-r2/`.

| Command | Result |
| --- | --- |
| `npm run check` | **exit 0** — capture: `.validation-p1fix-r2/check.txt` |
| `env -u ATOMIC_WORKFLOW_STAGE_SUBAGENT_GUARD npm run test:unit` | **exit 0** — 686 files / 6757 passed, 2 skipped. Capture: `.validation-p1fix-r2/test-unit.txt` |
| `npm run test --workspace=@bastani/atomic` | **exit 0** — 476 files / 3928 passed, 39 skipped. Capture: `.validation-p1fix-r2/test-workspace.txt` |
| `npm run test --workspace=@bastani/atomic -- extensions-user-blocks` | **exit 0** — 17 tests passed. Capture: `.validation-p1fix-r2/extensions-user-blocks-final.txt` |
| production-boundary mutation tests | **both fail first, pass after** — `.validation-p1fix-r2/wiring-production-{final,project-trust}-fail-first.txt` and `wiring-production-pass-after.txt` |
| module-import-specifier consistency | **exit 0** — 1 test passed. Capture: `.validation-p1fix-r2/import-consistency.txt` |

All suites are green at the final tip.

Both new changelog entries are under `## [Unreleased]` → `### Added`; the released
`0.9.14` and prerelease sections are untouched, verified against
`git show origin/main:packages/coding-agent/CHANGELOG.md`.

### End-to-end

Beyond the unit tests, the ordering fix was exercised through the **real CLI and real
extension loader** with an async `agent_blocked` handler that waits 150 ms and a plain
`agent_unblocked` handler. The throwaway extension was loaded from a temp global agent
dir by `rpc-entry` and driven by a `get_commands` JSON-RPC line (stdin stayed open for
three seconds so RPC shutdown could not cut off the async callbacks):

```
session_start
agent_blocked 1 Approve deploy? dialog open=1 active=Approve deploy?
agent_unblocked 1 Approve deploy? dialog open=0 active=undefined
final open=0 active=undefined
```

The command exited 0. This proves the async handler observes the open before the
close, and the final observed state is free (`open=0 active=undefined`). Full source,
command, stdout, stderr, and transcript: `/Users/akgunay/.atomic/workflows/runs/a92d187c-c133-4701-94b9-9c69b7c8429b/validation-r5/e2e-async.log`.
The earlier nested synchronous E2E remains in `validation-r4/e2e.log`.

## Notes on the review points from #2415

- **Import specifier.** lavaman131 restated the maintainer request on #2415 at
  2026-08-17T01:49:58Z: **"Import specifier" (Greptile P2): `runner-ui-blocks.ts:16`
  imports `./ui-types.ts`; [`AGENTS.md`](../blob/main/AGENTS.md) requires `.js`.
  Your scrutiny point 2 notes the mixed spelling — please settle on the repo
  convention.** The #2416 comment at 2026-08-17T01:50:02Z likewise lists
  **"`.ts` / `.js` import inconsistency"** carried up from #2415.

  This PR responds within its scope: every module it adds and every import line it
  adds uses the `.js` spelling, and it introduces no new `.ts` internal import. The
  specific `runner-ui-blocks.ts` example is in split 2, not this PR. The repository's
  `test/unit/module-import-specifier-consistency.test.ts` enforces per-module
  consistency, so a repo-wide respell is all-or-nothing per module. Re-verifying the
  current tree gives **48 target modules, 486 `.ts`-spelled import lines, and 203
  unique importer files** across exactly the six source roots walked by
  `module-import-specifier-consistency.test.ts` (`packages/coding-agent/src`,
  `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`,
  and `packages/intercom`). Test trees are excluded. The count covers static
  `from`/side-effect import and `require` sites whose target module is in the set;
  type-query/dynamic `import("...")` expressions are excluded. Reproducible script
  and output: `validation-r5/respell-census.log`. This is far past this PR's ~400-line
  target and 1000-line cap and outside the block-door scope. If maintainers want the
  repository settled on `.js`, that is best as a separate mechanical PR; please
  confirm whether that is preferred over leaving this split scoped.
- **`research/docs/2026-08-07-herdr-phase1-codebase.md` is absent** from this branch,
  as asked.
- **Heartbeat-suppression pinning test is not in this slice.** Its subject — reporter
  heartbeat suppression across session replacement, scrutiny point 6 on #2416 — is
  introduced by the phase-2 lifecycle/reporter work, so the accept-by-design pinning
  test lands with the PR that introduces the behavior (split 4 / phase 2) rather than
  pinning something this PR does not ship.
- **Full suites were re-run at the final tip**, as requested, and all pass: `npm run check`,
  the coding-agent package suite (472 files, 3893 tests), targeted import-consistency and
  public-API tests, the block-door suite (12 tests), the runtime-rebuild regression, and
  the async real-CLI end-to-end check. Captures are in `validation-r6/` (with the prior
  ordering and E2E captures retained under `validation-r5/`).
