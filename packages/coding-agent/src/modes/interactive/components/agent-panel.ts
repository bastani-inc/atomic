import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { formatModelLabel } from "../../../core/model-label.ts";
import { isActivePanelState, isRestingPanelRow, panelRowListed } from "../../../core/tasks/agent-panel-rules.ts";
import {
	type AgentPanelItem,
	type AgentPanelState,
	agentPanelTaskId,
	isInterruptedPanelTask,
	markInterruptedPanelTask,
	modelHasReasoning,
} from "../../../core/tasks/agent-panel-source.ts";
import type { TaskId } from "../../../core/tasks/contracts.js";
import {
	bindTaskClock,
	shownSpanMs,
	TaskElapsedClocks,
	taskClockOf,
	taskClockRunning,
} from "../../../core/tasks/live-elapsed.js";
import { formatTokenCount } from "../../../utils/token-count.ts";
import type { ModelCellReport, ModelColumn } from "./model-column.ts";
import {
	clickableKeyTextHint,
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navActionText,
	renderNavHintLine,
	TwoPressConfirm,
} from "./nav-keys.ts";
import { TASK_MARKS, taskMark } from "./task-marks.ts";
import { taskDisplayText } from "./task-row.js";

export type AgentPanelRow = AgentPanelItem;
export type { AgentPanelState };

export const AGENT_PANEL_FADE_MS = 30_000;
export const AGENT_PANEL_IDLE_ROWS = 4;
export const AGENT_PANEL_FOCUSED_ROWS = 8;
export const AGENT_PANEL_MAIN_ID = "main";
/** Narrower rows drop the model column, as rows narrower than 70 columns drop the token count. */
export const AGENT_PANEL_MODEL_MIN_WIDTH = 100;
/** The widest the model column grows: a longer model is cut in its id, keeping its reasoning level. */
export const AGENT_PANEL_MODEL_MAX_WIDTH = 40;
/** The narrowest task a row shows; with less room it shows none. */
const MIN_TASK_WIDTH = 8;

export interface AgentPanelStyle extends NavKeyStyle {
	accent(text: string): string;
	success(text: string): string;
	error(text: string): string;
	warning(text: string): string;
}

const FINISHED: ReadonlySet<AgentPanelState> = new Set(["done", "failed", "stopped"]);
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const NON_SINGLE_CELL = /[^\x20-\x7e\u00b7\u25b0\u25b1\u2193]/;
const NON_SINGLE_CELL_LINE = /[^\x20-\x7e·▰▱↓∀⧗◆‖○◯◌◼✓✗●❯]/;
const SGR_SEQUENCE = /\x1b\[[\d;:]*m/g;
const MAX_CACHED_LINE_WIDTHS = 512;
const singleCellLineWidths = new Map<string, number>();
export function isFinishedPanelRow(row: Pick<AgentPanelRow, "state">): boolean {
	return FINISHED.has(row.state) && !isInterruptedPanelTask(row);
}

/**
 * Whether a row is work still in progress: running, queued, waiting on an answer, stopping, or waiting to wake. A
 * running background shell counts too, though it is not a row. While nothing is active, stopped subagents leave.
 */
export function isActivePanelRow(row: Pick<AgentPanelRow, "state">): boolean {
	return isActivePanelState(row.state);
}

function panelText(text: string): string {
	if (!NON_PRINTABLE_ASCII.test(text)) return text;
	return taskDisplayText(text)
		.toWellFormed()
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.replace(/(?:^|(?<=\s))\p{M}+/gu, "");
}

function cellWidth(text: string): number {
	return NON_SINGLE_CELL.test(text) ? visibleWidth(text) : text.length;
}

/**
 * A row's model column: the model its agent runs on now as `provider/id`, then its reasoning level, as the main footer
 * names the chat's model, with a single space so the pair reads as one column. Empty for a shell, and for a row whose
 * model is not known. A model wider than `maxWidth` is cut in its id; its level stays whole.
 */
export function panelModelText(
	row: Pick<AgentPanelRow, "kind" | "model" | "thinking">,
	maxWidth = AGENT_PANEL_MODEL_MAX_WIDTH,
): string {
	if (row.kind !== "agent" || !row.model) return "";
	const model = panelText(row.model);
	const level = row.thinking ? panelText(row.thinking) : "";
	const label = formatModelLabel(model, { thinkingLevel: level || undefined, separator: " " });
	if (cellWidth(label) <= maxWidth) return label;
	const levelWidth = cellWidth(level);
	if (levelWidth > 0 && levelWidth + 2 < maxWidth)
		return `${fitToWidth(model, maxWidth - levelWidth - 1).text} ${level}`;
	return fitToWidth(label, maxWidth).text;
}

function fitToWidth(text: string, maxWidth: number): { readonly text: string; readonly width: number } {
	if (!NON_SINGLE_CELL.test(text) && text.length <= maxWidth) {
		return { text, width: text.length };
	}
	const truncated = truncateToWidth(text, maxWidth);
	return { text: truncated, width: cellWidth(truncated) };
}

function clampLine(line: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const cachedWidth = singleCellLineWidths.get(line);
	if (cachedWidth !== undefined) {
		if (cachedWidth <= maxWidth) return line;
	} else {
		const plain = line.replace(SGR_SEQUENCE, "");
		if (!NON_SINGLE_CELL_LINE.test(plain) && plain.length <= maxWidth) {
			if (singleCellLineWidths.size >= MAX_CACHED_LINE_WIDTHS) {
				const oldest = singleCellLineWidths.keys().next().value;
				if (oldest !== undefined) singleCellLineWidths.delete(oldest);
			}
			singleCellLineWidths.set(line, plain.length);
			return line;
		}
	}
	let clamped = line;
	for (let limit = maxWidth; visibleWidth(clamped) > maxWidth && limit > 0; limit--) {
		clamped = truncateToWidth(line, limit);
	}
	return visibleWidth(clamped) <= maxWidth ? clamped : "";
}

export function formatPanelElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export class AgentPanelModel {
	private readonly finishedAt = new Map<string, { since: number; pass: number }>();
	private readonly finishedTaskAt = new Map<string, { since: number; pass: number }>();
	/**
	 * Resting rows that left because nothing was active, by row id, with the pass that last saw them and the run they
	 * rest from (`AgentPanelItem.runGeneration`).
	 */
	private readonly retired = new Map<string, { pass: number; run: string | undefined }>();
	private readonly bases = new WeakMap<AgentPanelRow, AgentPanelRow>();
	private pass = 0;
	private finishedGeneration = 0;
	private passMatchedFinished = 0;
	private hasLocalClocks = false;
	private readonly elapsedClocks = new TaskElapsedClocks();
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}
	get finishedRevision(): number {
		return this.finishedGeneration;
	}
	finishedSince(id: string, native = false): number | undefined {
		return (native ? this.finishedTaskAt : this.finishedAt).get(id)?.since;
	}
	beginPass(): { readonly now: number; readonly pass: number } {
		this.passMatchedFinished = 0;
		return { now: this.now(), pass: ++this.pass };
	}
	/**
	 * Whether a finished row stays listed, such as a stopped subagent while something is active.
	 */
	keepFinished(id: string, keep: boolean, now: number, pass: number, native = false): boolean {
		if (!keep) return false;
		const table = native ? this.finishedTaskAt : this.finishedAt;
		let entry = table.get(id);
		if (entry === undefined) {
			entry = { since: now, pass };
			table.set(id, entry);
			this.finishedGeneration++;
			this.passMatchedFinished++;
		} else if (entry.pass !== pass) {
			entry.pass = pass;
			this.passMatchedFinished++;
		}
		return true;
	}
	/**
	 * Whether a resting row (`isRestingPanelRow`) has left the panel: it leaves when nothing is active, and stays gone
	 * until it runs again or is gone. `rowId` is the row's id; `pass` the ranking pass that sees it resting; `run` the
	 * run it rests from (`AgentPanelItem.runGeneration`). A row resting from another run than the one it left in ran
	 * again, even if no pass saw it running, so it is listed while something is active.
	 */
	retireResting(rowId: string, active: boolean, pass: number, run?: string): boolean {
		const left = this.retired.get(rowId);
		if (active && (left === undefined || left.run !== run)) {
			if (left !== undefined) this.retired.delete(rowId);
			return false;
		}
		this.retired.set(rowId, { pass, run });
		return true;
	}
	endPass(pass: number): void {
		// A retired row that runs again, or is gone, is forgotten: when it stops again it is listed again.
		if (this.retired.size > 0) {
			for (const [id, seen] of this.retired) if (seen.pass !== pass) this.retired.delete(id);
		}
		if (this.passMatchedFinished === this.finishedAt.size + this.finishedTaskAt.size) return;
		for (const table of [this.finishedAt, this.finishedTaskAt]) {
			for (const [id, entry] of table) {
				if (entry.pass !== pass) {
					table.delete(id);
					this.finishedGeneration++;
				}
			}
		}
	}
	withElapsed(row: AgentPanelRow, now = this.now(), state: AgentPanelState = row.state): AgentPanelRow {
		row = this.baseOf(row);
		if (state === "queued") return row;
		if (row.elapsedSpan) {
			const sourceClocks = taskClockOf(row);
			if (sourceClocks === undefined) this.hasLocalClocks = true;
			const taskId = agentPanelTaskId(row.id) ?? row.id;
			const elapsedMs = shownSpanMs(taskId, row.elapsedSpan, sourceClocks ?? this.elapsedClocks, now);
			return elapsedMs === row.elapsedMs ? row : this.copyOf(row, { ...row, elapsedMs });
		}
		const running = taskClockRunning(state);
		const taskId = agentPanelTaskId(row.id) ?? row.id;
		const sourceClocks = taskClockOf(row);
		if (sourceClocks === undefined) this.hasLocalClocks = true;
		const elapsedMs = (sourceClocks ?? this.elapsedClocks).elapsedMs(
			taskId,
			row.elapsedMs,
			running,
			now,
			isFinishedPanelRow(row),
		);
		if (elapsedMs === undefined || elapsedMs === row.elapsedMs) return row;
		const copy = { ...row, elapsedMs };
		if (isInterruptedPanelTask(row)) markInterruptedPanelTask(copy);
		return this.copyOf(row, sourceClocks === undefined ? copy : bindTaskClock(copy, sourceClocks));
	}
	baseOf(row: AgentPanelRow): AgentPanelRow {
		return this.bases.get(row) ?? row;
	}
	private copyOf(base: AgentPanelRow, copy: AgentPanelRow): AgentPanelRow {
		this.bases.set(copy, base);
		return copy;
	}
	/** The listed rows, in panel order. */
	rows(
		rows: readonly AgentPanelRow[],
		keep: (row: AgentPanelRow) => boolean = () => false,
		window?: { readonly start?: number; readonly limit?: number },
	): AgentPanelRow[] {
		const { now, pass } = this.beginPass();
		const inputRows: AgentPanelRow[] = [];
		const runningRows: AgentPanelRow[] = [];
		const otherRows: AgentPanelRow[] = [];
		const finishedRows: AgentPanelRow[] = [];
		const states = new Map<AgentPanelRow, AgentPanelState>();
		let active = false;
		for (const row of rows) {
			const state = row.state;
			states.set(row, state);
			if (isActivePanelState(state)) active = true;
		}
		/** Resting subagent rows that left: their clocks still follow them, so a resumed one keeps its time. */
		const hidden: AgentPanelRow[] = [];
		for (const row of rows) {
			const state = states.get(row)!;
			const resting = isRestingPanelRow(row.kind, state);
			const finished = FINISHED.has(state) && !isInterruptedPanelTask(row);
			const retired = resting && this.retireResting(row.id, active, pass, row.runGeneration);
			if (!panelRowListed(row.kind, state, finished, { active, retired, kept: finished && keep(row) })) {
				if (retired) hidden.push(row);
				continue;
			}
			if (finished) {
				this.keepFinished(row.id, true, now, pass);
				finishedRows.push(row);
			} else if (state === "input") inputRows.push(row);
			else if (state === "running") runningRows.push(row);
			else otherRows.push(row);
		}
		this.endPass(pass);
		const ordered =
			inputRows.length === 0 && otherRows.length === 0 && finishedRows.length === 0
				? runningRows
				: inputRows.concat(runningRows, otherRows, finishedRows);
		const start = Math.max(0, window?.start ?? 0);
		const limit = Math.max(0, window?.limit ?? Number.POSITIVE_INFINITY);
		const end = Math.min(ordered.length, start + limit);
		const localClockIds = new Set<string>();
		for (const row of hidden) {
			this.withElapsed(row, now, states.get(row)!);
			if (taskClockOf(row) === undefined) localClockIds.add(agentPanelTaskId(row.id) ?? row.id);
		}
		for (let index = start; index < end; index++) {
			const row = ordered[index]!;
			const state = states.get(row)!;
			ordered[index] = this.withElapsed(row, now, state);
			if (state !== "queued" && taskClockOf(row) === undefined) {
				localClockIds.add(agentPanelTaskId(row.id) ?? row.id);
			}
		}
		if (this.hasLocalClocks && start === 0 && end === ordered.length) {
			this.elapsedClocks.prune(localClockIds);
			if (localClockIds.size === 0) this.hasLocalClocks = false;
		}
		return ordered;
	}
	faded(row: Pick<AgentPanelRow, "id">): boolean {
		const taskId = agentPanelTaskId(row.id);
		const since =
			(taskId === undefined ? undefined : this.finishedTaskAt.get(taskId)?.since) ??
			this.finishedAt.get(row.id)?.since;
		return since !== undefined && this.now() - since >= AGENT_PANEL_FADE_MS;
	}
}

const OPEN_CIRCLE = "◯";
const FILLED_CIRCLE = "●";

/**
 * How a row reads, first match wins: the chat on screen is bold in the default colour, a faded finished row is dim, the
 * selected row is in the default colour, and the rest are muted.
 */
type RowTone = "onScreen" | "faded" | "selected" | "rest";

function rowTone(onScreen: boolean, faded: boolean, selected: boolean): RowTone {
	if (onScreen) return "onScreen";
	if (faded) return "faded";
	return selected ? "selected" : "rest";
}

function paintRow(style: AgentPanelStyle, tone: RowTone, text: string): string {
	switch (tone) {
		case "onScreen":
			return style.bold(style.text(text));
		case "faded":
			return style.dim(text);
		case "selected":
			return style.text(text);
		case "rest":
			return style.muted(text);
	}
}

/**
 * A subagent row's mark: the marks every view of a task shares (`TASK_MARKS`). Each state has its own mark and colour,
 * and every mark is one cell, so a row keeps its columns when its state changes. The chat on screen fills its open
 * circle; a running circle reads in its row's colour.
 */
function glyph(row: AgentPanelRow, style: AgentPanelStyle, tone: RowTone): string {
	const mark = taskMark(row.state, row.kind === "shell");
	const shape = tone === "onScreen" && mark.glyph === OPEN_CIRCLE ? FILLED_CIRCLE : mark.glyph;
	const colored =
		mark === TASK_MARKS.running && (tone === "onScreen" || tone === "selected")
			? style.text(shape)
			: style[mark.color](shape);
	return tone === "onScreen" ? style.bold(colored) : tone === "faded" ? style.dim(colored) : colored;
}

/** The main row's mark: filled while the screen shows main, a muted open circle while it shows a subagent. */
function mainGlyph(style: AgentPanelStyle, tone: RowTone): string {
	if (tone === "onScreen") return style.bold(style.text(FILLED_CIRCLE));
	return tone === "selected" ? style.text(OPEN_CIRCLE) : style.muted(OPEN_CIRCLE);
}

function stateWord(row: AgentPanelRow): string {
	switch (row.state) {
		case "running":
			return "running";
		case "input":
			return "needs input";
		case "paused":
			return "paused";
		case "queued":
			return "queued";
		case "stopping":
			return "stopping";
		case "waiting":
			return row.waitingOn ? `waiting on ${panelText(row.waitingOn)}` : "waiting";
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "stopped":
			return "stopped";
	}
}

function rightColumn(row: AgentPanelRow, width: number): string {
	const elapsed = row.elapsedMs === undefined ? "" : formatPanelElapsed(row.elapsedMs);
	if (row.state === "running") {
		const tokens = row.tokens === undefined || width < 70 ? "" : `↓ ${formatTokenCount(row.tokens)} tokens`;
		if (elapsed.length > 0 && tokens.length > 0) return `${elapsed} · ${tokens}`;
		return elapsed || tokens || "running";
	}
	const word = stateWord(row);
	return elapsed.length > 0 ? `${word} · ${elapsed}` : word;
}

export interface AgentPanelRenderOptions {
	readonly selectedId?: string;
	readonly faded?: (row: AgentPanelRow) => boolean;
	readonly scroll?: number;
	readonly hiddenAbove?: number;
	readonly hiddenBelow?: number;
	/** The main-chat row above the list. Defaults to shown only while focused. */
	readonly showMain?: boolean;
	/**
	 * The row of the subagent the screen shows: its open circle is filled and it reads in bold, and the main row's mark
	 * is a muted open circle. Undefined while the screen shows main: the main row is filled and bold.
	 */
	readonly viewedId?: string;
	/** Shell rows are a subagent's own shells, listed right under it: they are indented one step. */
	readonly nestShells?: boolean;
	/**
	 * The open panel's model column: a row whose model became known while shown waits for its reasoning level, and the
	 * column does not narrow while it fits. Without it, each row shows its model as soon as it is known.
	 */
	readonly modelColumn?: ModelColumn;
}

/** What a panel row reports to its view's `ModelColumn`, given its model column text `label`. */
function panelModelReport(row: AgentPanelRow, label: string): ModelCellReport {
	return {
		model: label.length > 0 && typeof row.model === "string" ? row.model : undefined,
		settled: Boolean(row.thinking) || isFinishedPanelRow(row),
		levelless: () => typeof row.model === "string" && modelHasReasoning(taskClockOf(row) ?? row, row.model) === false,
	};
}

/** The cells a nested shell row is indented by. */
const NESTED_INDENT = 2;

/** The main-chat row leads the panel whenever it lists a subagent. */
export function panelShowsMain(rows: readonly Pick<AgentPanelRow, "kind">[]): boolean {
	return rows.some((row) => row.kind === "agent");
}

export function renderAgentPanelRows(
	rows: readonly AgentPanelRow[],
	width: number,
	style: AgentPanelStyle,
	options: AgentPanelRenderOptions = {},
): string[] {
	if (rows.length === 0) return [];
	const { shown, showMain, hiddenAbove, hiddenBelow } = panelWindow(rows, options);
	const count = shown.length;
	const names = new Array<string>(count);
	const nameWidths = new Array<number>(count);
	const models = new Array<string>(count);
	const tasks = new Array<string>(count);
	const rights = new Array<string>(count);
	const queues = new Array<string | undefined>(count);
	let nameWidth = 4;
	let modelWidth = 0;
	const nested = (row: AgentPanelRow) => options.nestShells === true && row.kind === "shell";
	for (let i = 0; i < count; i++) {
		const raw = shown[i]!;
		const cleanName = panelText(raw.name);
		const w = cellWidth(cleanName);
		names[i] = cleanName;
		nameWidths[i] = w;
		// A nested row's name starts after its indent, and ends in the same column as the others.
		const span = nested(raw) ? w + NESTED_INDENT : w;
		if (span > nameWidth) nameWidth = span < 14 ? span : 14;
		models[i] = width >= AGENT_PANEL_MODEL_MIN_WIDTH ? panelModelText(raw) : "";
		tasks[i] = panelText(raw.task);
		rights[i] = rightColumn(raw, width);
		queues[i] = Number.isSafeInteger(raw.queued) && (raw.queued ?? 0) > 0 ? ` · ${raw.queued} queued` : undefined;
	}
	const modelColumn = options.modelColumn;
	// The widest label as the rows report it: a label still waiting for its level counts for whether any column fits.
	let widest = 0;
	for (const model of models) if (model.length > 0) widest = Math.max(widest, cellWidth(model));
	// Too narrow for the column: the rows are seen afresh once it is wide enough again, as on a first paint.
	if (modelColumn !== undefined && !(width >= AGENT_PANEL_MODEL_MIN_WIDTH)) modelColumn.forget();
	else if (modelColumn !== undefined) {
		const showing = modelColumn.paint(
			shown.map((row, i) => [row.id, panelModelReport(row, models[i]!)] as const),
			rows,
		);
		for (let i = 0; i < count; i++) if (!showing.has(shown[i]!.id)) models[i] = "";
	}
	for (const model of models) if (model.length > 0) modelWidth = Math.max(modelWidth, cellWidth(model));
	// The model column shows only while every row keeps its whole right column and some of its task beside it. A nested
	// row's indent is inside the name column, so `nameWidth` spans it.
	const modelFits = (column: number) => {
		const fixed = 6 + nameWidth + column + 2;
		for (let i = 0; i < count; i++) {
			const queued = queues[i];
			const rightWidth = cellWidth(queued === undefined ? rights[i]! : rights[i]! + queued);
			const taskRoom = width - fixed - rightWidth - 2;
			if (fixed + rightWidth + 1 > width || (tasks[i]!.length > 0 && taskRoom < MIN_TASK_WIDTH)) return false;
		}
		return true;
	};
	// An open panel's column does not narrow while it fits (`ModelColumn.column`).
	const fits = (column: number) => width >= AGENT_PANEL_MODEL_MIN_WIDTH && modelFits(column);
	if (modelColumn !== undefined) modelWidth = modelColumn.column(width, modelWidth, fits, widest);
	else if (modelWidth > 0 && !fits(modelWidth)) modelWidth = 0;
	const viewing = options.viewedId !== undefined;
	const lines: string[] = [];
	const line = (
		id: string,
		glyphText: string,
		name: string,
		knownNameWidth: number,
		task: string,
		right: string,
		tone: RowTone,
		queued?: string,
		model?: string,
		indent = 0,
	) => {
		// Columns 0-1 hold only the selection cursor.
		const cursor = options.selectedId === id ? style.accent(style.bold("∀ ")) : "  ";
		const lead = indent > 0 ? `${cursor}${" ".repeat(indent)}` : cursor;
		const paint = (text: string) => paintRow(style, tone, text);
		if (width < 40) {
			const shortName = fitToWidth(name, Math.max(1, width - 5 - indent)).text;
			return lines.push(clampLine(`${lead}${glyphText} ${paint(shortName)}`, width));
		}
		const room = nameWidth - indent;
		const fittedName = knownNameWidth <= room ? { text: name, width: knownNameWidth } : fitToWidth(name, room);
		const head =
			fittedName.width < room ? `${fittedName.text}${" ".repeat(room - fittedName.width)}` : fittedName.text;
		const headWidth = indent + (fittedName.width < room ? room : fittedName.width);
		const modelCell =
			model === undefined || modelWidth === 0
				? ""
				: `${model.length > 0 ? style.dim(model) : ""}${" ".repeat(modelWidth - cellWidth(model) + 2)}`;
		const fixed = 6 + headWidth + (modelCell.length > 0 ? modelWidth + 2 : 0);
		let shownRight = right;
		let shownQueued = queued;
		if (fixed + cellWidth(queued === undefined ? right : right + queued) + 1 > width) {
			shownQueued = undefined;
			const word = right.split(" · ")[0] ?? "";
			shownRight = fixed + cellWidth(word) + 1 <= width ? word : "";
		}
		const rightWidth = cellWidth(shownQueued === undefined ? shownRight : shownRight + shownQueued);
		const taskRoom = Math.max(0, width - fixed - rightWidth - 2);
		const fittedTask = taskRoom >= 8 && task.length > 0 ? fitToWidth(task, taskRoom) : { text: "", width: 0 };
		const pad = Math.max(1, width - fixed - fittedTask.width - rightWidth);
		const rightText = paint(shownRight) + (shownQueued === undefined ? "" : style.warning(shownQueued));
		const full = `${lead}${glyphText} ${paint(head)}  ${modelCell}${paint(fittedTask.text)}${" ".repeat(pad)}${rightText}`;
		lines.push(clampLine(full, width));
	};
	if (showMain) {
		const tone = rowTone(!viewing, false, options.selectedId === AGENT_PANEL_MAIN_ID);
		line(AGENT_PANEL_MAIN_ID, mainGlyph(style, tone), "main", 4, "", "", tone);
	}
	if (hiddenAbove > 0) lines.push(style.dim(truncateToWidth(`  ↑ ${hiddenAbove} more`, width)));
	for (let i = 0; i < count; i++) {
		const raw = shown[i]!;
		const tone = rowTone(
			viewing && options.viewedId === raw.id,
			options.faded?.(raw) === true,
			options.selectedId === raw.id,
		);
		line(
			raw.id,
			glyph(raw, style, tone),
			names[i]!,
			nameWidths[i]!,
			tasks[i]!,
			rights[i]!,
			tone,
			queues[i],
			models[i],
			nested(raw) ? NESTED_INDENT : 0,
		);
	}
	if (hiddenBelow > 0) lines.push(style.dim(truncateToWidth(`  +${hiddenBelow} more`, width)));
	return lines;
}

/** Which rows `renderAgentPanelRows` draws for `options`, and the lines it adds around them. */
function panelWindow(
	rows: readonly AgentPanelRow[],
	options: AgentPanelRenderOptions,
): {
	readonly shown: readonly AgentPanelRow[];
	readonly showMain: boolean;
	readonly hiddenAbove: number;
	readonly hiddenBelow: number;
} {
	const focused = options.selectedId !== undefined;
	const preSliced = options.hiddenAbove !== undefined || options.hiddenBelow !== undefined;
	const start = focused && !preSliced ? Math.max(0, options.scroll ?? 0) : 0;
	const visible = focused ? rows.slice(start, start + AGENT_PANEL_FOCUSED_ROWS) : rows;
	const shown = focused
		? visible
		: visible.length <= AGENT_PANEL_IDLE_ROWS
			? visible
			: visible.slice(0, AGENT_PANEL_IDLE_ROWS);
	return {
		shown,
		showMain: options.showMain ?? focused,
		hiddenAbove: options.hiddenAbove ?? (focused ? Math.min(start, rows.length) : 0),
		hiddenBelow:
			options.hiddenBelow ??
			(focused ? Math.max(0, rows.length - (start + shown.length)) : rows.length - shown.length),
	};
}

/**
 * The id of the row `renderAgentPanelRows(rows, width, style, options)` draws on line `line`: `AGENT_PANEL_MAIN_ID` for
 * the main row, a row's id, or undefined for the `↑ N more` and `+N more` lines and past the last line.
 */
export function agentPanelRowIdAtLine(
	rows: readonly AgentPanelRow[],
	options: AgentPanelRenderOptions,
	line: number,
): string | undefined {
	if (rows.length === 0 || line < 0) return undefined;
	const { shown, showMain, hiddenAbove } = panelWindow(rows, options);
	let at = line;
	if (showMain) {
		if (at === 0) return AGENT_PANEL_MAIN_ID;
		at -= 1;
	}
	if (hiddenAbove > 0) {
		if (at === 0) return undefined;
		at -= 1;
	}
	return shown[at]?.id;
}

export interface AgentPanelActions {
	open(row: AgentPanelRow): void;
	/** Enter or a click on the main row; without it, that returns to the prompt as Esc does. */
	openMain?(): void;
	stop(row: AgentPanelRow): void;
	dismiss(row: AgentPanelRow): void;
	close(): void;
}

const LITERAL_PANEL_KEYS: ReadonlySet<string> = new Set(["esc", "escape", "left", "up", "down", "home", "end"]);

function focusedPanelKeybindings(
	keybindings: NavKeybindings | undefined,
	rowSelected = true,
): NavKeybindings | undefined {
	if (!keybindings) return undefined;
	const liveKeys = (action: string): string[] =>
		(keybindings.getKeys?.(action) ?? []).filter((key) => !LITERAL_PANEL_KEYS.has(key));
	return {
		matches: (data, action) => keybindings.matches(data, action),
		getKeys: (action) => {
			const keys = liveKeys(action);
			if (action === "app.keys.help") return keys;
			const helpKeys = new Set(liveKeys("app.keys.help"));
			if (action === "app.list.open") return keys.filter((key) => !helpKeys.has(key));
			if (action === "app.list.stop") {
				const openKeys = rowSelected
					? new Set(liveKeys("app.list.open").filter((key) => !helpKeys.has(key)))
					: undefined;
				return keys.filter((key) => !helpKeys.has(key) && !openKeys?.has(key));
			}
			return keys;
		},
	};
}

export function agentPanelKeys(selected: AgentPanelRow | undefined, keybindings?: NavKeybindings): NavKey[] {
	const filtered = focusedPanelKeybindings(keybindings, selected !== undefined);
	const actionEntry = (action: string, label: string): NavKey[] => {
		if (!filtered) return [{ action, label }];
		const text = navActionText(filtered, action);
		return text ? [{ keys: text, label }] : [];
	};
	const includeHelp = filtered === undefined || (filtered.getKeys?.("app.keys.help")?.length ?? 0) > 0;
	return [
		{ keys: "↑↓", label: "select" },
		...actionEntry("app.list.open", "to open"),
		...(selected === undefined
			? []
			: actionEntry("app.list.stop", isFinishedPanelRow(selected) ? "dismiss" : "stop")),
		{ keys: "esc/←", label: "back to prompt" },
		...(includeHelp ? [{ action: "app.keys.help", label: "keys" }] : []),
	];
}

export class AgentPanelFocus {
	selectedId: string = AGENT_PANEL_MAIN_ID;
	scroll = 0;
	helpOpen = false;
	readonly stopConfirm: TwoPressConfirm;
	private rows: readonly AgentPanelRow[] = [];
	private readonly keys: NavKeybindings;
	private readonly actions: AgentPanelActions;
	constructor(keys: NavKeybindings, actions: AgentPanelActions, now: () => number = Date.now) {
		this.keys = keys;
		this.actions = actions;
		this.stopConfirm = new TwoPressConfirm(now);
	}
	finishedWhileArmed?: AgentPanelRow;
	private finishedAcknowledged = false;
	private readonly paintedFinished = new Map<string, boolean>();
	private selectionMovedUnseen = false;
	/** Whether the main-chat row leads the list; without it, ↑ on the first row returns to the prompt. */
	get showMain(): boolean {
		return panelShowsMain(this.rows);
	}
	notePainted(rows: readonly AgentPanelRow[]): void {
		this.paintedFinished.clear();
		for (const row of rows) this.paintedFinished.set(row.id, isFinishedPanelRow(row));
		this.selectionMovedUnseen = false;
	}
	update(rows: readonly AgentPanelRow[]): void {
		const selectedIndex = this.rows.findIndex((row) => row.id === this.selectedId);
		const mainWasShown = this.showMain;
		const ids = new Set([AGENT_PANEL_MAIN_ID]);
		this.rows = rows.filter((row) => {
			if (ids.has(row.id)) return false;
			ids.add(row.id);
			return true;
		});
		const armed = this.stopConfirm.pending();
		const settled = rows.find((row) => row.id === armed && isFinishedPanelRow(row));
		if (settled !== undefined) {
			this.stopConfirm.reset();
			this.finishedWhileArmed = settled;
			this.finishedAcknowledged = false;
		} else if (
			this.finishedWhileArmed !== undefined &&
			!rows.some((row) => row.id === this.finishedWhileArmed?.id && isFinishedPanelRow(row))
		) {
			this.finishedWhileArmed = undefined;
		}
		if (this.selectedId !== AGENT_PANEL_MAIN_ID && !rows.some((row) => row.id === this.selectedId)) {
			this.selectedId =
				this.rows[Math.max(0, Math.min(selectedIndex, this.rows.length - 1))]?.id ?? AGENT_PANEL_MAIN_ID;
			this.selectionMovedUnseen = true;
		} else if (this.selectedId === AGENT_PANEL_MAIN_ID && !this.showMain && this.rows.length > 0) {
			// The main row left with the last subagent: the selection moves to the first row.
			this.selectedId = this.rows[0]!.id;
			if (mainWasShown) this.selectionMovedUnseen = true;
		}
		this.keepInView();
	}
	/** A click on a row opens it, as Enter on it does; a click on the main row returns to the prompt. */
	click(id: string): void {
		this.stopConfirm.reset();
		this.finishedWhileArmed = undefined;
		this.selectionMovedUnseen = false;
		if (id === AGENT_PANEL_MAIN_ID) {
			this.openMain();
			return;
		}
		const row = this.rows.find((candidate) => candidate.id === id);
		if (row === undefined) return;
		this.selectedId = id;
		this.keepInView();
		this.actions.open(row);
	}
	enter(selectId?: string): void {
		this.selectedId = this.rows.some((row) => row.id === selectId)
			? (selectId as string)
			: (this.rows[0]?.id ?? AGENT_PANEL_MAIN_ID);
		this.keepInView();
	}
	private openMain(): void {
		if (this.actions.openMain === undefined) this.actions.close();
		else this.actions.openMain();
	}
	selected(): AgentPanelRow | undefined {
		return this.rows.find((row) => row.id === this.selectedId);
	}
	finishedAction(): "dismiss" | "acknowledge" {
		return this.finishedAcknowledged ? "dismiss" : "acknowledge";
	}
	pendingStop(): AgentPanelRow | undefined {
		const id = this.stopConfirm.pending();
		return id === undefined ? undefined : this.rows.find((row) => row.id === id);
	}
	private ids(): string[] {
		const ids = this.rows.map((row) => row.id);
		return this.showMain ? [AGENT_PANEL_MAIN_ID, ...ids] : ids;
	}
	private firstId(): string {
		return this.showMain ? AGENT_PANEL_MAIN_ID : (this.rows[0]?.id ?? AGENT_PANEL_MAIN_ID);
	}
	private keepInView(): void {
		const index = this.rows.findIndex((row) => row.id === this.selectedId);
		if (index < 0) {
			this.scroll = 0;
			return;
		}
		if (index < this.scroll) this.scroll = index;
		if (index >= this.scroll + AGENT_PANEL_FOCUSED_ROWS) this.scroll = index - AGENT_PANEL_FOCUSED_ROWS + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - AGENT_PANEL_FOCUSED_ROWS)));
	}
	private move(delta: number): void {
		const ids = this.ids();
		const index = Math.max(0, ids.indexOf(this.selectedId));
		this.selectedId = ids[Math.max(0, Math.min(ids.length - 1, index + delta))] ?? AGENT_PANEL_MAIN_ID;
		this.keepInView();
	}
	handleInput(data: string, is: (data: string, key: string) => boolean): boolean {
		if (this.helpOpen) {
			this.stopConfirm.reset();
			this.finishedWhileArmed = undefined;
			if (is(data, "escape") || this.keys.matches(data, "app.keys.help")) this.helpOpen = false;
			return true;
		}
		const literalNav =
			is(data, "escape") ||
			is(data, "left") ||
			is(data, "up") ||
			is(data, "down") ||
			is(data, "home") ||
			is(data, "end");
		const helpKey = !literalNav && this.keys.matches(data, "app.keys.help");
		const openKey = !literalNav && !helpKey && this.keys.matches(data, "app.list.open");
		const stopKey = !literalNav && !helpKey && !openKey && this.keys.matches(data, "app.list.stop");
		if (!stopKey) {
			this.stopConfirm.reset();
			this.finishedWhileArmed = undefined;
		}
		if (is(data, "escape") || is(data, "left")) {
			this.actions.close();
			return true;
		}
		if (is(data, "up")) {
			this.selectionMovedUnseen = false;
			if (this.selectedId === this.firstId()) this.actions.close();
			else this.move(-1);
			return true;
		}
		if (is(data, "down")) {
			this.selectionMovedUnseen = false;
			this.move(1);
			return true;
		}
		if (is(data, "home")) {
			this.selectionMovedUnseen = false;
			this.selectedId = this.firstId();
			this.scroll = 0;
			return true;
		}
		if (is(data, "end")) {
			this.selectionMovedUnseen = false;
			this.selectedId = this.rows.at(-1)?.id ?? AGENT_PANEL_MAIN_ID;
			this.keepInView();
			return true;
		}
		if (helpKey) {
			this.helpOpen = true;
			return true;
		}
		const row = this.selected();
		if (this.selectionMovedUnseen && (stopKey || openKey)) {
			this.stopConfirm.reset();
			return true;
		}
		if (openKey) {
			if (row === undefined) this.openMain();
			else this.actions.open(row);
			return true;
		}
		if (stopKey) {
			if (row === undefined) return true;
			const armed = this.stopConfirm.pending();
			if (armed !== undefined && armed !== row.id) {
				this.stopConfirm.reset();
				return true;
			}
			if (isFinishedPanelRow(row) && this.paintedFinished.get(row.id) !== true) {
				this.stopConfirm.reset();
				this.finishedWhileArmed = row;
				this.finishedAcknowledged = true;
				return true;
			}
			if (isFinishedPanelRow(row)) {
				if (this.finishedWhileArmed?.id === row.id && !this.finishedAcknowledged) {
					this.finishedAcknowledged = true;
					return true;
				}
				this.finishedWhileArmed = undefined;
				this.actions.dismiss(row);
			} else if (this.stopConfirm.press(row.id)) this.actions.stop(row);
			return true;
		}
		return true;
	}
}

export function renderAgentPanelHint(
	focus: AgentPanelFocus,
	width: number,
	style: AgentPanelStyle,
	keybindings: NavKeybindings | undefined,
): string {
	const selected = focus.selected();
	const filtered = focusedPanelKeybindings(keybindings, selected !== undefined);
	const finished = focus.finishedWhileArmed;
	if (finished !== undefined) {
		const key = filtered?.getKeys?.("app.list.stop")?.[0] ?? "x";
		return style.warning(
			truncateToWidth(
				`  ${panelText(finished.name)} finished · ${clickableKeyTextHint(key, ` to ${focus.finishedAction()}`)}`,
				width,
			),
		);
	}
	const pending = focus.pendingStop();
	if (pending !== undefined) {
		const key = filtered?.getKeys?.("app.list.stop")?.[0] ?? "x";
		return style.warning(
			truncateToWidth(
				`  Press ${clickableKeyTextHint(key, " again")} within 3s to stop ${panelText(pending.name)}`,
				width,
			),
		);
	}
	return renderNavHintLine(agentPanelKeys(selected, keybindings), width, style, filtered);
}

export function panelTaskId(row: Pick<AgentPanelRow, "id">): TaskId | undefined {
	return row.id.startsWith("task:") ? (row.id.slice(5) as TaskId) : undefined;
}
