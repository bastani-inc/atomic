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

interface PanelState {
	readonly model: AgentPanelModel;
	readonly viewed: Set<string>;
	readonly reported: Set<string>;
	open?: boolean;
	onSourceError?: (error: Error) => void;
	reportOnce?: (error: unknown) => void;
	setVisible?: (visible: boolean) => void;
}

const states = new WeakMap<object, PanelState>();

function panelState(session: object): PanelState {
	let state = states.get(session);
	if (state === undefined) {
		state = { model: new AgentPanelModel(), viewed: new Set(), reported: new Set() };
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
		notify?.(`Agent panel: a source failed and is hidden: ${safeLabel(message)}`, "warning");
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
	const items = agentPanelItems(session, state.onSourceError);
	const runs = items.filter((item) => item.kind === "workflow").reverse();
	const tasks = items.filter((item) => item.kind !== "workflow").reverse();
	// A finished run stays until it has been viewed; a finished task ages out.
	return state.model.rows([...runs, ...tasks], (row) => row.kind === "workflow" && !state.viewed.has(row.id));
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;

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
	let mounted = false;
	let visible = true;
	let disposed = false;
	let dirty = false;
	let currentRows: AgentPanelRow[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const unmount = () => {
		currentRows = [];
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
		try {
			refresh();
		} catch (error) {
			report(error);
			unmount();
		}
	};
	const refresh = () => {
		if (disposed) return;
		if (!visible) {
			unmount();
			return;
		}
		const rows = agentPanelRows(session);
		currentRows = rows;
		if (rows.length === 0) {
			unmount();
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
						try {
							if (dirty) {
								dirty = false;
								currentRows = agentPanelRows(session);
							}
							return renderAgentPanelRows(currentRows, width, themedAgentPanelStyle(), {
								frame: atomicWorkingFrame(),
								faded: (row) => state.model.faded(row),
							});
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
	let scheduled = false;
	const scheduleUpdate = () => {
		if (disposed) return;
		dirty = true;
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (dirty) update();
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
	const style = themedAgentPanelStyle();
	let currentRows = agentPanelRows(session);
	if (currentRows.length === 0) return;
	let next: (() => Promise<void>) | undefined;
	state.open = true;
	try {
		state.setVisible?.(false);
		await ui.custom<void>(
			(tui, _theme, keybindings, done) => {
				const keys = keybindings as Parameters<typeof renderAgentPanelHint>[3] & {
					matches(data: string, action: string): boolean;
				};
				let disposed = false;
				let dirty = false;
				let scheduled = false;
				const finish = () => done();
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
					invalidate() {},
					render(width: number) {
						try {
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
						disposed = true;
						clearInterval(tick);
						unsubscribe();
					},
				};
			},
			{ overlay: false, purpose: "navigation", handlesCtrlC: true, deferInlineCustomUiFocus: true },
		);
	} finally {
		state.open = false;
		try {
			state.setVisible?.(true);
		} catch (error) {
			report(error);
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
