import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { type AgentPanelItem, modelHasReasoning, taskPanelModel } from "../../../core/tasks/agent-panel-source.ts";
import { waitingReleasedTools } from "../../../core/tasks/completion.js";
import type { TaskRecord } from "../../../core/tasks/contracts.js";
import { shownSpanMs, taskClockOf, taskClockRunning } from "../../../core/tasks/live-elapsed.js";
import { isTaskTurnInterrupted } from "../../../core/tasks/owner-store.js";
import { formatTokenCount } from "../../../utils/token-count.ts";
import { theme } from "../theme/theme.js";
import { AGENT_PANEL_MODEL_MIN_WIDTH, formatPanelElapsed, panelModelText } from "./agent-panel.ts";
import type { ModelCellReport } from "./model-column.ts";
import { type TaskMark, taskMark } from "./task-marks.ts";
import { type TaskBoardState, taskBoardState, taskDisplayText, taskLabel } from "./task-row.js";

export { type TaskBoardState, taskBoardState };

export type TaskBoardItem = AgentPanelItem;

export type TaskBoardRow =
	| { readonly id: string; readonly kind: "task"; readonly task: TaskRecord }
	| { readonly id: string; readonly kind: "item"; readonly item: TaskBoardItem };

export type TaskBoardGroup = "input" | "working" | "waiting" | "done";
export const TASK_BOARD_GROUP_TITLES: Readonly<Record<TaskBoardGroup, string>> = {
	input: "Needs input",
	working: "Working",
	waiting: "Waiting",
	done: "Done",
};

export function rowState(row: TaskBoardRow): TaskBoardState {
	return row.kind === "task" ? taskBoardState(row.task) : row.item.state;
}

export function stateGroup(state: TaskBoardState): TaskBoardGroup {
	if (state === "input") return "input";
	if (state === "waiting") return "waiting";
	if (state === "running" || state === "queued" || state === "stopping" || state === "paused") return "working";
	return "done";
}

export function rowFinished(row: TaskBoardRow): boolean {
	return stateGroup(rowState(row)) === "done";
}

export function rowName(row: TaskBoardRow): string {
	if (row.kind === "item") return taskDisplayText(row.item.name);
	return taskDisplayText(row.task.kind === "command" ? "shell" : taskLabel(row.task));
}

export function rowTask(row: TaskBoardRow): string {
	if (row.kind === "item")
		return taskDisplayText(row.item.state === "input" && row.item.question ? row.item.question : row.item.task);
	if (row.task.attention.kind === "input-needed" && row.task.attention.prompt)
		return taskDisplayText(row.task.attention.prompt);
	return taskDisplayText(row.task.title || taskLabel(row.task));
}

export function taskBoardGroups(
	rows: readonly TaskBoardRow[],
): { group: TaskBoardGroup; title: string; rows: TaskBoardRow[] }[] {
	return (["input", "working", "waiting", "done"] as const).flatMap((group) => {
		const selected = rows.filter((row) => stateGroup(rowState(row)) === group);
		return selected.length ? [{ group, title: TASK_BOARD_GROUP_TITLES[group], rows: selected }] : [];
	});
}

export function taskBoardCounts(rows: readonly TaskBoardRow[]): string {
	const counts = { input: 0, working: 0, waiting: 0, done: 0 };
	for (const row of rows) counts[stateGroup(rowState(row))]++;
	return [
		counts.input ? `${counts.input} needs input` : "",
		counts.working ? `${counts.working} working` : "",
		counts.waiting ? `${counts.waiting} waiting` : "",
		counts.done ? `${counts.done} done` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** A row's mark: the agent panel's for its state, the hourglass for a running shell. */
export function stateGlyph(state: TaskBoardState, kind?: TaskBoardItem["kind"] | "command"): TaskMark {
	return taskMark(state, kind === "shell" || kind === "command");
}

function rowElapsed(row: TaskBoardRow): number | undefined {
	const span = row.kind === "task" ? row.task.elapsedSpan : row.item.elapsedSpan;
	if (span) {
		return row.kind === "task"
			? shownSpanMs(row.task.ref.taskId, span, taskClockOf(row.task))
			: shownSpanMs(row.item.id, span, taskClockOf(row.item));
	}
	if (row.kind === "task") {
		const reported = row.task.metrics?.elapsedMs;
		if (!isTaskTurnInterrupted(row.task)) return reported;
		return taskClockOf(row.task)?.elapsedMs(row.task.ref.taskId, reported, false) ?? reported;
	}
	if (row.item.state !== "queued") {
		const clocks = taskClockOf(row.item);
		if (clocks !== undefined) {
			return clocks.elapsedMs(row.item.id, row.item.elapsedMs, taskClockRunning(row.item.state));
		}
	}
	return row.item.elapsedMs;
}
function rowWaitingOn(row: TaskBoardRow): string | undefined {
	if (row.kind === "item") return row.item.waitingOn;
	return waitingReleasedTools(row.task);
}
function rowTokens(row: TaskBoardRow): number | undefined {
	return row.kind === "task" ? row.task.metrics?.tokenCount : row.item.tokens;
}

function validMetric(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function rowMeta(row: TaskBoardRow): string {
	const state = rowState(row);
	const elapsed = rowElapsed(row);
	const time = validMetric(elapsed) ? formatPanelElapsed(elapsed) : "";
	const tokens = rowTokens(row);
	if (state === "input") return time ? `waiting ${time}` : "waiting";
	if (state === "paused" || state === "stopped") return [state, time].filter(Boolean).join(" · ");
	if (state === "failed") return ["failed", time].filter(Boolean).join(" · ");
	if (state === "queued") return "queued";
	if (state === "waiting")
		return [`waiting on ${taskDisplayText(rowWaitingOn(row) ?? "a tool call")}`, time].filter(Boolean).join(" · ");
	if (state === "stopping") return ["stopping", time].filter(Boolean).join(" · ");
	if (state === "done") return ["done", time].filter(Boolean).join(" · ");
	return [time, validMetric(tokens) ? `↓ ${formatTokenCount(tokens)}` : ""].filter(Boolean).join(" · ");
}

const NAME_COLUMN = 14;
/** The narrowest task a row keeps beside the model column. */
const MIN_TASK_WIDTH = 8;

function nameColumnFor(width: number): number {
	return Math.min(NAME_COLUMN, Math.max(6, Math.floor((width - 6) / 3)));
}

/** A row's model column text, as the agent panel shows it, and its width in cells. */
export interface BoardRowModel {
	readonly text: string;
	readonly width: number;
}

export const NO_MODEL: BoardRowModel = { text: "", width: 0 };

/**
 * A row's model column: empty for a shell and for a row with no known model. `owner` is the task store the row's task
 * belongs to: its session's model registry says whether the model has reasoning levels.
 */
export function rowModel(row: TaskBoardRow, owner?: object): BoardRowModel {
	const text =
		row.kind === "item"
			? panelModelText(row.item)
			: row.task.kind === "agent"
				? panelModelText({ kind: "agent", ...taskPanelModel(row.task, owner ?? row.task) })
				: "";
	return text.length === 0 ? NO_MODEL : { text, width: visibleWidth(text) };
}

/**
 * What a row with model cell `model` (its `rowModel`) reports to the view's `ModelColumn`: whether it names a model,
 * whether its reasoning level is known or the row finished, and, asked only when needed, whether `owner`'s model
 * registry gives its model no levels.
 */
export function rowModelReport(row: TaskBoardRow, model: BoardRowModel, owner?: object): ModelCellReport {
	const reported = row.kind === "task" ? row.task : row.item;
	return {
		model: model.width > 0 && typeof reported.model === "string" ? reported.model : undefined,
		settled: Boolean(reported.thinking) || rowFinished(row),
		levelless: () =>
			typeof reported.model === "string" && modelHasReasoning(owner ?? reported, reported.model) === false,
	};
}

/**
 * Whether a model column `column` cells wide fits `rows` at `width`. As in the agent panel, rows narrower than 100
 * columns have none, and neither do rows where it would clip a row's right column or leave a task under 8 cells.
 */
export function boardModelFits(rows: readonly TaskBoardRow[], width: number): (column: number) => boolean {
	return (column) => {
		if (width < AGENT_PANEL_MODEL_MIN_WIDTH) return false;
		const fixed = 2 + 2 + nameColumnFor(width) + column + 2;
		for (const row of rows) {
			const meta = visibleWidth(rowMeta(row));
			const right = meta > 0 ? 2 + meta : 0;
			if (fixed + right > width || (rowTask(row).length > 0 && width - fixed - right < MIN_TASK_WIDTH)) return false;
		}
		return true;
	};
}

/** The width of the model column `rows` share at `width`, 0 for none; `models` are their `rowModel`s, in order. */
export function boardModelColumn(
	rows: readonly TaskBoardRow[],
	models: readonly BoardRowModel[],
	width: number,
): number {
	let column = 0;
	for (const model of models) column = Math.max(column, model.width);
	return column > 0 && boardModelFits(rows, width)(column) ? column : 0;
}

/** `model`: the model column every row of the list shares (`boardModelColumn`) and this row's cell of it. */
export function renderBoardRow(
	row: TaskBoardRow,
	selected: boolean,
	width: number,
	model?: { readonly column: number; readonly cell: BoardRowModel },
): string {
	const state = rowState(row);
	const { glyph, color } = stateGlyph(state, row.kind === "task" ? row.task.kind : row.item.kind);
	const marker = selected ? theme.fg("accent", "❯ ") : "  ";

	const nameColumn = nameColumnFor(width);
	const modelColumn = model === undefined ? 0 : model.column;
	const modelCell =
		model === undefined || modelColumn === 0
			? ""
			: `${model.cell.text}${" ".repeat(Math.max(0, modelColumn - model.cell.width) + 2)}`;
	const nameWidth = nameColumn + (modelColumn > 0 ? modelColumn + 2 : 0);
	const name = truncateToWidth(rowName(row), nameColumn - 1);
	const namePadded = name + " ".repeat(Math.max(1, nameColumn - visibleWidth(name)));
	const progress =
		row.kind === "item" &&
		row.item.progress &&
		validMetric(row.item.progress.done) &&
		validMetric(row.item.progress.total) &&
		row.item.progress.done <= row.item.progress.total &&
		state !== "input"
			? `${row.item.progress.done}/${row.item.progress.total}`
			: "";
	const reason = row.kind === "item" && state === "failed" && row.item.reason ? taskDisplayText(row.item.reason) : "";
	const title = rowTask(row);
	const task = [title, progress, reason === title ? "" : reason].filter(Boolean).join(" · ");
	const fullMeta = rowMeta(row);
	const meta = 2 + 2 + nameWidth + 2 + visibleWidth(fullMeta) <= width ? fullMeta : "";
	const fixed = 2 + 2 + nameWidth + (meta ? 2 + visibleWidth(meta) : 0);
	const taskText = truncateToWidth(task, Math.max(0, width - fixed));
	const gap = Math.max(meta ? 1 : 0, width - 2 - 2 - nameWidth - visibleWidth(taskText) - visibleWidth(meta));
	const finished = stateGroup(state) === "done";
	const nameText = selected ? theme.bold(namePadded) : finished ? theme.fg("muted", namePadded) : namePadded;
	const modelText = modelCell ? theme.fg("dim", modelCell) : "";
	const taskStyled = finished && !selected ? theme.fg("dim", taskText) : theme.fg("muted", taskText);
	const line = truncateToWidth(
		`${marker}${theme.fg(color, glyph)} ${nameText}${modelText}${taskStyled}${" ".repeat(gap)}${theme.fg("dim", meta)}`,
		width,
		"...",
		true,
	);
	// NO_COLOR: the row's mark and words say its state, so it carries no colour codes.
	return process.env.NO_COLOR === undefined ? line : stripTerminalSequences(line);
}

export type PeekContent = {
	question?: string;
	choices?: readonly string[];

	lines: readonly string[];
};

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

export function rowMatches(row: TaskBoardRow, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return [rowName(row), rowTask(row)].some((text) => text.toLowerCase().includes(needle));
}
