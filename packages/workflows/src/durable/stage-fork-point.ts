import { storedForkPoint } from "../shared/stage-session-store.js";
import type { StageOptions, WorkflowSerializableValue } from "../shared/types.js";
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
 * was not found at launch: a live stage still opens the named session in its own store.
 */
export type ForkPoint = string | null;

export type ReadForkPoint = (options: StageOptions, sessionId: string) => Promise<ForkPoint | undefined>;

interface ForkSourceRecord {
	/** The source's position in this parallel, when recorded by a store-aware writer. */
	readonly slot?: number;
	readonly sessionId: string;
	readonly entryId: ForkPoint;
}

function isForkSourceRecord(value: unknown): value is ForkSourceRecord {
	if (typeof value !== "object" || value === null) return false;
	const { sessionId, entryId } = value as { readonly sessionId?: unknown; readonly entryId?: unknown };
	return typeof sessionId === "string" && (typeof entryId === "string" || entryId === null);
}

interface ForkableStageOptions {
	readonly context?: "fresh" | "fork";
	readonly forkFromSessionId?: string;
	readonly forkFromEntryId?: string;
	readonly forkFromEmptySource?: boolean;
	readonly durableForkPoint?: () => Promise<ForkPoint | undefined>;
}

/**
 * The session a step with `options` forks without a fork point of its own: the source whose state at launch is its
 * fork point. Undefined for a step that does not fork, names its entry, or already has its launch's fork point.
 */
export function launchForkSourceOf(
	options: ForkableStageOptions | undefined,
	defaults?: ForkableStageOptions,
): string | undefined {
	if (
		(options?.context ?? defaults?.context) !== "fork" ||
		(options?.forkFromEntryId ?? defaults?.forkFromEntryId) !== undefined ||
		(options?.forkFromEmptySource ?? defaults?.forkFromEmptySource) === true
	)
		return undefined;
	return options?.forkFromSessionId ?? defaults?.forkFromSessionId;
}

/** `options` forking its source at `point`; unchanged for a source that was not open at launch. */
export function withForkPoint<TOptions extends ForkableStageOptions>(
	options: TOptions,
	point: ForkPoint | undefined,
): TOptions {
	if (point === undefined) return options;
	return point === null ? { ...options, forkFromEmptySource: true } : { ...options, forkFromEntryId: point };
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
	readonly readForkPoint?: ReadForkPoint;
}

export interface LaunchForkSource {
	readonly slot: number;
	readonly sessionId: string;
	readonly options: StageOptions;
}

/** A separate record for the same ID in two stores; older fan-out records had one point per session ID. */
function sourcePoints(
	sources: readonly LaunchForkSource[],
	entries: readonly ForkSourceRecord[],
): ReadonlyMap<number, ForkPoint> {
	const bySlot = new Map(entries.filter((e) => e.slot !== undefined).map((e) => [e.slot, e]));
	const legacy = new Map(entries.filter((e) => e.slot === undefined).map((e) => [e.sessionId, e]));
	const result = new Map<number, ForkPoint>();
	for (const source of sources) {
		const entry = bySlot.get(source.slot) ?? legacy.get(source.sessionId);
		if (entry?.sessionId === source.sessionId) result.set(source.slot, entry.entryId);
	}
	return result;
}

function fanOutEntries(output: unknown): readonly ForkSourceRecord[] | undefined {
	const entries = (output as { readonly entries?: unknown } | null | undefined)?.entries;
	return Array.isArray(entries) ? entries.filter(isForkSourceRecord) : undefined;
}

/**
 * The committed entry of each selected store and session, or null for an empty source (#5481).
 *
 * The caller takes the key from the run's separate fan-out counter at launch, so a
 * replayed fan-out reads the record of its first launch. The returned points are those of the record: an earlier
 * launch's when it has one, or the sources' points now, written to the run before the promise settles. It rejects
 * when the journal cannot take the record; no live step of the fan-out may start then.
 */
export async function recordFanOutForkPoints(
	run: DurableLaunchRun | undefined,
	launchKey: string,
	sources: readonly LaunchForkSource[],
): Promise<ReadonlyMap<number, ForkPoint>> {
	const key = `${launchKey}${FAN_OUT_FORK_SOURCES_SUFFIX}`;
	const recorded = () => run && fanOutEntries(run.backend.getToolCheckpoint(run.workflowId, key)?.output);
	const prior = recorded();
	if (prior !== undefined) return sourcePoints(sources, prior);
	const read = run?.readForkPoint ?? storedForkPoint;
	const entries = (
		await Promise.all(
			sources.map(async ({ sessionId, slot, options }) => {
				const entryId = await read(options, sessionId);
				return entryId === undefined ? [] : [{ slot, sessionId, entryId }];
			}),
		)
	).flat();
	if (run !== undefined) {
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
	}
	return sourcePoints(sources, recorded() ?? entries);
}

/**
 * `output` of the fork source record `argsHash` with each source session id passed through `session`, for a
 * `workflow fork` that copies the run's stage sessions under new ids; the copies keep the entries' ids (#5481).
 * Undefined for any other record.
 */
export function forkSourceRecordWithSessions(
	argsHash: string,
	output: WorkflowSerializableValue,
	session: (sessionId: string) => string,
): WorkflowSerializableValue | undefined {
	const copied = (record: ForkSourceRecord): ForkSourceRecord => ({ ...record, sessionId: session(record.sessionId) });
	const recorded: unknown = output;
	if (argsHash.endsWith(FORK_SOURCE_CHECKPOINT_SUFFIX))
		return isForkSourceRecord(recorded) ? (copied(recorded) as unknown as WorkflowSerializableValue) : undefined;
	if (!argsHash.endsWith(FAN_OUT_FORK_SOURCES_SUFFIX)) return undefined;
	const entries = fanOutEntries(recorded);
	return entries === undefined
		? undefined
		: ({ entries: entries.map(copied) } as unknown as WorkflowSerializableValue);
}

/**
 * `options` with the fork point of a stage that forks a session without naming an entry: the entry its source was at
 * when the stage was launched, or its empty start, so every stage launched from that point gets the same copy, and a
 * stage that starts later, because it was retried, resumed after a restart or run again by `workflow fork`, never sees
 * a later turn of its source (#5481). The point is read from the run's record when an earlier launch of the stage
 * recorded one, and otherwise from the selected store by session ID, and then recorded: the stage
 * opens its session only once the record is durable, at the point the run kept, and fails before it when the record
 * cannot be written. Unchanged for a stage that resumes its own session, has its fork point already (it names its
 * entry, or its parallel set its launch's point).
 */
export function withLaunchForkPoint<TOptions extends StageOptions>(input: {
	readonly readForkPoint?: ReadForkPoint;
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
	if (recorded !== undefined) return withForkPoint(options, recorded.entryId);
	const durable = (input.readForkPoint ?? storedForkPoint)(options, sessionId).then(async (entryId) => {
		if (entryId === undefined) return undefined;
		const record: ForkSourceRecord = { sessionId, entryId };
		await input.backend.commitCheckpoint({
			kind: "tool",
			workflowId: input.workflowId,
			checkpointId: key,
			name: key,
			argsHash: key,
			output: record as unknown as WorkflowSerializableValue,
			completedAt: Date.now(),
		});
		const kept = recordedPoint();
		return kept === undefined ? entryId : kept.entryId;
	});
	// Observed when the stage opens its session; a stage that never opens one has nothing to fail.
	durable.catch(() => {});
	return { ...options, durableForkPoint: () => durable };
}
