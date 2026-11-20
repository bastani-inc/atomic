// The history slice owns this module. C0 stub: no prompts yet.
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

export async function handleGetTaskPrompts(
	command: Command<"get_task_prompts">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcSuccessResponse(command.id, command.type, { prompts: [] });
}
