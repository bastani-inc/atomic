import type { TaskId } from "../../core/tasks/contracts.js";
import { engineAgentViewRegistry } from "./agent-view-engine-registry.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewOpenData, AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcErrorResponse, createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

export { bindEngineAgentViews, type EngineAgentViews, engineAgentViews } from "./agent-view-engine-registry.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** Open a view of the subagent `taskId` is an attempt of: its status, and its transcript as a remote component. */
export async function handleAgentViewOpen(
	command: Command<"agent_view_open">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const registry = engineAgentViewRegistry(context.session);
	if (registry === undefined)
		return createRpcErrorResponse(command.id, command.type, "Viewing a subagent requires an interactive host");
	const opened = await registry.open(command.taskId as TaskId);
	if (opened === undefined) return createRpcErrorResponse(command.id, command.type, "That subagent is not listed.");
	const data: AgentViewOpenData = {
		viewId: opened.viewId,
		componentId: opened.view.componentId,
		status: opened.view.port.status(),
	};
	return createRpcSuccessResponse(command.id, command.type, data);
}

export async function handleAgentViewClose(
	command: Command<"agent_view_close">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	engineAgentViewRegistry(context.session)?.close(command.viewId);
	return createRpcSuccessResponse(command.id, command.type);
}

export async function handleAgentViewLastMessage(
	command: Command<"agent_view_last_message">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const port = engineAgentViewRegistry(context.session)?.port(command.viewId);
	if (port === undefined) return createRpcErrorResponse(command.id, command.type, "That view is closed.");
	const text = await port.lastAgentMessageText();
	return createRpcSuccessResponse(command.id, command.type, text === undefined ? {} : { text });
}
