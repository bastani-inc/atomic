import type { TaskId } from "../../../core/tasks/contracts.js";

const dismissedBySource = new WeakMap<object, Set<TaskId>>();
export function dismissedTasks(source: object): Set<TaskId> {
	let dismissed = dismissedBySource.get(source);
	if (dismissed === undefined) {
		dismissed = new Set();
		dismissedBySource.set(source, dismissed);
	}
	return dismissed;
}
