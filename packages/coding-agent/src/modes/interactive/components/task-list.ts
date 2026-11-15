import type { Component } from "@bastani/atomic-tui";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { theme } from "../theme/theme.js";
import { renderAgentPanelRows, taskPanelRows } from "./agent-panel.ts";
import { TaskRow, taskLabel, taskTitle } from "./task-row.js";

/** Complete projection; viewport owners, not this list, decide how much to mount. */
export class TaskList implements Component {
	private readonly tasks: readonly TaskRecord[];
	private readonly expanded: boolean;
	constructor(tasks: readonly TaskRecord[], expanded = false) {
		this.tasks = tasks;
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.tasks.flatMap((task) => {
			const duplicate =
				this.tasks.filter((item) => taskLabel(item) === taskLabel(task) && taskTitle(item) === taskTitle(task))
					.length > 1;
			return new TaskRow(task, { expanded: this.expanded, duplicate, siblings: this.tasks }).render(width);
		});
	}
}
export type TaskListSection = { title: string; tasks: TaskRecord[] };

function statusRank(task: TaskRecord): number {
	const execution = task.execution;
	if (execution.kind === "running") return task.attention.kind === "none" ? 1 : 0;
	if (execution.kind === "cancelling") return 2;
	if (execution.kind === "queued") return 3;
	return { failed: 4, cancelled: 5, completed: 6 }[execution.result.kind];
}

/**
 * Sections list running work first, then stopping, queued, failed, cancelled and completed tasks.
 * Within a status, the latest launch comes first; settled tasks use the latest settlement when known,
 * and fall back to launch order when their settlement sequences tie.
 */
export function taskListSections(
	tasks: readonly TaskRecord[],
	settlementOrder: ReadonlyMap<TaskId, bigint> = new Map(),
): TaskListSection[] {
	const launchOrder = new Map(tasks.map((task, index) => [task.ref.taskId, index]));
	const newerFirst = (a: TaskRecord, b: TaskRecord) => {
		const settledA = a.execution.kind === "settled" ? settlementOrder.get(a.ref.taskId) : undefined;
		const settledB = b.execution.kind === "settled" ? settlementOrder.get(b.ref.taskId) : undefined;
		if (settledA !== undefined && settledB !== undefined && settledA !== settledB)
			return settledB > settledA ? 1 : -1;
		return (launchOrder.get(b.ref.taskId) ?? 0) - (launchOrder.get(a.ref.taskId) ?? 0);
	};
	const ordered = [...tasks].sort((a, b) => statusRank(a) - statusRank(b) || newerFirst(a, b));
	return (["agent", "command"] as const).flatMap((kind) => {
		const selected = ordered.filter((task) => task.kind === kind);
		return selected.length ? [{ title: kind === "agent" ? "Agents" : "Shells", tasks: selected }] : [];
	});
}
/** Terminal results remain inspectable but no longer advertise active work. */
export function isActiveBackgroundTask(task: TaskRecord): boolean {
	return task.observation.kind === "background" && task.execution.kind !== "settled";
}
/**
 * The rows of a chat's active background agents and shells, as the agent panel draws them: a stage or subagent chat
 * shows its own tasks this way below its prompt. Finished tasks leave at once; `/tasks` keeps them.
 */
export function renderTaskFooter(tasks: readonly TaskRecord[], width: number): string[] {
	const active = tasks.filter(isActiveBackgroundTask);
	return renderAgentPanelRows(taskPanelRows({ backgroundTasks: active }, new Set()).reverse(), width, {
		dim: (text) => theme.fg("dim", text),
		text: (text) => theme.fg("text", text),
		muted: (text) => theme.fg("muted", text),
		border: (text) => theme.fg("borderMuted", text),
		bold: (text) => theme.bold(text),
		accent: (text) => theme.fg("accent", text),
		success: (text) => theme.fg("success", text),
		error: (text) => theme.fg("error", text),
		warning: (text) => theme.fg("warning", text),
	});
}
