import type { Component, Container, TUI } from "@bastani/atomic-tui";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore, watchOwnerTaskStoreBinding } from "../../core/tasks/owner-store.js";
import { TaskRow } from "./components/task-row.js";

type InteractiveTaskHost = {
	session: object;
	chatContainer: Container;
	toolOutputExpanded: boolean;
	taskRowsInChat?: boolean;
	ui: Pick<TUI, "requestRender">;
};

const bindings = new WeakMap<InteractiveTaskHost, { store: OwnerTaskStore; dispose: () => void; update: () => void }>();
const sessionBindings = new WeakMap<InteractiveTaskHost, { session: object; dispose: () => void }>();
/** The launch tool's pending component is not the lifetime of a task anchor. */
export function refreshInteractiveTasks(mode: InteractiveTaskHost): void {
	if (sessionBindings.get(mode)?.session !== mode.session) {
		sessionBindings.get(mode)?.dispose();
		sessionBindings.set(mode, {
			session: mode.session,
			dispose: watchOwnerTaskStoreBinding(mode.session, () => refreshInteractiveTasks(mode)),
		});
	}
	const store = getOwnerTaskStore(mode.session);
	const binding = bindings.get(mode);
	if (store && binding?.store === store) {
		binding.update();
		return;
	}
	binding?.dispose();
	bindings.delete(mode);
	if (!store) return;
	const mounted = new Map<TaskId, Component>();
	const update = () => {
		if (mode.taskRowsInChat === false) {
			mode.ui.requestRender();
			return;
		}
		for (const task of store.tasks) {
			const anchor = mounted.get(task.ref.taskId);
			if (anchor && mode.chatContainer.children.includes(anchor)) continue;
			const component: Component = {
				invalidate() {},
				render(width: number) {
					const current = store.tasks.find((item) => item.ref.taskId === task.ref.taskId) ?? task;
					const duplicate =
						store.tasks.filter((item) => item.agentName === current.agentName && item.title === current.title)
							.length > 1;
					return new TaskRow(current, {
						expanded: mode.toolOutputExpanded,
						duplicate,
						siblings: store.tasks,
						activity: store.recentActivity(current.ref.taskId),
						activityOmitted: store.activityOmitted(current.ref.taskId),
					}).render(width);
				},
			};
			mounted.set(task.ref.taskId, component);
			mode.chatContainer.addChild(component);
		}
		mode.ui.requestRender();
	};
	const unsubscribe = store.subscribe(update);
	bindings.set(mode, {
		store,
		update,
		dispose() {
			unsubscribe();
			for (const component of mounted.values()) mode.chatContainer.removeChild(component);
		},
	});
	update();
}
export function disposeInteractiveTasks(mode: InteractiveTaskHost): void {
	sessionBindings.get(mode)?.dispose();
	sessionBindings.delete(mode);
	bindings.get(mode)?.dispose();
	bindings.delete(mode);
}
