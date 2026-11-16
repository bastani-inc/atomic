/**
 * `/workflows`: the way into a session's workflow runs. It opens the only run's graph directly, lists several, and says
 * so when there are none. Anything that lists runs opens one through {@link openWorkflowRun}, so Esc at the graph's
 * top goes back to that list.
 */

import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { deriveGraphTheme, type GraphTheme } from "../tui/graph-theme.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { renderSessionList } from "../tui/session-list.js";
import { openSessionPicker } from "../tui/session-overlays.js";
import {
	closesWorkflowsEmptySheet,
	renderWorkflowsEmptySheet,
	WORKFLOWS_EMPTY_MESSAGE,
} from "../tui/workflows-empty-sheet.js";
import type { PiCommandContext } from "./public-types.js";
import type { PiCustomComponent, PiCustomOverlayFactoryTui, PiCustomOverlayFunction } from "./wiring.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { overlaySurfaceFromContext, resolveRunId } from "./workflow-targets.js";

export interface OpenWorkflowRunOptions {
	/** Where Esc at the graph's top goes back to, such as the list the run was picked from; main chat otherwise. */
	readonly onReturn?: () => void;
	/** Open directly on this stage's chat. */
	readonly stageId?: string;
	/** The run that owns `stageId`, when it is a child run's stage. */
	readonly stageRunId?: string;
}

export interface WorkflowsCommandDeps {
	readonly overlay: GraphOverlayPort;
	readonly store: Store;
}

/**
 * Open a run's graph in the session's workflow pane, on the command's own surface when it has one and the session's
 * otherwise.
 */
export function openWorkflowRun(
	runId: string,
	ctx: Pick<PiCommandContext, "ui">,
	deps: Pick<WorkflowsCommandDeps, "overlay">,
	options: OpenWorkflowRunOptions = {},
): void {
	deps.overlay.open(runId, overlaySurfaceFromContext(ctx), options.stageId, options.stageRunId, {
		onReturn: options.onReturn,
	});
}

export interface WorkflowsCommandOptions {
	/** The run the list selects when it opens: the one a graph returning to it was opened from. */
	readonly selectRunId?: string;
}

/** `/workflows [run]`. */
export async function handleWorkflowsCommand(
	args: string,
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowsCommandDeps,
	options: WorkflowsCommandOptions = {},
): Promise<void> {
	const { store } = deps;
	const theme = deriveGraphTheme({});
	const interactive = workflowPolicyFromContext(ctx).allowInputPicker;
	const target = args.trim();
	if (target.length > 0) {
		const resolved = resolveRunId(target, store);
		if (resolved.kind === "malformed" || resolved.kind === "ambiguous") return reporter.error(resolved.message);
		if (resolved.kind === "not_found")
			return reporter.error(
				`Run not found: ${target}\n\n${renderSessionList(store.runs(), { theme, includeAll: true })}`,
			);
		if (!interactive) return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
		openWorkflowRun(resolved.runId, ctx, deps);
		return;
	}
	const runs = topLevelWorkflowRuns(store.runs());
	if (runs.length === 0) {
		if (interactive && typeof ctx.ui?.custom === "function")
			return await showWorkflowsEmptySheet(ctx.ui.custom, theme);
		return reporter.info(WORKFLOWS_EMPTY_MESSAGE);
	}
	if (!interactive) return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	if (runs.length === 1) {
		openWorkflowRun(runs[0]!.id, ctx, deps);
		return;
	}
	if (typeof ctx.ui?.custom !== "function")
		return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	const picked = await openSessionPicker(ctx.ui, store, theme, "connect", options.selectRunId);
	if (picked.kind !== "connect") return;
	// Back from the graph, the list opens again on the run it was opened from.
	const reopen = (): void => void handleWorkflowsCommand("", ctx, reporter, deps, { selectRunId: picked.runId });
	openWorkflowRun(picked.runId, ctx, deps, { onReturn: reopen });
}

/** The small sheet an empty `/workflows` shows in place of the editor, until Esc closes it. */
function showWorkflowsEmptySheet(custom: PiCustomOverlayFunction, theme: GraphTheme): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const factory = (
			_tui: PiCustomOverlayFactoryTui,
			_theme: unknown,
			_keys: unknown,
			done: (result: undefined) => void,
		): PiCustomComponent => ({
			render: (width: number) => renderWorkflowsEmptySheet(width, theme),
			handleInput: (data: string): boolean => {
				if (closesWorkflowsEmptySheet(data)) {
					done(undefined);
					settle();
				}
				return true;
			},
			invalidate: () => {},
			dispose: settle,
		});
		void Promise.resolve(custom(factory, { overlay: false, purpose: "navigation" })).then(settle, settle);
	});
}
