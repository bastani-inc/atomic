import { createHash } from "node:crypto";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { taskOutcomeStatus } from "../../../core/tasks/command-output.js";
import { isResumableStop } from "../../../core/tasks/completion.js";
import type { TaskRecord } from "../../../core/tasks/contracts.js";
import type { TaskActivity } from "../../../core/tasks/owner-store.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound as keyHint } from "./keybinding-hints.js";

/** Control removal and truncation apply only to terminal display, never task identity. */
export function taskDisplayText(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function taskState(task: TaskRecord): string {
	if (
		task.kind === "agent" &&
		task.execution.kind === "settled" &&
		task.execution.result.kind === "cancelled" &&
		task.execution.result.cause === "user"
	)
		return "killed";
	// A quit or paused agent awaits resume, as a quit workflow run does.
	if (task.kind === "agent" && task.execution.kind === "settled" && isResumableStop(task.execution.result))
		return "paused";
	if (task.execution.kind === "settled") return taskOutcomeStatus(task.execution.result, task.kind);
	if (task.execution.kind === "cancelling") return "cancelling";
	if (task.attention.kind === "input-needed") return "input-needed";
	return task.execution.kind;
}
export function taskLabel(task: TaskRecord): string {
	return task.kind === "command" ? "bash" : (task.agentName ?? "agent");
}
export function taskTitle(task: TaskRecord): string {
	return task.title || taskLabel(task);
}
export function taskModelText(task: Pick<TaskRecord, "kind" | "model" | "thinking">): string {
	if (task.kind !== "agent") return "";
	return taskDisplayText(
		[task.model ?? "model unavailable", task.thinking ? `thinking ${task.thinking}` : "thinking unavailable"].join(
			" · ",
		),
	);
}
export function taskShortId(task: TaskRecord): string {
	return createHash("sha256").update(task.ref.taskId).digest("hex").slice(0, 6);
}
export function taskDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One semantic status palette for inline rows, lists and detail headers. */
export function taskStatusAppearance(task: TaskRecord): {
	label: string;
	icon: string;
	color: "accent" | "success" | "error" | "warning" | "muted";
} {
	switch (taskState(task)) {
		case "completed":
			return { label: "Completed", icon: "✓", color: "success" };
		case "failed":
			return { label: "Failed", icon: "✗", color: "error" };
		case "killed":
			return { label: "Killed (non-resumable)", icon: "■", color: "warning" };
		case "paused":
			return { label: "Paused · awaiting resume", icon: "‖", color: "warning" };
		case "cancelled":
			return { label: "Stopped", icon: "✗", color: "warning" };
		case "cancelling":
			return { label: "Stopping", icon: "!", color: "warning" };
		case "input-needed":
			return { label: "Input needed", icon: "?", color: "warning" };
		case "queued":
			return { label: "Queued", icon: "○", color: "muted" };
		default:
			return { label: "Running", icon: "∀", color: "accent" };
	}
}

export function taskMetricsText(task: TaskRecord): string {
	const metrics = task.metrics;
	return [
		metrics?.elapsedMs === undefined ? "" : taskDuration(metrics.elapsedMs),
		metrics?.tokenCount === undefined ? "" : `${metrics.tokenCount.toLocaleString("en-US")} tokens`,
		metrics?.toolCount === undefined ? "" : `${metrics.toolCount} ${metrics.toolCount === 1 ? "tool" : "tools"}`,
	]
		.filter(Boolean)
		.join(" · ");
}
export type TaskRowOptions = {
	expanded?: boolean;
	duplicate?: boolean;
	hint?: boolean;
	siblings?: readonly TaskRecord[];
	activity?: readonly TaskActivity[];
	activityOmitted?: boolean;
};
export class TaskRow implements Component {
	private readonly task: TaskRecord;
	private readonly options: TaskRowOptions;
	constructor(task: TaskRecord, options: TaskRowOptions = {}) {
		this.task = task;
		this.options = options;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const task = this.task;
		const group = task.launchGroupId
			? this.options.siblings?.filter((item) => item.launchGroupId === task.launchGroupId)
			: undefined;
		const index = group?.findIndex((item) => item.ref.taskId === task.ref.taskId) ?? -1;
		const grouped = group !== undefined && index >= 0;
		const rowWidth = Math.max(1, width - (grouped ? 2 : 0));
		const state =
			taskState(task) === "killed"
				? "killed (non-resumable)"
				: taskState(task) === "paused"
					? "paused · awaiting resume"
					: taskState(task);
		const live = task.execution.kind === "running" || task.execution.kind === "queued";
		const badge = live && task.observation.kind !== "none" ? ` · ${task.observation.kind}` : "";
		const { icon: glyph, color } = taskStatusAppearance(task);
		const displayLabel = (item: TaskRecord) =>
			truncateToWidth(
				`${taskDisplayText(taskLabel(item))}: ${taskDisplayText(taskTitle(item))}`,
				Math.max(1, rowWidth - 2),
			);
		const duplicate =
			this.options.duplicate ||
			this.options.siblings?.some(
				(item) => item.ref.taskId !== task.ref.taskId && displayLabel(item) === displayLabel(task),
			);
		const suffix = duplicate ? ` [${taskShortId(task)}]` : "";
		const title =
			theme.fg(color, glyph) +
			" " +
			theme.bold(taskDisplayText(taskLabel(task))) +
			theme.fg("muted", `: ${taskDisplayText(taskTitle(task))}`);
		const lines = [truncateToWidth(title, Math.max(1, rowWidth - suffix.length)) + theme.fg("dim", suffix)];
		if (task.kind === "agent") lines.push(theme.fg("dim", truncateToWidth(`  ${taskModelText(task)}`, rowWidth)));
		const action =
			live && task.currentAction
				? ` · ${taskDisplayText(task.currentAction.tool)} ${taskDisplayText(task.currentAction.text)}`
				: "";
		const tools = task.metrics?.toolCount === undefined ? "" : ` · ${task.metrics.toolCount} tool uses`;
		const duration = task.metrics?.elapsedMs === undefined ? "" : ` · ${taskDuration(task.metrics.elapsedMs)}`;
		lines.push(theme.fg("dim", truncateToWidth(`  ${state}${badge}${tools}${duration}${action}`, width)));
		if (this.options.expanded) {
			lines.push(theme.fg("dim", truncateToWidth(`  ${task.ref.taskId} · owner ${task.ref.ownerId}`, width)));
			if (task.metrics?.tokenCount !== undefined) lines.push(theme.fg("dim", `  ${task.metrics.tokenCount} tokens`));
			lines.push("  Activity");
			if (this.options.activityOmitted) lines.push(theme.fg("dim", "    Earlier activity omitted"));
			const retained = retainedActivityLines(this.options.activity ?? []);
			if (retained.length) lines.push(...retained.map((text) => theme.fg("dim", `    ${taskDisplayText(text)}`)));
			else
				lines.push(
					theme.fg(
						"dim",
						task.currentAction
							? `    ${taskDisplayText(task.currentAction.tool)} ${taskDisplayText(task.currentAction.text)}`
							: "    No retained activity",
					),
				);
			lines.push(theme.fg("dim", "  /tasks to inspect transcript and task details"));
			if (task.execution.kind === "settled" && task.execution.result.kind === "failed")
				lines.push(truncateToWidth(`    ${taskDisplayText(task.execution.result.message)}`, width));
		}
		const rendered = lines.map(
			(line, row) =>
				(grouped ? theme.fg("dim", row === 0 ? (index === group.length - 1 ? "└─" : "├─") : "  ") : "") +
				truncateToWidth(line, rowWidth),
		);
		if (grouped && index === 0) {
			const labels = new Set(group.map(taskLabel));
			const counts = new Map<string, number>();
			for (const sibling of group) {
				const state = taskState(sibling);
				counts.set(state, (counts.get(state) ?? 0) + 1);
			}
			rendered.unshift(
				theme.bold(
					truncateToWidth(
						`${labels.size === 1 ? taskDisplayText(taskLabel(task)) : "Tasks"} · ${[...counts].map(([state, count]) => `${count} ${state}`).join(" · ")}`,
						width,
					),
				),
			);
		}
		if (this.options.hint !== false && (!grouped || index === group.length - 1)) {
			const hint = keyHint("app.tools.expand", this.options.expanded ? "collapse" : "expand");
			if (hint) rendered.push(theme.fg("dim", hint));
		}
		return rendered.map((line) => truncateToWidth(line, width));
	}
}

function retainedActivityLines(activity: readonly TaskActivity[]): string[] {
	const lines: string[] = [];
	const decoder = new TextDecoder();
	for (const { report } of activity) {
		const change = report.change;
		if (change.kind === "action") lines.push(`${change.tool} ${change.text}`);
		else if (change.kind === "output") {
			const text = decoder.decode(Buffer.from(change.bytesBase64, "base64"), { stream: true });
			if (text) lines.push(`Retained output: ${text}`);
		} else if (change.kind === "attention-set" && change.attention.kind === "input-needed")
			lines.push(`Input needed: ${change.attention.prompt}`);
	}
	const tail = decoder.decode();
	if (tail) lines.push(`Retained output: ${tail}`);
	return lines;
}
