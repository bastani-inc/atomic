import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../../core/tasks/owner-store.js";

/**
 * How the agent panel and `/tasks` read and change what the screen shows, wherever they are drawn: in this process,
 * or in the isolated engine for the host. A session without a bridge keeps opening a subagent's chat page, as SDK
 * hosts do.
 */
export interface AgentViewBridge {
	/** The task id of the subagent the screen shows; undefined while it shows main. */
	viewedTaskId(): TaskId | undefined;
	/** Show the subagent `taskId` is an attempt of, or main when undefined. The host decides; nothing is awaited. */
	requestView(taskId: TaskId | undefined): void;
	subscribe(listener: () => void): () => void;
}

const bridges = new WeakMap<object, AgentViewBridge>();

/** Attach `bridge` to `session` and its owner task store, or detach it with undefined. */
export function setAgentViewBridge(session: object, bridge: AgentViewBridge | undefined): void {
	const store = getOwnerTaskStore(session);
	for (const key of store === undefined ? [session] : [session, store]) {
		if (bridge === undefined) bridges.delete(key);
		else bridges.set(key, bridge);
	}
}

/** The bridge of `session`, found through the session itself or its owner task store. */
export function agentViewBridge(session: object): AgentViewBridge | undefined {
	const direct = bridges.get(session);
	if (direct !== undefined) return direct;
	const store = getOwnerTaskStore(session);
	return store === undefined ? undefined : bridges.get(store);
}
