import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import {
	type AgentPanelSession,
	agentPanelItems,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	sourceError,
	stopAgentPanelItem,
	subscribeAgentPanel,
} from "../../core/tasks/agent-panel-source.ts";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import {
	AGENT_PANEL_FOCUSED_ROWS,
	AGENT_PANEL_IDLE_ROWS,
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	agentPanelKeys,
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

interface PanelState {
	readonly model: AgentPanelModel;
	readonly viewed: Set<string>;
	readonly reported: Set<string>;
	readonly keepRow: (row: AgentPanelRow) => boolean;
	open?: boolean;
	onSourceError?: (error: Error) => void;
	reportOnce?: (error: unknown) => void;
	setVisible?: (visible: boolean) => void;
}

const states = new WeakMap<object, PanelState>();

function panelState(session: object): PanelState {
	let state = states.get(session);
	if (state === undefined) {
		const viewed = new Set<string>();
		state = {
			model: new AgentPanelModel(),
			viewed,
			reported: new Set(),
			keepRow: (row) => row.kind === "workflow" && !viewed.has(row.id),
		};
		states.set(session, state);
	}
	return state;
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

/** The panel's colours from Atomic's theme. */
export function themedAgentPanelStyle(): AgentPanelStyle {
	return THEMED_STYLE;
}

/** The rows the panel shows now: workflow runs, then subagents and shells, newest first, with finished rows aging out. */
export function agentPanelRows(session: AgentPanelSession & object): AgentPanelRow[] {
	const state = panelState(session);
	const items = agentPanelItems(session, state.onSourceError);
	if (items.length <= 1) return state.model.rows(items, state.keepRow);
	const ordered: AgentPanelRow[] = [];
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.kind === "workflow") ordered.push(item);
	}
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.kind !== "workflow") ordered.push(item);
	}
	// A finished run stays until it has been viewed; a finished task ages out.
	return state.model.rows(ordered, state.keepRow);
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;
const REFRESH_WINDOW_MS = 50;
const REFRESH_BUDGET_MS = 8;
const REFRESH_BURST = 4;

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

/**
 * Mounts the unfocused panel below the prompt while it has rows, and keeps it current: task and run changes repaint
 * it, and a one-second tick advances elapsed times, the spinner and fading while anything is listed.
 */
export function bindAgentPanel(
	session: AgentPanelSession & object,
	ui: Pick<ExtensionUIContext, "setWidget" | "requestRender"> &
		Partial<Pick<ExtensionUIContext, "onWidgetRelease" | "notify">>,
): () => void {
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
	let visible = true;
	let disposed = false;
	let dirty = false;
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
		if (began - windowStart >= REFRESH_WINDOW_MS) {
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
	const refresh = () => {
		if (disposed) return;
		if (!visible) {
			agentPanelItems(session, state.onSourceError);
			unmount();
			return;
		}
		const rows = agentPanelRows(session);
		if (rows.length === 0) {
			unmount();
			return;
		}
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
								if (now - windowStart >= REFRESH_WINDOW_MS) {
									windowStart = now;
									spent = 0;
									refreshes = 0;
								}
								if (refreshes < REFRESH_BURST || spent < REFRESH_BUDGET_MS) {
									dirty = false;
									refreshes++;
									try {
										const rows = agentPanelRows(session);
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
		timer ??= setInterval(update, TICK_MS);
		timer.unref?.();
		ui.requestRender();
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
			if (now - windowStart >= REFRESH_WINDOW_MS) {
				windowStart = now;
				spent = 0;
				refreshes = 0;
			}
			if (refreshes < REFRESH_BURST || spent < REFRESH_BUDGET_MS) {
				refreshes++;
				update();
				return;
			}
			deferred = setTimeout(
				() => {
					deferred = undefined;
					if (disposed || !dirty) return;
					const began = performance.now();
					if (began - windowStart >= REFRESH_WINDOW_MS) {
						windowStart = began;
						spent = 0;
						refreshes = 0;
					}
					refreshes++;
					update();
				},
				Math.max(0, windowStart + REFRESH_WINDOW_MS - now),
			);
			deferred.unref?.();
		});
	};
	const unsubscribe = subscribeAgentPanel(session, scheduleUpdate);
	const unwatchRelease = ui.onWidgetRelease?.(WIDGET_KEY, () => {
		mounted = false;
	});
	state.setVisible = (value) => {
		visible = value;
		update();
	};
	update();
	return () => {
		disposed = true;
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
	state.open = true;
	try {
		currentRows = agentPanelRows(session);
		if (currentRows.length === 0) return;
		state.setVisible?.(false);
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
						const taskId = panelTaskId(row);
						const back = () => showAgentPanel(session, ui, row.id);
						if (taskId !== undefined && store !== undefined)
							next = async () => {
								if (
									(await showTaskInspector(ui, store, taskId, { chat: true, backLabel: "agents" })) === "back"
								)
									await back();
							};
						else {
							state.viewed.add(row.id);
							next = async () => {
								openAgentPanelItem(session, row.id, {
									onReturn: () => {
										back().catch(report);
									},
								});
							};
						}
						finish();
					},
					stop(row) {
						void stopAgentPanelItem(session, row.id)
							.then((result) => {
								if (!result.ok)
									ui.notify?.(`Could not stop ${safeLabel(row.name)}: ${safeLabel(result.reason)}`, "warning");
								tui.requestRender();
							})
							.catch((error: unknown) => {
								ui.notify?.(`Could not stop ${safeLabel(row?.name)}: ${safeLabel(error)}`, "warning");
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
							currentRows = agentPanelRows(session);
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
						currentRows = agentPanelRows(session);
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
								currentRows = agentPanelRows(session);
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
			state.setVisible?.(true);
		} catch (error) {
			report(error);
		} finally {
			state.open = false;
		}
	}
	await next?.();
}

export function setAgentPanelVisible(session: object, visible: boolean): void {
	states.get(session)?.setVisible?.(visible);
}

export function agentPanelHasRows(session: AgentPanelSession & object): boolean {
	try {
		return agentPanelRows(session).length > 0;
	} catch (error) {
		const state = panelState(session);
		if (state.reportOnce !== undefined) state.reportOnce(error);
		else state.onSourceError?.(sourceError(error));
		return false;
	}
}
