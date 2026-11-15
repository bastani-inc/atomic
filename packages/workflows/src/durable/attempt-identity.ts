/**
 * Durable attempt identity (#4874).
 *
 * A run resumed under its own id is a new attempt of the same run, and the durable view must show what the latest
 * attempt reached, as the live run does. Three records carry that:
 *
 * - **The attempt record.** When a durable root attempt begins on a run that already has checkpoints, it writes one
 *   `workflow-attempt:<n>` record, `n` one past the highest attempt recorded. A run that is never resumed writes
 *   none, so its journal is what it has always been. The record is a `ui`-kind checkpoint under a prompt hash no prompt
 *   produces: every release reads `ui` checkpoints as non-graph state, while an unknown checkpoint kind would be indexed
 *   as a stage without a replay key. It is honoured only when the run id it names is the run's own, so a fork made by
 *   a release that copies it unchanged reads as a history without attempts.
 * - **The attempt stamp.** Once a run has an attempt record, every new stage and tool checkpoint committed for it
 *   carries `attempt`, stamped where checkpoints leave the process (`stampCheckpointAttempt`).
 * - **A record per reach.** Each id family that a later attempt would otherwise write again under the same key, and
 *   so not write at all, includes the attempt in its id while the run has one (`attemptScopedHash`), and a child
 *   boundary started again writes `boundary-attempt:<key>:<n>` (`boundaryAttemptCheckpoint`).
 *
 * `attemptReachedCheckpoints` then selects, before reconstruction, the records of the attempt each run was last
 * executed in. A history with no attempt record is returned as it is.
 */

import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint, DurableStageCheckpoint, DurableToolCheckpoint, DurableUiCheckpoint } from "./types.js";

/** Prompt hash and checkpoint id prefix of an attempt record. */
export const WORKFLOW_ATTEMPT_CHECKPOINT_PREFIX = "workflow-attempt:";
/** Checkpoint id prefix of the record a child boundary writes when a later attempt starts it again. */
export const BOUNDARY_ATTEMPT_CHECKPOINT_PREFIX = "boundary-attempt:";

/** The attempt record of attempt `attempt` of `workflowId`. */
export function workflowAttemptCheckpoint(workflowId: string, attempt: number, now: number): DurableUiCheckpoint {
	const key = `${WORKFLOW_ATTEMPT_CHECKPOINT_PREFIX}${attempt}`;
	return {
		kind: "ui",
		workflowId,
		checkpointId: key,
		promptKind: "custom",
		message: key,
		promptHash: key,
		response: { workflowId, attempt },
		completedAt: now,
	};
}

/** The attempt an attempt record starts, or undefined for any other checkpoint and for a record naming another run. */
export function workflowAttemptOf(checkpoint: DurableCheckpoint): number | undefined {
	if (checkpoint.kind !== "ui" || !checkpoint.promptHash.startsWith(WORKFLOW_ATTEMPT_CHECKPOINT_PREFIX))
		return undefined;
	const attempt = Number(checkpoint.promptHash.slice(WORKFLOW_ATTEMPT_CHECKPOINT_PREFIX.length));
	const owner = (checkpoint.response as { readonly workflowId?: WorkflowSerializableValue } | null)?.workflowId;
	return Number.isSafeInteger(attempt) && attempt >= 1 && owner === checkpoint.workflowId ? attempt : undefined;
}

/** The highest attempt the checkpoints record, 0 for a history without attempt records. */
export function latestWorkflowAttempt(checkpoints: readonly DurableCheckpoint[]): number {
	let latest = 0;
	for (const checkpoint of checkpoints) latest = Math.max(latest, workflowAttemptOf(checkpoint) ?? 0);
	return latest;
}

/** The attempt a stage or tool checkpoint was recorded in; 0 when it carries none. */
export function checkpointAttempt(checkpoint: DurableCheckpoint): number {
	return checkpoint.kind === "ui" ? 0 : (checkpoint.attempt ?? 0);
}

/** The attempt the run that `workflowId` belongs to is in, or undefined while it has no attempt record. */
export function durableWorkflowAttempt(backend: DurableWorkflowBackend, workflowId: string): number | undefined {
	const attempt = backend.workflowAttempt?.(workflowId) ?? 0;
	return attempt > 0 ? attempt : undefined;
}

/** `fields`, with the run's attempt added while it has one, for a content-derived id that must differ per attempt. */
export function attemptScopedHash<T extends object>(
	backend: DurableWorkflowBackend,
	workflowId: string,
	fields: T,
): T | (T & { readonly attempt: number }) {
	const attempt = durableWorkflowAttempt(backend, workflowId);
	return attempt === undefined ? fields : { ...fields, attempt };
}

/**
 * `checkpoint` as it is committed while its run is in `attempt`. A stage or tool record is stamped with the attempt,
 * unless a record is already stored under its key: re-recording that one stays the no-op it was, so it keeps the stored
 * record's stamp, and a pool's identity check still finds the same checkpoint. Attempt records, `ui` responses and
 * reserved run-level records are not stamped.
 */
export function stampCheckpointAttempt<T extends DurableCheckpoint>(
	checkpoint: T,
	attempt: number,
	existing: DurableCheckpoint | undefined,
): T {
	if (attempt < 1 || checkpoint.kind === "ui" || (checkpoint.kind === "tool" && checkpoint.topology === undefined))
		return checkpoint;
	const stamp = existing === undefined ? attempt : checkpointAttempt(existing);
	const { attempt: _previous, ...unstamped } = checkpoint as DurableStageCheckpoint | DurableToolCheckpoint;
	return (stamp > 0 ? { ...unstamped, attempt: stamp } : unstamped) as T;
}

/**
 * The record a child boundary writes when a later attempt starts it again: its start and terminal records keep their
 * ids, which every release's lifecycle validator reads, so this record is what says the attempt reached the boundary.
 * It joins the boundary's stage group with the boundary's immutable identity, without `boundary` topology, as replay
 * metadata already does; status `running` marks it as a start, which replay metadata never is.
 */
export function boundaryAttemptCheckpoint(input: {
	readonly workflowId: string;
	readonly replayKey: string;
	readonly name: string;
	readonly topology: NonNullable<DurableStageCheckpoint["topology"]>;
	readonly attempt: number;
	readonly now: number;
}): DurableStageCheckpoint {
	const { boundary: _boundary, status: _status, ...identity } = input.topology;
	return {
		kind: "stage",
		workflowId: input.workflowId,
		checkpointId: `${BOUNDARY_ATTEMPT_CHECKPOINT_PREFIX}${input.replayKey}:${input.attempt}`,
		name: input.name,
		replayKey: input.replayKey,
		topology: { ...identity, status: "running" },
		completedAt: input.now,
	};
}

/**
 * Record that an attempt of root run `workflowId` begins, before it writes anything else. A run without checkpoints
 * records none: its first attempt is the attempt every unstamped record belongs to, and a record would make a run with
 * no progress look resumable. A backend that cannot stamp checkpoints records none either.
 */
export async function beginDurableWorkflowAttempt(backend: DurableWorkflowBackend, workflowId: string): Promise<void> {
	if (backend.workflowAttempt === undefined || (backend.getWorkflow(workflowId)?.completedCheckpoints ?? 0) === 0)
		return;
	const attempt = backend.workflowAttempt(workflowId) + 1;
	await backend.commitCheckpoint(workflowAttemptCheckpoint(workflowId, attempt, Date.now()));
}

/** Whether a stage record starts its boundary's child in its attempt: the boundary start, or a boundary attempt record. */
function startsBoundaryAttempt(checkpoint: DurableStageCheckpoint): boolean {
	return (
		checkpoint.topology?.boundary?.event === "start" ||
		checkpoint.checkpointId.includes(BOUNDARY_ATTEMPT_CHECKPOINT_PREFIX)
	);
}

/** The run a stage or tool record belongs to. */
function ownerRunId(checkpoint: DurableStageCheckpoint | DurableToolCheckpoint, rootRunId: string): string {
	return checkpoint.topology?.run?.runId ?? rootRunId;
}

/**
 * The records of the attempt each run was last executed in (#4874): the root's latest attempt, and for a child the
 * latest attempt its boundary was started in, so a cached child keeps the attempt it completed in, which is what
 * replay hydrates. A stage or tool appears only with a record from its run's attempt, and a child run only while its
 * boundary appears. Of a stage the records of that attempt are kept with its boundary lifecycle and the output records
 * of earlier attempts that replay reads; of a tool only that attempt's records. Records of no graph node are kept, and
 * so are those of a child run whose boundary is not in the list.
 *
 * With `rootReach` false the root's own records are all kept: a resumed attempt looks a cached child up before its
 * replay is recorded. A history without an attempt record is returned unchanged.
 */
export function attemptReachedCheckpoints(
	checkpoints: readonly DurableCheckpoint[],
	rootRunId: string,
	options: { readonly rootReach: boolean },
): readonly DurableCheckpoint[] {
	const latest = latestWorkflowAttempt(checkpoints);
	if (latest === 0) return checkpoints;
	const nodes = checkpoints.filter(isGraphRecord);
	/** Each child run's parent run, and the replay key and stage node of its boundary there. */
	const boundaries = new Map<
		string,
		{ readonly parentRunId: string; readonly replayKey: string; readonly node: string }
	>();
	const started = new Map<string, number>();
	for (const checkpoint of nodes) {
		if (checkpoint.kind !== "stage") continue;
		const child = checkpoint.topology?.boundary?.child.runId;
		if (child !== undefined)
			boundaries.set(child, {
				parentRunId: ownerRunId(checkpoint, rootRunId),
				replayKey: checkpoint.replayKey,
				node: stageNodeKey(checkpoint),
			});
		if (startsBoundaryAttempt(checkpoint))
			started.set(
				checkpoint.replayKey,
				Math.max(started.get(checkpoint.replayKey) ?? 0, checkpointAttempt(checkpoint)),
			);
	}
	const anchor = (runId: string): number | undefined => {
		if (runId === rootRunId) return options.rootReach ? latest : undefined;
		const boundary = boundaries.get(runId);
		return boundary === undefined ? undefined : (started.get(boundary.replayKey) ?? 0);
	};
	const nodeKey = (checkpoint: DurableStageCheckpoint | DurableToolCheckpoint) =>
		checkpoint.kind === "stage" ? stageNodeKey(checkpoint) : JSON.stringify(["tool", checkpoint.argsHash]);
	const reached = new Set<string>();
	for (const checkpoint of nodes) {
		const attempt = anchor(ownerRunId(checkpoint, rootRunId));
		if (attempt === undefined || checkpointAttempt(checkpoint) === attempt) reached.add(nodeKey(checkpoint));
	}
	const shownRuns = new Map<string, boolean>();
	const shown = (runId: string): boolean => {
		const known = shownRuns.get(runId);
		if (known !== undefined) return known;
		shownRuns.set(runId, false);
		const boundary = boundaries.get(runId);
		const result = boundary === undefined || (reached.has(boundary.node) && shown(boundary.parentRunId));
		shownRuns.set(runId, result);
		return result;
	};
	const kept = new Set<DurableCheckpoint>(
		nodes.filter((checkpoint) => {
			const owner = ownerRunId(checkpoint, rootRunId);
			const attempt = anchor(owner);
			if (!shown(owner) || !reached.has(nodeKey(checkpoint))) return false;
			if (attempt === undefined || checkpointAttempt(checkpoint) === attempt) return true;
			return (
				checkpoint.kind === "stage" &&
				(checkpoint.output !== undefined || checkpoint.topology?.boundary !== undefined)
			);
		}),
	);
	return checkpoints.filter((checkpoint) => !isGraphRecord(checkpoint) || kept.has(checkpoint));
}

/** A stage or tool record of a graph node; a reserved run-level record has no topology. */
function isGraphRecord(checkpoint: DurableCheckpoint): checkpoint is DurableStageCheckpoint | DurableToolCheckpoint {
	return checkpoint.kind !== "ui" && checkpoint.topology !== undefined;
}

/** A stage record's node: its replay key, and its prompt occurrence when it has one. */
function stageNodeKey(checkpoint: DurableStageCheckpoint): string {
	return JSON.stringify([checkpoint.replayKey, checkpoint.topology?.occurrenceKey ?? null]);
}
