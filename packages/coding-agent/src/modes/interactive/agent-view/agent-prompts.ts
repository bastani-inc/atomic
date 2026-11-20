import type { TaskId } from "../../../core/tasks/contracts.js";
import { readTaskPrompts } from "../../../core/tasks/task-prompts.ts";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { AgentViewRuntime } from "./agent-steering.ts";

/**
 * The subagent's own delivered user messages, oldest first, read where its session lives: its task, its resume
 * messages and what was typed to it. None when it has no readable session.
 */
export async function localAgentPrompts(source: TaskViewSource, taskId: TaskId): Promise<readonly string[]> {
	return readTaskPrompts(source, taskId);
}

/** The same, read through the isolated engine; none when the engine cannot answer, as for an unreadable session. */
export async function remoteAgentPrompts(runtime: AgentViewRuntime, taskId: TaskId): Promise<readonly string[]> {
	try {
		const answer = await runtime.requestAgentView<{ readonly prompts?: unknown }>({
			type: "get_task_prompts",
			taskId,
		});
		const prompts = answer?.prompts;
		return Array.isArray(prompts) ? prompts.filter((prompt): prompt is string => typeof prompt === "string") : [];
	} catch {
		return [];
	}
}
