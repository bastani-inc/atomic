import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { theme } from "../theme/theme.js";
import { taskDisplayText, taskDuration, taskLabel, taskState } from "./task-row.js";

/**
 * The states a /tasks row can show, shared by task records (subagents and shells) and items another source lists,
 * such as workflow runs. They match the agent panel's states.
 */
export type TaskBoardState = "running" | "queued" | "input" | "paused" | "stopping" | "done" | "failed" | "stopped";

/** A row that is not a task record, such as a workflow run: what the list and its peek card show of it. */
export type TaskBoardItem = {
	readonly id: string;
	readonly kind: "agent" | "shell" | "workflow";
	readonly state: TaskBoardState;
	readonly name: string;
	readonly task: string;
	readonly elapsedMs?: number;
	readonly tokens?: number;
	readonly progress?: { readonly done: number; readonly total: number };
	readonly question?: string;
	readonly choices?: readonly string[];
	readonly reason?: string;
};

/** One row of /tasks: a task record from the task store, or an item another source lists. */
export type TaskBoardRow =
	| { readonly id: string; readonly kind: "task"; readonly task: TaskRecord }
	| { readonly id: string; readonly kind: "item"; readonly item: TaskBoardItem };

export type TaskBoardGroup = "input" | "working" | "done";
export const TASK_BOARD_GROUP_TITLES: Readonly<Record<TaskBoardGroup, string>> = {
	input: "Needs input",
	working: "Working",
	done: "Done",
};

/** A task record's state as a /tasks row reads it. */
export function taskBoardState(task: TaskRecord): TaskBoardState {
	switch (taskState(task)) {
		case "input-needed":
			return "input";
		case "queued":
			return "queued";
		case "cancelling":
			return "stopping";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "paused":
			return "paused";
		case "killed":
		case "cancelled":
			return "stopped";
		case "released":
		case "running":
			return "running";
		default:
			return task.execution.kind === "settled" ? "done" : "running";
	}
}

export function rowState(row: TaskBoardRow): TaskBoardState {
	return row.kind === "task" ? taskBoardState(row.task) : row.item.state;
}

export function stateGroup(state: TaskBoardState): TaskBoardGroup {
	if (state === "input") return "input";
	if (state === "running" || state === "queued" || state === "stopping") return "working";
	return "done";
}

/** Whether a row's work has ended, so `x` dismisses it rather than stopping it. */
export function rowFinished(row: TaskBoardRow): boolean {
	return stateGroup(rowState(row)) === "done";
}

export function rowName(row: TaskBoardRow): string {
	if (row.kind === "item") return taskDisplayText(row.item.name);
	return taskDisplayText(row.task.kind === "command" ? "shell" : taskLabel(row.task));
}

export function rowTask(row: TaskBoardRow): string {
	if (row.kind === "item") return taskDisplayText(row.item.task);
	if (row.task.attention.kind === "input-needed") return taskDisplayText(row.task.attention.prompt);
	return taskDisplayText(row.task.title || taskLabel(row.task));
}

/** Rows grouped as /tasks shows them: Needs input, Working, Done, keeping each source's order within a group. */
export function taskBoardGroups(
	rows: readonly TaskBoardRow[],
): { group: TaskBoardGroup; title: string; rows: TaskBoardRow[] }[] {
	return (["input", "working", "done"] as const).flatMap((group) => {
		const selected = rows.filter((row) => stateGroup(rowState(row)) === group);
		return selected.length ? [{ group, title: TASK_BOARD_GROUP_TITLES[group], rows: selected }] : [];
	});
}

/** `1 needs input · 3 working · 2 done`, leaving out empty groups. */
export function taskBoardCounts(rows: readonly TaskBoardRow[]): string {
	const counts = { input: 0, working: 0, done: 0 };
	for (const row of rows) counts[stateGroup(rowState(row))]++;
	return [
		counts.input ? `${counts.input} needs input` : "",
		counts.working ? `${counts.working} working` : "",
		counts.done ? `${counts.done} done` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

type Glyph = { glyph: string; color: "accent" | "success" | "error" | "warning" | "muted" | "dim" };

/** The glyph of a state: Atomic's ∀ while it works, ◆ while it waits on you, ✗ failed, ◼ stopped. */
export function stateGlyph(state: TaskBoardState): Glyph {
	switch (state) {
		case "input":
			return { glyph: "◆", color: "warning" };
		case "queued":
			return { glyph: "○", color: "muted" };
		case "stopping":
			return { glyph: "◼", color: "warning" };
		case "done":
			return { glyph: "✓", color: "success" };
		case "failed":
			return { glyph: "✗", color: "error" };
		case "paused":
		case "stopped":
			return { glyph: "◼", color: "muted" };
		default:
			return { glyph: "∀", color: "accent" };
	}
}

/** `87.4k`, as rows and the panel show token counts. */
export function compactTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function rowElapsed(row: TaskBoardRow): number | undefined {
	return row.kind === "task" ? row.task.metrics?.elapsedMs : row.item.elapsedMs;
}
function rowTokens(row: TaskBoardRow): number | undefined {
	return row.kind === "task" ? row.task.metrics?.tokenCount : row.item.tokens;
}

/** The right-hand column: how long it has waited, worked or took, its tokens, and why a failed or stopped row ended. */
export function rowMeta(row: TaskBoardRow): string {
	const state = rowState(row);
	const elapsed = rowElapsed(row);
	const time = elapsed === undefined ? "" : taskDuration(elapsed);
	const tokens = rowTokens(row);
	if (state === "input") return time ? `waiting ${time}` : "waiting";
	if (state === "paused" || state === "stopped") return ["stopped", time].filter(Boolean).join(" · ");
	if (state === "failed") return ["failed", time].filter(Boolean).join(" · ");
	if (state === "queued") return "queued";
	if (state === "stopping") return "stopping";
	return [time, tokens === undefined ? "" : `↓ ${compactTokens(tokens)}`].filter(Boolean).join(" · ");
}

const NAME_COLUMN = 14;

/** One /tasks row: `❯ ◆ name  task                      meta`, its task truncated so the meta stays aligned right. */
export function renderBoardRow(row: TaskBoardRow, selected: boolean, width: number): string {
	const state = rowState(row);
	const { glyph, color } = stateGlyph(state);
	const marker = selected ? theme.fg("accent", "❯ ") : "  ";
	const name = truncateToWidth(rowName(row), NAME_COLUMN - 1);
	const namePadded = name + " ".repeat(Math.max(1, NAME_COLUMN - visibleWidth(name)));
	let task = rowTask(row);
	if (row.kind === "item" && row.item.progress && state !== "input")
		task = `${task} · ${row.item.progress.done}/${row.item.progress.total}`;
	const reason = row.kind === "item" && state === "failed" && row.item.reason ? ` · ${row.item.reason}` : "";
	const meta = rowMeta(row);
	const fixed = 2 + 2 + NAME_COLUMN + 2 + visibleWidth(meta);
	const taskText = truncateToWidth(task + reason, Math.max(1, width - fixed));
	const gap = Math.max(1, width - 2 - 2 - NAME_COLUMN - visibleWidth(taskText) - visibleWidth(meta));
	const finished = stateGroup(state) === "done";
	const nameText = selected ? theme.bold(namePadded) : finished ? theme.fg("muted", namePadded) : namePadded;
	const taskStyled = finished && !selected ? theme.fg("dim", taskText) : theme.fg("muted", taskText);
	return truncateToWidth(
		`${marker}${theme.fg(color, glyph)} ${nameText}${taskStyled}${" ".repeat(gap)}${theme.fg("dim", meta)}`,
		width,
	);
}

/** What a peek card shows of a row, besides its reply input. */
export type PeekContent = {
	/** A waiting row's exact question, numbered choices under it. */
	question?: string;
	choices?: readonly string[];
	/** A working row's latest status, or a finished row's result. */
	lines: readonly string[];
};

/** The rounded peek card under a row: its name in the top edge, then its question and choices, status or result. */
export function renderPeekCard(
	title: string,
	content: PeekContent,
	replyLines: readonly string[],
	width: number,
	maxLines = 8,
): string[] {
	const inner = Math.max(1, width - 4);
	const border = (text: string) => theme.fg("borderMuted", text);
	const heading = ` ${truncateToWidth(title, Math.max(1, width - 8))} `;
	const top = `${border("╭─")}${theme.bold(heading)}${border(`${"─".repeat(Math.max(0, width - visibleWidth(heading) - 3))}╮`)}`;
	const frame = (line: string) => {
		const text = truncateToWidth(line, inner);
		return `${border("│ ")}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${border(" │")}`;
	};
	const body: string[] = [];
	if (content.question !== undefined) {
		body.push(theme.bold(taskDisplayText(content.question)));
		for (const [index, choice] of (content.choices ?? []).entries())
			body.push(`${theme.fg("accent", `${index + 1}`)} ${taskDisplayText(choice)}`);
	}
	for (const line of content.lines) body.push(theme.fg("muted", taskDisplayText(line)));
	const clipped = body.slice(0, Math.max(1, maxLines));
	return [top, ...clipped.map(frame), ...replyLines.map(frame), border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)].map(
		(line) => truncateToWidth(line, width),
	);
}

/** The task ids among rows, in display order. */
export function boardTaskIds(rows: readonly TaskBoardRow[]): TaskId[] {
	return rows.flatMap((row) => (row.kind === "task" ? [row.task.ref.taskId] : []));
}

/** Whether a row matches a `/` filter: its name, task, or question contains the text, ignoring case. */
export function rowMatches(row: TaskBoardRow, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return [rowName(row), rowTask(row)].some((text) => text.toLowerCase().includes(needle));
}
