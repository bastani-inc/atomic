import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import {
	type AgentPanelSession,
	agentPanelExtensionItems,
	dismissedAgentPanelItems,
	lazyTaskPanelItem,
	materializePanelItem,
	openAgentPanelItem,
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
import { theme } from "../interactive/theme/theme.js";
import { showTaskInspector, type TaskInspectorUi } from "./task-ui-bridge.js";

/** Per-session panel state that outlives one mount: when rows finished, viewed and dismissed runs. */
type PanelRankCache = {
	readonly store: OwnerTaskStore | undefined;
	readonly revision: number;
	readonly extensions: string;
	readonly dismissed: ReadonlySet<string>;
	readonly expiresAt: number;
	readonly rows: AgentPanelRow[];
	readonly total: number;
	readonly extensionSlots: readonly { readonly index: number; readonly id: string }[];
};

interface PanelState {
	readonly model: AgentPanelModel;
	rankCaches?: Map<number, PanelRankCache>;
	/** Workflow-run rows opened at least once: a finished run stays until it has been viewed. */
	readonly viewed: Set<string>;
	hideCount: number;
	/** Hides the unfocused panel while the focused one owns the same rows. */
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
	if (state === undefined) {
		state = { model: new AgentPanelModel(), viewed: new Set(), hideCount: 0 };
	}
	states.set(target, state);
	const store = getOwnerTaskStore(target);
	if (store !== undefined) states.set(store, state);
	return state;
}

/** The panel's colours from Atomic's theme. */
export function themedAgentPanelStyle(): AgentPanelStyle {
	return {
		dim: (text) => theme.fg("dim", text),
		text: (text) => theme.fg("text", text),
		muted: (text) => theme.fg("muted", text),
		border: (text) => theme.fg("borderMuted", text),
		bold: (text) => theme.bold(text),
		accent: (text) => theme.fg("accent", text),
		success: (text) => theme.fg("success", text),
		error: (text) => theme.fg("error", text),
		warning: (text) => theme.fg("warning", text),
	};
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
	const extItems = agentPanelExtensionItems(session);
	const store = getOwnerTaskStore(session);
	const cap = options.cap ?? Number.POSITIVE_INFINITY;
	const revision = store?.panelRevision ?? 0;
	const extensions = JSON.stringify(
		extItems.map((item) => [
			item.id,
			item.kind,
			item.state,
			item.kind === "workflow" && item.viewed !== true && !state.viewed.has(item.id) && !sharedViewed.has(item.id),
		]),
	);
	const cached = state.rankCaches?.get(cap);
	const materialize = (row: AgentPanelRow): AgentPanelRow => currentPanelItem(store, row);
	if (
		cached !== undefined &&
		cached.store === store &&
		cached.revision === revision &&
		cached.extensions === extensions &&
		cached.expiresAt > Date.now() &&
		cached.dismissed.size === dismissed.size &&
		[...dismissed].every((id) => cached.dismissed.has(id))
	) {
		const currentExtensions = new Map(extItems.map((item) => [item.id, item]));
		for (const { index, id } of cached.extensionSlots) {
			const current = currentExtensions.get(id);
			if (current !== undefined) cached.rows[index] = current;
		}
		const start = Math.max(0, options.start ?? 0);
		const end = Math.min(cached.rows.length, start + Math.max(0, options.limit ?? AGENT_PANEL_IDLE_ROWS));
		for (let index = start; index < end; index++)
			cached.rows[index] = state.model.withElapsed(materialize(cached.rows[index]!));
		return { rows: cached.rows, total: cached.total };
	}
	const liveWorkflowIds = new Set<string>();
	for (const item of extItems) {
		if (item.kind === "workflow") liveWorkflowIds.add(item.id);
	}
	for (const id of state.viewed) if (!liveWorkflowIds.has(id)) state.viewed.delete(id);
	for (const id of sharedViewed) if (!liveWorkflowIds.has(id)) sharedViewed.delete(id);

	const { now, pass } = state.model.beginPass();
	let expiresAt = Number.POSITIVE_INFINITY;
	const inputRows: AgentPanelRow[] = [];
	const runningRows: AgentPanelRow[] = [];
	const otherRows: AgentPanelRow[] = [];
	const finishedRows: AgentPanelRow[] = [];
	let total = 0;

	const pushItem = (item: AgentPanelRow, keep: boolean) => {
		const finished = isFinishedPanelRow(item);
		if (finished) {
			if (!state.model.keepFinished(item.id, keep, now, pass)) return;
			if (!keep) expiresAt = Math.min(expiresAt, state.model.finishedSince(item.id)! + AGENT_PANEL_DROP_MS);
			total++;
			if (inputRows.length + runningRows.length + otherRows.length + finishedRows.length < cap) {
				finishedRows.push(item);
			}
		} else if (item.state === "input") {
			total++;
			if (inputRows.length < cap) inputRows.push(item);
		} else if (item.state === "running") {
			total++;
			if (inputRows.length + runningRows.length < cap) runningRows.push(item);
		} else {
			total++;
			if (inputRows.length + runningRows.length + otherRows.length < cap) otherRows.push(item);
		}
	};

	for (let i = extItems.length - 1; i >= 0; i--) {
		const item = extItems[i]!;
		if (item.kind !== "workflow") continue;
		const keep = item.viewed !== true && !state.viewed.has(item.id) && !sharedViewed.has(item.id);
		pushItem(item, keep);
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
				const id = `task:${task.ref.taskId}`;
				if (!state.model.keepFinished(id, false, now, pass)) continue;
				expiresAt = Math.min(expiresAt, state.model.finishedSince(id)! + AGENT_PANEL_DROP_MS);
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
		if (item.kind === "workflow") continue;
		pushItem(item, false);
	}

	state.model.endPass(pass);
	const ordered = [...inputRows, ...runningRows, ...otherRows, ...finishedRows];
	const rows = Number.isFinite(cap) ? ordered.slice(0, cap) : ordered;
	const start = Math.max(0, options.start ?? 0);
	const limit = Math.max(0, options.limit ?? AGENT_PANEL_IDLE_ROWS);
	const end = Math.min(rows.length, start + limit);
	for (let index = start; index < end; index++) {
		rows[index] = state.model.withElapsed(materialize(rows[index]!), now);
	}
	state.rankCaches ??= new Map();
	const extensionSlots: { index: number; id: string }[] = [];
	for (let index = 0; index < rows.length; index++) {
		if (panelTaskId(rows[index]!) === undefined) extensionSlots.push({ index, id: rows[index]!.id });
	}
	state.rankCaches.set(cap, {
		store,
		revision,
		extensions,
		dismissed: new Set(dismissed),
		expiresAt,
		rows,
		total,
		extensionSlots,
	});
	return { rows, total };
}

/** The rows the panel shows now: workflow runs, then subagents and shells, newest first, with finished rows aging out. */
export function agentPanelRows(
	session: AgentPanelSession & object,
	window?: { readonly start?: number; readonly limit?: number },
): AgentPanelRow[] {
	return [...rankPanelSession(session, window).rows];
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;
export const AGENT_PANEL_REFRESH_WINDOW_MS = 50;
export const AGENT_PANEL_REFRESH_BUDGET_MS = 8;

function budgetedPanelListener(listener: () => void): { listener: () => void; dispose(): void } {
	let windowStart = Number.NEGATIVE_INFINITY;
	let spent = 0;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	const refresh = (): void => {
		const began = performance.now();
		if (began - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS) {
			windowStart = began;
			spent = 0;
		}
		try {
			listener();
		} finally {
			spent += performance.now() - began;
		}
	};
	return {
		listener: () => {
			if (deferred !== undefined) return;
			const now = performance.now();
			if (now - windowStart >= AGENT_PANEL_REFRESH_WINDOW_MS || spent < AGENT_PANEL_REFRESH_BUDGET_MS) {
				refresh();
				return;
			}
			deferred = setTimeout(
				() => {
					deferred = undefined;
					try {
						refresh();
					} catch {}
				},
				Math.max(0, windowStart + AGENT_PANEL_REFRESH_WINDOW_MS - now),
			);
			deferred.unref?.();
		},
		dispose: () => {
			if (deferred !== undefined) clearTimeout(deferred);
			deferred = undefined;
		},
	};
}

export function bindAgentPanel(
	session: AgentPanelSession & object,
	ui: Pick<ExtensionUIContext, "setWidget" | "requestRender"> & Partial<Pick<ExtensionUIContext, "onWidgetRelease">>,
): () => void {
	boundSessions.add(session);
	const state = panelState(session);
	let mounted = false;
	let visible = state.hideCount === 0;
	let disposed = false;
	let currentRows: AgentPanelRow[] = [];
	let currentHiddenBelow = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const update = () => {
		if (disposed) return;
		if (!visible) {
			currentRows = [];
			currentHiddenBelow = 0;
			if (mounted) ui.setWidget(WIDGET_KEY, undefined);
			mounted = false;
			stopTimer();
			return;
		}
		const { rows, total } = rankPanelSession(session, {
			start: 0,
			limit: AGENT_PANEL_IDLE_ROWS,
			cap: AGENT_PANEL_IDLE_ROWS,
		});
		currentRows = rows;
		currentHiddenBelow = Math.max(0, total - rows.length);
		if (rows.length === 0) {
			if (mounted) ui.setWidget(WIDGET_KEY, undefined);
			mounted = false;
			stopTimer();
			return;
		}
		if (!mounted) {
			mounted = true;
			ui.setWidget(
				WIDGET_KEY,
				() => ({
					invalidate() {},
					render(width: number) {
						if (!visible) return [];
						return renderAgentPanelRows(currentRows, width, themedAgentPanelStyle(), {
							frame: atomicWorkingFrame(),
							faded: (row) => state.model.faded(row),
							hiddenBelow: currentHiddenBelow,
						});
					},
				}),
				{ placement: "belowEditor" },
			);
		}
		timer ??= setInterval(update, TICK_MS);
		timer.unref?.();
		ui.requestRender();
	};
	const budgeted = budgetedPanelListener(update);
	const unsubscribe = subscribeAgentPanel(session, budgeted.listener);
	const unwatchRelease = ui.onWidgetRelease?.(WIDGET_KEY, () => {
		mounted = false;
	});
	state.setVisible = (value) => {
		if (visible === value) return;
		visible = value;
		if (!value) budgeted.dispose();
		update();
	};
	update();
	return () => {
		disposed = true;
		boundSessions.delete(session);
		stopTimer();
		budgeted.dispose();
		state.setVisible = undefined;
		unsubscribe();
		unwatchRelease?.();
		if (mounted) ui.setWidget(WIDGET_KEY, undefined);
	};
}

/**
 * The focused panel, in the prompt's place: ↓ on an empty prompt opens it. Enter or → opens a subagent's or shell's
 * chat, or a workflow run's graph; `x` twice stops; Esc (or ↑ past `main`) returns to the prompt.
 */
export async function showAgentPanel(
	session: AgentPanelSession & object,
	ui: TaskInspectorUi,
	/** The row to select, as when coming back to the panel from that row's chat or graph. */
	selectId?: string,
): Promise<void> {
	const state = panelState(session);
	const store = getOwnerTaskStore(session);
	const style = themedAgentPanelStyle();
	let currentRows = agentPanelRows(session, { start: 0, limit: AGENT_PANEL_FOCUSED_ROWS });
	if (currentRows.length === 0) return;
	let next: (() => Promise<void>) | undefined;
	setAgentPanelVisible(session, false);
	try {
		await ui.custom<void>(
			(tui, _theme, keybindings, done) => {
				const keys = keybindings as Parameters<typeof renderAgentPanelHint>[3] & {
					matches(data: string, action: string): boolean;
				};
				const finish = () => done();
				const focus = new AgentPanelFocus(keys, {
					open(row) {
						const item = materializePanelItem(row);
						const taskId = panelTaskId(item);
						// One level down; going back from there returns to this panel with the row still selected.
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
										void back().catch((error: unknown) => {
											const message = error instanceof Error ? error.message : String(error);
											ui.notify?.(taskDisplayText(message), "warning");
										});
									},
								});
								if (opened) state.viewed.add(item.id);
								else ui.notify?.(`Could not open ${taskDisplayText(item.name)}.`, "warning");
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
										`Could not stop ${taskDisplayText(item.name)}: ${taskDisplayText(result.reason)}`,
										"warning",
									);
								tui.requestRender();
							})
							.catch((error: unknown) => {
								const reason = error instanceof Error ? error.message : String(error);
								ui.notify?.(
									`Could not stop ${taskDisplayText(item.name)}: ${taskDisplayText(reason)}`,
									"warning",
								);
								tui.requestRender();
							});
						tui.requestRender();
					},
					dismiss(row) {
						dismissedAgentPanelItems(session).add(row.id);
						const taskId = panelTaskId(row);
						// /tasks hides a dismissed task too.
						if (taskId !== undefined && store !== undefined)
							dismissedTasks(ownerTaskViewSource(store)).add(taskId);
						currentRows = agentPanelRows(session, {
							start: focus.scroll,
							limit: AGENT_PANEL_FOCUSED_ROWS,
						});
						focus.update(currentRows);
						if (currentRows.length === 0) finish();
						tui.requestRender();
					},
					close: finish,
				});
				focus.update(currentRows);
				focus.enter(selectId);
				const refreshFocus = () => {
					currentRows = agentPanelRows(session, {
						start: focus.scroll,
						limit: AGENT_PANEL_FOCUSED_ROWS,
					});
					focus.update(currentRows);
					tui.requestRender();
				};
				const budgetedFocus = budgetedPanelListener(refreshFocus);
				const unsubscribe = subscribeAgentPanel(session, budgetedFocus.listener);
				const tick = setInterval(refreshFocus, TICK_MS);
				tick.unref?.();
				return {
					invalidate() {},
					render(width: number) {
						if (focus.helpOpen)
							return renderNavKeyOverlay(
								"keys · agents",
								agentPanelKeys(focus.selected()).concat([
									{ keys: "↑ on main", label: "back to prompt" },
									{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
								]),
								width,
								style,
								keys,
							);
						const start = Math.max(0, focus.scroll);
						const visible = currentRows
							.slice(start, start + AGENT_PANEL_FOCUSED_ROWS)
							.map((row) => state.model.withElapsed(currentPanelItem(store, row)));
						return [
							...renderAgentPanelRows(visible, width, style, {
								selectedId: focus.selectedId,
								frame: atomicWorkingFrame(),
								faded: (row) => state.model.faded(row),
								hiddenAbove: Math.min(start, currentRows.length),
								hiddenBelow: Math.max(0, currentRows.length - (start + visible.length)),
							}),
							truncateToWidth(renderAgentPanelHint(focus, width, style, keys), width),
						];
					},
					handleInput(data: string) {
						if (isPhysicalCtrlC(data)) {
							finish();
							return true;
						}
						focus.handleInput(data, (input, key) => matchesKey(input, key as Parameters<typeof matchesKey>[1]));
						tui.requestRender();
						return true;
					},
					dispose() {
						clearInterval(tick);
						budgetedFocus.dispose();
						unsubscribe();
					},
				};
			},
			{ overlay: false, purpose: "navigation", handlesCtrlC: true, deferInlineCustomUiFocus: true },
		);
	} finally {
		setAgentPanelVisible(session, true);
	}
	await next?.();
}

/** Shows or hides the unfocused panel, as a view that owns the prompt's place (such as `/tasks`) needs. */
export function setAgentPanelVisible(session: object, visible: boolean): void {
	const state = panelState(session);
	state.hideCount = visible ? Math.max(0, state.hideCount - 1) : state.hideCount + 1;
	state.setVisible?.(state.hideCount === 0);
}

/** Whether the session has anything for ↓ to focus. */
export function agentPanelHasRows(session: AgentPanelSession & object): boolean {
	return rankPanelSession(session, { start: 0, limit: 1, cap: 1 }).total > 0;
}
