import type { PooledStageSessionCommand } from "./stage-watch-types.js";

/** Whether a stage chat's session command only stops work already running: it goes through even while the pool is paused. */
export function isCancellation(command: PooledStageSessionCommand): boolean {
	return (
		command.kind === "abort-bash" ||
		command.kind === "abort-compaction" ||
		(command.kind === "task" && command.action.kind === "cancel")
	);
}
