/**
 * The agent panel below the main chat's prompt: one row per running or recent subagent, workflow run and background
 * shell. Unfocused it is a quiet status block; ↓ on an empty prompt focuses it, and then it is a list like every other
 * list: ↑↓ select, Enter or → open, `x` stops (twice) or dismisses, Esc returns to the prompt.
 */

import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { AgentPanelItem, AgentPanelState } from "../../../core/tasks/agent-panel-source.ts";
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
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/** A run's stage progress as a 16-cell bar: `▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱`. */
export function panelProgressBar(done: number, total: number, cells = 16): string {
	const filled = total <= 0 ? 0 : Math.round((Math.min(done, total) / total) * cells);
	return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/**
 * Orders rows (needing input, running, queued and stopping, then finished, each newest first as given) and applies the
 * finished-row lifetime: a row finished for {@link AGENT_PANEL_DROP_MS} leaves, unless `keep` holds it (a workflow run
 * that has not been viewed yet).
 */
export class AgentPanelModel {
	private readonly finishedAt = new Map<string, number>();
	/** When a task row was first seen live: its reported elapsed time arrives with progress, so the panel's clock runs between reports. */
	private readonly liveSince = new Map<string, number>();
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
		const live = new Set(rows.map((row) => row.id));
		for (const id of this.finishedAt.keys()) if (!live.has(id)) this.finishedAt.delete(id);
		for (const id of this.liveSince.keys()) if (!live.has(id)) this.liveSince.delete(id);
		const rank = (row: AgentPanelRow) =>
			row.state === "input" ? 0 : row.state === "running" ? 1 : isFinishedPanelRow(row) ? 3 : 2;
		return rows
			.filter((row) => {
				if (!isFinishedPanelRow(row)) {
					this.finishedAt.delete(row.id);
					return true;
				}
				if (!this.finishedAt.has(row.id)) this.finishedAt.set(row.id, now);
				return keep(row) || now - (this.finishedAt.get(row.id) ?? now) < AGENT_PANEL_DROP_MS;
			})
			.map((row) => {
				if (row.kind === "workflow" || isFinishedPanelRow(row) || row.state === "queued") return row;
				const since = this.liveSince.get(row.id) ?? now - (row.elapsedMs ?? 0);
				if (!this.liveSince.has(row.id)) this.liveSince.set(row.id, since);
				return { ...row, elapsedMs: Math.max(row.elapsedMs ?? 0, now - since) };
			})
			.map((row, index) => ({ row, index }))
			.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
			.map(({ row }) => row);
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
	const nameWidth = Math.min(14, Math.max(4, ...rows.map((row) => visibleWidth(row.name))));
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
	const visible = focused ? rows.slice(options.scroll ?? 0, (options.scroll ?? 0) + AGENT_PANEL_FOCUSED_ROWS) : rows;
	const shown = focused ? visible : visible.slice(0, AGENT_PANEL_IDLE_ROWS);
	for (const raw of shown) {
		// Names and tasks come from models and commands: control sequences never reach the terminal.
		const row = { ...raw, name: taskDisplayText(raw.name), task: taskDisplayText(raw.task) };
		const dim = options.faded?.(row) === true;
		const queued = row.queued ? ` · ${row.queued} queued` : undefined;
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
	update(rows: readonly AgentPanelRow[]): void {
		this.rows = rows;
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
		if (index < 0) return;
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
		if (!stopKey) this.stopConfirm.reset();
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
			if (isFinishedPanelRow(row)) this.actions.dismiss(row);
			else if (this.stopConfirm.press(row.id)) this.actions.stop(row);
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
	const pending = focus.pendingStop();
	if (pending !== undefined) {
		const key = keybindings?.getKeys?.("app.list.stop")?.[0] ?? "x";
		return style.warning(truncateToWidth(`  Press ${key} again within 3s to stop ${pending.name}`, width));
	}
	return renderNavHintLine(agentPanelKeys(focus.selected()), width, style, keybindings);
}

/** Task ids a panel's rows name, for a caller that acts on tasks. */
export function panelTaskId(row: Pick<AgentPanelRow, "id">): TaskId | undefined {
	return row.id.startsWith("task:") ? (row.id.slice(5) as TaskId) : undefined;
}
