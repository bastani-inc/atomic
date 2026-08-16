/**
 * Durable workflow-heartbeat cadence anchor.
 *
 * The heartbeat cadence is `anchorAt + n × interval`. Every input to that is
 * already persisted except one: the *original* run start time. A durable resume
 * re-dispatches under the original workflow id but mints a fresh
 * `RunSnapshot.startedAt` (`engine/run.ts`), and that fresh value is passed to
 * `registerWorkflow` as `createdAt`, which the backend overwrites
 * unconditionally (`durable/backend.ts`). Checkpoints are the only per-run state
 * that survives re-registration, so this record is the sole surviving carrier of
 * the original start — which is what keeps a resumed run on its original
 * cadence rather than starting a fresh series.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-heartbeat-anchor`), following `run-timing.ts`. Its `checkpointId` is
 * that same constant with no suffix, so `recordCheckpoint`'s duplicate-key early
 * return makes the record **write-once and exactly one row per run** rather than
 * one row per boundary.
 *
 * Three properties this shape is chosen for:
 *
 * - **It cannot manufacture resumability.** `recordCheckpoint` sets
 *   `completedCheckpoints = checkpoints.size`, and `isDurableWorkflowResumable`
 *   gates a running or paused run on `completedCheckpoints > 0`. Writing for a
 *   run with no durable progress of its own would make it look resumable, so the
 *   write is skipped until the run has at least one other checkpoint — the same
 *   guard, and the same reason, as `run-timing.ts`.
 * - **It cannot walk liveness backwards.** `recordCheckpoint` copies
 *   `completedAt` onto the handle as `updatedAt`, which the foreign-liveness
 *   window reads, so `completedAt` is the write time and never a cadence
 *   boundary.
 * - **It cannot move a boundary forward.** It is read as
 *   `min(run.startedAt, anchorAt)`, so it can only restore the original anchor,
 *   never advance it. Recovery still floors at `now`, so no missed boundary is
 *   ever replayed.
 *
 * The record has no per-checkpoint deletion — `DurableWorkflowBackend` removes
 * whole workflows only — so terminal cleanup (issue #1975) invalidates it on the
 * read side instead: the scheduler neither reads nor writes an anchor for a run
 * it observes as terminal, and drops the in-memory memo of it. A leftover row is
 * therefore inert, and cannot put a finished run back on a cadence.
 *
 * cross-ref: packages/workflows/src/extension/workflow-heartbeat-scheduler.ts
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name, args-hash, AND checkpoint id for cadence anchors. */
export const WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME = "workflow-heartbeat-anchor";

/**
 * What a run launched with: its original start time, and the cadence its own
 * definition declared.
 *
 * `intervalMinutes` is absent on records written before it was added, so a
 * reader must treat that as "unknown" and fall back to the live definition —
 * never as `0`.
 */
export interface WorkflowHeartbeatAnchorRecord {
	readonly anchorAt: number;
	readonly intervalMinutes?: number;
}

/**
 * The stored checkpoint payload, before validation.
 *
 * `getToolOutput` returns whatever a previous process wrote, so the fields are
 * declared optional and validated below rather than trusted. Naming the shape
 * keeps the decode free of inline casts while leaving the trust boundary
 * explicit.
 */
interface PersistedAnchorOutput {
	readonly anchorAt?: number;
	readonly intervalMinutes?: number;
}

function asPersistedAnchorOutput(output: unknown): PersistedAnchorOutput | undefined {
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const { anchorAt, intervalMinutes } = output as Partial<Record<keyof PersistedAnchorOutput, unknown>>;
	return {
		...(typeof anchorAt === "number" ? { anchorAt } : {}),
		...(typeof intervalMinutes === "number" ? { intervalMinutes } : {}),
	};
}

/** The persisted launch anchor for a run, or undefined when absent or malformed. */
export function readWorkflowHeartbeatAnchor(
	backend: DurableWorkflowBackend,
	workflowId: string,
): WorkflowHeartbeatAnchorRecord | undefined {
	const record = asPersistedAnchorOutput(backend.getToolOutput(workflowId, WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME));
	if (record === undefined) return undefined;
	const { anchorAt, intervalMinutes } = record;
	if (anchorAt === undefined || !Number.isFinite(anchorAt)) return undefined;
	// Only a positive finite cadence is carried: a disabled run never writes a
	// record at all, so a non-positive value here is corrupt rather than meaningful.
	return intervalMinutes !== undefined && Number.isFinite(intervalMinutes) && intervalMinutes > 0
		? { anchorAt, intervalMinutes }
		: { anchorAt };
}

/**
 * Persist what a run launched with, once.
 *
 * Uses `recordAdditiveCheckpointBestEffort` rather than the synchronous
 * `recordCheckpoint`, because the DBOS backend updates its in-memory mirror
 * *before* the real write is queued: a synchronous read-back therefore proves
 * only that the mirror holds the row, and would let a rejected storage write be
 * remembered as a success that is never retried. The best-effort path awaits
 * `recordStepOutput` and updates the mirror only after it resolves, and turns a
 * storage rejection into `false` instead of a fatal flush error.
 *
 * Returns `true` only when the record is durably written *and* readable — the
 * backend silently drops a checkpoint for a workflow it has never registered,
 * so the read-back stays as well.
 */
export async function recordWorkflowHeartbeatAnchor(
	backend: DurableWorkflowBackend,
	record: {
		readonly runId: string;
		readonly anchorAt: number;
		readonly intervalMinutes: number;
		readonly now: number;
	},
): Promise<boolean> {
	if (!Number.isFinite(record.anchorAt)) return false;
	// A run launched with heartbeats disabled writes no record at all, so this
	// path is never reached for a non-positive cadence. Guarding it here keeps
	// that invariant local to the writer as well as to its caller.
	if (!Number.isFinite(record.intervalMinutes) || record.intervalMinutes <= 0) return false;
	const existing = readWorkflowHeartbeatAnchor(backend, record.runId);
	// Write-once: the first record stands. A later write cannot move the anchor
	// forward, and it cannot retro-fit an edited cadence onto a run in flight.
	if (existing !== undefined) return true;
	// A record for a run with no durable progress of its own would make that run
	// look resumable; the anchor is worth nothing on a run that cannot resume.
	if (backend.listCheckpoints(record.runId).length === 0) return false;
	const checkpoint: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: record.runId,
		checkpointId: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		name: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		argsHash: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		output: { anchorAt: record.anchorAt, intervalMinutes: record.intervalMinutes },
		// Write time, never the boundary: this lands on the handle as `updatedAt`,
		// which the foreign-liveness window reads.
		completedAt: record.now,
	};
	const stored = await backend.recordAdditiveCheckpointBestEffort(checkpoint);
	if (!stored) return false;
	return readWorkflowHeartbeatAnchor(backend, record.runId) !== undefined;
}
