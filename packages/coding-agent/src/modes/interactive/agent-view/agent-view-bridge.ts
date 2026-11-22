import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskStore, type OwnerTaskStore } from "../../../core/tasks/owner-store.js";

/**
 * How the agent panel and `/tasks` read and change what the screen shows, wherever they are drawn: in this process,
 * or in the isolated engine for the host. A session without a bridge keeps opening a subagent's chat page, as SDK
 * hosts do.
 */
export interface AgentViewBridge {
	/** The task id of the subagent the screen shows; undefined while it shows main. */
	viewedTaskId(): TaskId | undefined;
	/** Show the subagent `taskId` is an attempt of, or main when undefined. The host decides; nothing is awaited. */
	requestView(taskId: TaskId | undefined, options?: AgentViewRequestOptions): void;
	subscribe(listener: () => void): () => void;
}

export interface AgentViewRequestOptions {
	/**
	 * The request closes what asked for it (`/tasks`): the prompt, footer and panel stay as painted until the subagent
	 * is shown or cannot be, so the main chat's prompt is never painted in between.
	 */
	readonly keepScreen?: boolean;
	/**
	 * With `keepScreen`: what asked for it hid the agent panel and shows it again as it closes, in another process. The
	 * subagent is shown once that panel can draw too, so the screen never shows it without the panel's rows.
	 */
	readonly panel?: boolean;
}

const bridges = new WeakMap<object, AgentViewBridge>();
const bridgeOwners = new WeakMap<AgentViewBridge, WeakRef<OwnerTaskStore>>();

/** Attach `bridge` to `session` and its owner task store, or detach it with undefined. */
export function setAgentViewBridge(session: object, bridge: AgentViewBridge | undefined): void {
	const store = getOwnerTaskStore(session);
	const previous = bridges.get(session) ?? (store === undefined ? undefined : bridges.get(store));
	for (const key of store === undefined ? [session] : [session, store]) {
		if (bridge === undefined) bridges.delete(key);
		else bridges.set(key, bridge);
	}
	if (
		previous !== undefined &&
		previous !== bridge &&
		(store === undefined || bridgeOwners.get(previous)?.deref() === store)
	) {
		bridgeOwners.delete(previous);
	}
	if (bridge !== undefined && store !== undefined) {
		bridgeOwners.set(bridge, new WeakRef(store));
	}
}

/** The owner task store weakly associated with `bridge`, if still alive. */
export function ownerTaskStoreForBridge(bridge: AgentViewBridge): OwnerTaskStore | undefined {
	return bridgeOwners.get(bridge)?.deref();
}

/** The bridge of `session`, found through the session itself or its owner task store. */
export function agentViewBridge(session: object): AgentViewBridge | undefined {
	const direct = bridges.get(session);
	if (direct !== undefined) return direct;
	const store = getOwnerTaskStore(session);
	return store === undefined ? undefined : bridges.get(store);
}
