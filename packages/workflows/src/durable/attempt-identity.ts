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

import type { DurableWorkflowBackend } from "./backend.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableUiCheckpoint,
	DurableWorkflowBoundaryTopology,
} from "./types.js";

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
	const response = checkpoint.response;
	if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
	const { workflowId, attempt } = response as { readonly workflowId?: unknown; readonly attempt?: unknown };
	if (
		workflowId !== checkpoint.workflowId ||
		typeof attempt !== "number" ||
		!Number.isSafeInteger(attempt) ||
		attempt < 1 ||
		checkpoint.promptHash !== `${WORKFLOW_ATTEMPT_CHECKPOINT_PREFIX}${attempt}`
	)
		return undefined;
	return attempt;
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

/** Whether the run is in an attempt and an earlier one recorded the tool call `argsHash`. */
export function recordedInEarlierAttempt(
	backend: DurableWorkflowBackend,
	workflowId: string,
	argsHash: string,
): boolean {
	const attempt = durableWorkflowAttempt(backend, workflowId);
	return (
		attempt !== undefined &&
		backend
			.listCheckpoints(workflowId)
			.some(
				(checkpoint) =>
					checkpoint.kind === "tool" &&
					checkpoint.argsHash === argsHash &&
					checkpointAttempt(checkpoint) < attempt,
			)
	);
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

/** Whether a stage record executes its boundary in its attempt: a boundary start, or a boundary attempt record. */
function startsBoundaryAttempt(checkpoint: DurableStageCheckpoint, boundaryKeys: ReadonlySet<string>): boolean {
	const boundary = checkpoint.topology?.boundary;
	if (boundary !== undefined) return boundary.event === "start";
	return (
		boundaryKeys.has(checkpoint.replayKey) &&
		checkpoint.output === undefined &&
		checkpoint.topology?.status === "running" &&
		checkpoint.checkpointId.includes(BOUNDARY_ATTEMPT_CHECKPOINT_PREFIX)
	);
}

type BoundaryRecord = DurableStageCheckpoint & {
	readonly topology: NonNullable<DurableStageCheckpoint["topology"]> & {
		readonly boundary: DurableWorkflowBoundaryTopology;
	};
};

/** The run a stage or tool record belongs to. */
function ownerRunId(checkpoint: DurableStageCheckpoint | DurableToolCheckpoint, rootRunId: string): string {
	return checkpoint.topology?.run?.runId ?? rootRunId;
}

/**
 * The records of the attempt each run was last executed in (#4874): the root's latest attempt, and for a child the
 * latest attempt its boundary was started in, so a cached child keeps the attempt it completed in, which is what
 * replay hydrates. A stage group or tool appears only with a record from its run's attempt; of a stage group the
 * records of that attempt are kept with the boundary lifecycle and the output records of earlier attempts that
 * replay reads, and of a tool only that attempt's records. Records of no graph node are kept.
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
	const boundaryKeys = new Set<string>();
	const childBoundaryKeys = new Map<string, string>();
	/** Each child run's parent run and the stage node of its boundary there. */
	const childBoundaries = new Map<string, { readonly parentRunId: string; readonly node: string }>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.kind !== "stage" || checkpoint.topology?.boundary === undefined) continue;
		const childRunId = (checkpoint as BoundaryRecord).topology.boundary.child.runId;
		boundaryKeys.add(checkpoint.replayKey);
		childBoundaryKeys.set(childRunId, checkpoint.replayKey);
		childBoundaries.set(childRunId, {
			parentRunId: ownerRunId(checkpoint, rootRunId),
			node: stageNodeKey(checkpoint),
		});
	}
	const boundaryAttempts = new Map<string, number>();
	const ownAttempts = new Map<string, number>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.kind === "ui") continue;
		const attempt = checkpointAttempt(checkpoint);
		if (checkpoint.kind === "stage" && startsBoundaryAttempt(checkpoint, boundaryKeys))
			boundaryAttempts.set(checkpoint.replayKey, Math.max(boundaryAttempts.get(checkpoint.replayKey) ?? 0, attempt));
		if (checkpoint.topology === undefined) continue;
		const owner = ownerRunId(checkpoint, rootRunId);
		ownAttempts.set(owner, Math.max(ownAttempts.get(owner) ?? 0, attempt));
	}
	const anchor = (runId: string): number | undefined => {
		if (runId === rootRunId) return options.rootReach ? latest : undefined;
		const boundaryKey = childBoundaryKeys.get(runId);
		return boundaryKey === undefined ? (ownAttempts.get(runId) ?? 0) : (boundaryAttempts.get(boundaryKey) ?? 0);
	};
	const reachedStageGroups = new Set<string>();
	const reachedTools = new Set<string>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.kind === "ui" || checkpoint.topology === undefined) continue;
		const attempt = anchor(ownerRunId(checkpoint, rootRunId));
		if (attempt !== undefined && checkpointAttempt(checkpoint) !== attempt) continue;
		if (checkpoint.kind === "stage") reachedStageGroups.add(stageNodeKey(checkpoint));
		else reachedTools.add(checkpoint.argsHash);
	}
	// A child run is shown only while its boundary is, in a run that is shown.
	const shownRuns = new Map<string, boolean>();
	const shown = (runId: string): boolean => {
		const known = shownRuns.get(runId);
		if (known !== undefined) return known;
		shownRuns.set(runId, false);
		const boundary = childBoundaries.get(runId);
		const result =
			runId === rootRunId ||
			boundary === undefined ||
			(reachedStageGroups.has(boundary.node) && shown(boundary.parentRunId));
		shownRuns.set(runId, result);
		return result;
	};
	return checkpoints.filter((checkpoint) => {
		if (checkpoint.kind === "ui" || checkpoint.topology === undefined) return true;
		const owner = ownerRunId(checkpoint, rootRunId);
		if (!shown(owner)) return false;
		const attempt = anchor(owner);
		if (attempt === undefined) return true;
		if (checkpoint.kind === "tool")
			return reachedTools.has(checkpoint.argsHash) && checkpointAttempt(checkpoint) === attempt;
		if (!reachedStageGroups.has(stageNodeKey(checkpoint))) return false;
		return (
			checkpointAttempt(checkpoint) === attempt ||
			checkpoint.output !== undefined ||
			checkpoint.topology.boundary !== undefined
		);
	});
}

/** A stage record's node: its replay key, and its prompt occurrence when it has one. */
function stageNodeKey(checkpoint: DurableStageCheckpoint): string {
	return JSON.stringify([checkpoint.replayKey, checkpoint.topology?.occurrenceKey ?? null]);
}
