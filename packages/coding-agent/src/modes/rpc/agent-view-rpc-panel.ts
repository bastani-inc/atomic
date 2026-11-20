// S-C (panel) owns this module. C0 stub: the engine's panel and /tasks have no bridge yet, so they keep opening the
// subagent's chat page.
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/**
 * Attach the engine's `AgentViewBridge` to `context.session`: `set_viewed_agent` feeds `viewedTaskId`, and
 * `requestView` sends `engine_view_agent` to the host. Answers the detach.
 */
export function installEngineAgentViewBridge(_context: EngineAgentViewContext): () => void {
	return () => {};
}

export async function handleSetViewedAgent(
	command: Command<"set_viewed_agent">,
	_context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return createRpcSuccessResponse(command.id, command.type);
}
