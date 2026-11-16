import {
	type AgentPanelItem,
	type AgentPanelState,
	agentPanelItemReadAt,
	agentPanelTaskId,
} from "../../../core/tasks/agent-panel-source.ts";
import { isRunningTaskClock, liveElapsedMs } from "../../../core/tasks/live-elapsed.js";
/**
 * The agent panel below the main chat's prompt: one row per running or recent subagent, workflow run and background
 * shell. Unfocused it is a quiet status block; ↓ on an empty prompt focuses it, and then it is a list like every other
 * list: ↑↓ select, Enter or → open, `x` stops (twice) or dismisses, Esc returns to the prompt.
 */

import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { atomicWorkingGlyph } from "./atomic-working-status.ts";
import { type NavKey, type NavKeybindings, type NavKeyStyle, renderNavHintLine, TwoPressConfirm } from "./nav-keys.ts";
import { taskDisplayText } from "./task-row.js";

/** A panel row: one item of the session's agent panel. */
export type AgentPanelRow = AgentPanelItem;
export type { AgentPanelState };

/** A finished row reads dim after this long, and leaves the panel after {@link AGENT_PANEL_DROP_MS}. */
export const AGENT_PANEL_FADE_MS = 30_000;
export const AGENT_PANEL_DROP_MS = 180_000;
/** Rows the unfocused panel shows before it folds the rest into `+N more`. */
export const AGENT_PANEL_IDLE_ROWS = 4;
/** Rows the focused panel shows at once; the selection scrolls through the rest. */
export const AGENT_PANEL_FOCUSED_ROWS = 8;
/** The id of the `● main` row the focused panel starts with. */
export const AGENT_PANEL_MAIN_ID = "main";

export interface AgentPanelStyle extends NavKeyStyle {
	accent(text: string): string;
	success(text: string): string;
	error(text: string): string;
	warning(text: string): string;
}

const FINISHED: ReadonlySet<AgentPanelState> = new Set(["done", "failed", "stopped"]);

export function isFinishedPanelRow(row: Pick<AgentPanelRow, "state">): boolean {
	return FINISHED.has(row.state);
}

/** One safe display line: no terminal controls, unpaired surrogates, or invisible and bidi-override characters. */
function panelText(text: string): string {
	return taskDisplayText(text)
		.toWellFormed()
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}

/** `41m`, `1h 31m`, `9s`: elapsed time as the panel shows it. */
export function formatPanelElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `96.1k`, `1.2M`, `812`: a token count as the panel shows it. */
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

/** A run's stage progress as a 16-cell bar: `▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱`. */
export function panelProgressBar(done: number, total: number, cells = 16): string {
	const size = Number.isFinite(cells) ? Math.max(0, Math.min(1024, Math.floor(cells))) : 0;
	const ratio = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? done / total : 0;
	const filled = Math.round(Math.max(0, Math.min(1, ratio)) * size);
	return "▰".repeat(filled) + "▱".repeat(size - filled);
}

/**
 * Orders rows (needing input, running, queued and stopping, then finished, each newest first as given) and applies the
 * finished-row lifetime: a row finished for {@link AGENT_PANEL_DROP_MS} leaves, unless `keep` holds it (a workflow run
 * that has not been viewed yet).
 */
export class AgentPanelModel {
	private readonly finishedAt = new Map<string, number>();
	private readonly readAt = new WeakMap<AgentPanelRow, number>();
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}
	/** When the row was first seen finished, if it is. */
	finishedSince(id: string): number | undefined {
		return this.finishedAt.get(id);
	}
	rows(rows: readonly AgentPanelRow[], keep: (row: AgentPanelRow) => boolean = () => false): AgentPanelRow[] {
		const now = this.now();
		const live = new Set<string>();
		const groups: [AgentPanelRow[], AgentPanelRow[], AgentPanelRow[], AgentPanelRow[]] = [[], [], [], []];
		for (const row of rows) {
			live.add(row.id);
			const state = row.state;
			const finished = FINISHED.has(state);
			if (!finished) this.finishedAt.delete(row.id);
			else {
				if (!this.finishedAt.has(row.id)) this.finishedAt.set(row.id, now);
				if (!keep(row) && now - (this.finishedAt.get(row.id) ?? now) >= AGENT_PANEL_DROP_MS) continue;
			}
			let item = row;
			if (state !== "queued") {
				const taskId = agentPanelTaskId(row.id);
				const running = isRunningTaskClock(state);
				if (taskId !== undefined) {
					const elapsedMs = liveElapsedMs(taskId, row.elapsedMs, running, now);
					if (elapsedMs !== undefined && elapsedMs !== row.elapsedMs) item = { ...row, elapsedMs };
				} else if (running && row.elapsedMs !== undefined) {
					let since = agentPanelItemReadAt(row) ?? this.readAt.get(row);
					if (since === undefined) {
						since = now;
						this.readAt.set(row, since);
					}
					const elapsedMs = row.elapsedMs + Math.max(0, now - since);
					if (elapsedMs !== row.elapsedMs) item = { ...row, elapsedMs };
				}
			}
			const rank = state === "input" ? 0 : state === "running" ? 1 : finished ? 3 : 2;
			groups[rank].push(item);
		}
		for (const id of this.finishedAt.keys()) if (!live.has(id)) this.finishedAt.delete(id);
		return groups.flat();
	}
	/** Whether a finished row has been finished long enough to read dim. */
	faded(row: AgentPanelRow): boolean {
		const since = this.finishedAt.get(row.id);
		return since !== undefined && this.now() - since >= AGENT_PANEL_FADE_MS;
	}
}

function glyph(row: AgentPanelRow, style: AgentPanelStyle, frame: number | undefined): string {
	switch (row.state) {
		case "running":
			return frame === undefined ? style.accent("∀") : atomicWorkingGlyph(frame);
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

/** The right-hand column: `18m · ↓ 87.4k tokens`, `done · 6m`, `needs input · 3m`. Narrow panels drop tokens. */
function rightColumn(row: AgentPanelRow, width: number): string {
	const elapsed = row.elapsedMs === undefined ? "" : formatPanelElapsed(row.elapsedMs);
	const tokens = row.tokens === undefined || width < 70 ? "" : `↓ ${formatPanelTokens(row.tokens)} tokens`;
	if (row.state === "running") return [elapsed, tokens].filter(Boolean).join(" · ") || "running";
	return [stateWord(row), elapsed].filter(Boolean).join(" · ");
}

/** The middle column: the task, or a workflow run's stage bar and `n/m stages`. */
function taskColumn(row: AgentPanelRow, width: number): string {
	if (row.kind === "workflow" && row.progress !== undefined && width >= 60) {
		const counts = `${row.progress.done}/${row.progress.total} stages`;
		const stage = row.task.startsWith("stage ") ? ` · ${row.task.slice(6)}` : "";
		return `${panelProgressBar(row.progress.done, row.progress.total)}  ${counts}${stage}`;
	}
	return row.task;
}

export interface AgentPanelRenderOptions {
	/** The selected row's id when the panel is focused; absent renders the quiet unfocused panel. */
	readonly selectedId?: string;
	/** Spinner frame for running rows; absent draws a still accent ∀. */
	readonly frame?: number;
	readonly faded?: (row: AgentPanelRow) => boolean;
	/** First row to show when focused, so the selection stays in view. */
	readonly scroll?: number;
}

/**
 * The panel's rows at `width`: `  ● main` first when focused, then one row per item. A row is
 * `<cursor><glyph> <name>  <task><pad><right>` with the right column flush to the edge.
 */
export function renderAgentPanelRows(
	rows: readonly AgentPanelRow[],
	width: number,
	style: AgentPanelStyle,
	options: AgentPanelRenderOptions = {},
): string[] {
	if (rows.length === 0) return [];
	const focused = options.selectedId !== undefined;
	const visible = focused ? rows.slice(options.scroll ?? 0, (options.scroll ?? 0) + AGENT_PANEL_FOCUSED_ROWS) : rows;
	const shown = focused ? visible : visible.slice(0, AGENT_PANEL_IDLE_ROWS);
	const nameWidth = shown.reduce((width, row) => Math.min(14, Math.max(width, visibleWidth(panelText(row.name)))), 4);
	const lines: string[] = [];
	const line = (
		id: string,
		glyphText: string,
		name: string,
		task: string,
		right: string,
		dim: boolean,
		queued?: string,
	) => {
		const selected = options.selectedId === id;
		const cursor = selected ? style.accent(style.bold("❯ ")) : "  ";
		const paint = (text: string) => (dim ? style.dim(text) : selected ? style.text(text) : style.muted(text));
		const rightPlain = right + (queued ?? "");
		const shownName = truncateToWidth(name, nameWidth);
		const head = `${shownName}${" ".repeat(Math.max(0, nameWidth - visibleWidth(shownName)))}`;
		const fixed = 2 + 2 + visibleWidth(head) + 2;
		if (width < 40) {
			const short = `${cursor}${glyphText} ${paint(truncateToWidth(name, Math.max(1, width - 5)))}`;
			return lines.push(truncateToWidth(short, width));
		}
		const rightWidth = visibleWidth(rightPlain);
		const taskRoom = Math.max(0, width - fixed - rightWidth - 2);
		const shownTask = taskRoom >= 4 ? truncateToWidth(task, taskRoom) : "";
		const pad = Math.max(1, width - fixed - visibleWidth(shownTask) - rightWidth);
		const nameText = selected ? style.bold(style.text(head)) : paint(head);
		const rightText = paint(right) + (queued === undefined ? "" : style.warning(queued));
		lines.push(
			truncateToWidth(`${cursor}${glyphText} ${nameText}  ${paint(shownTask)}${" ".repeat(pad)}${rightText}`, width),
		);
	};
	if (focused) {
		const selected = options.selectedId === AGENT_PANEL_MAIN_ID;
		line(AGENT_PANEL_MAIN_ID, selected ? style.accent("●") : style.text("●"), "main", "", "", false);
	}
	for (const raw of shown) {
		// Names and tasks come from models and commands: control sequences never reach the terminal.
		const row = { ...raw, name: panelText(raw.name), task: panelText(raw.task) };
		const dim = options.faded?.(row) === true;
		const queued = Number.isSafeInteger(row.queued) && (row.queued ?? 0) > 0 ? ` · ${row.queued} queued` : undefined;
		line(
			row.id,
			dim ? style.dim(glyph(row, style, undefined)) : glyph(row, style, options.frame),
			row.name,
			taskColumn(row, width),
			rightColumn(row, width),
			dim,
			queued,
		);
	}
	const hidden = focused ? rows.length - visible.length : rows.length - shown.length;
	if (hidden > 0) lines.push(style.dim(truncateToWidth(`  +${hidden} more`, width)));
	return lines;
}

/** What a focused panel does with its selection. */
export interface AgentPanelActions {
	/** Open the row: a subagent's or shell's chat, or a workflow run's graph. */
	open(row: AgentPanelRow): void;
	/** Stop a running row, after the second `x`. */
	stop(row: AgentPanelRow): void;
	/** Clear a finished row from the panel. */
	dismiss(row: AgentPanelRow): void;
	/** Give the keyboard back to the prompt. */
	close(): void;
}

/** The focused panel's keys, in hint order. */
export function agentPanelKeys(selected: AgentPanelRow | undefined): NavKey[] {
	return [
		{ keys: "↑↓", label: "select" },
		...(selected === undefined
			? []
			: [
					{ action: "app.list.open", label: "open" },
					{ action: "app.list.stop", label: isFinishedPanelRow(selected) ? "dismiss" : "stop" },
				]),
		{ keys: "esc/←", label: "back to prompt" },
		{ action: "app.keys.help", label: "keys" },
	];
}

/** Selection, the two-press stop and key handling of the focused panel; rendering stays with the caller. */
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
	/**
	 * A row that finished while its stop waited for the second `x`: the wait ends, and the next `x` on it only
	 * acknowledges this, so a row is never dismissed by a press aimed at a running item.
	 */
	finishedWhileArmed?: AgentPanelRow;
	private finishedAcknowledged = false;
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
		}
		if (this.selectedId !== AGENT_PANEL_MAIN_ID && !rows.some((row) => row.id === this.selectedId))
			this.selectedId = rows[0]?.id ?? AGENT_PANEL_MAIN_ID;
		this.keepInView();
	}
	/** Focus starts on the first row below `main`, as ↓ from the prompt moves one step. */
	enter(selectId?: string): void {
		this.selectedId = this.rows.some((row) => row.id === selectId)
			? (selectId as string)
			: (this.rows[0]?.id ?? AGENT_PANEL_MAIN_ID);
		this.keepInView();
	}
	selected(): AgentPanelRow | undefined {
		return this.rows.find((row) => row.id === this.selectedId);
	}
	/** The row waiting for its second `x`, while the window is open. */
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
	/** Every key belongs to the focused panel; returns whether it changed anything worth a repaint. */
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
		// Esc and ← go back one level, to the prompt the panel was focused from.
		if (is(data, "escape") || is(data, "left")) {
			this.actions.close();
			return true;
		}
		if (is(data, "up")) {
			if (this.selectedId === AGENT_PANEL_MAIN_ID) this.actions.close();
			else this.move(-1);
			return true;
		}
		if (is(data, "down")) {
			this.move(1);
			return true;
		}
		if (is(data, "home")) {
			this.selectedId = AGENT_PANEL_MAIN_ID;
			this.scroll = 0;
			return true;
		}
		if (is(data, "end")) {
			this.selectedId = this.rows.at(-1)?.id ?? AGENT_PANEL_MAIN_ID;
			this.keepInView();
			return true;
		}
		const row = this.selected();
		if (this.keys.matches(data, "app.list.open")) {
			if (row === undefined) this.actions.close();
			else this.actions.open(row);
			return true;
		}
		if (stopKey) {
			if (row === undefined) return true;
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

/** The focused panel's hint line, or the waiting second `x`. */
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

/** Task ids a panel's rows name, for a caller that acts on tasks. */
export function panelTaskId(row: Pick<AgentPanelRow, "id">): TaskId | undefined {
	return row.id.startsWith("task:") ? (row.id.slice(5) as TaskId) : undefined;
}
