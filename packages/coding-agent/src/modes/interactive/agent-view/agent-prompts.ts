// The history slice owns this module. C0 stub: no delivered prompts.
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { AgentViewRuntime } from "./agent-steering.ts";

/** The subagent's own delivered user messages, oldest first, read where its session lives. */
export async function localAgentPrompts(_source: TaskViewSource, _taskId: TaskId): Promise<readonly string[]> {
	return [];
}

/** The same, read through the isolated engine. */
export async function remoteAgentPrompts(_runtime: AgentViewRuntime, _taskId: TaskId): Promise<readonly string[]> {
	return [];
}
