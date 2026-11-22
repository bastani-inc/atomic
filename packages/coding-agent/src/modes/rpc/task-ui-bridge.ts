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
import { AgentViewSwitcher } from "../interactive/agent-view/agent-view-switcher.ts";
import { ChatSessionHost } from "../interactive/components/chat-session-host.ts";
import { type TaskBoardSource, TaskInspector } from "../interactive/components/task-inspector.js";
import { taskDisplayText } from "../interactive/components/task-row.js";
import {
	clearTasksReturnAnchor,
	type ListSelectionAnchor,
	resolveStoreTaskKey,
	saveTasksReturnAnchor,
	stagePendingTasksReturn,
	taskStableKey,
	tasksReturnAnchor,
	tasksReturnRecord,
} from "../interactive/components/task-selection-state.js";
import { type TaskTranscriptEnvironment, themedChatHostStyle } from "../interactive/components/task-transcript-page.ts";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { getEditorTheme } from "../interactive/theme/theme.js";
import type { EngineHostRenderSettings } from "../interactive-engine/protocol.ts";
import { hideAgentPanelFor } from "./agent-panel-bridge.ts";
import { engineAgentViewSettlementSeq } from "./agent-view-rpc-panel.ts";

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
		/** Saved list anchor when returning from an item that closed `/tasks`. */
		readonly returnAnchor?: ListSelectionAnchor;
	} = {},
): Promise<"back" | "closed"> {
	let requestRender = () => {};
	let finishView = () => {};
	let closed = false;
	let fullscreen = false;
	let environment: TaskTranscriptEnvironment | undefined;
	let pendingChat: TaskId | undefined;
	let requestedAgentId: TaskId | undefined;
	let engineSeqAtRequest: number | undefined;
	const trackReturn = !options.chat && options.source === undefined;
	const session = options.board ? boardSessions.get(options.board) : undefined;
	const bridge = session === undefined ? undefined : agentViewBridge(session);
	const panelTarget = session ?? store;
	const priorRecord = trackReturn ? tasksReturnRecord(store) : undefined;
	const priorViewedId = bridge?.viewedTaskId();
	const priorSaved = trackReturn
		? priorViewedId !== undefined && priorRecord?.anchor !== undefined
			? priorRecord.anchor
			: tasksReturnAnchor(store)
		: undefined;
	/** The agent panel this view takes the place of: hidden once the view is mounted, back in the step it closes. */
	const panel = hideAgentPanelFor(panelTarget);
	const inspector = new TaskInspector(
		options.source ?? store,
		() => {
			if (inspector.fullscreen !== fullscreen) finishView();
			else requestRender();
		},
		() => {
			closed = true;
			panel.show(() => finishView());
		},
		undefined,
		() => environment,
	);
	if (options.board) {
		inspector.setBoardSource(options.board);
		// On the single chat screen a subagent opens there, where the main chat was, and /tasks closes.
		if (bridge !== undefined)
			inspector.setAgentView((id) => {
				requestedAgentId = id;
				engineSeqAtRequest = engineAgentViewSettlementSeq(bridge);
				bridge.requestView(id, { keepScreen: true });
			});

		const reopenOptions = { board: options.board };
		inspector.setReopen((id, anchor) => {
			void showTaskInspector(ui, store, id, {
				...reopenOptions,
				...(anchor === undefined ? {} : { returnAnchor: anchor }),
			}).catch((error: unknown) => {
				try {
					ui.notify?.(taskDisplayText(error instanceof Error ? error.message : String(error)), "error");
				} catch {}
			});
		});
	}
	if (options.chat && taskId !== undefined) {
		pendingChat = taskId as TaskId;
	} else if (options.returnAnchor !== undefined) {
		inspector.restoreAnchor(options.returnAnchor);
	} else if (taskId !== undefined) {
		inspector.open(taskId as TaskId);
	} else if (trackReturn) {
		const viewedId = priorViewedId;
		const listedViewed =
			viewedId === undefined
				? undefined
				: (latestSubagentAttempt(store.backgroundTasks, viewedId) ?? store.taskRecord?.(viewedId));
		const viewedKey = listedViewed === undefined ? undefined : taskStableKey(listedViewed);
		const sameAsSaved = priorSaved !== undefined && viewedKey !== undefined && priorSaved.selectedKey === viewedKey;
		// Only synthesize a fresh viewed-agent anchor when that subagent is actually present in `store`;
		// if a resumed viewed attempt was already evicted, keep `priorSaved` so nearest-neighbour fallback uses
		// the departure order instead of an empty order.
		if (viewedId !== undefined && listedViewed !== undefined && viewedKey !== undefined && !sameAsSaved) {
			inspector.restoreAnchor({
				selectedKey: viewedKey,
				orderKeys: [],
				scroll: 0,
			});
		} else if (priorSaved !== undefined) {
			inspector.restoreAnchor(priorSaved);
		} else {
			inspector.open(undefined);
		}
	} else {
		inspector.open(undefined);
	}
	try {
		while (!closed) {
			fullscreen = inspector.fullscreen || pendingChat !== undefined;
			const shown = ui.custom<void>(
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
							queueMicrotask(() => panel.show(() => done()));
						}
					}
					// Elapsed times and the stop notice's window advance while the view is shown.
					const mountFullscreen = fullscreen;
					const tick = setInterval(() => tui.requestRender(), 1000);
					tick.unref?.();
					return {
						dispose: () => clearInterval(tick),
						invalidate: () => inspector.invalidate(),
						render: (width: number) => {
							const height = Math.max(1, tui.terminal.rows);
							if (!mountFullscreen) return inspector.renderPicker(width, height);
							// A closing fullscreen mount (after `←` returned to the inline picker) must not
							// repaint: rendering the board at full terminal height would clamp scroll to 0, and
							// painting a stale fullscreen frame would bleed beneath the inline picker.
							if (!inspector.fullscreen) return [];
							const lines = inspector.renderViewport(width, height);
							// Fullscreen detail pages cover all parent chat and prompt cells.
							return Array.from({ length: height }, (_, row) => {
								const line = truncateToWidth(lines[row] ?? "", width);
								return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
							});
						},
						// A full-screen page draws from the top row, so the click's row is the page's.
						handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined =>
							mountFullscreen && inspector.fullscreen ? inspector.handleMouse(event) : undefined,
						paintedRowKey: (row: number): string | undefined =>
							mountFullscreen && inspector.fullscreen ? inspector.paintedRowKey(row) : undefined,
						handleInput: (data: string) => {
							if (!isPhysicalCtrlC(data)) return inspector.handleInput(data);
							// Ctrl+C closes the view: what it shows here (lists, details, a shell's output) has no prompt.
							closed = true;
							panel.show(() => done());
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
			panel.hide();
			await shown;
			// Host dismissal without a navigation transition must not reopen the view.
			if (inspector.fullscreen === fullscreen) closed = true;
		}
	} finally {
		if (trackReturn) {
			if (inspector.closeReason === "navigated-agent" && inspector.returnAnchor !== undefined) {
				const anchor = inspector.returnAnchor;
				const currentViewed = bridge?.viewedTaskId();
				if (
					bridge === undefined ||
					requestedAgentId === undefined ||
					(currentViewed !== undefined &&
						(currentViewed === requestedAgentId ||
							resolveStoreTaskKey(store, currentViewed) === anchor.selectedKey))
				) {
					saveTasksReturnAnchor(store, anchor, currentViewed ?? requestedAgentId);
				} else {
					const priorViewedKey =
						priorViewedId === undefined ? undefined : resolveStoreTaskKey(store, priorViewedId);
					const priorFallbackAnchor =
						priorViewedId !== undefined && priorViewedKey !== undefined && anchor.selectedKey !== priorViewedKey
							? priorSaved !== undefined && priorSaved.selectedKey === priorViewedKey
								? priorSaved
								: {
										selectedKey: priorViewedKey,
										orderKeys: anchor.orderKeys,
										scroll: anchor.scroll,
									}
							: undefined;
					const awaitingAsyncSettlement =
						(bridge instanceof AgentViewSwitcher && bridge.pendingTaskId !== undefined) ||
						(engineSeqAtRequest !== undefined && engineAgentViewSettlementSeq(bridge) === engineSeqAtRequest);
					if (awaitingAsyncSettlement) {
						stagePendingTasksReturn(store, requestedAgentId, anchor, priorFallbackAnchor, priorViewedId);
					} else if (priorViewedId !== undefined && currentViewed === priorViewedId) {
						if (priorFallbackAnchor !== undefined)
							saveTasksReturnAnchor(store, priorFallbackAnchor, priorViewedId);
					} else {
						clearTasksReturnAnchor(store);
					}
				}
			} else if (inspector.closeReason === "navigated-item" && inspector.returnAnchor !== undefined) {
				saveTasksReturnAnchor(store, inspector.returnAnchor);
			} else if (bridge?.viewedTaskId() === undefined) {
				clearTasksReturnAnchor(store, { keepPending: true });
			}
		}
		inspector?.dispose();
		panel.show();
	}
	return inspector?.closedByBack === true ? "back" : "closed";
}
