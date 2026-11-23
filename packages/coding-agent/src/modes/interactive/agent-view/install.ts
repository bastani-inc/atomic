import type { TaskId } from "../../../core/tasks/contracts.js";
import { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import {
	cancelWidgetPreview,
	clearPromotedWidgetPreview,
	commitWidgetPreview,
	hasUnansweredNavigationCancelInput,
	resetWidgetPreview,
	stageWidgetPreview,
} from "../../interactive-engine/remote-component.ts";
import { AGENT_PANEL_WIDGET_KEY } from "../../rpc/agent-panel-bridge.ts";
import { isPhysicalEscape } from "../interactive-key-identity.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { setAgentViewBridge } from "./agent-view-bridge.ts";
import { AgentViewSwitcher, type OpenAgentViewPort } from "./agent-view-switcher.ts";
import { openAgentViewPort } from "./open-port.ts";
import { installPromptRetarget, isCancelPendingOpenKey } from "./prompt-retarget.ts";
import { FIRST_FRAME_TIMEOUT_MS, PANEL_FIRST_FRAME_TIMEOUT_MS } from "./remote-port.ts";
import { holdTranscriptDock, installTranscriptSlot } from "./transcript-slot.ts";
import {
	type HostEngineViewSyncState,
	initialHostEngineViewSyncState,
	planPreViewCancelAck,
	shouldCancelEngineViewOnArrival,
} from "./view-preview-protocol.js";
import { installViewedCommandGates } from "./viewed-commands.ts";

const switchers = new WeakMap<InteractiveModeBase, AgentViewSwitcher>();

/**
 * The mode's switcher, made on first use: a session can be bound before the screen is set up. `openPort` opens the
 * subagents it shows; the first call decides it.
 */
export function agentViewSwitcher(
	mode: InteractiveModeBase,
	openPort: OpenAgentViewPort = (taskId, options) => openAgentViewPort(mode, taskId, options),
): AgentViewSwitcher {
	let switcher = switchers.get(mode);
	if (switcher === undefined) {
		switcher = new AgentViewSwitcher(
			openPort,
			(message) => mode.showWarning(message),
			() => holdTranscriptDock(mode, FIRST_FRAME_TIMEOUT_MS),
		);
		switchers.set(mode, switcher);
		mode.agentView = switcher;
	}
	return switcher;
}

/**
 * Set up the single chat screen once the main screen is: the transcript area, the prompt's retargeting and the
 * hotkey gates follow what the switcher shows, in that order. On the isolated host the engine's panel and `/tasks`
 * reach the switcher through `engine_view_agent`, and learn what it shows through `set_viewed_agent`.
 */
/**
 * Tells the engine what the screen shows, with `tell`: when it changes, and when a request ends without showing what
 * it asked for, since the engine lists the subagent it asked to show while the screen is kept for it.
 */
export function tellEngineViewed(
	switcher: Pick<AgentViewSwitcher, "onChange" | "onPending" | "viewedTaskId">,
	tell: (taskId: TaskId | undefined) => void,
	/** Runs before the screen the request kept is shown again, when the request ended without showing `taskId`. */
	beforeCorrection?: (taskId: TaskId) => void,
): () => void {
	const stopChange = switcher.onChange(({ to }) => tell(to.kind === "agent" ? to.port.status().taskId : undefined));
	const stopPending = switcher.onPending((pending, settled) => {
		if (pending !== undefined || settled === undefined || settled.outcome === "shown") return;
		beforeCorrection?.(settled.taskId);
		tell(switcher.viewedTaskId());
	});
	return () => {
		stopChange();
		stopPending();
	};
}

/**
 * Shows what the engine asks for (`engine_view_agent`). While the screen is kept for it, the engine's panel is told
 * first that the subagent is about to be shown (`tell`), so that the panel draws its row before the subagent is shown;
 * a request that ends without showing it tells the engine what the screen shows instead (tellEngineViewed).
 */
export function showForEngine(
	switcher: Pick<AgentViewSwitcher, "requestView">,
	message: { taskId: string | null; requestId?: number; keepScreen?: true; panel?: true; panelOnView?: true },
	tell: (taskId: TaskId | undefined) => void,
): TaskId | undefined {
	const taskId = message.taskId === null ? undefined : (message.taskId as TaskId);
	const keepScreen = message.keepScreen === true;
	const panelOnView = keepScreen && taskId !== undefined && message.panelOnView === true;
	if (panelOnView) tell(taskId);
	switcher.requestView(taskId, { keepScreen, panel: message.panel === true || panelOnView });
	return panelOnView ? taskId : undefined;
}

export function installAgentView(mode: InteractiveModeBase): AgentViewSwitcher {
	const switcher = agentViewSwitcher(mode);
	const undo: (() => void)[] = [
		installTranscriptSlot(mode, switcher),
		installPromptRetarget(mode, switcher),
		installViewedCommandGates(mode, switcher),
	];
	const runtime = mode.runtimeHost;
	if (runtime instanceof IsolatedInteractiveRuntime) {
		let sync: HostEngineViewSyncState = initialHostEngineViewSyncState();
		let resettingGeneration = false;
		let replacingWithPreview = false;
		let supersededSettledForPreview: number | undefined;
		let syncEngineRequestId: number | undefined;

		const advanceSettled = (candidate: number | undefined): number => {
			if (candidate !== undefined && candidate > sync.settledRequestId) {
				sync = { ...sync, settledRequestId: candidate };
			}
			return sync.settledRequestId;
		};

		const allocateViewSeq = (): number => {
			const viewSeq = sync.viewSeq + 1;
			sync = { ...sync, viewSeq };
			return viewSeq;
		};

		const sendSetViewed = (payload: {
			readonly taskId?: TaskId;
			readonly preview?: true;
			readonly viewSeq?: number;
			readonly requestId?: number;
			readonly settledRequestId?: number;
		}): number => {
			const viewSeq = payload.viewSeq ?? allocateViewSeq();
			const settled = payload.settledRequestId;
			if (settled !== undefined && settled > sync.lastSentSettledRequestId) {
				sync = { ...sync, lastSentSettledRequestId: settled };
			}
			if (resettingGeneration) return viewSeq;
			void runtime
				.requestAgentView({
					type: "set_viewed_agent",
					...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
					...(payload.preview === true ? { preview: true as const } : {}),
					viewSeq,
					...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
					...(settled === undefined ? {} : { settledRequestId: settled }),
				})
				.catch(() => {
					// A lost engine forgets what was shown; its replacement starts on main.
				});
			return viewSeq;
		};

		const resetGenerationSync = () => {
			sync = initialHostEngineViewSyncState();
			supersededSettledForPreview = undefined;
			syncEngineRequestId = undefined;
			resetWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY);
		};

		undo.push(
			runtime.onEngineMessage((message) => {
				if (message.type === "engine_ready") {
					resetGenerationSync();
					return;
				}
				if (message.type !== "engine_view_agent") return;
				const taskId = message.taskId === null ? undefined : (message.taskId as TaskId);
				const keepScreen = message.keepScreen === true;
				const panelOnView = keepScreen && taskId !== undefined && message.panelOnView === true;
				const engineRequestId = message.requestId;
				const tagged = engineRequestId !== undefined;

				const cancelledBeforeArrival =
					taskId !== undefined &&
					keepScreen &&
					shouldCancelEngineViewOnArrival(
						true,
						true,
						true,
						hasUnansweredNavigationCancelInput(
							runtime,
							(data) => isCancelPendingOpenKey(mode.keybindings, data),
							isPhysicalEscape,
						),
					);
				if (cancelledBeforeArrival) {
					const priorPendingActive = switcher.pendingTaskId !== undefined;
					const plan = planPreViewCancelAck(
						sync.settledRequestId,
						sync.lastSentSettledRequestId,
						engineRequestId ?? 0,
						priorPendingActive,
					);
					advanceSettled(engineRequestId);
					if (priorPendingActive) {
						switcher.cancelPending();
					}
					if (plan.shouldSendAck) {
						const viewed = switcher.viewedTaskId();
						sendSetViewed({
							...(viewed === undefined ? {} : { taskId: viewed }),
							...(engineRequestId === undefined && plan.nextSettledReq === 0
								? {}
								: { settledRequestId: plan.nextSettledReq }),
						});
					}
					return;
				}

				const willOpenAsyncWithPreview = panelOnView && switcher.viewedTaskId() !== taskId;

				replacingWithPreview = willOpenAsyncWithPreview;
				supersededSettledForPreview = undefined;
				syncEngineRequestId = taskId === undefined ? engineRequestId : undefined;
				try {
					switcher.requestView(taskId, { keepScreen, panel: message.panel === true || panelOnView });
				} finally {
					replacingWithPreview = false;
					syncEngineRequestId = undefined;
				}

				const pendingHostId = switcher.pendingRequestId;
				if (pendingHostId !== undefined && taskId !== undefined) {
					if (panelOnView) {
						const previewSeq = allocateViewSeq();
						sync = {
							...sync,
							pendingEngine: { hostRequestId: pendingHostId, engineRequestId, previewSeq, tagged },
						};
						stageWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY, previewSeq, tagged);
						sendSetViewed({
							taskId,
							preview: true,
							viewSeq: previewSeq,
							...(engineRequestId === undefined ? {} : { requestId: engineRequestId }),
							...(supersededSettledForPreview === undefined
								? {}
								: { settledRequestId: supersededSettledForPreview }),
						});
					} else {
						sync = {
							...sync,
							pendingEngine: { hostRequestId: pendingHostId, engineRequestId, tagged },
						};
					}
					supersededSettledForPreview = undefined;
					return;
				}

				// Request settled synchronously (already on main or already viewing the requested subagent).
				supersededSettledForPreview = undefined;
				const settled = advanceSettled(engineRequestId);
				if (engineRequestId !== undefined && sync.lastSentSettledRequestId < engineRequestId) {
					sendSetViewed({
						...(switcher.viewedTaskId() === undefined ? {} : { taskId: switcher.viewedTaskId() }),
						settledRequestId: settled,
					});
				}
			}),
			runtime.onGenerationEnded(() => {
				resetGenerationSync();
				resettingGeneration = true;
				try {
					switcher.reset("generation-lost");
				} finally {
					resettingGeneration = false;
				}
			}),
			switcher.onChange(({ to }) => {
				if (resettingGeneration) return;
				const toTaskId = to.kind === "agent" ? to.port.status().taskId : undefined;
				const pending = sync.pendingEngine;
				if (pending !== undefined && switcher.pendingRequestId === pending.hostRequestId && to.kind === "agent") {
					sync = { ...sync, pendingEngine: undefined };
					const settled = advanceSettled(pending.engineRequestId);
					if (pending.previewSeq !== undefined) {
						commitWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY, pending.previewSeq);
					} else {
						clearPromotedWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY);
					}
					sendSetViewed({
						taskId: toTaskId,
						settledRequestId: settled,
					});
					return;
				}
				clearPromotedWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY);
				const settled = advanceSettled(syncEngineRequestId);
				sendSetViewed({
					...(toTaskId === undefined ? {} : { taskId: toTaskId }),
					settledRequestId: settled,
				});
			}),
			switcher.onPending((pendingTask, settled) => {
				if (resettingGeneration || settled === undefined) return;
				const active = sync.pendingEngine;
				if (active !== undefined && settled.requestId === active.hostRequestId) {
					sync = { ...sync, pendingEngine: undefined };
					const settledReq = advanceSettled(active.engineRequestId);
					if (settled.outcome === "shown") {
						if (active.previewSeq !== undefined) {
							commitWidgetPreview(runtime, AGENT_PANEL_WIDGET_KEY, active.previewSeq);
						}
						if (active.engineRequestId !== undefined && sync.lastSentSettledRequestId < active.engineRequestId) {
							sendSetViewed({
								...(switcher.viewedTaskId() === undefined ? {} : { taskId: switcher.viewedTaskId() }),
								settledRequestId: settledReq,
							});
						}
						return;
					}
					if (replacingWithPreview) {
						if (active.engineRequestId !== undefined) supersededSettledForPreview = settledReq;
						return;
					}
					if (active.previewSeq !== undefined) {
						cancelWidgetPreview(
							runtime,
							AGENT_PANEL_WIDGET_KEY,
							active.tagged ? undefined : PANEL_FIRST_FRAME_TIMEOUT_MS,
						);
					}
					sendSetViewed({
						...(switcher.viewedTaskId() === undefined ? {} : { taskId: switcher.viewedTaskId() }),
						settledRequestId: settledReq,
					});
					return;
				}
				if (pendingTask === undefined && settled.outcome !== "shown") {
					sendSetViewed({
						...(switcher.viewedTaskId() === undefined ? {} : { taskId: switcher.viewedTaskId() }),
						settledRequestId: sync.settledRequestId,
					});
				}
			}),
		);
	}
	mode.disposeAgentView = () => {
		mode.disposeAgentView = undefined;
		// Main is shown again first, while every part still follows the switcher, then each part is taken down.
		switcher.dispose();
		for (const release of undo.reverse()) {
			try {
				release();
			} catch {
				// One part's failure must not keep the others installed.
			}
		}
	};
	return switcher;
}

/**
 * Let the panel and `/tasks` of a session bound in this process change what the screen shows. Answers the unbind,
 * which shows main again: the subagents shown belonged to the session left.
 */
export function bindAgentViewSession(mode: InteractiveModeBase, session: object): () => void {
	if (mode.runtimeHost instanceof IsolatedInteractiveRuntime) return () => {};
	const switcher = agentViewSwitcher(mode);
	setAgentViewBridge(session, switcher);
	return () => {
		setAgentViewBridge(session, undefined);
		switcher.reset("session-replaced");
	};
}
