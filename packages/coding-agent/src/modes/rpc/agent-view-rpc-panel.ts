import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import {
	type AgentViewBridge,
	agentViewBridge,
	setAgentViewBridge,
} from "../interactive/agent-view/agent-view-bridge.ts";
import { settleStoreTasksReturn } from "../interactive/components/task-selection-state.js";
import { agentPanelReturnsOnShow } from "./agent-panel-bridge.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The engine's copy of what the host's screen shows, which the host keeps current with `set_viewed_agent`. */
interface EngineAgentViewBridge extends AgentViewBridge {
	show(taskId: TaskId | undefined): void;
	settlementSeq(): number;
	noteSettled(): void;
}

const engineBridges = new WeakMap<object, EngineAgentViewBridge>();
const engineBridgeSet = new WeakSet<AgentViewBridge>();

/** Current settlement counter of an isolated-engine bridge, or undefined for other bridges. */
export function engineAgentViewSettlementSeq(bridge: AgentViewBridge): number | undefined {
	return engineBridgeSet.has(bridge) ? (bridge as EngineAgentViewBridge).settlementSeq() : undefined;
}

/**
 * Attach the engine's `AgentViewBridge` to `context.session`: `set_viewed_agent` feeds `viewedTaskId`, and
 * `requestView` sends `engine_view_agent` to the host, whose screen decides. Answers the detach.
 */
export function installEngineAgentViewBridge(context: EngineAgentViewContext): () => void {
	const session = context.session;
	let viewed: TaskId | undefined;
	let settledCount = 0;
	const listeners = new Set<() => void>();
	const bridge: EngineAgentViewBridge = {
		viewedTaskId: () => viewed,
		settlementSeq: () => settledCount,
		noteSettled: () => {
			settledCount++;
		},
		requestView: (taskId, options) => {
			const keepScreen = options?.keepScreen === true;
			// What keeps the screen (`/tasks`) hid the panel; the host waits for it when it opens again as that closes.
			const panel = keepScreen && taskId !== undefined && agentPanelReturnsOnShow(session);
			// When the panel lists the subagent only once the screen shows it, a host that says first what it is about to
			// show waits for that panel too.
			const panelOnView = keepScreen && taskId !== undefined && !panel && agentPanelReturnsOnShow(session, taskId);
			context.send({
				type: "engine_view_agent",
				taskId: taskId ?? null,
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
		show(taskId) {
			if (viewed === taskId) return;
			viewed = taskId;
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					// A listener's failure must not keep the others from learning what the screen shows.
				}
			}
		},
	};
	setAgentViewBridge(session, bridge);
	engineBridges.set(session, bridge);
	engineBridgeSet.add(bridge);
	return () => {
		if (engineBridges.get(session) === bridge) engineBridges.delete(session);
		if (agentViewBridge(session) === bridge) setAgentViewBridge(session, undefined);
		listeners.clear();
	};
}

/** The host's screen now shows the subagent `taskId` names, or main without one. */
export async function handleSetViewedAgent(
	command: Command<"set_viewed_agent">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const taskId = command.taskId === undefined ? undefined : (command.taskId as TaskId);
	const bridge = engineBridges.get(context.session);
	bridge?.noteSettled();
	bridge?.show(taskId);
	settleStoreTasksReturn(getOwnerTaskStore(context.session), taskId);
	return createRpcSuccessResponse(command.id, command.type);
}
