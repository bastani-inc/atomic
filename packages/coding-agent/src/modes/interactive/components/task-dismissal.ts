import type { TaskId } from "../../../core/tasks/contracts.js";

const dismissedBySource = new WeakMap<object, Set<TaskId>>();
const listenersBySource = new WeakMap<object, Set<(taskId: TaskId) => void>>();

export function dismissedTasks(source: object): Set<TaskId> {
	let dismissed = dismissedBySource.get(source);
	if (dismissed === undefined) {
		const backing = new Set<TaskId>();
		const add = backing.add.bind(backing);
		backing.add = (taskId: TaskId) => {
			const had = backing.has(taskId);
			add(taskId);
			if (!had) {
				for (const listener of [...(listenersBySource.get(source) ?? [])]) listener(taskId);
			}
			return backing;
		};
		dismissed = backing;
		dismissedBySource.set(source, dismissed);
	}
	return dismissed;
}

/** Observe tasks dismissed from `source` (through `/tasks` or the agent panel). Answers the unsubscribe. */
export function onTaskDismissed(source: object, listener: (taskId: TaskId) => void): () => void {
	let listeners = listenersBySource.get(source);
	if (listeners === undefined) {
		listeners = new Set();
		listenersBySource.set(source, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
