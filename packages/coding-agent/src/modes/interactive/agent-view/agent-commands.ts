// S-D (commands) owns this module. C0 stub: no catalog.
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { AgentViewRuntime } from "./agent-steering.ts";
import type { AgentViewCommands } from "./contracts.ts";

/** The slash commands the subagent's own session runs, read where it lives. */
export async function localAgentCommands(
	_source: TaskViewSource,
	_taskId: TaskId,
): Promise<AgentViewCommands | undefined> {
	return undefined;
}

/** The same, read through the isolated engine for view `viewId`. */
export async function remoteAgentCommands(
	_runtime: AgentViewRuntime,
	_viewId: string,
): Promise<AgentViewCommands | undefined> {
	return undefined;
}
