import type { Component, Container, TUI } from "@bastani/atomic-tui";
import type { TaskId, TaskRecord } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore, watchOwnerTaskStoreBinding } from "../../core/tasks/owner-store.js";
import { messageComponents } from "./chat-message-count.ts";
import { countTasksBy, TranscriptTaskRow, taskNameAndTitle, taskSiblings } from "./components/task-row.js";
import { type ClickExpandableBlock, rowsFrom } from "./components/transcript-block-clicks.ts";

function taskSnapshot(tasks: readonly TaskRecord[]) {
	const siblings = taskSiblings(tasks);
	return {
		siblings,
		byId: new Map(siblings.map((task) => [task.ref.taskId, task])),
		copies: countTasksBy(siblings, taskNameAndTitle),
	};
}

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
	let snapshot = taskSnapshot(store.tasks);
	const update = () => {
		snapshot = taskSnapshot(store.tasks);
		if (mode.taskRowsInChat === false) {
			mode.ui.requestRender();
			return;
		}
		const attached = mounted.size > 0 ? new Set(mode.chatContainer.children) : undefined;
		for (const task of snapshot.siblings) {
			const anchor = mounted.get(task.ref.taskId);
			if (anchor && attached?.has(anchor)) continue;
			// The row follows the chat's tool-output setting until a click, or Ctrl+O, sets its own expansion.
			let clicked: boolean | undefined;
			const isExpanded = () => clicked ?? mode.toolOutputExpanded;
			const component: ClickExpandableBlock = {
				expandsOnClick: true,
				isExpanded,
				setExpanded(next: boolean) {
					clicked = next;
				},
				clickArea: (width: number) => rowsFrom(0, component.render(width).length),
				invalidate() {},
				render(width: number) {
					const current = snapshot.byId.get(task.ref.taskId) ?? task;
					const duplicate = (snapshot.copies.get(taskNameAndTitle(current)) ?? 0) > 1;
					return new TranscriptTaskRow(current, {
						expanded: isExpanded(),
						duplicate,
						siblings: snapshot.siblings,
						activity: store.recentActivity(current.ref.taskId),
						activityOmitted: store.activityOmitted(current.ref.taskId),
					}).render(width);
				},
			};
			mounted.set(task.ref.taskId, component);
			messageComponents.add(component);
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
