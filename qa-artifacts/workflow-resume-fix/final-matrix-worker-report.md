# Final matrix worker report

## Outcome: STOPPED — not authoritative

I did **not** certify the requested 14/14 matrix. Per the task's genuine-product-defect stop rule, completion review identified ownership/fencing defects in frozen committed source. The source was not changed. A complete rerun would also be invalid until those defects are fixed and a new source/runtime/CLI fingerprint is frozen.

The existing regenerated scenario artifacts contain 14 observed behavioral passes, but they must not be treated as an authoritative release gate: seven scenarios did not preserve the mandatory authoritative durable JSON before isolated `HOME` cleanup. I did not synthesize that missing evidence.

## Frozen build inspected

- HEAD: `871a705cbe7f9289cbb9c3b62d25a55519a809ba`
- Workflow source manifest: `aeaed928dd74948bb16a387b950887b6ad059cdf2986d303cc131c1b2ec7708a`
- `packages/coding-agent/dist-dev/cli.js`: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`
- Base fixture: `ac762e71b4440093f66a1ab4c0e8c4f0203fb0c847ecfceea0d9cd47c3e947bf`
- `packages/coding-agent/dist/builtin/workflows/src` was byte-identical to `packages/workflows/src`.

## Objective-blocking product defects

1. **Completion can race between validation and lease claim.** `resume-runtime.ts:151-197` reads and validates a handle, then claims ownership, but never re-reads authoritative state after the claim. A run can complete/be removed in that interval and still be dispatched from the stale handle.
2. **A pre-dispatch flush failure can strand this process's lease.** After claiming, `resume-runtime.ts:209-210` sets running status and flushes. Its catch only rolls back when `isWorkflowExecutionActive(...) !== true` (`:243-250`); this process's own live claim makes that condition false, so the lease is not released.
3. **PostgreSQL connection loss does not fence the still-running executor.** `postgres-execution-lease.ts:33-40` removes the owner entry when the advisory-lock connection drops. Another process may claim and execute while the original executor continues without a cancellation/fencing signal.
4. **An unconfirmable process identity can evict a live stalled owner.** `execution-lease.ts:95-107` observes a live PID, but if saved/current identity cannot be confirmed it falls back to the 30-second heartbeat. A synchronous stage can stall the heartbeat and be reclaimed despite the live PID, allowing duplicate execution.

These are concurrency failures not reliably certifiable through a happy-path 14-row TUI matrix; durable regression tests and source changes are required first.

## Evidence work completed before the stop

The exact-session scenario was honestly rerun through the full-screen TUI with:

- captured bun PID `34161`;
- `kill -9` followed by `kill -0` polling to ESRCH;
- authoritative durable JSON showing `status:"running"`, one checkpoint, `resumable:true`, and its definition hash;
- exact `--session 019f5cc9-45d2-7785-b406-036832552b37` reopen;
- targeted resume of `0a0051e3-2c7e-4fee-957a-2d342f34da46`;
- resumed `ctx.ui.input` attachment, literal answer entry, and a separate real Enter key;
- singular checkpoint, answer, and final markers.

Literal executed tmux commands, per-scenario hash equality, two-root ID/`updatedAt` evidence, and actual cleanup/redaction command output were also regenerated. Final cleanup reports zero QA CLI processes, zero live recorded sockets, zero credential directories, and zero secret-pattern matches.

## Evidence gap requiring rerun

The following observed runs lack the mandatory preserved durable JSON because their isolated homes were already removed: `fresh-empty-session-selector`, `nested-child-root-only`, `rapid-resume-command-burst`, `repeated-resume-across-two-prompts`, `resume-picker-then-workflow-resume`, `selector-cancel-reopen`, and `stale-picker-row-revalidation`.

After fixing the product defects, all 14 scenarios—not only these seven—must be rerun against the newly frozen fingerprint, preserving the authoritative durable file before cleanup in every required case.

## Validation

- `git diff --check`: pass
- `bun run check:file-length`: pass (2083 tracked files checked)
- Production source/tests/docs remained unchanged.
