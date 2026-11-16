import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import {
	type AgentPanelItem,
	type AgentPanelSession,
	agentPanelItems,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	stopAgentPanelItem,
	subscribeAgentPanel,
	viewedAgentPanelItems,
} from "../../core/tasks/agent-panel-source.ts";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import {
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
import { theme } from "../interactive/theme/theme.js";
import { showTaskInspector, type TaskInspectorUi } from "./task-ui-bridge.js";

/** Per-session panel state that outlives one mount: when rows finished, viewed and dismissed runs. */
interface PanelState {
	readonly model: AgentPanelModel;
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

/** The rows the panel shows now: workflow runs, then subagents and shells, newest first, with finished rows aging out. */
export function agentPanelRows(session: AgentPanelSession & object): AgentPanelRow[] {
	const state = panelState(session);
	const sharedViewed = viewedAgentPanelItems(session);
	const items = agentPanelItems(session);
	const runs: AgentPanelItem[] = [];
	const tasks: AgentPanelItem[] = [];
	const liveWorkflowIds = new Set<string>();
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.kind === "workflow") {
			runs.push(item);
			liveWorkflowIds.add(item.id);
		} else {
			tasks.push(item);
		}
	}
	for (const id of state.viewed) if (!liveWorkflowIds.has(id)) state.viewed.delete(id);
	for (const id of sharedViewed) if (!liveWorkflowIds.has(id)) sharedViewed.delete(id);
	// A finished run stays until it has been viewed; a finished task ages out.
	return state.model.rows(
		[...runs, ...tasks],
		(row) => row.kind === "workflow" && row.viewed !== true && !state.viewed.has(row.id) && !sharedViewed.has(row.id),
	);
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;
export const AGENT_PANEL_REFRESH_WINDOW_MS = 50;
export const AGENT_PANEL_REFRESH_BUDGET_MS = 8;
export const AGENT_PANEL_REFRESH_BURST = 4;

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
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const update = () => {
		if (disposed) return;
		if (!visible) {
			currentRows = [];
			if (mounted) ui.setWidget(WIDGET_KEY, undefined);
			mounted = false;
			stopTimer();
			return;
		}
		const rows = agentPanelRows(session);
		currentRows = rows;
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
	const sharedViewed = viewedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const style = themedAgentPanelStyle();
	let currentRows = agentPanelRows(session);
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
						const taskId = panelTaskId(row);
						// One level down; going back from there returns to this panel with the row still selected.
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
							sharedViewed.add(row.id);
							next = async () => {
								openAgentPanelItem(session, row.id, {
									onReturn: () => {
										void back().catch((error: unknown) => {
											const message = error instanceof Error ? error.message : String(error);
											ui.notify?.(taskDisplayText(message), "warning");
										});
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
									ui.notify?.(
										`Could not stop ${taskDisplayText(row.name)}: ${taskDisplayText(result.reason)}`,
										"warning",
									);
								tui.requestRender();
							})
							.catch((error: unknown) => {
								const reason = error instanceof Error ? error.message : String(error);
								ui.notify?.(
									`Could not stop ${taskDisplayText(row.name)}: ${taskDisplayText(reason)}`,
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
						currentRows = agentPanelRows(session);
						focus.update(currentRows);
						if (currentRows.length === 0) finish();
						tui.requestRender();
					},
					close: finish,
				});
				focus.update(currentRows);
				focus.enter(selectId);
				const refreshFocus = () => {
					currentRows = agentPanelRows(session);
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
						return [
							...renderAgentPanelRows(currentRows, width, style, {
								selectedId: focus.selectedId,
								frame: atomicWorkingFrame(),
								faded: (row) => state.model.faded(row),
								scroll: focus.scroll,
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
	return agentPanelRows(session).length > 0;
}
