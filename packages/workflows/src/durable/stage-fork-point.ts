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

interface ForkSourceRecord {
	readonly sessionId: string;
	readonly entryId: string;
}

interface ForkableStageOptions {
	readonly context?: "fresh" | "fork";
	readonly forkFromSessionId?: string;
	readonly forkFromEntryId?: string;
}

/**
 * Set by a fan-out on the options of each of its steps: the entry the step's source was at when the fan-out was
 * launched. A step that waits for a slot of the fan-out starts after its source may have moved on, so it forks at this
 * entry rather than where its source is when the step starts (#5481).
 */
const LAUNCH_FORK_ENTRY = Symbol("launchForkEntry");

type WithLaunchForkEntry = { readonly [LAUNCH_FORK_ENTRY]?: string };

/**
 * The session a step with `options` forks without naming an entry: the source whose entry at launch is its fork point.
 * Undefined for a step that does not fork, or names its entry.
 */
export function launchForkSourceOf(options: ForkableStageOptions | undefined): string | undefined {
	if (options?.context !== "fork" || options.forkFromEntryId !== undefined) return undefined;
	return options.forkFromSessionId;
}

/**
 * The suffix of the run-level record of where the sources of a fan-out's forked steps were when the fan-out was
 * launched, under the fan-out's own replay key. It names no graph node of its own.
 */
export const FAN_OUT_FORK_SOURCES_SUFFIX = ":fork-source-entries";

/**
 * The entry each of `sessionIds` was at when a fan-out named `launchName` was launched, by session id. A source that is
 * not open in this process has no entry; a step forking it copies it as stored when it starts.
 */
export type FanOutForkPoints = (
	launchName: string,
	sessionIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/**
 * The fork points of the fan-outs of a run, recorded in the run before any step of a fan-out is scheduled (#5481). A
 * step that waits for a slot, and every step of the fan-out after the run resumes, is retried or is forked into another
 * run, forks where the first launch found its source, even when a step that ran earlier stopped the run. The record is
 * keyed by the fan-out's replay key, which the run's replay keys give it in launch order, so a replayed fan-out reads
 * the record of its first launch.
 */
export function createFanOutForkPoints(input: {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	readonly nextReplayKey: (name: string) => string;
}): FanOutForkPoints {
	return async (launchName, sessionIds) => {
		const key = `${input.nextReplayKey(launchName)}${FAN_OUT_FORK_SOURCES_SUFFIX}`;
		const recorded = input.backend.getToolCheckpoint(input.workflowId, key)?.output as {
			readonly entries?: readonly Partial<ForkSourceRecord>[];
		} | null;
		if (Array.isArray(recorded?.entries))
			return new Map(
				recorded.entries.flatMap((entry) =>
					typeof entry.sessionId === "string" && typeof entry.entryId === "string"
						? [[entry.sessionId, entry.entryId] as const]
						: [],
				),
			);
		const entries = [...new Set(sessionIds)].flatMap((sessionId): ForkSourceRecord[] => {
			const entryId = liveStageSessionLeaf(sessionId);
			return entryId === undefined ? [] : [{ sessionId, entryId }];
		});
		// Recorded before the fan-out schedules a step. A journal that cannot take it fails the steps' own records too.
		await input.backend
			.commitAdditiveCheckpointBestEffort({
				kind: "tool",
				workflowId: input.workflowId,
				checkpointId: key,
				name: key,
				argsHash: key,
				output: { entries } as unknown as WorkflowSerializableValue,
				completedAt: Date.now(),
			})
			.catch(() => false);
		return new Map(entries.map((entry) => [entry.sessionId, entry.entryId]));
	};
}

/** `options` of a step of a fan-out, holding the entry its source was at when the fan-out was launched. */
export function withLaunchForkEntry<TOptions extends object>(options: TOptions, entryId: string | undefined): TOptions {
	return entryId === undefined ? options : { ...options, [LAUNCH_FORK_ENTRY]: entryId };
}

/**
 * `options` with the fork point of a stage that forks a session without naming an entry: the entry its source was at
 * when the stage was launched, so every stage launched from that point gets the same copy, and a stage that starts
 * later, because it waited for a slot, was retried, or resumed after a restart, never sees a later turn of its source
 * (#5481). The point is read from the run's record when an earlier launch of the stage recorded one, and otherwise from
 * the entry its fan-out read at launch ({@link withLaunchForkEntry}) or the source's session when it is open in this
 * process, and then recorded. Unchanged for a stage that resumes its own
 * session, names its entry, or forks a session that is not open here, whose stored conversation it copies at start.
 */
export function withLaunchForkPoint<TOptions extends ForkableStageOptions>(input: {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	readonly replayKey: string;
	readonly options: TOptions | undefined;
	readonly resuming: boolean;
}): TOptions | undefined {
	const { options } = input;
	const sessionId = options?.forkFromSessionId;
	if (
		input.resuming ||
		options?.context !== "fork" ||
		sessionId === undefined ||
		options.forkFromEntryId !== undefined
	)
		return options;
	const key = forkSourceCheckpointKey(input.replayKey);
	const recorded = input.backend.getToolCheckpoint(input.workflowId, key)?.output as Partial<ForkSourceRecord> | null;
	if (recorded?.sessionId === sessionId && typeof recorded.entryId === "string")
		return { ...options, forkFromEntryId: recorded.entryId };
	const entryId = (options as WithLaunchForkEntry)[LAUNCH_FORK_ENTRY] ?? liveStageSessionLeaf(sessionId);
	if (entryId === undefined) return options;
	const record: ForkSourceRecord = { sessionId, entryId };
	void input.backend
		.commitAdditiveCheckpointBestEffort({
			kind: "tool",
			workflowId: input.workflowId,
			checkpointId: key,
			name: key,
			argsHash: key,
			output: record as unknown as WorkflowSerializableValue,
			completedAt: Date.now(),
		})
		.catch(() => false);
	return { ...options, forkFromEntryId: entryId };
}
