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
 * `options` with the fork point of a stage that forks a session without naming an entry: the entry its source was at
 * when the stage was launched, so every stage launched from that point gets the same copy, and a stage that starts
 * later, because it waited for a slot, was retried, or resumed after a restart, never sees a later turn of its source
 * (#5481). The point is read from the run's record when an earlier launch of the stage recorded one, and otherwise from
 * the source's session when it is open in this process, and then recorded. Unchanged for a stage that resumes its own
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
	const entryId = liveStageSessionLeaf(sessionId);
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
