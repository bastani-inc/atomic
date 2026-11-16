import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ChatSessionHost } from "../interactive/components/chat-session-host.ts";
import { TaskInspector } from "../interactive/components/task-inspector.js";
import { type TaskTranscriptEnvironment, themedChatHostStyle } from "../interactive/components/task-transcript-page.ts";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { getEditorTheme } from "../interactive/theme/theme.js";
import type { EngineHostRenderSettings } from "../interactive-engine/protocol.ts";
import { setAgentPanelVisible } from "./agent-panel-bridge.ts";

/** The UI a task inspector mounts in: its custom UI, and the chat render settings its transcripts inherit. */
export type TaskInspectorUi = Pick<ExtensionUIContext, "custom"> &
	Partial<
		Pick<
			ExtensionUIContext,
			"getChatRenderSettings" | "getToolsExpanded" | "setToolsExpanded" | "notify" | "getFooterDataProvider"
		>
	>;

/** The engine's custom UI, with the render settings of the host chat that opened the inspector. */
export type EngineTaskInspectorMount = Pick<ExtensionUIContext, "custom"> & {
	getHostRenderSettings?(): EngineHostRenderSettings | undefined;
};

/**
 * The isolated engine's `/tasks`, opened from the host's chat. Its transcripts show tool output as the host chat does
 * (the engine's own state stands in until a render request carries the host's), and Ctrl+O there changes it for this
 * inspector only, as an attached stage chat keeps its own.
 */
export function engineTaskInspectorUi(
	ui: Pick<ExtensionUIContext, "getChatRenderSettings" | "getToolsExpanded" | "notify" | "getFooterDataProvider">,
	mount: EngineTaskInspectorMount,
): TaskInspectorUi {
	let toggled: boolean | undefined;
	const toolsExpanded = () => toggled ?? mount.getHostRenderSettings?.()?.toolOutputExpanded ?? ui.getToolsExpanded();
	return {
		custom: mount.custom,
		getChatRenderSettings: () => ({ ...ui.getChatRenderSettings(), toolOutputExpanded: toolsExpanded() }),
		getToolsExpanded: toolsExpanded,
		setToolsExpanded: (expanded) => {
			toggled = expanded;
		},
		getFooterDataProvider: () => ui.getFooterDataProvider(),
		notify: (message, type) => ui.notify(message, type),
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
	// The agent panel lists the same tasks; it steps aside while the inspector owns the prompt's place.
	setAgentPanelVisible(session, false);
	try {
		await showTaskInspector(ui, store, taskId);
	} finally {
		setAgentPanelVisible(session, true);
	}
}

/** Main CLI mount, shared by the local host and its isolated engine. */
export async function showTaskInspector(
	ui: TaskInspectorUi,
	store: OwnerTaskStore,
	taskId?: string,
	options: { readonly chat?: boolean } = {},
): Promise<void> {
	let requestRender = () => {};
	let finishView = () => {};
	let closed = false;
	let fullscreen = false;
	let environment: TaskTranscriptEnvironment | undefined;
	let pendingChat: TaskId | undefined;
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
	if (options.chat && taskId !== undefined) {
		// The chat needs its environment, which the first mount below creates; open it once the mount exists.
		pendingChat = taskId as TaskId;
	} else inspector.open(taskId as TaskId | undefined);
	try {
		while (!closed) {
			fullscreen = inspector.fullscreen || pendingChat !== undefined;
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
						...(ui.getFooterDataProvider ? { footerData: ui.getFooterDataProvider() } : {}),
						...(ui.notify ? { notify: (message: string) => ui.notify?.(message, "warning") } : {}),
					};
					if (pendingChat !== undefined) {
						const chat = pendingChat;
						pendingChat = undefined;
						inspector.openChat(chat);
						// A task that is gone opens nothing: close instead of showing the list.
						if (!inspector.fullscreen) {
							closed = true;
							queueMicrotask(() => done());
						}
					}
					// Elapsed times and the stop notice's window advance while the view is shown.
					const tick = setInterval(() => tui.requestRender(), 1000);
					tick.unref?.();
					return {
						dispose: () => clearInterval(tick),
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
