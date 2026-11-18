import { stripVTControlCharacters } from "node:util";
import type { Component } from "@bastani/atomic-tui";
import {
	formatTaskHeartbeatDuration,
	formatTaskHeartbeatStatus,
	type TaskHeartbeatDetails,
	type TaskHeartbeatTask,
	taskHeartbeatKindLabel,
} from "../../../core/tasks/heartbeat-notice.js";
import { theme } from "../theme/theme.js";
import { HeartbeatBlock, type HeartbeatRow } from "./heartbeat-block.ts";

function isNamedTask(value: unknown): value is TaskHeartbeatDetails["more"][number] {
	if (!value || typeof value !== "object") return false;
	const task = value as Partial<TaskHeartbeatTask>;
	return (
		typeof task.taskId === "string" &&
		(task.kind === "agent" || task.kind === "command") &&
		typeof task.title === "string"
	);
}

function isHeartbeatTask(value: unknown): value is TaskHeartbeatTask {
	if (!isNamedTask(value)) return false;
	const task = value as Partial<TaskHeartbeatTask>;
	return typeof task.elapsedMs === "number" && typeof task.intervalMs === "number";
}

/** The structured heartbeat a card was raised with, or `undefined` when the entry does not carry one. */
export function heartbeatDetailsFrom(details: unknown): TaskHeartbeatDetails | undefined {
	if (!details || typeof details !== "object") return undefined;
	const candidate = details as Partial<TaskHeartbeatDetails>;
	if (!Array.isArray(candidate.tasks) || !candidate.tasks.every(isHeartbeatTask)) return undefined;
	return {
		scheduledAt: typeof candidate.scheduledAt === "number" ? candidate.scheduledAt : 0,
		tasks: candidate.tasks,
		more: Array.isArray(candidate.more) ? candidate.more.filter(isNamedTask) : [],
		moreCount: typeof candidate.moreCount === "number" ? candidate.moreCount : 0,
	};
}

const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ");

/** Tasks listed while a task heartbeat is collapsed; the rest are counted in one `… +N more` row. */
export const TASK_HEARTBEAT_COLLAPSED_TASKS = 5;

/**
 * A task heartbeat in its chat, in the shared notice anatomy: `♥ Task heartbeat · N tasks still running`, one
 * connector row per task, and each task's status and last output lines when expanded.
 */
export class TaskHeartbeatMessage implements Component {
	private readonly details: TaskHeartbeatDetails;
	private readonly expanded: boolean;
	private readonly outputPad: number | undefined;
	constructor(details: TaskHeartbeatDetails, expanded: boolean, outputPad?: number) {
		this.details = details;
		this.expanded = expanded;
		this.outputPad = outputPad;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const { tasks, moreCount } = this.details;
		const total = tasks.length + moreCount;
		const shown = this.expanded ? tasks : tasks.slice(0, TASK_HEARTBEAT_COLLAPSED_TASKS);
		const records: HeartbeatRow[][] = shown.map((task) => {
			const rows: HeartbeatRow[] = [
				`${theme.fg("accent", `${taskHeartbeatKindLabel(task.kind)} ${clean(task.taskId)}`)} ${theme.fg("text", clean(task.title))}${theme.fg("dim", ` · ${formatTaskHeartbeatDuration(task.elapsedMs)}`)}`,
			];
			if (!this.expanded) return rows;
			rows.push({ text: theme.fg("muted", clean(formatTaskHeartbeatStatus(task))), wrap: true });
			for (const line of task.output?.tail ?? []) rows.push(theme.fg("dim", `│ ${clean(line)}`));
			return rows;
		});
		const hidden = tasks.length - shown.length + moreCount;
		if (hidden > 0) records.push([theme.fg("muted", `… +${hidden} more`)]);
		return new HeartbeatBlock({
			title: "Task heartbeat",
			meta: [`${total === 1 ? "1 task" : `${total} tasks`} still running`],
			records,
			hint: "/tasks to inspect",
			// Collapsed, each task hides its status and output lines.
			expandable: tasks.length > 0,
			expanded: this.expanded,
			outputPad: this.outputPad,
		}).render(width);
	}
}
