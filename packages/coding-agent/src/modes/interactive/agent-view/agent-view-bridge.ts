import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../../core/tasks/owner-store.js";

/**
 * Explicit state of what the screen shows from the bridge's perspective:
 * - `main`: settled on the main chat, with no subagent view request in flight.
 * - `opening`: a subagent view request (`taskId`) is in flight (awaiting host acknowledgment or port open).
 * - `agent`: settled on subagent `taskId`.
 */
export type AgentViewBridgeState =
	| { readonly kind: "main" }
	| { readonly kind: "opening"; readonly taskId: TaskId; readonly previous?: TaskId }
	| { readonly kind: "agent"; readonly taskId: TaskId };

/**
 * How the agent panel and `/tasks` read and change what the screen shows, wherever they are drawn: in this process,
 * or in the isolated engine for the host. A session without a bridge keeps opening a subagent's chat page, as SDK
 * hosts do.
 */
export interface AgentViewBridge {
	/** The task id of the subagent the screen shows; undefined while it shows main. */
	viewedTaskId(): TaskId | undefined;
	/** Typed view state including any in-flight subagent open request. */
	viewState?(): AgentViewBridgeState;
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
