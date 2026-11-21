import type { TaskId } from "../../core/tasks/contracts.js";
import {
	type AgentViewBridge,
	agentViewBridge,
	setAgentViewBridge,
} from "../interactive/agent-view/agent-view-bridge.ts";
import { agentPanelReturnsOnShow } from "./agent-panel-bridge.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The engine's copy of what the host's screen shows, which the host keeps current with `set_viewed_agent`. */
interface EngineAgentViewBridge extends AgentViewBridge {
	show(taskId: TaskId | undefined): void;
}

const engineBridges = new WeakMap<object, EngineAgentViewBridge>();

/**
 * Attach the engine's `AgentViewBridge` to `context.session`: `set_viewed_agent` feeds `viewedTaskId`, and
 * `requestView` sends `engine_view_agent` to the host, whose screen decides. Answers the detach.
 */
export function installEngineAgentViewBridge(context: EngineAgentViewContext): () => void {
	const session = context.session;
	let viewed: TaskId | undefined;
	const listeners = new Set<() => void>();
	const bridge: EngineAgentViewBridge = {
		viewedTaskId: () => viewed,
		requestView: (taskId, options) => {
			const keepScreen = options?.keepScreen === true;
			context.send({
				type: "engine_view_agent",
				taskId: taskId ?? null,
				...(keepScreen ? { keepScreen: true as const } : {}),
				// What keeps the screen (`/tasks`) hid the panel; the host waits for it when it opens again as that closes.
				...(keepScreen && taskId !== undefined && agentPanelReturnsOnShow(session) ? { panel: true as const } : {}),
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
	engineBridges.get(context.session)?.show(command.taskId === undefined ? undefined : (command.taskId as TaskId));
	return createRpcSuccessResponse(command.id, command.type);
}
