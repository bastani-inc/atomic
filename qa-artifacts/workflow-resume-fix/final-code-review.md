## Final Code Review: `/workflow resume`

**Recommendation: REJECT**

### P0
None found.

### P1
None found.

### P2

#### 1. Execution ownership is claimed after session/store mutation

`run()` records the run in the active store and optionally appends a session `run.start` entry before attempting to claim the file execution lease:

- Store/session mutation: `packages/workflows/src/engine/run.ts:136-150`
- Lease claim: `packages/workflows/src/engine/run.ts:402`

Consequently, a contender rejected by `WorkflowExecutionAlreadyClaimedError` can leave a phantom running snapshot and session entry despite never owning execution. The regression test only asserts that the durable handle was not created; it does not verify that the store or persistence remained unchanged (`test/unit/durable-execution-lease.test.ts:83-104`).

The durable-resume adapter itself orders these operations correctly: it claims at `packages/workflows/src/durable/resume-runtime.ts:188-190`, then removes shadows and changes status at `:191-196`. The general top-level `run()` path does not.

#### 2. Definition fingerprint is omitted from session JSONL persistence

The backend cache entry includes `definitionHash` (`packages/workflows/src/durable/backend.ts:310-331`), and the session scanner can parse and propagate it (`packages/workflows/src/durable/resume-catalog.ts:91-116,138-157`). However, `persistDurableCacheEntry()` drops the field when writing JSONL (`packages/workflows/src/durable/resume-catalog.ts:195-215`).

This leaves the requested session propagation incomplete. Current resume safety still uses the authoritative backend handle (`packages/workflows/src/durable/resume-runtime.ts:151-179`), but session artifacts do not contain the compatibility fingerprint their types and reader support.

No regression test verifies a persisted JSONL entry contains `definitionHash`.

### P3
None found.

## Verified Areas

- **Exact-session durable-shadow routing:** Ended exact-ID shadows are checked against durable state and routed to durable resume (`packages/workflows/src/extension/workflow-run-control-command.ts:423-446`). Exact-ID stale shadows are removed before redispatch (`packages/workflows/src/durable/resume-runtime.ts:191,216-227`).
- **File leases:** Active owners are refused, dead same-host owners reclaimed, and malformed published owner metadata treated conservatively (`packages/workflows/src/durable/execution-lease.ts:18-52,62-88`). Unit coverage exists at `test/unit/durable-execution-lease.test.ts:26-81`.
- **Authored source fingerprint:** `workflow()` preserves `String(specRun)` as `definitionSource` (`packages/workflows/src/authoring/workflow.ts:145-176`), and hashing uses it ahead of the wrapper’s source (`packages/workflows/src/durable/backend.ts:185-193`).
- **File/DBOS propagation:** File state serializes the complete handle (`packages/workflows/src/durable/file-backend.ts:52-58,279-287`). DBOS encode, decode, and hydration propagate `definitionHash` (`packages/workflows/src/durable/dbos-backend.ts:336-367,388-463`), covered at `test/unit/durable-dbos-backend.test.ts:325-341`.
- **Compatibility refusal:** Resume compares the authoritative stored hash before claiming or dispatching (`packages/workflows/src/durable/resume-runtime.ts:166-190`), covered at `test/unit/durable-resume-runtime.test.ts:158-179`.
- **Artifacts:** Final matrix records 13 passes, one fixture/environment failure, and zero product failures (`qa-artifacts/workflow-resume-fix/after/complete-matrix-summary.json:1-119`).

The requested file was not written because this review session was explicitly kept read-only and had no write tool.