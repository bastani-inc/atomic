import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { readTaskPrompts } from "../../core/tasks/task-prompts.ts";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { createRpcSuccessResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The host asks for a subagent's own delivered user messages, which the engine reads from its session. */
export async function handleGetTaskPrompts(
	command: Command<"get_task_prompts">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	const store = getOwnerTaskStore(context.session);
	const prompts =
		store === undefined ? [] : await readTaskPrompts(ownerTaskViewSource(store), command.taskId as TaskId);
	return createRpcSuccessResponse(command.id, command.type, { prompts: [...prompts] });
}
