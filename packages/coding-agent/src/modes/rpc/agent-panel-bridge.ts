import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import {
	type AgentPanelItem,
	type AgentPanelSession,
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
	taskPanelState,
	viewedAgentPanelItems,
} from "../../core/tasks/agent-panel-source.ts";
import { taskClockOf } from "../../core/tasks/live-elapsed.ts";
import { getOwnerTaskStore, type OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import {
	AGENT_PANEL_DROP_MS,
	AGENT_PANEL_FOCUSED_ROWS,
	AGENT_PANEL_IDLE_ROWS,
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	agentPanelKeys,
	isFinishedPanelRow,
	panelTaskId,
	renderAgentPanelHint,
	renderAgentPanelRows,
} from "../interactive/components/agent-panel.ts";
import { atomicWorkingFrame } from "../interactive/components/atomic-working-status.ts";
import { renderNavKeyOverlay } from "../interactive/components/nav-keys.ts";
import { dismissedTasks } from "../interactive/components/task-dismissal.ts";
import { taskDisplayText } from "../interactive/components/task-row.js";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { getGlobalTheme } from "../interactive/theme/global-theme.ts";
import { theme } from "../interactive/theme/theme.js";
import { showTaskInspector, type TaskInspectorUi } from "./task-ui-bridge.js";

type PanelRankCache = {
	readonly store: OwnerTaskStore | undefined;
	readonly revision: number;
	readonly finishedRevision: number;
	readonly hub: ReturnType<typeof agentPanelSourceHubOf>;
	readonly generation: number;
	readonly dismissed: ReadonlySet<string>;
	readonly viewed: ReadonlySet<string>;
	readonly expiresAt: number;
	readonly rows: AgentPanelRow[];
	readonly total: number;
};

interface PanelState {
	readonly model: AgentPanelModel;

	readonly viewed: Set<string>;
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
	state ??= { model: new AgentPanelModel(), viewed: new Set(), reported: new Set(), hideCount: 0 };
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
): { readonly rows: AgentPanelRow[]; readonly total: number } {
	const state = panelState(session);
	const sharedViewed = viewedAgentPanelItems(session);
	const dismissed = dismissedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const cap = options.cap ?? Number.POSITIVE_INFINITY;
	const revision = store?.panelRevision ?? 0;
	const hub = agentPanelSourceHubOf(session);
	const generation = agentPanelSourcesGeneration();
	const start = Math.max(0, options.start ?? 0);
	const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
	const materialize = (row: AgentPanelRow): AgentPanelRow => currentPanelItem(store, row);
	const cached = state.rankCaches?.get(cap);
	const cacheMetaMatches =
		cached !== undefined &&
		cached.store === store &&
		cached.revision === revision &&
		cached.finishedRevision === state.model.finishedRevision &&
		cached.hub === hub &&
		cached.expiresAt > Date.now() &&
		sameIds(cached.dismissed, dismissed) &&
		cached.viewed.size === state.viewed.size + sharedViewed.size &&
		[...state.viewed].every((id) => cached.viewed.has(id)) &&
		[...sharedViewed].every((id) => cached.viewed.has(id));
	if (cacheMetaMatches && cached.generation === generation) {
		const end = Math.min(cached.rows.length, start + limit);
		let rows: AgentPanelRow[] | undefined;
		for (let index = start; index < end; index++) {
			const current = cached.rows[index]!;
			const base = materialize(current);
			const next = state.model.withElapsed(base);
			if (
				next === current ||
				(base === state.model.baseOf(current) && elapsedSecond(next.elapsedMs) === elapsedSecond(current.elapsedMs))
			)
				continue;
			rows ??= cached.rows.slice();
			rows[index] = next;
		}
		if (rows === undefined) return { rows: cached.rows, total: cached.total };
		state.rankCaches?.set(cap, { ...cached, rows });
		return { rows, total: cached.total };
	}
	const extItems = agentPanelExtensionItems(session, state.onSourceError);
	const liveWorkflowIds = new Set<string>();
	for (const item of extItems) if (item.kind === "workflow") liveWorkflowIds.add(item.id);
	for (const id of state.viewed) if (!liveWorkflowIds.has(id)) state.viewed.delete(id);
	for (const id of sharedViewed) if (!liveWorkflowIds.has(id)) sharedViewed.delete(id);

	const { now, pass } = state.model.beginPass();
	let expiresAt = Number.POSITIVE_INFINITY;
	const inputRows: AgentPanelRow[] = [];
	const runningRows: AgentPanelRow[] = [];
	const otherRows: AgentPanelRow[] = [];
	const finishedRows: AgentPanelRow[] = [];
	let total = 0;
	const pushItem = (item: AgentPanelItem, keep: boolean) => {
		const finished = isFinishedPanelRow(item);
		if (finished) {
			if (!state.model.keepFinished(item.id, keep, now, pass)) return;
			if (!keep) expiresAt = Math.min(expiresAt, state.model.finishedSince(item.id)! + AGENT_PANEL_DROP_MS);
		}
		total++;
		const group = finished
			? finishedRows
			: item.state === "input"
				? inputRows
				: item.state === "running"
					? runningRows
					: otherRows;
		const preceding =
			group === inputRows
				? 0
				: inputRows.length +
					(group === runningRows ? 0 : runningRows.length + (group === otherRows ? 0 : otherRows.length));
		if (preceding + group.length >= cap) return;
		group.push(item);
	};

	for (let i = extItems.length - 1; i >= 0; i--) {
		const item = extItems[i]!;
		if (item.kind !== "workflow") continue;
		pushItem(item, item.viewed !== true && !state.viewed.has(item.id) && !sharedViewed.has(item.id));
	}

	if (store !== undefined) {
		const source = ownerTaskViewSource(store);
		const sourceClocks = taskClockOf(source);
		const tasks = source.backgroundTasks;
		for (let i = tasks.length - 1; i >= 0; i--) {
			const task = tasks[i]!;
			if (task.parentTaskId !== undefined) continue;
			if (dismissed.size > 0 && dismissed.has(`task:${task.ref.taskId}`)) continue;
			const rowState = taskPanelState(task);
			if (rowState === "done" || rowState === "failed" || rowState === "stopped") {
				const id = task.ref.taskId;
				if (!state.model.keepFinished(id, false, now, pass, true)) continue;
				expiresAt = Math.min(expiresAt, state.model.finishedSince(id, true)! + AGENT_PANEL_DROP_MS);
				total++;
				if (inputRows.length + runningRows.length + otherRows.length + finishedRows.length < cap) {
					finishedRows.push(lazyTaskPanelItem(task, sourceClocks));
				}
			} else if (rowState === "input") {
				total++;
				if (inputRows.length < cap) inputRows.push(lazyTaskPanelItem(task, sourceClocks));
			} else if (rowState === "running") {
				total++;
				if (inputRows.length + runningRows.length < cap) runningRows.push(lazyTaskPanelItem(task, sourceClocks));
			} else {
				total++;
				if (inputRows.length + runningRows.length + otherRows.length < cap) {
					otherRows.push(lazyTaskPanelItem(task, sourceClocks));
				}
			}
		}
	}

	for (let i = extItems.length - 1; i >= 0; i--) {
		const item = extItems[i]!;
		if (item.kind !== "workflow") pushItem(item, false);
	}

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
		viewed: new Set([...state.viewed, ...sharedViewed]),
		expiresAt,
		rows,
		total,
	});
	return { rows, total };
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

function sameProgress(
	a: { readonly done: number; readonly total: number } | undefined,
	b: { readonly done: number; readonly total: number } | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return a.done === b.done && a.total === b.total;
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
			!sameProgress(a.progress, b.progress) ||
			model.faded(a) !== model.faded(b)
		) {
			return false;
		}
	}
	return true;
}

export function bindAgentPanel(
	session: AgentPanelSession & object,
	ui: Pick<ExtensionUIContext, "setWidget" | "requestRender"> &
		Partial<Pick<ExtensionUIContext, "onWidgetRelease" | "notify">>,
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
	let cachedLines: string[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const clearDeferred = () => {
		if (deferred !== undefined) clearTimeout(deferred);
		deferred = undefined;
	};
	const unmount = () => {
		currentRows = [];
		cachedRows = undefined;
		cachedLines = [];
		const wasMounted = mounted;
		mounted = false;
		stopTimer();
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
			unmount();
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
			unmount();
			return;
		}
		const { rows, total } = idleRows();
		if (rows.length === 0) {
			unmount();
			return;
		}
		currentHiddenBelow = Math.max(0, total - rows.length);
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
						cachedLines = [];
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
										const { rows, total } = idleRows();
										currentHiddenBelow = Math.max(0, total - rows.length);
										if (!sameUnfocusedRows(currentRows, rows, state.model)) {
											currentRows = rows;
										}
									} finally {
										spent += Math.max(0, performance.now() - now);
									}
								}
							}
							if (!Number.isFinite(w)) {
								return renderAgentPanelRows(currentRows, w, THEMED_STYLE, {
									frame: atomicWorkingFrame(),
									faded,
									hiddenBelow: currentHiddenBelow,
								});
							}
							const frame = atomicWorkingFrame();
							const fadedMask = sliceFadedMask(currentRows, 0, AGENT_PANEL_IDLE_ROWS, state.model);
							if (
								cachedRows === currentRows &&
								cachedWidth === w &&
								cachedFrame === frame &&
								cachedFaded === fadedMask
							) {
								return cachedLines;
							}
							const renderStart = performance.now();
							const lines = renderAgentPanelRows(currentRows, w, THEMED_STYLE, {
								frame,
								faded,
								hiddenBelow: currentHiddenBelow,
							});
							spent += Math.max(0, performance.now() - renderStart);
							cachedRows = currentRows;
							cachedWidth = w;
							cachedFrame = frame;
							cachedFaded = fadedMask;
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

	const rowsChangeWithTime = (rows: readonly AgentPanelRow[]): boolean => {
		const sharedViewed = viewedAgentPanelItems(session);
		for (const row of rows) {
			if (!isFinishedPanelRow(row)) return true;
			const kept =
				row.kind === "workflow" && row.viewed !== true && !state.viewed.has(row.id) && !sharedViewed.has(row.id);
			if (!kept || !state.model.faded(row)) return true;
		}
		return currentHiddenBelow > 0;
	};
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
				let cachedFrame = -1;
				let cachedFaded = -1;
				let cachedRowLines: string[] = [];
				const finish = () => {
					if (finished) return;
					finished = true;
					done();
				};
				const focus = new AgentPanelFocus(keys, {
					open(row) {
						const item = materializePanelItem(row);
						const taskId = panelTaskId(item);

						const back = () => showAgentPanel(session, ui, item.id);
						if (taskId !== undefined && store !== undefined)
							next = async () => {
								if (
									(await showTaskInspector(ui, store, taskId, { chat: true, backLabel: "agents" })) === "back"
								)
									await back();
							};
						else {
							next = async () => {
								const opened = openAgentPanelItem(session, item.id, {
									onReturn: () => {
										back().catch(report);
									},
								});
								if (opened) state.viewed.add(item.id);
								else ui.notify?.(`Could not open ${safeLabel(item.name)}.`, "warning");
							};
						}
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
				const refreshFocus = () => {
					if (disposed) return;
					dirty = false;
					try {
						currentRows = focusedRows(focus.scroll);
						focus.update(currentRows);
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
				const tick = setInterval(refreshFocus, TICK_MS);
				tick.unref?.();
				return {
					invalidate() {
						cachedRows = undefined;
						cachedRowLines = [];
					},
					render(width: number) {
						try {
							const w = +width;
							if (dirty) {
								dirty = false;
								currentRows = focusedRows(focus.scroll);
								focus.update(currentRows);
							}
							if (focus.helpOpen)
								return renderNavKeyOverlay(
									"keys · agents",
									agentPanelKeys(focus.selected()).concat([
										{ keys: "↑ on main", label: "back to prompt" },
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
									});
									cachedRows = currentRows;
									cachedWidth = w;
									cachedSelectedId = focus.selectedId;
									cachedScroll = focus.scroll;
									cachedFrame = frame;
									cachedFaded = fadedMask;
									cachedRowLines = rowLines;
								}
							}
							focus.notePainted(currentRows.slice(focus.scroll, focus.scroll + AGENT_PANEL_FOCUSED_ROWS));
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
								currentRows = focusedRows(focus.scroll);
								focus.update(currentRows);
							}
							focus.handleInput(data, (input, key) =>
								matchesKey(input, key as Parameters<typeof matchesKey>[1]),
							);
						} catch (error) {
							report(error);
						}
						tui.requestRender();
						return true;
					},
					dispose() {
						if (disposed) return;
						disposed = true;
						clearInterval(tick);
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

export function agentPanelHasRows(session: AgentPanelSession & object): boolean {
	try {
		return rankPanelSession(session, { start: 0, limit: 0, cap: 1 }).total > 0;
	} catch (error) {
		const state = panelState(session);
		if (state.reportOnce !== undefined) state.reportOnce(error);
		else state.onSourceError?.(sourceError(error));
		return false;
	}
}
