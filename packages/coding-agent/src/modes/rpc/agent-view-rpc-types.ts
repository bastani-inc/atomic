/**
 * The commands an interactive host sends its isolated engine to show one of the engine's subagents on the host's main
 * screen: its transcript in the transcript area, and the host's prompt retargeted to it.
 */

import type { ClearedQueue, PromptDisposition } from "../../core/agent-session-types.js";
import type { QueuedTaskMessages } from "../../core/tasks/supervisor.js";
import type { TaskViewResult } from "../../core/tasks/task-view-source.js";
import type { AgentViewCommands, AgentViewStatus } from "../interactive/agent-view/contracts.ts";
import type { SteeringSubmitLane } from "../interactive/steering-queue-controller.ts";

export type AgentViewRpcCommand =
	/** Open a view of the subagent `taskId` is an attempt of: its status, and its transcript as a remote component. */
	| { id?: string; type: "agent_view_open"; taskId: string }
	| { id?: string; type: "agent_view_close"; viewId: string }
	/** Send `message` to the viewed subagent: queued in `streamingBehavior`'s lane, or starting its next turn. */
	| {
			id?: string;
			type: "agent_view_prompt";
			viewId: string;
			message: string;
			streamingBehavior?: "steer" | "followUp";
	  }
	/** Continue the paused or finished viewed subagent with `message`. */
	| { id?: string; type: "agent_view_resume"; viewId: string; message: string; lane: SteeringSubmitLane }
	| { id?: string; type: "agent_view_clear_queue"; viewId: string }
	/** Esc: pause the viewed subagent, taking its queued messages back. */
	| { id?: string; type: "agent_view_pause"; viewId: string }
	| { id?: string; type: "agent_view_commands"; viewId: string }
	| { id?: string; type: "agent_view_last_message"; viewId: string }
	/** The subagent's own delivered user messages, oldest first. */
	| { id?: string; type: "get_task_prompts"; taskId: string }
	/** What the host's screen shows, for the engine's agent panel and `/tasks`: a subagent, or main without `taskId`. */
	| { id?: string; type: "set_viewed_agent"; taskId?: string };

export type AgentViewRpcCommandType = AgentViewRpcCommand["type"];

/** A command as a client sends it: the request id is the client's. */
export type AgentViewRpcCommandBody = AgentViewRpcCommand extends infer C
	? C extends AgentViewRpcCommand
		? Omit<C, "id">
		: never
	: never;

export interface AgentViewOpenData {
	readonly viewId: string;
	/** The remote component the engine opened with `placement: "transcript"` for this view. */
	readonly componentId: string;
	readonly status: AgentViewStatus;
}

export type AgentViewRpcResponse =
	| { id?: string; type: "response"; command: "agent_view_open"; success: true; data: AgentViewOpenData }
	| { id?: string; type: "response"; command: "agent_view_close"; success: true }
	| {
			id?: string;
			type: "response";
			command: "agent_view_prompt";
			success: true;
			data: { disposition?: PromptDisposition };
	  }
	| { id?: string; type: "response"; command: "agent_view_resume"; success: true }
	| { id?: string; type: "response"; command: "agent_view_clear_queue"; success: true; data: ClearedQueue }
	| {
			id?: string;
			type: "response";
			command: "agent_view_pause";
			success: true;
			data: TaskViewResult<QueuedTaskMessages>;
	  }
	| {
			id?: string;
			type: "response";
			command: "agent_view_commands";
			success: true;
			data: AgentViewCommands | null;
	  }
	| { id?: string; type: "response"; command: "agent_view_last_message"; success: true; data: { text?: string } }
	| { id?: string; type: "response"; command: "get_task_prompts"; success: true; data: { prompts: string[] } }
	| { id?: string; type: "response"; command: "set_viewed_agent"; success: true };

const AGENT_VIEW_COMMAND_TYPES: ReadonlySet<string> = new Set<AgentViewRpcCommandType>([
	"agent_view_open",
	"agent_view_close",
	"agent_view_prompt",
	"agent_view_resume",
	"agent_view_clear_queue",
	"agent_view_pause",
	"agent_view_commands",
	"agent_view_last_message",
	"get_task_prompts",
	"set_viewed_agent",
]);

export function isAgentViewRpcCommand(command: { readonly type: string }): command is AgentViewRpcCommand {
	return AGENT_VIEW_COMMAND_TYPES.has(command.type);
}
