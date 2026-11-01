import { stripVTControlCharacters } from "node:util";
import { Box, type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	formatTaskHeartbeatDuration,
	formatTaskHeartbeatStatus,
	type TaskHeartbeatDetails,
	type TaskHeartbeatTask,
	taskHeartbeatKindLabel,
} from "../../../core/tasks/heartbeat-notice.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";

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

/** Compact heartbeat card in the owning chat: one row per task, status and output lines when expanded. */
export class TaskHeartbeatMessage implements Component {
	private readonly details: TaskHeartbeatDetails;
	private readonly expanded: boolean;
	constructor(details: TaskHeartbeatDetails, expanded: boolean) {
		this.details = details;
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const card = new Box(width >= 3 ? 1 : 0, 1, (line) => theme.bg("customMessageBg", line));
		card.addChild({
			invalidate() {},
			render: (innerWidth) => this.renderContent(innerWidth),
		});
		return card.render(width);
	}
	private renderContent(width: number): string[] {
		const { tasks, moreCount } = this.details;
		const total = tasks.length + moreCount;
		const lines = [
			theme.fg(
				"accent",
				theme.bold(`♥ Task heartbeat · ${total === 1 ? "1 task" : `${total} tasks`} still running`),
			),
		];
		for (const task of tasks) {
			lines.push(
				`  ${theme.fg("accent", `${taskHeartbeatKindLabel(task.kind)} ${task.taskId}`)} ${theme.fg("text", clean(task.title))} ${theme.fg("dim", `· ${formatTaskHeartbeatDuration(task.elapsedMs)}`)}`,
			);
			if (!this.expanded) continue;
			for (const row of wrapTextWithAnsi(clean(formatTaskHeartbeatStatus(task)), Math.max(1, width - 4)))
				lines.push(theme.fg("muted", `    ${row}`));
			for (const line of task.output?.tail ?? []) lines.push(theme.fg("dim", `    │ ${clean(line)}`));
		}
		if (moreCount > 0) lines.push(theme.fg("muted", `  and ${moreCount} more`));
		const expand = this.expanded ? "" : keyHintIfBound("app.tools.expand", "Expand");
		lines.push(theme.fg("dim", `${expand ? `(${expand}) · ` : ""}periodic check · /tasks to inspect`));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
