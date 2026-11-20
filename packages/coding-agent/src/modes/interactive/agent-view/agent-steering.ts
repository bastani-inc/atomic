// S-B (prompt) owns this module. C0 stub: the types are the contract; the implementations refuse.
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import type { SteeringTarget } from "../steering-queue-controller.ts";
import type { AgentSteeringPort, AgentViewStatus } from "./contracts.ts";

/** The isolated runtime as the agent-view proxies use it. */
export type AgentViewRuntime = Pick<
	IsolatedInteractiveRuntime,
	"requestAgentView" | "onEngineMessage" | "onGenerationEnded" | "getGeneration"
>;

/** A subagent in this process (or in the engine, for the engine's own port). */
export interface LocalAgentContext {
	readonly source: TaskViewSource;
	/** The latest attempt now. */
	liveTaskId(): TaskId;
	status(): AgentViewStatus;
	onStatus(listener: () => void): () => void;
}

/** A subagent in the isolated engine, reached through view `viewId`. */
export interface RemoteAgentContext {
	readonly runtime: AgentViewRuntime;
	readonly viewId: string;
	status(): AgentViewStatus;
	onStatus(listener: () => void): () => void;
}

const UNAVAILABLE = "Messaging a viewed subagent is not available yet";

function refusingSteering(status: () => AgentViewStatus): AgentSteeringPort {
	const steering: SteeringTarget = {
		get busy() {
			return status().busy;
		},
		get paused() {
			return status().paused;
		},
		queued: () => status().queued,
		prompt: async () => {
			throw new Error(UNAVAILABLE);
		},
		clearQueue: async () => {
			throw new Error(UNAVAILABLE);
		},
	};
	return { steering, pause: async () => ({ ok: false, error: { message: UNAVAILABLE } }) };
}

export function createLocalAgentSteering(ctx: LocalAgentContext): AgentSteeringPort {
	return refusingSteering(() => ctx.status());
}

export function createRemoteAgentSteering(ctx: RemoteAgentContext): AgentSteeringPort {
	return refusingSteering(() => ctx.status());
}
