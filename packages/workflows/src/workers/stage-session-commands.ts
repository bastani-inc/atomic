import type { PooledStageSessionCommand } from "./stage-watch-types.js";

/**
 * Whether a stage chat's session command goes through while the pool is paused: one that stops work
 * already running, or only reads a background task's state. New work stays refused until it resumes.
 */
export function runsWhilePaused(command: PooledStageSessionCommand): boolean {
	if (command.kind === "abort-bash" || command.kind === "abort-compaction") return true;
	if (command.kind !== "task") return false;
	const action = command.action.kind;
	return (
		action === "cancel" ||
		action === "output" ||
		action === "detail" ||
		action === "transcript" ||
		action === "commands"
	);
}
