import { asyncScope } from "../async-scope.ts";
import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskId } from "./contracts.js";

export type AdmittedAgentTask = { host: AgentTaskHost; taskId: TaskId };
type TaskScope = { signal: AbortSignal; tasks: AdmittedAgentTask[] };
const executionScope = asyncScope<TaskScope>();

/** Internal durable callback boundary; admission still belongs to the actual host. */
export async function collectAgentTasks<T>(
	signal: AbortSignal,
	callback: () => Promise<T>,
	settle: (value: T, tasks: AdmittedAgentTask[]) => Promise<T>,
): Promise<T> {
	const scope: TaskScope = { signal, tasks: [] };
	const cancel = () => {
		for (const task of scope.tasks) void task.host.cancelTask(task.taskId, "owner-close");
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		return await executionScope.run(scope, async () => settle(await callback(), scope.tasks));
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

export function trackAdmittedAgentTask(task: AdmittedAgentTask): void {
	const scope = executionScope.getStore();
	if (!scope) return;
	if (!scope.tasks.some((entry) => entry.host === task.host && entry.taskId === task.taskId)) scope.tasks.push(task);
	if (scope.signal.aborted) void task.host.cancelTask(task.taskId, "owner-close");
}
