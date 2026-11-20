// S-A (view) owns this module. C0 stub: the engine has no views yet.
import type { AgentViewPort } from "../interactive/agent-view/contracts.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcErrorResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The views the host opened on this engine, by view id. */
export interface EngineAgentViews {
	port(viewId: string): AgentViewPort | undefined;
}

const NO_VIEWS: EngineAgentViews = { port: () => undefined };

export function engineAgentViews(_session: object): EngineAgentViews {
	return NO_VIEWS;
}

export function bindEngineAgentViews(_context: EngineAgentViewContext): () => void {
	return () => {};
}

export async function handleAgentViewOpen(
	command: Command<"agent_view_open">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, "Viewing a subagent is not available yet");
}

export async function handleAgentViewClose(
	command: Command<"agent_view_close">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, "Viewing a subagent is not available yet");
}

export async function handleAgentViewLastMessage(
	command: Command<"agent_view_last_message">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcErrorResponse(command.id, command.type, "Viewing a subagent is not available yet");
}
