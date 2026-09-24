import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { theme } from "../theme/theme.js";
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
export function renderTaskFooter(tasks: readonly TaskRecord[], width: number): string[] {
	const active = tasks.filter(isActiveBackgroundTask);
	const background = active.filter((task) => task.execution.kind === "running" || task.execution.kind === "queued");
	const attention = active.filter((task) => task.attention.kind !== "none");
	if (!active.length) return [];
	const parts: string[] = [];
	if (attention.length) parts.push(`${attention.length} need attention`);
	const agents = background.filter((task) => task.kind === "agent" && task.execution.kind === "running").length;
	const shells = background.filter((task) => task.kind === "command" && task.execution.kind === "running").length;
	const queued = background.filter((task) => task.execution.kind === "queued").length;
	if (agents && shells) parts.push(`${agents + shells} background tasks running`);
	else if (agents) parts.push(`${agents} ${agents === 1 ? "local agent" : "local agents"} running`);
	else if (shells) parts.push(`${shells} ${shells === 1 ? "shell" : "shells"} running`);
	if (queued) parts.push(`${queued} queued`);
	const cancelling = active.filter((task) => task.execution.kind === "cancelling").length;
	if (cancelling) parts.push(`${cancelling} stopping`);
	if (!parts.length) parts.push(`${active.length} active`);
	const route = " · /tasks";
	return [
		theme.fg(
			attention.length || cancelling ? "warning" : "accent",
			truncateToWidth(
				truncateToWidth(`Tasks  ${parts.join(" · ")}`, Math.max(1, width - route.length)) + route,
				width,
			),
		),
	];
}
