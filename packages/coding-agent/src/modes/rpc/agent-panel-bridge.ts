import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import { countPanelRow, isRestingPanelRow, NO_PANEL_ROWS, panelRowListed } from "../../core/tasks/agent-panel-rules.ts";
import {
	type AgentPanelItem,
	type AgentPanelSession,
	type AgentPanelSourceHub,
	agentPanelExtensionItems,
	agentPanelSourceHubOf,
	agentPanelSourcesGeneration,
	dismissedAgentPanelItems,
	lazyTaskPanelItem,
	materializePanelItem,
	openAgentPanelItem,
	sampleAgentPanelSources,
	sourceError,
	stopAgentPanelItem,
	subscribeAgentPanel,
	taskPanelItem,
	taskPanelRole,
	taskPanelState,
	taskRunGeneration,
} from "../../core/tasks/agent-panel-source.ts";
import { latestSubagentAttempt, supersededSettledAttempts } from "../../core/tasks/completion.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import { taskClockOf, taskClockRunning } from "../../core/tasks/live-elapsed.js";
import { getOwnerTaskStore, type OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import {
	AGENT_PANEL_FOCUSED_ROWS,
	AGENT_PANEL_IDLE_ROWS,
	AGENT_PANEL_MAIN_ID,
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	agentPanelKeys,
	agentPanelRowIdAtLine,
	isActivePanelRow,
	isFinishedPanelRow,
	panelTaskId,
	renderAgentPanelHint,
	renderAgentPanelRows,
} from "../interactive/components/agent-panel.ts";
import { atomicWorkingFrame } from "../interactive/components/atomic-working-status.ts";
import { renderNavKeyOverlay } from "../interactive/components/nav-keys.ts";
import { isSingleLeftClick } from "../interactive/components/single-click.ts";
import { dismissedTasks } from "../interactive/components/task-dismissal.ts";
import { taskDisplayText } from "../interactive/components/task-row.js";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { getGlobalTheme } from "../interactive/theme/global-theme.ts";
import { theme } from "../interactive/theme/theme.js";
import { showTaskInspector, type TaskInspectorUi } from "./task-ui-bridge.js";

export interface AgentPanelCounts {
	/** Every row the panel lists: ↓ focuses the panel while it is not 0. */
	readonly total: number;
	/** The subagent rows among them, folded rows included; the hint counts only these as agents. */
	readonly agents?: number;
	readonly needsInput: number;
	/** Running background shells: counted in the hint line, listed in /tasks rather than the panel. */
	readonly shells?: number;
	/** The chat's subagents in /tasks, listed in the panel or not: the hint points there once the panel lists none. */
	readonly subagents?: number;
}

const EMPTY_PANEL_COUNTS: AgentPanelCounts = { ...NO_PANEL_ROWS, shells: 0, subagents: 0 };

type PanelRankCache = PanelRanking & {
	readonly store: OwnerTaskStore | undefined;
	readonly revision: number;
	readonly finishedRevision: number;
	readonly hub: AgentPanelSourceHub | undefined;
	readonly generation: number;
	readonly dismissed: ReadonlySet<string>;
};

interface PanelRanking {
	readonly rows: AgentPanelRow[];
	readonly counts: AgentPanelCounts;
	readonly main: boolean;
}

function rankingOf(cache: PanelRankCache, rows: AgentPanelRow[] = cache.rows): PanelRanking {
	return { rows, counts: cache.counts, main: cache.main };
}

interface PanelState {
	readonly model: AgentPanelModel;
	readonly reported: Set<string>;
	rankCaches?: Map<number, PanelRankCache>;
	hideCount: number;
	open?: boolean;
	onSourceError?: (error: Error) => void;
	reportOnce?: (error: unknown) => void;
	setVisible?: (visible: boolean) => void;
}

const states = new WeakMap<object, PanelState>();
const boundSessions = new Set<AgentPanelSession & object>();

function panelState(target: object): PanelState {
	let state = states.get(target);
	if (state === undefined) {
		const store = getOwnerTaskStore(target);
		if (store !== undefined) state = states.get(store);
	}
	if (state === undefined) {
		for (const session of boundSessions) {
			if (getOwnerTaskStore(session) === target) {
				state = states.get(session);
				break;
			}
		}
	}
	state ??= { model: new AgentPanelModel(), reported: new Set(), hideCount: 0 };
	states.set(target, state);
	const store = getOwnerTaskStore(target);
	if (store !== undefined) states.set(store, state);
	return state;
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

function safeLabel(value: unknown): string {
	const raw = typeof value === "string" ? value : sourceError(value).message;
	return taskDisplayText(raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""))
		.toWellFormed()
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}

function notifyPanelWarning(
	notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined,
	message: string,
): void {
	try {
		notify?.(`Agent panel: a source failed: ${safeLabel(message)}`, "warning");
	} catch {}
}

function reportOnceWith(
	state: PanelState,
	notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined,
	error: unknown,
): void {
	const message = sourceError(error).message;
	if (state.reported.has(message)) return;
	state.reported.add(message);
	notifyPanelWarning(notify, message);
}

function panelTheme(): typeof theme {
	return getGlobalTheme() ?? theme;
}

const THEMED_STYLE: AgentPanelStyle = {
	dim: (text) => panelTheme().fg("dim", text),
	text: (text) => panelTheme().fg("text", text),
	muted: (text) => panelTheme().fg("muted", text),
	border: (text) => panelTheme().fg("borderMuted", text),
	bold: (text) => panelTheme().bold(text),
	accent: (text) => panelTheme().fg("accent", text),
	success: (text) => panelTheme().fg("success", text),
	error: (text) => panelTheme().fg("error", text),
	warning: (text) => panelTheme().fg("warning", text),
};

export function themedAgentPanelStyle(): AgentPanelStyle {
	return THEMED_STYLE;
}

function currentPanelItem(store: OwnerTaskStore | undefined, row: AgentPanelRow): AgentPanelRow {
	const taskId = panelTaskId(row);
	const task = taskId === undefined ? undefined : store?.taskRecord(taskId);
	if (task === undefined || store === undefined) return materializePanelItem(row);
	return taskPanelItem(task, taskClockOf(ownerTaskViewSource(store)));
}

function rankPanelSession(
	session: AgentPanelSession & object,
	options: { readonly start?: number; readonly limit?: number; readonly cap?: number } = {},
): PanelRanking {
	const state = panelState(session);
	const dismissed = dismissedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const cap = options.cap ?? Number.POSITIVE_INFINITY;
	const revision = store?.panelRevision ?? 0;
	const hub = agentPanelSourceHubOf(session);
	const generation = agentPanelSourcesGeneration();
	const start = Math.max(0, options.start ?? 0);
	const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
	const materialize = (row: AgentPanelRow): AgentPanelRow => currentPanelItem(store, row);
	const cached =
		state.rankCaches?.get(cap) ??
		(limit === 0
			? (state.rankCaches?.get(AGENT_PANEL_IDLE_ROWS) ?? state.rankCaches?.get(Number.POSITIVE_INFINITY))
			: undefined);
	if (
		cached !== undefined &&
		cached.store === store &&
		cached.revision === revision &&
		cached.finishedRevision === state.model.finishedRevision &&
		cached.hub === hub &&
		cached.generation === generation &&
		sameIds(cached.dismissed, dismissed)
	) {
		const end = Math.min(cached.rows.length, start + limit);
		if (end <= start) return rankingOf(cached);
		let rows: AgentPanelRow[] | undefined;
		for (let index = start; index < end; index++) {
			const current = cached.rows[index]!;
			const base = materialize(state.model.baseOf(current));
			const next = state.model.withElapsed(base);
			if (
				next === current ||
				(base === state.model.baseOf(current) && elapsedSecond(next.elapsedMs) === elapsedSecond(current.elapsedMs))
			)
				continue;
			rows ??= cached.rows.slice();
			rows[index] = next;
		}
		if (rows === undefined) return rankingOf(cached);
		state.rankCaches?.set(cap, { ...cached, rows });
		return rankingOf(cached, rows);
	}
	const extItems = agentPanelExtensionItems(session, state.onSourceError);
	const source = store === undefined ? undefined : ownerTaskViewSource(store);
	const tasks = source?.backgroundTasks ?? [];
	// A resumed or woken subagent is listed as its latest attempt only.
	const superseded = tasks.length === 0 ? new Set<TaskId>() : supersededSettledAttempts(tasks);
	// Resting rows, such as a stopped subagent, stay listed only while something is active: a
	// row, or a running shell, which is not one.
	let active = false;
	for (const item of extItems) {
		if ((item.kind === "agent" || item.kind === "shell") && isActivePanelRow(item)) {
			active = true;
			break;
		}
	}
	if (!active) {
		for (const task of tasks) {
			if (task.parentTaskId !== undefined || (superseded.size > 0 && superseded.has(task.ref.taskId))) continue;
			// Background work that is not a row (a shell) is active while it runs.
			if (
				taskPanelRole(task) === "agent"
					? isActivePanelRow({ state: taskPanelState(task) })
					: task.execution.kind !== "settled"
			) {
				active = true;
				break;
			}
		}
	}

	const { now, pass } = state.model.beginPass();
	const inputRows: AgentPanelRow[] = [];
	const runningRows: AgentPanelRow[] = [];
	const otherRows: AgentPanelRow[] = [];
	const finishedRows: AgentPanelRow[] = [];
	let counts = NO_PANEL_ROWS;
	let shells = 0;
	let subagents = 0;
	const room = () => inputRows.length + runningRows.length + otherRows.length + finishedRows.length < cap;
	/** Whether the panel lists a row, by the shared rules; a finished row it lists starts fading. */
	const listed = (
		rowId: string,
		kind: AgentPanelItem["kind"],
		rowState: AgentPanelItem["state"],
		finished: boolean,
		kept: boolean,
		fadeKey: string,
		native: boolean,
		run: string | undefined,
	): boolean => {
		const retired = isRestingPanelRow(kind, rowState) && state.model.retireResting(rowId, active, pass, run);
		if (!panelRowListed(kind, rowState, finished, { active, retired, kept })) return false;
		if (finished) state.model.keepFinished(fadeKey, true, now, pass, native);
		counts = countPanelRow(counts, kind, rowState);
		return true;
	};
	const place = (rowState: AgentPanelItem["state"], finished: boolean, row: () => AgentPanelRow) => {
		if (finished) {
			if (room()) finishedRows.push(row());
		} else if (rowState === "input") {
			if (inputRows.length < cap) inputRows.push(row());
		} else if (rowState === "running") {
			if (inputRows.length + runningRows.length < cap) runningRows.push(row());
		} else if (inputRows.length + runningRows.length + otherRows.length < cap) otherRows.push(row());
	};
	const pushItem = (item: AgentPanelItem) => {
		// Shells are counted on the hint line and listed in /tasks, not here.
		if (item.kind === "shell") {
			if (!isFinishedPanelRow(item)) shells++;
			return;
		}
		const finished = isFinishedPanelRow(item);
		if (!listed(item.id, item.kind, item.state, finished, false, item.id, false, item.runGeneration)) return;
		place(item.state, finished, () => item);
	};

	if (store !== undefined && source !== undefined) {
		const taskDismissed = dismissedTasks(source);
		const storeDismissed = dismissedTasks(store);
		const sourceClocks = taskClockOf(source);
		for (let i = tasks.length - 1; i >= 0; i--) {
			const task = tasks[i]!;
			if (superseded.size > 0 && superseded.has(task.ref.taskId)) continue;
			if (task.parentTaskId !== undefined) continue;
			// Only subagents are rows. A shell is counted on the hint line and listed in /tasks.
			const role = taskPanelRole(task);
			if (role !== "agent") {
				if (role === "shell" && task.execution.kind !== "settled") shells++;
				continue;
			}
			subagents++;
			const id = task.ref.taskId;
			const rowState = taskPanelState(task);
			const finishedState =
				task.execution.kind === "settled" &&
				(rowState === "done" || rowState === "failed" || rowState === "stopped");
			if (!finishedState) {
				if (dismissed.size > 0) dismissed.delete(`task:${id}`);
				if (taskDismissed.size > 0) taskDismissed.delete(id);
				if (storeDismissed.size > 0) storeDismissed.delete(id);
			} else if (dismissed.size > 0 && dismissed.has(`task:${id}`)) {
				continue;
			}
			// Every native task here is a subagent row: a stopped or interrupted one rests, a finished one leaves.
			if (!listed(`task:${id}`, "agent", rowState, finishedState, false, id, true, taskRunGeneration(task)))
				continue;
			place(rowState, finishedState, () => lazyTaskPanelItem(task, sourceClocks));
		}
	}

	for (let i = extItems.length - 1; i >= 0; i--) {
		const item = extItems[i]!;
		if (item.kind === "agent" || item.kind === "shell") pushItem(item);
	}

	const panelCounts = { ...counts, shells, subagents };
	// The main row leads the panel whenever it lists a subagent.
	const main = counts.agents > 0;
	state.model.endPass(pass);
	const ordered = inputRows.concat(runningRows, otherRows, finishedRows);
	const rows = Number.isFinite(cap) ? ordered.slice(0, cap) : ordered;
	const end = Math.min(rows.length, start + limit);
	for (let index = start; index < end; index++) rows[index] = state.model.withElapsed(materialize(rows[index]!), now);
	state.rankCaches ??= new Map();
	state.rankCaches.set(cap, {
		store,
		revision,
		finishedRevision: state.model.finishedRevision,
		hub,
		generation,
		dismissed: new Set(dismissed),
		rows,
		counts: panelCounts,
		main,
	});
	return { rows, counts: panelCounts, main };
}

export function agentPanelRows(
	session: AgentPanelSession & object,
	window?: { readonly start?: number; readonly limit?: number },
): AgentPanelRow[] {
	return rankPanelSession(session, window).rows;
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;
export const AGENT_PANEL_REFRESH_WINDOW_MS = 50;
export const AGENT_PANEL_REFRESH_BUDGET_MS = 8;
const REFRESH_BURST = 4;

function withinRefreshBudget(refreshes: number, spent: number): boolean {
	if (spent < AGENT_PANEL_REFRESH_BUDGET_MS) return true;
	return refreshes < REFRESH_BURST && spent <= (refreshes + 1) * (AGENT_PANEL_REFRESH_BUDGET_MS / REFRESH_BURST);
}

function elapsedSecond(ms: number | undefined): number {
	return ms === undefined ? -1 : Math.max(0, Math.floor(ms / 1000));
}

function sliceFadedMask(rows: readonly AgentPanelRow[], start: number, count: number, model: AgentPanelModel): number {
	const end = Math.min(rows.length, start + count);
	let mask = 0;
	for (let i = start; i < end; i++) {
		if (model.faded(rows[i]!)) mask |= 1 << (i - start);
	}
	return mask;
}

function sameUnfocusedRows(
	prev: readonly AgentPanelRow[],
	next: readonly AgentPanelRow[],
	model: AgentPanelModel,
): boolean {
	if (prev === next) return true;
	if (prev.length !== next.length || prev.length === 0) return false;
	const limit = Math.min(prev.length, AGENT_PANEL_IDLE_ROWS);
	for (let i = 0; i < limit; i++) {
		const a = prev[i]!;
		const b = next[i]!;
		if (
			a.id !== b.id ||
			a.kind !== b.kind ||
			a.state !== b.state ||
			a.name !== b.name ||
			a.task !== b.task ||
			a.tokens !== b.tokens ||
			a.queued !== b.queued ||
			elapsedSecond(a.elapsedMs) !== elapsedSecond(b.elapsedMs) ||
			model.faded(a) !== model.faded(b)
		) {
			return false;
		}
	}
	return true;
}

/** Whether the rows change with time alone: a running clock, or a finished row that has not faded yet. */
function panelRowsNeedClock(rows: readonly AgentPanelRow[], state: PanelState): boolean {
	for (const row of rows) {
		if (taskClockRunning(row.state)) return true;
		if (isFinishedPanelRow(row) && !state.model.faded(row)) return true;
	}
	return false;
}

export function bindAgentPanel(
	session: AgentPanelSession & object,
	ui: Pick<ExtensionUIContext, "setWidget" | "requestRender"> &
		Partial<Pick<ExtensionUIContext, "onWidgetRelease" | "notify">>,
	onCounts?: (counts: AgentPanelCounts) => void,
	/** Where a click on a row opens that row's view; without it the rows take no clicks. */
	inspector?: TaskInspectorUi,
): () => void {
	boundSessions.add(session);
	const state = panelState(session);
	const reportSource = (error: Error) => {
		const message = sourceError(error).message;
		state.reported.add(message);
		notifyPanelWarning(ui.notify, message);
	};
	const report = (error: unknown) => reportOnceWith(state, ui.notify, error);
	state.onSourceError = reportSource;
	state.reportOnce = report;
	const faded = (row: AgentPanelRow) => state.model.faded(row);
	let mounted = false;
	let visible = state.hideCount === 0;
	let disposed = false;
	let dirty = false;
	let currentHiddenBelow = 0;
	let currentMain = false;
	let lastCounts: AgentPanelCounts | undefined;
	let scheduled = false;
	let windowStart = Number.NEGATIVE_INFINITY;
	let spent = 0;
	let refreshes = 0;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	let currentRows: AgentPanelRow[] = [];
	let cachedRows: AgentPanelRow[] | undefined;
	let cachedWidth = -1;
	let cachedFrame = -1;
	let cachedFaded = -1;
	let cachedHiddenBelow = -1;
	let cachedMain = false;
	/** The rows the widget last drew, which a click is resolved against. */
	let painted: { rows: readonly AgentPanelRow[]; hiddenBelow: number; main: boolean } | undefined;
	let cachedLines: string[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	const publishCounts = (counts: AgentPanelCounts) => {
		if (
			lastCounts !== undefined &&
			counts.total === lastCounts.total &&
			counts.needsInput === lastCounts.needsInput &&
			counts.shells === lastCounts.shells &&
			counts.subagents === lastCounts.subagents &&
			counts.agents === lastCounts.agents
		)
			return false;
		lastCounts = counts;
		try {
			onCounts?.({ ...counts });
		} catch {}
		return true;
	};
	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const clearDeferred = () => {
		if (deferred !== undefined) clearTimeout(deferred);
		deferred = undefined;
	};
	const unmount = (resetCounts = true) => {
		currentRows = [];
		currentHiddenBelow = 0;
		currentMain = false;
		cachedRows = undefined;
		cachedHiddenBelow = -1;
		cachedLines = [];
		const wasMounted = mounted;
		mounted = false;
		stopTimer();
		if (resetCounts) publishCounts(EMPTY_PANEL_COUNTS);
		if (wasMounted) {
			try {
				ui.setWidget(WIDGET_KEY, undefined);
			} catch {}
		}
	};
	const update = () => {
		dirty = false;
		const began = performance.now();
		if (began - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS) {
			windowStart = began;
			spent = 0;
			refreshes = 0;
		}
		try {
			refresh();
		} catch (error) {
			report(error);
			unmount(true);
		} finally {
			spent += Math.max(0, performance.now() - began);
		}
	};
	const idleRows = () =>
		rankPanelSession(session, { start: 0, limit: AGENT_PANEL_IDLE_ROWS, cap: AGENT_PANEL_IDLE_ROWS });
	const refresh = () => {
		if (disposed) return;
		if (!visible) {
			sampleAgentPanelSources(session, state.onSourceError);
			unmount(false);
			return;
		}
		const { rows, counts, main } = idleRows();
		// The prompt's hints still update when there are no rows to mount.
		const changed = publishCounts(counts);
		if (rows.length === 0) {
			unmount(false);
			if (changed) ui.requestRender();
			return;
		}
		currentHiddenBelow = Math.max(0, counts.total - rows.length);
		currentMain = main;
		if (!mounted || !sameUnfocusedRows(currentRows, rows, state.model)) {
			currentRows = rows;
		}
		if (!mounted) {
			mounted = true;
			ui.setWidget(
				WIDGET_KEY,
				() => ({
					invalidate() {
						cachedRows = undefined;
						cachedHiddenBelow = -1;
						cachedLines = [];
					},
					/** The id of the row last drawn on `row`, so a click on a row whose item changed is not taken. */
					paintedRowKey(row: number): string | undefined {
						if (!visible || painted === undefined) return undefined;
						return agentPanelRowIdAtLine(
							painted.rows,
							{ hiddenBelow: painted.hiddenBelow, showMain: painted.main },
							row,
						);
					},
					handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
						if (!visible || inspector === undefined || painted === undefined || !isSingleLeftClick(event))
							return undefined;
						// The rows the reader saw: the panel's rows can change before it paints them again.
						const id = agentPanelRowIdAtLine(
							painted.rows,
							{ hiddenBelow: painted.hiddenBelow, showMain: painted.main },
							event.y,
						);
						if (id === undefined) return undefined;
						// The main row is the chat the reader is already in.
						if (id === AGENT_PANEL_MAIN_ID) return { handled: true };
						const row = painted.rows.find((candidate) => candidate.id === id);
						if (row === undefined) return undefined;
						openPanelRow(session, inspector, materializePanelItem(row), report).catch(report);
						return { handled: true };
					},
					render(width: number) {
						if (!visible) return [];
						try {
							const w = +width;
							if (dirty && deferred === undefined) {
								const now = performance.now();
								if (now - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS) {
									windowStart = now;
									spent = 0;
									refreshes = 0;
								}
								if (withinRefreshBudget(refreshes, spent)) {
									dirty = false;
									refreshes++;
									try {
										const { rows, counts, main } = idleRows();
										publishCounts(counts);
										currentHiddenBelow = Math.max(0, counts.total - rows.length);
										currentMain = main;
										if (!sameUnfocusedRows(currentRows, rows, state.model)) {
											currentRows = rows;
										}
										if (rowsChangeWithTime(currentRows)) {
											timer ??= setInterval(update, TICK_MS);
											timer.unref?.();
										} else stopTimer();
									} finally {
										spent += Math.max(0, performance.now() - now);
									}
								}
							}
							painted = { rows: currentRows, hiddenBelow: currentHiddenBelow, main: currentMain };
							if (!Number.isFinite(w)) {
								return renderAgentPanelRows(currentRows, w, THEMED_STYLE, {
									frame: atomicWorkingFrame(),
									faded,
									hiddenBelow: currentHiddenBelow,
									showMain: currentMain,
								});
							}
							const frame = atomicWorkingFrame();
							const fadedMask = sliceFadedMask(currentRows, 0, AGENT_PANEL_IDLE_ROWS, state.model);
							if (
								cachedRows === currentRows &&
								cachedWidth === w &&
								cachedFrame === frame &&
								cachedFaded === fadedMask &&
								cachedHiddenBelow === currentHiddenBelow &&
								cachedMain === currentMain
							) {
								return cachedLines;
							}
							const renderStart = performance.now();
							const lines = renderAgentPanelRows(currentRows, w, THEMED_STYLE, {
								frame,
								faded,
								hiddenBelow: currentHiddenBelow,
								showMain: currentMain,
							});
							spent += Math.max(0, performance.now() - renderStart);
							cachedRows = currentRows;
							cachedWidth = w;
							cachedFrame = frame;
							cachedFaded = fadedMask;
							cachedHiddenBelow = currentHiddenBelow;
							cachedMain = currentMain;
							cachedLines = lines;
							return lines;
						} catch (error) {
							report(error);
							return [];
						}
					},
				}),
				{ placement: "belowEditor" },
			);
		}
		if (rowsChangeWithTime(currentRows)) {
			timer ??= setInterval(update, TICK_MS);
			timer.unref?.();
		} else stopTimer();
		ui.requestRender();
	};
	const rowsChangeWithTime = (rows: readonly AgentPanelRow[]): boolean => panelRowsNeedClock(rows, state);
	const scheduleUpdate = () => {
		if (disposed) return;
		dirty = true;
		if (scheduled || deferred !== undefined) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (disposed || !dirty || deferred !== undefined) return;
			const now = performance.now();
			if (now - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS) {
				windowStart = now;
				spent = 0;
				refreshes = 0;
			}
			if (withinRefreshBudget(refreshes, spent)) {
				refreshes++;
				update();
				return;
			}
			deferred = setTimeout(
				() => {
					deferred = undefined;
					if (disposed || !dirty) return;
					const began = performance.now();
					if (began - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS) {
						windowStart = began;
						spent = 0;
						refreshes = 0;
					}
					refreshes++;
					update();
				},
				Math.max(0, windowStart + AGENT_PANEL_REFRESH_WINDOW_MS - now),
			);
			deferred.unref?.();
		});
	};
	const unsubscribe = subscribeAgentPanel(session, scheduleUpdate);
	const unwatchRelease = ui.onWidgetRelease?.(WIDGET_KEY, () => {
		mounted = false;
	});
	state.setVisible = (value) => {
		if (visible === value) return;
		visible = value;
		update();
	};
	update();
	return () => {
		disposed = true;
		boundSessions.delete(session);
		clearDeferred();
		state.setVisible = undefined;
		if (state.onSourceError === reportSource) state.onSourceError = undefined;
		if (state.reportOnce === report) state.reportOnce = undefined;
		unsubscribe();
		unwatchRelease?.();
		unmount();
	};
}

/**
 * Open a panel row's view. Leaving it returns to the focused panel with the row selected.
 */
async function openPanelRow(
	session: AgentPanelSession & object,
	ui: TaskInspectorUi,
	item: AgentPanelItem,
	report: (error: unknown) => void,
): Promise<void> {
	const store = getOwnerTaskStore(session);
	const taskId = panelTaskId(item);
	// A subagent resumed while its chat was open is the same row: its latest attempt is selected again.
	const back = () => {
		const latest = taskId === undefined ? undefined : store && latestSubagentAttempt(store.tasks, taskId);
		return showAgentPanel(session, ui, latest === undefined ? item.id : `task:${latest.ref.taskId}`);
	};
	if (taskId !== undefined && store !== undefined) {
		if ((await showTaskInspector(ui, store, taskId, { chat: true, backLabel: "main chat" })) === "back") await back();
		return;
	}
	const opened = openAgentPanelItem(session, item.id, {
		onReturn: () => {
			back().catch(report);
		},
	});
	if (!opened) ui.notify?.(`Could not open ${safeLabel(item.name)}.`, "warning");
}

export async function showAgentPanel(
	session: AgentPanelSession & object,
	ui: TaskInspectorUi,
	selectId?: string,
): Promise<void> {
	const state = panelState(session);
	if (state.open) return;
	const report = (error: unknown) => {
		if (state.reportOnce !== undefined) {
			state.reportOnce(error);
			return;
		}
		reportOnceWith(state, ui.notify, error);
	};
	state.onSourceError ??= (error: Error) => {
		const message = sourceError(error).message;
		state.reported.add(message);
		notifyPanelWarning(ui.notify, message);
	};
	const store = getOwnerTaskStore(session);
	const style = THEMED_STYLE;
	const faded = (row: AgentPanelRow) => state.model.faded(row);
	let currentRows: AgentPanelRow[] = [];
	let next: (() => Promise<void>) | undefined;
	let hidden = false;
	const focusedRows = (scroll: number) =>
		agentPanelRows(session, { start: Math.max(0, scroll), limit: AGENT_PANEL_FOCUSED_ROWS });
	state.open = true;
	try {
		currentRows = focusedRows(0);
		if (currentRows.length === 0) return;
		setAgentPanelVisible(session, false);
		hidden = true;
		await ui.custom<void>(
			(tui, _theme, keybindings, done) => {
				const keys = keybindings as Parameters<typeof renderAgentPanelHint>[3] & {
					matches(data: string, action: string): boolean;
				};
				let disposed = false;
				let finished = false;
				let dirty = false;
				let scheduled = false;
				let cachedRows: AgentPanelRow[] | undefined;
				let cachedWidth = -1;
				let cachedSelectedId: string | undefined;
				let cachedScroll = -1;
				let cachedMain = false;
				/** The rows and view the focused panel last drew, which a click is resolved against. */
				let paintedFocus:
					| { rows: readonly AgentPanelRow[]; selectedId: string; scroll: number; showMain: boolean }
					| undefined;
				let cachedFrame = -1;
				let cachedFaded = -1;
				let cachedRowLines: string[] = [];
				let materializedScroll = 0;
				let tick: ReturnType<typeof setInterval> | undefined;
				const finish = () => {
					if (finished) return;
					finished = true;
					done();
				};
				const focus = new AgentPanelFocus(keys, {
					open(row) {
						const item = materializePanelItem(row);
						next = () => openPanelRow(session, ui, item, report);
						finish();
					},
					stop(row) {
						const item = materializePanelItem(row);
						void stopAgentPanelItem(session, item.id)
							.then((result) => {
								if (!result.ok)
									ui.notify?.(
										`Could not stop ${safeLabel(item.name)}: ${safeLabel(result.reason)}`,
										"warning",
									);
								tui.requestRender();
							})
							.catch((error: unknown) => {
								ui.notify?.(`Could not stop ${safeLabel(item.name)}: ${safeLabel(error)}`, "warning");
								tui.requestRender();
							})
							.catch(() => {});
						tui.requestRender();
					},
					dismiss(row) {
						if (!isFinishedPanelRow(row)) return;
						dismissedAgentPanelItems(session).add(row.id);
						const taskId = panelTaskId(row);
						if (taskId !== undefined && store !== undefined)
							dismissedTasks(ownerTaskViewSource(store)).add(taskId);
						try {
							dirty = false;
							currentRows = focusedRows(focus.scroll);
							focus.update(currentRows);
							if (currentRows.length === 0) finish();
						} catch (error) {
							report(error);
						}
						tui.requestRender();
					},
					close: finish,
				});
				focus.update(currentRows);
				focus.enter(selectId);
				const refreshRows = () => {
					materializedScroll = focus.scroll;
					currentRows = focusedRows(materializedScroll);
					if (currentRows.length === 0 && materializedScroll > 0) {
						materializedScroll = 0;
						currentRows = focusedRows(0);
					}
					focus.update(currentRows);
					// The last row left by itself (it finished, or nothing is active any more): the focus goes back
					// to the prompt, as when the last row is cleared. Never from inside a paint.
					if (currentRows.length === 0) queueMicrotask(finish);
				};
				const syncTick = () => {
					const needed = focus.pendingStop() !== undefined || panelRowsNeedClock(currentRows, state);
					if (needed) {
						tick ??= setInterval(refreshFocus, TICK_MS);
						tick.unref?.();
					} else if (tick !== undefined) {
						clearInterval(tick);
						tick = undefined;
					}
				};
				const refreshFocus = () => {
					if (disposed) return;
					dirty = false;
					try {
						refreshRows();
						syncTick();
						tui.requestRender();
					} catch (error) {
						report(error);
					}
				};
				const scheduleRefresh = () => {
					if (disposed) return;
					dirty = true;
					if (scheduled) return;
					scheduled = true;
					queueMicrotask(() => {
						scheduled = false;
						if (dirty) refreshFocus();
					});
				};
				const unsubscribe = subscribeAgentPanel(session, scheduleRefresh);
				syncTick();
				return {
					invalidate() {
						cachedRows = undefined;
						cachedRowLines = [];
					},
					/** The id of the row last drawn on `row`, so a click on a row whose item changed is not taken. */
					paintedRowKey(row: number): string | undefined {
						if (paintedFocus === undefined) return undefined;
						const { rows, ...view } = paintedFocus;
						return agentPanelRowIdAtLine(rows, view, row);
					},
					handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
						if (focus.helpOpen || paintedFocus === undefined || !isSingleLeftClick(event)) return undefined;
						// The rows the reader saw: the panel's rows can change before it paints them again.
						const { rows, ...view } = paintedFocus;
						const id = agentPanelRowIdAtLine(rows, view, event.y);
						if (id === undefined) return undefined;
						try {
							focus.click(id);
							syncTick();
						} catch (error) {
							report(error);
						}
						tui.requestRender();
						return { handled: true };
					},
					render(width: number) {
						try {
							const w = +width;
							if (dirty || materializedScroll !== focus.scroll) {
								dirty = false;
								refreshRows();
								syncTick();
							}
							paintedFocus = undefined;
							if (focus.helpOpen)
								return renderNavKeyOverlay(
									"keys · agents",
									agentPanelKeys(focus.selected(), keys).concat([
										{ keys: focus.showMain ? "↑ on main" : "↑ on the first row", label: "back to prompt" },
										{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
									]),
									w,
									style,
									keys,
								);
							let rowLines: string[];
							if (!Number.isFinite(w)) {
								rowLines = renderAgentPanelRows(currentRows, w, style, {
									selectedId: focus.selectedId,
									frame: atomicWorkingFrame(),
									faded,
									scroll: focus.scroll,
									showMain: focus.showMain,
								});
							} else {
								const frame = atomicWorkingFrame();
								const fadedMask = sliceFadedMask(
									currentRows,
									focus.scroll,
									AGENT_PANEL_FOCUSED_ROWS,
									state.model,
								);
								if (
									cachedRows === currentRows &&
									cachedWidth === w &&
									cachedSelectedId === focus.selectedId &&
									cachedScroll === focus.scroll &&
									cachedMain === focus.showMain &&
									cachedFrame === frame &&
									cachedFaded === fadedMask
								) {
									rowLines = cachedRowLines;
								} else {
									rowLines = renderAgentPanelRows(currentRows, w, style, {
										selectedId: focus.selectedId,
										frame,
										faded,
										scroll: focus.scroll,
										showMain: focus.showMain,
									});
									cachedRows = currentRows;
									cachedWidth = w;
									cachedSelectedId = focus.selectedId;
									cachedScroll = focus.scroll;
									cachedMain = focus.showMain;
									cachedFrame = frame;
									cachedFaded = fadedMask;
									cachedRowLines = rowLines;
								}
							}
							focus.notePainted(currentRows.slice(focus.scroll, focus.scroll + AGENT_PANEL_FOCUSED_ROWS));
							paintedFocus = {
								rows: currentRows,
								selectedId: focus.selectedId,
								scroll: focus.scroll,
								showMain: focus.showMain,
							};
							return [...rowLines, truncateToWidth(renderAgentPanelHint(focus, w, style, keys), w)];
						} catch (error) {
							report(error);
							return [];
						}
					},
					handleInput(data: string) {
						if (isPhysicalCtrlC(data)) {
							finish();
							return true;
						}
						try {
							if (dirty) {
								dirty = false;
								refreshRows();
							}
							if (currentRows.length === 0) {
								finish();
								return true;
							}
							focus.handleInput(data, (input, key) =>
								matchesKey(input, key as Parameters<typeof matchesKey>[1]),
							);
							syncTick();
						} catch (error) {
							report(error);
						}
						tui.requestRender();
						return true;
					},
					dispose() {
						if (disposed) return;
						disposed = true;
						if (tick !== undefined) clearInterval(tick);
						unsubscribe();
						if (!finished) queueMicrotask(finish);
					},
				};
			},
			{ overlay: false, purpose: "navigation", handlesCtrlC: true, deferInlineCustomUiFocus: true },
		);
	} finally {
		try {
			if (hidden) setAgentPanelVisible(session, true);
		} catch (error) {
			report(error);
		} finally {
			state.open = false;
		}
	}
	await next?.();
}

export function setAgentPanelVisible(session: object, visible: boolean): void {
	const state = panelState(session);
	state.hideCount = visible ? Math.max(0, state.hideCount - 1) : state.hideCount + 1;
	state.setVisible?.(state.hideCount === 0);
}

export function agentPanelCounts(session: AgentPanelSession & object): AgentPanelCounts {
	try {
		return { ...rankPanelSession(session, { start: 0, limit: 0, cap: 1 }).counts };
	} catch (error) {
		const state = panelState(session);
		if (state.reportOnce !== undefined) state.reportOnce(error);
		else state.onSourceError?.(sourceError(error));
		return { ...EMPTY_PANEL_COUNTS };
	}
}

export function agentPanelHasRows(session: AgentPanelSession & object): boolean {
	return agentPanelCounts(session).total > 0;
}
