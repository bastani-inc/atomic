import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import {
	type AgentViewBridge,
	agentViewBridge,
	setAgentViewBridge,
} from "../interactive/agent-view/agent-view-bridge.ts";
import {
	applyEngineSetViewedAgent,
	beginEngineViewRequest,
	type EngineAgentViewState,
	type HostSetViewedAgentInput,
	initialEngineAgentViewState,
	setBridgePanelPreview,
} from "../interactive/agent-view/view-preview-protocol.js";
import { settleStoreTasksReturn, tasksReturnRecord } from "../interactive/components/task-selection-state.js";
import { agentPanelReturnsOnShow } from "./agent-panel-bridge.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The engine's copy of what the host's screen shows, which the host keeps current with `set_viewed_agent`. */
interface EngineAgentViewBridge extends AgentViewBridge {
	applyHostSetViewed(command: HostSetViewedAgentInput): {
		readonly settle?: {
			readonly viewed: TaskId | undefined;
			readonly settledRequestId: number | undefined;
			readonly supersededOnly?: true;
		};
	};
	settlementSeq(): number;
	legacySettlementSeq(): number;
	lastRequestId(): number;
	settledRequestId(): number;
	hasTypedHost(): boolean;
}

const engineBridges = new WeakMap<object, EngineAgentViewBridge>();
const engineBridgeSet = new WeakSet<AgentViewBridge>();

/** Current committed settlement counter of an isolated-engine bridge, or undefined for other bridges. */
export function engineAgentViewSettlementSeq(bridge: AgentViewBridge): number | undefined {
	return engineBridgeSet.has(bridge) ? (bridge as EngineAgentViewBridge).settlementSeq() : undefined;
}

/** Current legacy (untagged) settlement counter of an isolated-engine bridge, or undefined for other bridges. */
export function engineAgentViewLegacySettlementSeq(bridge: AgentViewBridge): number | undefined {
	return engineBridgeSet.has(bridge) ? (bridge as EngineAgentViewBridge).legacySettlementSeq() : undefined;
}

/** Latest `engine_view_agent.requestId` emitted by an isolated-engine bridge, or undefined for other bridges. */
export function engineAgentViewLastRequestId(bridge: AgentViewBridge): number | undefined {
	return engineBridgeSet.has(bridge) ? (bridge as EngineAgentViewBridge).lastRequestId() : undefined;
}

/** Highest `settledRequestId` received by an isolated-engine bridge, or undefined for other bridges. */
export function engineAgentViewSettledRequestId(bridge: AgentViewBridge): number | undefined {
	return engineBridgeSet.has(bridge) ? (bridge as EngineAgentViewBridge).settledRequestId() : undefined;
}

/** True once the isolated-engine bridge has observed a typed host (`viewSeq` / `settledRequestId`). */
export function engineAgentViewHasTypedHost(bridge: AgentViewBridge): boolean {
	return engineBridgeSet.has(bridge) && (bridge as EngineAgentViewBridge).hasTypedHost();
}

/**
 * Attach the engine's `AgentViewBridge` to `context.session`: `set_viewed_agent` feeds committed `viewedTaskId` and
 * panel-only speculative preview state, and `requestView` sends `engine_view_agent` (with monotonic `requestId`) to
 * the host, whose screen decides. Answers the detach.
 */
export function installEngineAgentViewBridge(context: EngineAgentViewContext): () => void {
	const session = context.session;
	let state: EngineAgentViewState = initialEngineAgentViewState();
	const listeners = new Set<() => void>();
	const notifyListeners = () => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// A listener's failure must not keep the others from learning what the screen shows.
			}
		}
	};
	const syncPreviewWeakMap = (bridgeObj: AgentViewBridge) => {
		if (state.preview.kind === "preview") {
			setBridgePanelPreview(bridgeObj, { taskId: state.preview.taskId, previewSeq: state.preview.previewSeq });
		} else {
			setBridgePanelPreview(bridgeObj, undefined);
		}
	};
	const bridge: EngineAgentViewBridge = {
		viewedTaskId: () => state.committed,
		settlementSeq: () => state.settledCount,
		legacySettlementSeq: () => state.legacySettledCount,
		lastRequestId: () => state.lastRequestId,
		settledRequestId: () => state.settledRequestId,
		hasTypedHost: () => state.appliedViewSeq > 0 || state.settledCount > state.legacySettledCount,
		requestView: (taskId, options) => {
			const begun = beginEngineViewRequest(state);
			state = begun.state;
			syncPreviewWeakMap(bridge);
			if (begun.previewCleared) notifyListeners();
			const keepScreen = options?.keepScreen === true;
			// What keeps the screen (`/tasks`) hid the panel; the host waits for it when it opens again as that closes.
			const panel = keepScreen && taskId !== undefined && agentPanelReturnsOnShow(session);
			// When the panel lists the subagent only once the screen shows it, a host that says first what it is about to
			// show waits for that panel too.
			const panelOnView = keepScreen && taskId !== undefined && !panel && agentPanelReturnsOnShow(session, taskId);
			context.send({
				type: "engine_view_agent",
				taskId: taskId ?? null,
				requestId: begun.requestId,
				...(keepScreen ? { keepScreen: true as const } : {}),
				...(panel ? { panel: true as const } : {}),
				...(panelOnView ? { panelOnView: true as const } : {}),
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		applyHostSetViewed(command) {
			const transition = applyEngineSetViewedAgent(state, command);
			state = transition.state;
			syncPreviewWeakMap(bridge);
			if (transition.panelChanged) notifyListeners();
			return { ...(transition.settle === undefined ? {} : { settle: transition.settle }) };
		},
	};
	setAgentViewBridge(session, bridge);
	engineBridges.set(session, bridge);
	engineBridgeSet.add(bridge);
	return () => {
		setBridgePanelPreview(bridge, undefined);
		if (engineBridges.get(session) === bridge) engineBridges.delete(session);
		if (agentViewBridge(session) === bridge) setAgentViewBridge(session, undefined);
		listeners.clear();
	};
}

/** The host's screen now shows (or speculatively previews) the subagent `taskId` names, or main without one. */
export async function handleSetViewedAgent(
	command: Command<"set_viewed_agent">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const taskId = command.taskId === undefined ? undefined : (command.taskId as TaskId);
	const bridge = engineBridges.get(context.session);
	const store = getOwnerTaskStore(context.session);
	if (bridge !== undefined) {
		const { settle } = bridge.applyHostSetViewed({
			taskId,
			...(command.preview === true ? { preview: true as const } : {}),
			...(command.viewSeq === undefined ? {} : { viewSeq: command.viewSeq }),
			...(command.requestId === undefined ? {} : { requestId: command.requestId }),
			...(command.settledRequestId === undefined ? {} : { settledRequestId: command.settledRequestId }),
		});
		if (settle !== undefined) {
			if (settle.supersededOnly === true) {
				const pendingReqId = store === undefined ? undefined : tasksReturnRecord(store)?.pending?.requestId;
				if (
					pendingReqId !== undefined &&
					settle.settledRequestId !== undefined &&
					pendingReqId <= settle.settledRequestId
				) {
					settleStoreTasksReturn(store, settle.viewed, settle.settledRequestId);
				}
			} else {
				settleStoreTasksReturn(store, settle.viewed, settle.settledRequestId);
			}
		}
	} else if (command.preview !== true) {
		settleStoreTasksReturn(store, taskId, command.settledRequestId);
	}
	return createRpcSuccessResponse(command.id, command.type);
}
