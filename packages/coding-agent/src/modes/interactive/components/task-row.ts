import { createHash } from "node:crypto";
import { type Component, truncateToWidth } from "@bastani/atomic-tui";
import { formatModelLabel } from "../../../core/model-label.ts";
import { taskOutcomeStatus } from "../../../core/tasks/command-output.js";
import { isResumableStop, releasedWaitingOn, waitingReleasedTools } from "../../../core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { taskClockRunning, taskElapsedMs } from "../../../core/tasks/live-elapsed.js";
import { isTaskTurnInterrupted, type TaskActivity } from "../../../core/tasks/owner-store.js";
import { toolTaskNoun, unreachableTaskKind } from "../../../core/tasks/task-kind.js";
import { sanitizeTerminalText } from "../../../utils/terminal-text.ts";
import { theme } from "../theme/theme.js";
import { formatPanelElapsed } from "./agent-panel.ts";
import { keyHintIfBound as keyHint } from "./keybinding-hints.js";
import { slashCommandHint } from "./nav-keys.ts";
import { WAITING_MARKER } from "./notice-line.ts";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

const EMOJI_OR_IGNORABLE_PATTERN = String.raw`(\p{RGI_Emoji}|\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})*(?:\u200d\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})*)+|[\p{Extended_Pictographic}\p{Emoji_Presentation}]\ufe0f)|\p{Default_Ignorable_Code_Point}`;
const EMOJI_OR_IGNORABLE = new RegExp(EMOJI_OR_IGNORABLE_PATTERN, "gv");

/** Control removal and truncation apply only to terminal display, never task identity. */
export function taskDisplayText(text: string): string {
	if (!/[\x00-\x1f\x7f-\x9f\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(text)) return text;
	return sanitizeTerminalText(text)
		.replace(EMOJI_OR_IGNORABLE, "$1")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}
export function taskState(task: TaskRecord): string {
	if (
		task.kind === "agent" &&
		task.execution.kind === "settled" &&
		task.execution.result.kind === "cancelled" &&
		task.execution.result.cause === "user"
	)
		return "killed";
	// A released agent waits on a call and wakes by itself when it finishes; nothing paused it (#5031).
	if (waitingReleasedTools(task) !== undefined) return "released";
	// A quit or paused agent awaits resume, as a quit workflow run does.
	if (task.kind === "agent" && task.execution.kind === "settled" && isResumableStop(task.execution.result))
		return "paused";
	if (task.execution.kind === "settled") return taskOutcomeStatus(task.execution.result, task.kind);
	if (task.execution.kind === "cancelling") return "cancelling";
	if (task.attention.kind === "input-needed") return "input-needed";
	return task.execution.kind;
}
export function taskLabel(task: TaskRecord): string {
	switch (task.kind) {
		case "agent":
			return task.agentName ?? "agent";
		case "command":
			return "bash";
		case "tool":
			return toolTaskNoun(task);
		default:
			return unreachableTaskKind(task.kind);
	}
}
export function taskTitle(task: TaskRecord): string {
	return task.title || taskLabel(task);
}
/** An agent's model as every model label reads: its raw `provider/id`, then its level (#4269). */
export function taskModelText(task: Pick<TaskRecord, "kind" | "model" | "thinking">): string {
	if (task.kind !== "agent") return "";
	return taskDisplayText(
		task.model === undefined ? "model unavailable" : formatModelLabel(task.model, { thinkingLevel: task.thinking }),
	);
}
export function taskShortId(task: TaskRecord): string {
	return createHash("sha256").update(task.ref.taskId).digest("hex").slice(0, 6);
}
export function taskDuration(milliseconds: number): string {
	return formatPanelElapsed(milliseconds);
}

/** One semantic status palette for inline rows, lists and detail headers. */
export function taskStatusAppearance(task: TaskRecord): {
	label: string;
	icon: string;
	color: "accent" | "success" | "error" | "warning" | "muted" | "dim";
} {
	if (isTaskTurnInterrupted(task)) return { label: "Stopped · send to resume", icon: "◼", color: "muted" };
	switch (taskState(task)) {
		case "completed":
			return { label: "Completed", icon: "✓", color: "success" };
		case "failed":
			return { label: "Failed", icon: "✗", color: "error" };
		case "killed":
			return { label: "Killed (non-resumable)", icon: "■", color: "warning" };
		case "paused":
			return { label: "Paused · awaiting resume", icon: "‖", color: "warning" };
		case "released":
			// It is not working: a still mark, not the running ∀, as its /tasks row and the agent panel show it.
			return {
				label: `Waiting on ${waitingReleasedTools(task) ?? "a tool call"}`,
				icon: WAITING_MARKER.glyph,
				color: WAITING_MARKER.color,
			};
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
	const running = taskClockRunning(task.execution.kind) && !isTaskTurnInterrupted(task);
	const elapsedMs = metrics?.elapsedMs === undefined ? undefined : taskElapsedMs(task, running);
	return [
		elapsedMs === undefined ? "" : formatPanelElapsed(elapsedMs),
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

type LaunchGroup = { tasks: TaskRecord[]; positions: Map<TaskId, number> };

class SiblingIndex {
	private readonly tasks: readonly TaskRecord[];
	private readonly groups = new Map<string, LaunchGroup>();
	private readonly labels = new Map<number, Map<string, Set<TaskId>>>();
	constructor(tasks: readonly TaskRecord[]) {
		this.tasks = tasks;
		for (const task of tasks) {
			if (!task.launchGroupId) continue;
			let group = this.groups.get(task.launchGroupId);
			if (!group) {
				group = { tasks: [], positions: new Map() };
				this.groups.set(task.launchGroupId, group);
			}
			if (!group.positions.has(task.ref.taskId)) group.positions.set(task.ref.taskId, group.tasks.length);
			group.tasks.push(task);
		}
	}
	groupOf(task: TaskRecord): LaunchGroup {
		return (task.launchGroupId && this.groups.get(task.launchGroupId)) || { tasks: [], positions: new Map() };
	}
	sharesLabel(task: TaskRecord, width: number): boolean {
		let byLabel = this.labels.get(width);
		if (!byLabel) {
			byLabel = new Map();
			for (const item of this.tasks) {
				const label = taskDisplayLabel(item, width);
				const ids = byLabel.get(label) ?? new Set<TaskId>();
				ids.add(item.ref.taskId);
				byLabel.set(label, ids);
			}
			this.labels.set(width, byLabel);
		}
		const ids = byLabel.get(taskDisplayLabel(task, width));
		return ids !== undefined && ids.size > (ids.has(task.ref.taskId) ? 1 : 0);
	}
}

const siblingIndexes = new WeakMap<readonly TaskRecord[], SiblingIndex>();

export function taskSiblings(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
	const siblings = Object.freeze([...tasks]);
	siblingIndexes.set(siblings, new SiblingIndex(siblings));
	return siblings;
}

export function taskNameAndTitle(task: TaskRecord): string {
	return JSON.stringify([task.agentName ?? null, task.title]);
}

export function countTasksBy(tasks: readonly TaskRecord[], key: (task: TaskRecord) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const task of tasks) {
		const value = key(task);
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return counts;
}

function taskDisplayLabel(task: TaskRecord, width: number): string {
	return truncateToWidth(`${taskDisplayText(taskLabel(task))}: ${taskDisplayText(taskTitle(task))}`, width);
}

export class TaskRow implements Component {
	/** A click anywhere on the row shows or hides its details, as Ctrl+O does. */
	readonly expandsOnClick = true;
	private readonly task: TaskRecord;
	private readonly options: TaskRowOptions;
	private expanded: boolean;
	constructor(task: TaskRecord, options: TaskRowOptions = {}) {
		this.task = task;
		this.options = options;
		this.expanded = options.expanded === true;
	}
	invalidate(): void {}
	isExpanded(): boolean {
		return this.expanded;
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(0, this.render(width).length);
	}
	render(width: number): string[] {
		const task = this.task;
		const siblings = this.options.siblings;
		const siblingIndex = siblings && (siblingIndexes.get(siblings) ?? new SiblingIndex(siblings));
		const launchGroup = task.launchGroupId ? siblingIndex?.groupOf(task) : undefined;
		const group = launchGroup?.tasks;
		const position = launchGroup?.positions.get(task.ref.taskId) ?? -1;
		const grouped = group !== undefined && position >= 0;
		const rowWidth = Math.max(1, width - (grouped ? 2 : 0));
		const state =
			taskState(task) === "killed"
				? "killed (non-resumable)"
				: taskState(task) === "paused"
					? "paused · awaiting resume"
					: task.execution.kind === "settled" && waitingReleasedTools(task) !== undefined
						? `waiting on ${releasedWaitingOn(task.execution.result)}`
						: taskState(task);
		const live = task.execution.kind === "running" || task.execution.kind === "queued";
		const badge = live && task.observation.kind !== "none" ? ` · ${task.observation.kind}` : "";
		const { icon: glyph, color } = taskStatusAppearance(task);
		const duplicate = this.options.duplicate || siblingIndex?.sharesLabel(task, Math.max(1, rowWidth - 2));
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
		const elapsedMs = task.elapsedSpan ? taskElapsedMs(task, live) : task.metrics?.elapsedMs;
		const duration = elapsedMs === undefined ? "" : ` · ${formatPanelElapsed(elapsedMs)}`;
		lines.push(theme.fg("dim", truncateToWidth(`  ${state}${badge}${tools}${duration}${action}`, width)));
		if (this.expanded) {
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
			lines.push(theme.fg("dim", `  ${slashCommandHint("/tasks to inspect transcript and task details")}`));
			if (task.execution.kind === "settled" && task.execution.result.kind === "failed")
				lines.push(truncateToWidth(`    ${taskDisplayText(task.execution.result.message)}`, width));
		}
		const rendered = lines.map(
			(line, row) =>
				(grouped ? theme.fg("dim", row === 0 ? (position === group.length - 1 ? "└─" : "├─") : "  ") : "") +
				truncateToWidth(line, rowWidth),
		);
		if (grouped && position === 0) {
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
		if (this.options.hint !== false && (!grouped || position === group.length - 1)) {
			const hint = keyHint("app.tools.expand", this.expanded ? "collapse" : "expand");
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
