// S-B (prompt) owns this module. C0 stub.
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcErrorResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

const UNAVAILABLE = "Messaging a viewed subagent is not available yet";

export async function handleAgentViewPrompt(
	command: Command<"agent_view_prompt">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, UNAVAILABLE);
}

export async function handleAgentViewResume(
	command: Command<"agent_view_resume">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, UNAVAILABLE);
}

export async function handleAgentViewClearQueue(
	command: Command<"agent_view_clear_queue">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, UNAVAILABLE);
}

export async function handleAgentViewPause(
	command: Command<"agent_view_pause">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, UNAVAILABLE);
}
