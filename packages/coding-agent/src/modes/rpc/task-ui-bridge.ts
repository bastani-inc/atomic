import { type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import {
	type AgentPanelSession,
	agentPanelExtensionItems,
	agentPanelTaskId,
	answerAgentPanelItem,
	dismissedAgentPanelItems,
	notifyAgentPanelChanged,
	openAgentPanelItem,
	stopAgentPanelItem,
	subscribeAgentPanelExtensions,
} from "../../core/tasks/agent-panel-source.ts";
import { latestSubagentAttempt, waitingReleasedShells } from "../../core/tasks/completion.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { launchedTaskViewSource, ownerTaskViewSource, type TaskViewSource } from "../../core/tasks/task-view-source.js";
import { agentViewBridge } from "../interactive/agent-view/agent-view-bridge.ts";
import { ChatSessionHost } from "../interactive/components/chat-session-host.ts";
import { type TaskBoardSource, TaskInspector } from "../interactive/components/task-inspector.js";
import { taskDisplayText } from "../interactive/components/task-row.js";
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
 * inspector only.
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

const boardSessions = new WeakMap<TaskBoardSource, object>();

export function agentPanelBoardSource(session: AgentPanelSession & object): TaskBoardSource {
	const board: TaskBoardSource = {
		items: () => agentPanelExtensionItems(session).filter((item) => agentPanelTaskId(item.id) === undefined),
		subscribe: (listener) => subscribeAgentPanelExtensions(session, listener),
		open: (id, options) => openAgentPanelItem(session, id, options),
		stop: (id) => stopAgentPanelItem(session, id),
		answer: (id, text, options) => answerAgentPanelItem(session, id, text, options),
		dismiss: (id) => {
			dismissedAgentPanelItems(session).add(id);
			notifyAgentPanelChanged(session);
		},
	};
	boardSessions.set(board, session);
	return board;
}

export async function showEngineTaskInspector(
	session: AgentSession,
	ui: TaskInspectorUi,
	taskId?: string,
	options: { readonly waitedShellOf?: string } = {},
): Promise<void> {
	session.getAgentTaskHost();
	const store = getOwnerTaskStore(session);
	if (!store) throw new Error("Task owner is unavailable");
	if (options.waitedShellOf !== undefined) {
		await openWaitedShellOf(session, ui, options.waitedShellOf);
		return;
	}
	await showTaskInspector(ui, store, taskId, { board: agentPanelBoardSource(session) });
}

/**
 * The waited-shell key of the subagent `taskId` the screen shows: while it waits on the shells it launched, `/tasks`
 * opens at the output of the newest one still running, in that subagent's own task list. Nothing opens otherwise.
 */
export async function openWaitedShellOf(session: object, ui: TaskInspectorUi, taskId: string): Promise<void> {
	const store = getOwnerTaskStore(session);
	if (store === undefined) return;
	const agent = latestSubagentAttempt(store.ownerTasks, taskId as TaskId);
	const shell = agent === undefined ? undefined : waitingReleasedShells(agent, store.ownerTasks).at(-1);
	if (agent === undefined || shell === undefined) return;
	const source = launchedTaskViewSource(ownerTaskViewSource(store), shell.parentTaskId ?? agent.ref.taskId);
	await showTaskInspector(ui, store, shell.ref.taskId, {
		chat: true,
		backLabel: agent.agentName ?? "back",
		source,
	});
}

/** Main CLI mount, shared by the local host and its isolated engine. */
export async function showTaskInspector(
	ui: TaskInspectorUi,
	store: OwnerTaskStore,
	taskId?: string,
	options: {
		readonly chat?: boolean;
		readonly backLabel?: string;
		readonly board?: TaskBoardSource;
		/** The tasks it lists, when not the session's own: a subagent's, through its launched view of `store`. */
		readonly source?: TaskViewSource;
	} = {},
): Promise<"back" | "closed"> {
	let requestRender = () => {};
	let finishView = () => {};
	let closed = false;
	let fullscreen = false;
	let environment: TaskTranscriptEnvironment | undefined;
	let pendingChat: TaskId | undefined;
	const inspector = new TaskInspector(
		options.source ?? store,
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
	if (options.board) {
		inspector.setBoardSource(options.board);
		// On the single chat screen a subagent opens there, where the main chat was, and /tasks closes.
		const session = boardSessions.get(options.board);
		const bridge = session === undefined ? undefined : agentViewBridge(session);
		if (bridge !== undefined) inspector.setAgentView((id) => bridge.requestView(id));

		const reopenOptions = { board: options.board };
		inspector.setReopen((id) => {
			void showTaskInspector(ui, store, id, reopenOptions).catch((error: unknown) => {
				try {
					ui.notify?.(taskDisplayText(error instanceof Error ? error.message : String(error)), "error");
				} catch {}
			});
		});
	}
	if (options.chat && taskId !== undefined) {
		pendingChat = taskId as TaskId;
	} else inspector.open(taskId as TaskId | undefined);
	const panelTarget = (options.board ? boardSessions.get(options.board) : undefined) ?? store;
	setAgentPanelVisible(panelTarget, false);
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
						inspector.openChat(chat, options.backLabel);

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
						// A full-screen page draws from the top row, so the click's row is the page's.
						handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined =>
							fullscreen ? inspector.handleMouse(event) : undefined,
						paintedRowKey: (row: number): string | undefined =>
							fullscreen ? inspector.paintedRowKey(row) : undefined,
						handleInput: (data: string) => {
							if (!isPhysicalCtrlC(data)) return inspector.handleInput(data);
							// Ctrl+C clears a chat's typed prompt, as in the main chat; on an empty one it closes the view.
							if (inspector.clearTypedPrompt()) return true;
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
		setAgentPanelVisible(panelTarget, true);
	}
	return inspector?.closedByBack === true ? "back" : "closed";
}
