import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { engineAgentViews } from "./agent-view-rpc-view.ts";
import { createRpcErrorResponse, createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The slash commands of the subagent the host shows through view `viewId`, read from its session in this engine. */
export async function handleAgentViewCommands(
	command: Command<"agent_view_commands">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const port = engineAgentViews(context.session).port(command.viewId);
	if (port === undefined) return createRpcErrorResponse(command.id, command.type, "This subagent view is closed");
	try {
		return createRpcSuccessResponse(command.id, command.type, (await port.commands()) ?? null);
	} catch (error) {
		return createRpcErrorResponse(command.id, command.type, error instanceof Error ? error.message : String(error));
	}
}
