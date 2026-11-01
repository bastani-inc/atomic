import { stripVTControlCharacters } from "node:util";
import { type Component, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Attention, Execution, TaskRecord } from "../../../core/tasks/contracts.js";
import { formatTaskHeartbeatDuration } from "../../../core/tasks/heartbeat-notice.js";
import type { TaskActivity } from "../../../core/tasks/owner-store.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import { taskDisplayText, taskMetricsText, taskModelText, taskStatusAppearance } from "./task-row.js";

export type TaskDetailAction = "transcript" | "foreground" | "cancel" | "input" | "question";

export function taskDetailActions(
	execution: Execution,
	attention: Attention,
	stdinAvailable: boolean,
): TaskDetailAction[] {
	if (execution.kind === "settled") return ["transcript"];
	return [
		"transcript",
		"foreground",
		"cancel",
		...(stdinAvailable ? ["input" as const] : []),
		...(attention.kind === "input-needed" ? ["question" as const] : []),
	];
}

export const taskDetailLabels: Record<TaskDetailAction, string> = {
	transcript: "Inspect transcript",
	foreground: "Foreground wait",
	cancel: "Cancel task…",
	input: "Input",
	question: "Open question",
};

export type TaskDetailContent = {
	prompt?: string;
	output?: string;
	outputOmitted?: boolean;
	stdinAvailable: boolean;
	activity?: readonly TaskActivity[];
	activityOmitted?: boolean;
};

export function taskDetailSummary(task: TaskRecord): string {
	const status = taskStatusAppearance(task);
	const metrics = taskMetricsText(task);
	const exit =
		task.execution.kind === "settled" && task.execution.result.kind !== "cancelled"
			? task.execution.result.exitCode
			: undefined;
	return (
		theme.fg(status.color, `${status.icon} ${status.label}`) +
		theme.fg("dim", `${metrics ? ` · ${metrics}` : ""}${exit === undefined ? "" : ` · exit ${exit}`}`)
	);
}

const displayMultiline = (text: string) =>
	stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");

/** A focused view of the same record, never another lifecycle transcript anchor. */
export class TaskDetail implements Component {
	private task: TaskRecord;
	private content: TaskDetailContent;
	constructor(task: TaskRecord, content: TaskDetailContent) {
		this.task = task;
		this.content = content;
	}

	update(task: TaskRecord, content = this.content): void {
		this.task = task;
		this.content = content;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [
			theme.bold(taskDisplayText(this.task.title)),
			taskDetailSummary(this.task),
			...this.renderContent(width),
		];
		lines.push("", theme.fg("muted", theme.bold("Actions")));
		for (const action of taskDetailActions(this.task.execution, this.task.attention, this.content.stdinAvailable)) {
			const hint =
				action === "foreground" || action === "cancel" || action === "input"
					? keyHintIfBound(`app.tasks.${action}`, taskDetailLabels[action])
					: "";
			lines.push(hint || taskDetailLabels[action]);
		}
		return new Text(lines.join("\n"), 0, 0).render(width);
	}

	/** Body only: viewport owners pin identity, status and actions outside scrolling content. */
	renderContent(width: number): string[] {
		const task = this.task;
		const lines: string[] = [];
		if (task.kind === "agent")
			lines.push(...wrapTextWithAnsi(theme.fg("dim", taskModelText(task)), Math.max(1, width)));
		if (task.execution.kind !== "settled" && task.heartbeatMs !== undefined)
			lines.push(
				theme.fg(
					"dim",
					task.heartbeatMs === 0
						? "Heartbeat off"
						: `Heartbeat every ${formatTaskHeartbeatDuration(task.heartbeatMs)}`,
				),
			);
		const section = (label: string, text: string, limit: number, tail = false) => {
			const wrapped = wrapTextWithAnsi(displayMultiline(text), Math.max(1, width));
			lines.push(
				"",
				theme.fg("muted", theme.bold(label)),
				...(tail ? wrapped.slice(-limit) : wrapped.slice(0, limit)),
			);
			if (wrapped.length > limit || (tail && this.content.outputOmitted))
				lines.push(
					theme.fg(
						"dim",
						tail ? "Earlier output omitted · retained tail shown" : "… Inspect transcript for the full text",
					),
				);
		};
		if (task.execution.kind === "settled" && task.execution.result.kind === "failed") {
			lines.push(theme.fg("error", theme.bold("Error")));
			lines.push(
				...wrapTextWithAnsi(theme.fg("error", displayMultiline(task.execution.result.message)), Math.max(1, width)),
			);
		}
		if (task.execution.kind !== "settled" && task.attention.kind === "input-needed")
			section("Input needed", task.attention.prompt, 5);
		if (task.execution.kind !== "settled" && task.attention.kind === "no-recent-activity")
			lines.push(theme.fg("warning", "No recent activity reported"));
		const activities = (this.content.activity ?? []).flatMap(({ report }) =>
			report.change.kind === "action" ? [`${report.change.tool} ${report.change.text}`] : [],
		);
		if (task.currentAction) {
			const current = `${task.currentAction.tool} ${task.currentAction.text}`;
			if (activities[activities.length - 1] !== current) activities.push(current);
		}
		if (activities.length) {
			lines.push("", theme.fg("muted", theme.bold("Recent activity")));
			if (this.content.activityOmitted || activities.length > 5)
				lines.push(theme.fg("dim", "Earlier activity omitted"));
			const recent = activities.slice(-5);
			lines.push(
				...recent.map((text, index) =>
					theme.fg(
						index === recent.length - 1 ? "muted" : "dim",
						truncateToWidth(`${index === recent.length - 1 ? "›" : " "} ${taskDisplayText(text)}`, width),
					),
				),
			);
		}
		if (task.kind === "command") {
			section("Command", this.content.prompt ?? task.title, 3);
			section("Output", this.content.output || "No output available", 10, true);
		} else {
			if (this.content.prompt !== undefined) section("Prompt", this.content.prompt, 3);
			if (this.content.output) section("Latest response", this.content.output, 5);
		}
		lines.push(
			"",
			theme.fg("dim", `Owner ${taskDisplayText(task.ref.ownerId)} · Task ${taskDisplayText(task.ref.taskId)}`),
		);
		return new Text(lines.join("\n"), 0, 0).render(width);
	}
}
