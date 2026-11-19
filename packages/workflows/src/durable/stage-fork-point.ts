import { liveStageSessionLeaf } from "../shared/live-stage-sessions.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";

/**
 * The suffix of the run-level record of where a forked stage's source was when the stage was launched, under the
 * stage's replay key. It names no graph node of its own.
 */
export const FORK_SOURCE_CHECKPOINT_SUFFIX = ":fork-source-entry";

/** The key of the fork source record of the stage at `replayKey`. */
export function forkSourceCheckpointKey(replayKey: string): string {
	return `${replayKey}${FORK_SOURCE_CHECKPOINT_SUFFIX}`;
}

/**
 * Where a forked stage's source was when the stage was launched: the entry the source continued from, or `null` when
 * it had no entries yet, so the stage copies none of it. Where a fork point is looked up, undefined means the source
 * was not open in this process at launch: the stage copies the source as it is stored when the stage starts.
 */
export type ForkPoint = string | null;

export interface ForkSourceRecord {
	readonly sessionId: string;
	readonly entryId: ForkPoint;
	/** The immutable copy of this particular launch window in an explicit workflow fork. */
	readonly windowSessionId?: string;
}

function isForkSourceRecord(value: unknown): value is ForkSourceRecord {
	if (typeof value !== "object" || value === null) return false;
	const { sessionId, entryId, windowSessionId } = value as Partial<ForkSourceRecord>;
	return (
		typeof sessionId === "string" &&
		(typeof entryId === "string" || entryId === null) &&
		(windowSessionId === undefined || typeof windowSessionId === "string")
	);
}

interface ForkableStageOptions {
	readonly context?: "fresh" | "fork";
	readonly forkFromSessionId?: string;
	readonly forkFromEntryId?: string;
	readonly forkFromEmptySource?: boolean;
	readonly durableForkPoint?: () => Promise<ForkPoint>;
}

/**
 * The session a step with `options` forks without a fork point of its own: the source whose state at launch is its
 * fork point. Undefined for a step that does not fork, names its entry, or already has its launch's fork point.
 */
export function launchForkSourceOf(options: ForkableStageOptions | undefined): string | undefined {
	if (options?.context !== "fork" || options.forkFromEntryId !== undefined || options.forkFromEmptySource === true)
		return undefined;
	return options.forkFromSessionId;
}

/** `options` forking its source at `point`; unchanged for a source that was not open at launch. */
export function withForkPoint<TOptions extends ForkableStageOptions>(
	options: TOptions,
	point: ForkPoint | ForkSourceRecord | undefined,
): TOptions {
	if (point === undefined) return options;
	const entryId = typeof point === "object" && point !== null ? point.entryId : point;
	const fork =
		typeof point === "object" && point?.windowSessionId !== undefined
			? { ...options, forkFromSessionId: point.windowSessionId }
			: options;
	return entryId === null ? { ...fork, forkFromEmptySource: true } : { ...fork, forkFromEntryId: entryId };
}

/**
 * The suffix of the run-level record of where the sources of a fan-out's forked steps were when the fan-out was
 * launched, under the fan-out's own replay key. It names no graph node of its own.
 */
export const FAN_OUT_FORK_SOURCES_SUFFIX = ":fork-source-entries";

/** The journal of a run, and the run's replay keys, which name its launches in launch order. */
export interface DurableLaunchRun {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	readonly nextReplayKey: (name: string) => string;
}

/** The fork points a fan-out's record holds, by source session id; undefined when there is no such record. */
function fanOutRecord(run: DurableLaunchRun, key: string): ReadonlyMap<string, ForkSourceRecord> | undefined {
	const entries = fanOutEntries(run.backend.getToolCheckpoint(run.workflowId, key)?.output);
	return entries === undefined ? undefined : new Map(entries.map((entry) => [entry.sessionId, entry]));
}

function fanOutEntries(output: unknown): readonly ForkSourceRecord[] | undefined {
	const entries = (output as { readonly entries?: unknown } | null | undefined)?.entries;
	return Array.isArray(entries) ? entries.filter(isForkSourceRecord) : undefined;
}

/**
 * Where each of `sessionIds` was when a fan-out named `launchName` was launched, by session id: its entry then, or
 * `null` when it had no entries. A source that is not open in this process has no point; a step forking it copies it
 * as stored when it starts (#5481).
 *
 * The fan-out's record key is taken from the run's replay keys when this is called, at the fan-out's launch, so a
 * replayed fan-out reads the record of its first launch. The returned points are those of the record: an earlier
 * launch's when it has one, or the sources' points now, written to the run before the promise settles. It rejects
 * when the journal cannot take the record; no step of the fan-out may start then, so no two of them can start from
 * different points.
 */
export function recordFanOutForkPoints(
	run: DurableLaunchRun,
	launchName: string,
	sessionIds: readonly string[],
): Promise<ReadonlyMap<string, ForkSourceRecord>> {
	const key = `${run.nextReplayKey(launchName)}${FAN_OUT_FORK_SOURCES_SUFFIX}`;
	const recorded = fanOutRecord(run, key);
	if (recorded !== undefined) return Promise.resolve(recorded);
	const entries = [...new Set(sessionIds)].flatMap((sessionId): ForkSourceRecord[] => {
		const entryId = liveStageSessionLeaf(sessionId);
		return entryId === undefined ? [] : [{ sessionId, entryId }];
	});
	return (async () => {
		await run.backend.commitCheckpoint({
			kind: "tool",
			workflowId: run.workflowId,
			checkpointId: key,
			name: key,
			argsHash: key,
			output: { entries } as unknown as WorkflowSerializableValue,
			completedAt: Date.now(),
		});
		// The journal keeps the first record written under a key: a record of this launch that an earlier attempt wrote,
		// though that attempt failed before it learned so, is the launch's point.
		return fanOutRecord(run, key) ?? new Map(entries.map((entry) => [entry.sessionId, entry]));
	})();
}

/**
 * `output` of the fork source record `argsHash` with each source session id passed through `session`, for a
 * `workflow fork` that copies the run's stage sessions under new ids; the copies keep the entries' ids (#5481).
 * Undefined for any other record.
 */
export function forkSourceRecordWithSessions(
	argsHash: string,
	output: WorkflowSerializableValue,
	copy: (record: ForkSourceRecord) => ForkSourceRecord,
): WorkflowSerializableValue | undefined {
	const recorded: unknown = output;
	if (argsHash.endsWith(FORK_SOURCE_CHECKPOINT_SUFFIX))
		return isForkSourceRecord(recorded) ? (copy(recorded) as unknown as WorkflowSerializableValue) : undefined;
	if (!argsHash.endsWith(FAN_OUT_FORK_SOURCES_SUFFIX)) return undefined;
	const entries = fanOutEntries(recorded);
	return entries === undefined ? undefined : ({ entries: entries.map(copy) } as unknown as WorkflowSerializableValue);
}

/**
 * `options` with the fork point of a stage that forks a session without naming an entry: the entry its source was at
 * when the stage was launched, or its empty start, so every stage launched from that point gets the same copy, and a
 * stage that starts later, because it was retried, resumed after a restart or run again by `workflow fork`, never sees
 * a later turn of its source (#5481). The point is read from the run's record when an earlier launch of the stage
 * recorded one, and otherwise from the source's session when it is open in this process, and then recorded: the stage
 * opens its session only once the record is durable, at the point the run kept, and fails before it when the record
 * cannot be written. Unchanged for a stage that resumes its own session, has its fork point already (it names its
 * entry, or its parallel set its launch's point), or forks a session that is not open here, whose stored conversation
 * it copies at start.
 */
export function withLaunchForkPoint<TOptions extends ForkableStageOptions>(input: {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	readonly replayKey: string;
	readonly options: TOptions | undefined;
	readonly resuming: boolean;
}): TOptions | undefined {
	const { options } = input;
	const sessionId = launchForkSourceOf(options);
	if (input.resuming || options === undefined || sessionId === undefined) return options;
	const key = forkSourceCheckpointKey(input.replayKey);
	const recordedPoint = (): ForkSourceRecord | undefined => {
		const recorded = input.backend.getToolCheckpoint(input.workflowId, key)?.output;
		return isForkSourceRecord(recorded) && recorded.sessionId === sessionId ? recorded : undefined;
	};
	const recorded = recordedPoint();
	if (recorded !== undefined) return withForkPoint(options, recorded);
	const entryId = liveStageSessionLeaf(sessionId);
	if (entryId === undefined) return options;
	const record: ForkSourceRecord = { sessionId, entryId };
	const durable = input.backend
		.commitCheckpoint({
			kind: "tool",
			workflowId: input.workflowId,
			checkpointId: key,
			name: key,
			argsHash: key,
			output: record as unknown as WorkflowSerializableValue,
			completedAt: Date.now(),
		})
		// The journal keeps the first record written under a key: a record of this launch that an earlier attempt wrote,
		// though that attempt failed before it learned so, is the launch's point.
		.then(() => recordedPoint()?.entryId ?? entryId);
	// Observed when the stage opens its session; a stage that never opens one has nothing to fail.
	durable.catch(() => {});
	return { ...withForkPoint(options, entryId), durableForkPoint: () => durable };
}
