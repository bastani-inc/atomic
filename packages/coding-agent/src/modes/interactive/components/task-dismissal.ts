import type { TaskId } from "../../../core/tasks/contracts.js";

const dismissedBySource = new WeakMap<object, Set<TaskId>>();
/**
 * Finished tasks the user dismissed with `x`, per task source, so each view of that source leaves them out. The task
 * and its result are untouched; only the lists stop showing it.
 */
export function dismissedTasks(source: object): Set<TaskId> {
	let dismissed = dismissedBySource.get(source);
	if (dismissed === undefined) {
		dismissed = new Set();
		dismissedBySource.set(source, dismissed);
	}
	return dismissed;
}
