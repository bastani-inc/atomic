import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint } from "./types.js";

/**
 * The run-level record of a run whose chains and parallels take their steps' replay keys when each is called (#5481).
 * An older run that has saved work but neither this checkpoint nor launch keys in its registration keeps taking
 * keys when steps start, so each step finds its recorded result. The checkpoint names no graph node.
 */
export const LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME = "launch-replay-keys";

/** Whether `argsHash` is a launch replay key record, of the run or of a child run under its scope prefix. */
export function isLaunchReplayKeysCheckpointHash(argsHash: string): boolean {
	return (
		argsHash === LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME || argsHash.endsWith(`:${LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME}`)
	);
}

/**
 * A scope's own launch checkpoint takes precedence. Otherwise use the registered order, or, for older registrations,
 * launch order only when the journal has no previous checkpoints. The first launch in launch order still
 * writes the checkpoint if absent; `recorded` holds tasks until the write succeeds and fails the run on refusal.
 */
export function launchReplayKeys(input: {
	readonly backend: DurableWorkflowBackend;
	readonly workflowId: string;
	readonly registeredOrder: "launch" | "admission" | undefined;
	/** The run's records when it started. */
	readonly priorCheckpoints: readonly DurableCheckpoint[];
	readonly nextReplayKey: (name: string) => string;
	readonly recorded: (write: Promise<void>) => void;
}): ((name: string) => string) | undefined {
	let marked = input.priorCheckpoints.some(
		(checkpoint) => checkpoint.kind === "tool" && checkpoint.argsHash === LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME,
	);
	if (
		!marked &&
		(input.registeredOrder === "admission" ||
			(input.registeredOrder === undefined && input.priorCheckpoints.length > 0))
	)
		return undefined;
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
