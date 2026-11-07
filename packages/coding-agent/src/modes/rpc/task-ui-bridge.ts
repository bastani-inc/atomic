import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore, watchOwnerTaskStoreBinding } from "../../core/tasks/owner-store.js";
import { ChatSessionHost } from "../interactive/components/chat-session-host.js";
import { TaskInspector } from "../interactive/components/task-inspector.js";
import { isActiveBackgroundTask, renderTaskFooter } from "../interactive/components/task-list.js";
import { type TaskTranscriptEnvironment, themedChatHostStyle } from "../interactive/components/task-transcript-page.ts";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { getEditorTheme } from "../interactive/theme/theme.js";

/** The UI a task inspector mounts in: its custom UI, and the chat render settings its transcripts inherit. */
export type TaskInspectorUi = Pick<ExtensionUIContext, "custom"> &
	Partial<Pick<ExtensionUIContext, "getChatRenderSettings" | "getToolsExpanded" | "setToolsExpanded">>;

const widgetVisibility = new WeakMap<AgentSession, (visible: boolean) => void>();

/** Render against the engine's owner. Native capabilities never cross the UI bridge. */
export function bindEngineTaskWidget(session: AgentSession, ui: ExtensionUIContext): () => void {
	const key = "atomic.background-tasks";
	let unsubscribe = () => {};
	let disposed = false;
	let mounted = false;
	let visible = true;
	const connect = () => {
		unsubscribe();
		if (mounted) ui.setWidget(key, undefined);
		mounted = false;
		const store = getOwnerTaskStore(session);
		const update = () => {
			if (disposed) return;
			if (!visible || !store?.backgroundTasks.some(isActiveBackgroundTask)) {
				if (mounted) ui.setWidget(key, undefined);
				mounted = false;
				return;
			}
			if (!mounted) {
				mounted = true;
				ui.setWidget(
					key,
					() => ({
						invalidate() {},
						render(width: number) {
							return renderTaskFooter(store?.backgroundTasks ?? [], width);
						},
					}),
					{ placement: "belowEditor" },
				);
			}
			ui.requestRender();
		};
		unsubscribe = store?.subscribe(update) ?? (() => {});
		update();
	};
	const unwatch = watchOwnerTaskStoreBinding(session, connect);
	const unwatchWidget = ui.onWidgetRelease?.(key, () => {
		mounted = false;
	});
	widgetVisibility.set(session, (value) => {
		visible = value;
		connect();
	});
	connect();
	return () => {
		disposed = true;
		widgetVisibility.delete(session);
		unwatch();
		unwatchWidget?.();
		unsubscribe();
		if (mounted) ui.setWidget(key, undefined);
	};
}

export async function showEngineTaskInspector(
	session: AgentSession,
	ui: TaskInspectorUi,
	taskId?: string,
): Promise<void> {
	session.getAgentTaskHost();
	const store = getOwnerTaskStore(session);
	if (!store) throw new Error("Task owner is unavailable");
	try {
		widgetVisibility.get(session)?.(false);
		await showTaskInspector(ui, store, taskId);
	} finally {
		widgetVisibility.get(session)?.(true);
	}
}

/** Main CLI mount, shared by the local host and its isolated engine. */
export async function showTaskInspector(ui: TaskInspectorUi, store: OwnerTaskStore, taskId?: string): Promise<void> {
	let requestRender = () => {};
	let finishView = () => {};
	let closed = false;
	let fullscreen = false;
	let environment: TaskTranscriptEnvironment | undefined;
	const inspector = new TaskInspector(
		store,
		() => {
			if (inspector.fullscreen !== fullscreen) finishView();
			else requestRender();
		},
		() => {
			closed = true;
			finishView();
		},
		undefined,
		() => environment,
	);
	inspector.open(taskId as TaskId | undefined);
	try {
		while (!closed) {
			fullscreen = inspector.fullscreen;
			await ui.custom<void>(
				(tui, _theme, keybindings, done) => {
					requestRender = () => tui.requestRender();
					finishView = () => done();
					environment = {
						createChat: (opts) => new ChatSessionHost(opts),
						tui,
						keybindings,
						editorTheme: getEditorTheme(),
						style: themedChatHostStyle(),
						...(ui.getChatRenderSettings ? { getChatRenderSettings: () => ui.getChatRenderSettings?.() } : {}),
						...(ui.getToolsExpanded ? { getToolsExpanded: () => ui.getToolsExpanded?.() === true } : {}),
						...(ui.setToolsExpanded
							? { setToolsExpanded: (expanded: boolean) => ui.setToolsExpanded?.(expanded) }
							: {}),
					};
					return {
						invalidate: () => inspector.invalidate(),
						render: (width: number) => {
							const height = Math.max(1, tui.terminal.rows);
							if (!fullscreen) return inspector.renderPicker(width, height);
							const lines = inspector.renderViewport(width, height);
							// Fullscreen detail pages cover all parent chat and prompt cells.
							return Array.from({ length: height }, (_, row) => {
								const line = truncateToWidth(lines[row] ?? "", width);
								return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
							});
						},
						handleInput: (data: string) => {
							if (!isPhysicalCtrlC(data)) return inspector.handleInput(data);
							closed = true;
							done();
							return true;
						},
					};
				},
				{
					overlay: fullscreen,
					purpose: "navigation",
					handlesCtrlC: true,
					deferInlineCustomUiFocus: true,
					handlesInternalUiAction: true,
					...(fullscreen
						? {
								overlayOptions: {
									anchor: "center" as const,
									width: "100%" as const,
									maxHeight: "100%" as const,
									margin: 0,
								},
							}
						: {}),
				},
			);
			// Host dismissal without a navigation transition must not reopen the view.
			if (inspector.fullscreen === fullscreen) closed = true;
		}
	} finally {
		inspector?.dispose();
	}
}
