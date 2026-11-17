import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import {
	type AgentPanelItem,
	type AgentPanelState,
	agentPanelItemReadAt,
	agentPanelTaskId,
} from "../../../core/tasks/agent-panel-source.ts";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { bindTaskClock, TaskElapsedClocks, taskClockOf, taskClockRunning } from "../../../core/tasks/live-elapsed.ts";
import { getGlobalTheme } from "../theme/global-theme.ts";
import { ATOMIC_WORKING_FRAMES, atomicWorkingGlyph } from "./atomic-working-status.ts";
import { type NavKey, type NavKeybindings, type NavKeyStyle, renderNavHintLine, TwoPressConfirm } from "./nav-keys.ts";
import { taskDisplayText } from "./task-row.js";

export type AgentPanelRow = AgentPanelItem;
export type { AgentPanelState };

export const AGENT_PANEL_FADE_MS = 30_000;
export const AGENT_PANEL_DROP_MS = 180_000;
export const AGENT_PANEL_IDLE_ROWS = 4;
export const AGENT_PANEL_FOCUSED_ROWS = 8;
export const AGENT_PANEL_MAIN_ID = "main";

export interface AgentPanelStyle extends NavKeyStyle {
	accent(text: string): string;
	success(text: string): string;
	error(text: string): string;
	warning(text: string): string;
}

const FINISHED: ReadonlySet<AgentPanelState> = new Set(["done", "failed", "stopped"]);
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const NON_SINGLE_CELL = /[^\x20-\x7e\u00b7\u25b0\u25b1\u2193]/;
const NON_SINGLE_CELL_LINE = /[^\x20-\x7e·▰▱↓∀⧗◆‖○◼✓✗●❯]/;
const SGR_SEQUENCE = /\x1b\[[\d;:]*m/g;
const MAX_CACHED_LINE_WIDTHS = 512;
const singleCellLineWidths = new Map<string, number>();
const BARS_16 = Array.from({ length: 17 }, (_, filled) => "▰".repeat(filled) + "▱".repeat(16 - filled));
let glyphThemeRef: ReturnType<typeof getGlobalTheme>;
let glyphNoColor: string | undefined;
let glyphReducedMotion: string | undefined;
const glyphCache: Array<string | undefined> = new Array(ATOMIC_WORKING_FRAMES.length);

function cachedWorkingGlyph(frame: number): string {
	const themeRef = getGlobalTheme();
	const noColor = process.env.NO_COLOR;
	const reduced = process.env.ATOMIC_REDUCED_MOTION;
	if (themeRef !== glyphThemeRef || noColor !== glyphNoColor || reduced !== glyphReducedMotion) {
		glyphThemeRef = themeRef;
		glyphNoColor = noColor;
		glyphReducedMotion = reduced;
		glyphCache.fill(undefined);
	}
	const count = ATOMIC_WORKING_FRAMES.length;
	const index = reduced === "1" ? 3 : ((frame % count) + count) % count;
	let cached = glyphCache[index];
	if (cached === undefined) {
		cached = atomicWorkingGlyph(index);
		glyphCache[index] = cached;
	}
	return cached;
}

export function isFinishedPanelRow(row: Pick<AgentPanelRow, "state">): boolean {
	return FINISHED.has(row.state);
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

export function formatPanelTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "0";
	const rounded = Math.round(tokens);
	if (rounded < 1000) return String(rounded);
	const units = ["k", "M", "B", "T", "Q"];
	let amount = tokens / 1000;
	let unit = 0;
	while (Math.round(amount * 10) >= 10_000 && unit < units.length - 1) {
		amount /= 1000;
		unit++;
	}
	return `${amount.toFixed(1)}${units[unit]}`;
}

export function panelProgressBar(done: number, total: number, cells = 16): string {
	const ratio = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? done / total : 0;
	const clamped = Math.max(0, Math.min(1, ratio));
	if (cells === 16) return BARS_16[Math.round(clamped * 16)]!;
	const size = Number.isFinite(cells) ? Math.max(0, Math.min(1024, Math.floor(cells))) : 0;
	const filled = Math.round(clamped * size);
	return "▰".repeat(filled) + "▱".repeat(size - filled);
}

export class AgentPanelModel {
	private readonly finishedAt = new Map<string, { since: number; pass: number }>();
	private readonly finishedTaskAt = new Map<string, { since: number; pass: number }>();
	private readonly readAt = new WeakMap<AgentPanelRow, number>();
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
	keepFinished(id: string, keep: boolean, now: number, pass: number, native = false): boolean {
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
		return keep || now - entry.since < AGENT_PANEL_DROP_MS;
	}
	endPass(pass: number): void {
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
		if (state === "queued") return row;
		const running = taskClockRunning(state);
		if (row.kind === "workflow") {
			if (!running || row.elapsedMs === undefined) return row;
			let since = agentPanelItemReadAt(row) ?? this.readAt.get(row);
			if (since === undefined) {
				since = now;
				this.readAt.set(row, since);
			}
			const elapsedMs = row.elapsedMs + Math.max(0, now - since);
			return elapsedMs === row.elapsedMs ? row : this.copyOf(row, { ...row, elapsedMs });
		}
		const taskId = agentPanelTaskId(row.id) ?? row.id;
		const sourceClocks = taskClockOf(row);
		if (sourceClocks === undefined) this.hasLocalClocks = true;
		const elapsedMs = (sourceClocks ?? this.elapsedClocks).elapsedMs(
			taskId,
			row.elapsedMs,
			running,
			now,
			FINISHED.has(state),
		);
		if (elapsedMs === undefined || elapsedMs === row.elapsedMs) return row;
		const copy = { ...row, elapsedMs };
		return this.copyOf(row, sourceClocks === undefined ? copy : bindTaskClock(copy, sourceClocks));
	}
	baseOf(row: AgentPanelRow): AgentPanelRow {
		return this.bases.get(row) ?? row;
	}
	private copyOf(base: AgentPanelRow, copy: AgentPanelRow): AgentPanelRow {
		this.bases.set(copy, base);
		return copy;
	}
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
		for (const row of rows) {
			const state = row.state;
			states.set(row, state);
			if (FINISHED.has(state)) {
				if (!this.keepFinished(row.id, keep(row), now, pass)) continue;
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
		for (let index = start; index < end; index++) {
			const row = ordered[index]!;
			const state = states.get(row)!;
			ordered[index] = this.withElapsed(row, now, state);
			if (row.kind !== "workflow" && state !== "queued" && taskClockOf(row) === undefined) {
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

function glyph(row: AgentPanelRow, style: AgentPanelStyle, frame: number | undefined): string {
	switch (row.state) {
		case "running":
			if (row.kind === "shell") return style.accent("⧗");
			return frame === undefined ? style.accent("∀") : cachedWorkingGlyph(frame);
		case "input":
			return style.warning("◆");
		case "paused":
			return style.warning("‖");
		case "queued":
			return style.dim("○");
		case "stopping":
			return style.warning("◼");
		case "done":
			return style.success("✓");
		case "failed":
			return style.error("✗");
		case "stopped":
			return style.muted("◼");
	}
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
		const tokens = row.tokens === undefined || width < 70 ? "" : `↓ ${formatPanelTokens(row.tokens)} tokens`;
		if (elapsed.length > 0 && tokens.length > 0) return `${elapsed} · ${tokens}`;
		return elapsed || tokens || "running";
	}
	const word = stateWord(row);
	return elapsed.length > 0 ? `${word} · ${elapsed}` : word;
}

function taskColumn(row: AgentPanelRow, cleanTask: string, width: number): string {
	if (row.kind === "workflow" && row.progress !== undefined && width >= 60) {
		return `${panelProgressBar(row.progress.done, row.progress.total)}  ${row.progress.done}/${row.progress.total} stages`;
	}
	return cleanTask;
}

export interface AgentPanelRenderOptions {
	readonly selectedId?: string;
	readonly frame?: number;
	readonly faded?: (row: AgentPanelRow) => boolean;
	readonly scroll?: number;
	readonly hiddenAbove?: number;
	readonly hiddenBelow?: number;
}

export function renderAgentPanelRows(
	rows: readonly AgentPanelRow[],
	width: number,
	style: AgentPanelStyle,
	options: AgentPanelRenderOptions = {},
): string[] {
	if (rows.length === 0) return [];
	const focused = options.selectedId !== undefined;
	const preSliced = options.hiddenAbove !== undefined || options.hiddenBelow !== undefined;
	const start = focused && !preSliced ? Math.max(0, options.scroll ?? 0) : 0;
	const visible = focused ? rows.slice(start, start + AGENT_PANEL_FOCUSED_ROWS) : rows;
	const shown = focused
		? visible
		: visible.length <= AGENT_PANEL_IDLE_ROWS
			? visible
			: visible.slice(0, AGENT_PANEL_IDLE_ROWS);
	const count = shown.length;
	const names = new Array<string>(count);
	const nameWidths = new Array<number>(count);
	let nameWidth = 4;
	for (let i = 0; i < count; i++) {
		const cleanName = panelText(shown[i]!.name);
		const w = cellWidth(cleanName);
		names[i] = cleanName;
		nameWidths[i] = w;
		if (w > nameWidth) nameWidth = w < 14 ? w : 14;
	}
	const lines: string[] = [];
	const line = (
		id: string,
		glyphText: string,
		name: string,
		knownNameWidth: number,
		task: string,
		right: string,
		dim: boolean,
		queued?: string,
	) => {
		const selected = options.selectedId === id;
		const cursor = selected ? style.accent(style.bold("❯ ")) : "  ";
		const paint = (text: string) => (dim ? style.dim(text) : selected ? style.text(text) : style.muted(text));
		if (width < 40) {
			const shortName = fitToWidth(name, Math.max(1, width - 5)).text;
			const short = `${cursor}${glyphText} ${paint(shortName)}`;
			return lines.push(clampLine(short, width));
		}
		const fittedName =
			knownNameWidth <= nameWidth ? { text: name, width: knownNameWidth } : fitToWidth(name, nameWidth);
		const head =
			fittedName.width < nameWidth
				? `${fittedName.text}${" ".repeat(nameWidth - fittedName.width)}`
				: fittedName.text;
		const headWidth = fittedName.width < nameWidth ? nameWidth : fittedName.width;
		const fixed = 6 + headWidth;
		let shownRight = right;
		let shownQueued = queued;
		if (fixed + cellWidth(queued === undefined ? right : right + queued) + 1 > width) {
			shownQueued = undefined;
			const word = right.split(" · ")[0] ?? "";
			shownRight = fixed + cellWidth(word) + 1 <= width ? word : "";
		}
		const rightWidth = cellWidth(shownQueued === undefined ? shownRight : shownRight + shownQueued);
		const taskRoom = Math.max(0, width - fixed - rightWidth - 2);
		const fittedTask = taskRoom >= 4 && task.length > 0 ? fitToWidth(task, taskRoom) : { text: "", width: 0 };
		const pad = Math.max(1, width - fixed - fittedTask.width - rightWidth);
		const nameText = selected ? style.bold(style.text(head)) : paint(head);
		const rightText = paint(shownRight) + (shownQueued === undefined ? "" : style.warning(shownQueued));
		const full = `${cursor}${glyphText} ${nameText}  ${paint(fittedTask.text)}${" ".repeat(pad)}${rightText}`;
		lines.push(clampLine(full, width));
	};
	if (focused) {
		const selected = options.selectedId === AGENT_PANEL_MAIN_ID;
		line(AGENT_PANEL_MAIN_ID, selected ? style.accent("●") : style.text("●"), "main", 4, "", "", false);
	}
	const hiddenAbove = options.hiddenAbove ?? (focused ? Math.min(start, rows.length) : 0);
	if (hiddenAbove > 0) lines.push(style.dim(truncateToWidth(`  ↑ ${hiddenAbove} more`, width)));
	for (let i = 0; i < count; i++) {
		const raw = shown[i]!;
		const cleanName = names[i]!;
		const cleanTask = panelText(raw.task);
		const dim = options.faded?.(raw) === true;
		const queued = Number.isSafeInteger(raw.queued) && (raw.queued ?? 0) > 0 ? ` · ${raw.queued} queued` : undefined;
		line(
			raw.id,
			dim ? style.dim(glyph(raw, style, undefined)) : glyph(raw, style, options.frame),
			cleanName,
			nameWidths[i]!,
			taskColumn(raw, cleanTask, width),
			rightColumn(raw, width),
			dim,
			queued,
		);
	}
	const hiddenBelow =
		options.hiddenBelow ?? (focused ? Math.max(0, rows.length - (start + shown.length)) : rows.length - shown.length);
	if (hiddenBelow > 0) lines.push(style.dim(truncateToWidth(`  +${hiddenBelow} more`, width)));
	return lines;
}

export interface AgentPanelActions {
	open(row: AgentPanelRow): void;
	stop(row: AgentPanelRow): void;
	dismiss(row: AgentPanelRow): void;
	close(): void;
}

export function agentPanelKeys(selected: AgentPanelRow | undefined): NavKey[] {
	return [
		{ keys: "↑↓", label: "select" },
		...(selected === undefined
			? []
			: [
					{ action: "app.list.open", label: "to open" },
					{ action: "app.list.stop", label: isFinishedPanelRow(selected) ? "dismiss" : "stop" },
				]),
		{ keys: "esc/←", label: "back to prompt" },
		{ action: "app.keys.help", label: "keys" },
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
	notePainted(rows: readonly AgentPanelRow[]): void {
		this.paintedFinished.clear();
		for (const row of rows) this.paintedFinished.set(row.id, isFinishedPanelRow(row));
		this.selectionMovedUnseen = false;
	}
	update(rows: readonly AgentPanelRow[]): void {
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
			this.selectedId = rows[0]?.id ?? AGENT_PANEL_MAIN_ID;
			this.selectionMovedUnseen = true;
		}
		this.keepInView();
	}
	enter(selectId?: string): void {
		this.selectedId = this.rows.some((row) => row.id === selectId)
			? (selectId as string)
			: (this.rows[0]?.id ?? AGENT_PANEL_MAIN_ID);
		this.keepInView();
	}
	selected(): AgentPanelRow | undefined {
		return this.rows.find((row) => row.id === this.selectedId);
	}
	pendingStop(): AgentPanelRow | undefined {
		const id = this.stopConfirm.pending();
		return id === undefined ? undefined : this.rows.find((row) => row.id === id);
	}
	private ids(): string[] {
		return [AGENT_PANEL_MAIN_ID, ...this.rows.map((row) => row.id)];
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
			if (is(data, "escape") || this.keys.matches(data, "app.keys.help")) this.helpOpen = false;
			return true;
		}
		if (this.keys.matches(data, "app.keys.help")) {
			this.helpOpen = true;
			return true;
		}
		const stopKey = this.keys.matches(data, "app.list.stop");
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
			if (this.selectedId === AGENT_PANEL_MAIN_ID) this.actions.close();
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
			this.selectedId = AGENT_PANEL_MAIN_ID;
			this.scroll = 0;
			return true;
		}
		if (is(data, "end")) {
			this.selectionMovedUnseen = false;
			this.selectedId = this.rows.at(-1)?.id ?? AGENT_PANEL_MAIN_ID;
			this.keepInView();
			return true;
		}
		const row = this.selected();
		if (this.selectionMovedUnseen && (stopKey || this.keys.matches(data, "app.list.open"))) {
			this.stopConfirm.reset();
			return true;
		}
		if (this.keys.matches(data, "app.list.open")) {
			if (row === undefined) this.actions.close();
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
			if (isFinishedPanelRow(row) && this.paintedFinished.get(row.id) === false) {
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
	const finished = focus.finishedWhileArmed;
	if (finished !== undefined) {
		const key = keybindings?.getKeys?.("app.list.stop")?.[0] ?? "x";
		return style.warning(truncateToWidth(`  ${panelText(finished.name)} finished · ${key} to dismiss`, width));
	}
	const pending = focus.pendingStop();
	if (pending !== undefined) {
		const key = keybindings?.getKeys?.("app.list.stop")?.[0] ?? "x";
		return style.warning(truncateToWidth(`  Press ${key} again within 3s to stop ${panelText(pending.name)}`, width));
	}
	return renderNavHintLine(agentPanelKeys(focus.selected()), width, style, keybindings);
}

export function panelTaskId(row: Pick<AgentPanelRow, "id">): TaskId | undefined {
	return row.id.startsWith("task:") ? (row.id.slice(5) as TaskId) : undefined;
}
