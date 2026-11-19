import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint } from "./types.js";

/**
 * The run-level record of a run whose chains and parallels take their steps' replay keys when each is called (#5481).
 * A run whose record has results but not this one, such as a run an earlier release started, took its steps' keys
 * when they started and keeps doing so when it resumes, so each finds its result under the key it was recorded with.
 * It names no graph node of its own.
 */
export const LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME = "launch-replay-keys";

/** Whether `argsHash` is a launch replay key record, of the run or of a child run under its scope prefix. */
export function isLaunchReplayKeysCheckpointHash(argsHash: string): boolean {
	return (
		argsHash === LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME || argsHash.endsWith(`:${LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME}`)
	);
}

/**
 * How a chain or parallel of run `workflowId` takes its steps' replay keys when it is called: from `nextReplayKey`, in a
 * run that has the launch record or no records at all; undefined in a run whose record has results but not the
 * launch record, whose steps take theirs when they start. A run without the record writes it as its first launch takes a key: `recorded`
 * gets the write, which the run lets no task start before, and which fails the run when it fails.
 */
export function launchReplayKeys(input: {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	/** The run's records when it started. */
	readonly priorCheckpoints: readonly DurableCheckpoint[];
	readonly nextReplayKey: (name: string) => string;
	readonly recorded: (write: Promise<void>) => void;
}): ((name: string) => string) | undefined {
	let marked = input.priorCheckpoints.some(
		(checkpoint) => checkpoint.kind === "tool" && checkpoint.argsHash === LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME,
	);
	if (!marked && input.priorCheckpoints.length > 0) return undefined;
	return (name) => {
		if (!marked) {
			marked = true;
			input.recorded(
				input.backend.commitCheckpoint({
					kind: "tool",
					workflowId: input.workflowId,
					checkpointId: LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME,
					name: LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME,
					argsHash: LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME,
					output: true,
					completedAt: Date.now(),
				}),
			);
		}
		return input.nextReplayKey(name);
	};
}
