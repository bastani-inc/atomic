import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { WorkflowPanelRun, WorkflowRunControl } from "../../core/extensions/workflow-run-control.js";
import { getOwnerTaskStore, watchOwnerTaskStoreBinding } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import {
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	agentPanelKeys,
	panelRunId,
	panelTaskId,
	renderAgentPanelHint,
	renderAgentPanelRows,
	taskPanelRows,
} from "../interactive/components/agent-panel.ts";
import { atomicWorkingFrame } from "../interactive/components/atomic-working-status.ts";
import { renderNavKeyOverlay } from "../interactive/components/nav-keys.ts";
import { dismissedTasks } from "../interactive/components/task-dismissal.ts";
import { isPhysicalCtrlC } from "../interactive/interactive-key-identity.ts";
import { theme } from "../interactive/theme/theme.js";
import { showTaskInspector, type TaskInspectorUi } from "./task-ui-bridge.js";

/** What the panel reads of a session: its task store (by identity) and its workflow runs. */
export interface AgentPanelSession {
	readonly workflows?: Pick<WorkflowRunControl, "panelRuns" | "subscribePanelRuns" | "openRun" | "quit">;
}

/** Per-session panel state that outlives one mount: when rows finished, viewed and dismissed runs. */
interface PanelState {
	readonly model: AgentPanelModel;
	readonly viewedRuns: Set<string>;
	readonly dismissedRuns: Set<string>;
	/** Hides the unfocused panel while the focused one owns the same rows. */
	setVisible?: (visible: boolean) => void;
}

const states = new WeakMap<object, PanelState>();

function panelState(session: object): PanelState {
	let state = states.get(session);
	if (state === undefined) {
		state = { model: new AgentPanelModel(), viewedRuns: new Set(), dismissedRuns: new Set() };
		states.set(session, state);
	}
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

/** A workflow run as a panel row: its name, the stage it is on or what it waits for, and its stage progress. */
export function workflowPanelRow(run: WorkflowPanelRun): AgentPanelRow {
	const live = run.endedAt === undefined;
	const state: AgentPanelRow["state"] = run.awaitingInput
		? "input"
		: run.status === "completed" || run.status === "skipped"
			? "done"
			: run.status === "failed" || run.status === "killed"
				? "failed"
				: run.status === "cancelled"
					? "stopped"
					: run.status === "paused" || run.status === "blocked"
						? "paused"
						: live
							? "running"
							: "stopped";
	const task =
		state === "input"
			? (run.question ?? (run.currentStage === undefined ? "waiting for input" : `stage ${run.currentStage}`))
			: state === "failed"
				? (run.reason ?? "failed")
				: run.currentStage === undefined
					? ""
					: `stage ${run.currentStage}`;
	return {
		id: `run:${run.runId}`,
		kind: "workflow",
		state,
		name: run.name,
		task,
		elapsedMs: run.elapsedMs,
		...(state === "running" || state === "paused" || state === "done"
			? { progress: { done: run.stagesDone, total: run.stagesTotal } }
			: {}),
	};
}

/** The rows the panel shows now: workflow runs, then subagents and shells, newest first, with finished rows aging out. */
export function agentPanelRows(session: AgentPanelSession & object): AgentPanelRow[] {
	const state = panelState(session);
	const store = getOwnerTaskStore(session);
	const source = store === undefined ? undefined : ownerTaskViewSource(store);
	const tasks = source === undefined ? [] : taskPanelRows(source, dismissedTasks(source)).reverse();
	const runs = (session.workflows?.panelRuns?.() ?? [])
		.filter((run) => !state.dismissedRuns.has(run.runId))
		.map(workflowPanelRow)
		.reverse();
	// A finished run stays until it has been viewed; a finished task ages out.
	return state.model.rows([...runs, ...tasks], (row) => {
		const runId = panelRunId(row);
		return runId !== undefined && !state.viewedRuns.has(runId);
	});
}

const WIDGET_KEY = "atomic.agent-panel";
const TICK_MS = 1000;

/**
 * Mounts the unfocused panel below the prompt while it has rows, and keeps it current: task and run changes repaint
 * it, and a one-second tick advances elapsed times, the spinner and fading while anything is listed.
 */
export function bindAgentPanel(
	session: AgentPanelSession & object,
	ui: Pick<ExtensionUIContext, "setWidget" | "requestRender"> & Partial<Pick<ExtensionUIContext, "onWidgetRelease">>,
): () => void {
	const state = panelState(session);
	let mounted = false;
	let visible = true;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeStore = () => {};
	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const update = () => {
		if (disposed) return;
		const rows = agentPanelRows(session);
		if (!visible || rows.length === 0) {
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
						const current = agentPanelRows(session);
						return renderAgentPanelRows(current, width, themedAgentPanelStyle(), {
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
	const connect = () => {
		unsubscribeStore();
		unsubscribeStore = getOwnerTaskStore(session)?.subscribe(update) ?? (() => {});
		update();
	};
	const unwatchStore = watchOwnerTaskStoreBinding(session, connect);
	const unsubscribeRuns = session.workflows?.subscribePanelRuns?.(update) ?? (() => {});
	const unwatchRelease = ui.onWidgetRelease?.(WIDGET_KEY, () => {
		mounted = false;
	});
	state.setVisible = (value) => {
		visible = value;
		update();
	};
	connect();
	return () => {
		disposed = true;
		stopTimer();
		state.setVisible = undefined;
		unwatchStore();
		unsubscribeStore();
		unsubscribeRuns();
		unwatchRelease?.();
		if (mounted) ui.setWidget(WIDGET_KEY, undefined);
	};
}

/**
 * The focused panel, in the prompt's place: ↓ on an empty prompt opens it. Enter or → opens a subagent's or shell's
 * chat, or a workflow run's graph; `x` twice stops; Esc (or ↑ past `main`) returns to the prompt.
 */
export async function showAgentPanel(session: AgentPanelSession & object, ui: TaskInspectorUi): Promise<void> {
	const state = panelState(session);
	const store = getOwnerTaskStore(session);
	const source = store === undefined ? undefined : ownerTaskViewSource(store);
	const style = themedAgentPanelStyle();
	if (agentPanelRows(session).length === 0) return;
	let next: (() => Promise<void>) | undefined;
	state.setVisible?.(false);
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
						const runId = panelRunId(row);
						if (taskId !== undefined && store !== undefined)
							next = () => showTaskInspector(ui, store, taskId, { chat: true });
						if (runId !== undefined) {
							state.viewedRuns.add(runId);
							next = async () => session.workflows?.openRun?.(runId);
						}
						finish();
					},
					stop(row) {
						const taskId = panelTaskId(row);
						const runId = panelRunId(row);
						if (taskId !== undefined) void source?.cancelTask(taskId).then(() => tui.requestRender());
						if (runId !== undefined) void session.workflows?.quit(runId).catch(() => undefined);
						tui.requestRender();
					},
					dismiss(row) {
						const taskId = panelTaskId(row);
						const runId = panelRunId(row);
						if (taskId !== undefined && source !== undefined) dismissedTasks(source).add(taskId);
						if (runId !== undefined) state.dismissedRuns.add(runId);
						focus.update(agentPanelRows(session));
						if (agentPanelRows(session).length === 0) finish();
						tui.requestRender();
					},
					close: finish,
				});
				focus.update(agentPanelRows(session));
				focus.enter();
				const unsubscribe = store?.subscribe(() => {
					focus.update(agentPanelRows(session));
					tui.requestRender();
				});
				const unsubscribeRuns = session.workflows?.subscribePanelRuns?.(() => {
					focus.update(agentPanelRows(session));
					tui.requestRender();
				});
				const tick = setInterval(() => tui.requestRender(), TICK_MS);
				tick.unref?.();
				return {
					invalidate() {},
					render(width: number) {
						const rows = agentPanelRows(session);
						focus.update(rows);
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
							...renderAgentPanelRows(rows, width, style, {
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
						unsubscribe?.();
						unsubscribeRuns?.();
					},
				};
			},
			{ overlay: false, purpose: "navigation", handlesCtrlC: true, deferInlineCustomUiFocus: true },
		);
	} finally {
		state.setVisible?.(true);
	}
	await next?.();
}

/** Shows or hides the unfocused panel, as a view that owns the prompt's place (such as `/tasks`) needs. */
export function setAgentPanelVisible(session: object, visible: boolean): void {
	states.get(session)?.setVisible?.(visible);
}

/** Whether the session has anything for ↓ to focus. */
export function agentPanelHasRows(session: AgentPanelSession & object): boolean {
	return agentPanelRows(session).length > 0;
}
