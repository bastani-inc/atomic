/**
 * `/workflows`: the way into a session's workflow runs. It opens the only run's graph directly, lists several, and says
 * so when there are none. Anything that lists runs opens one through {@link openWorkflowRun}, so Esc at the graph's
 * top goes back to that list.
 */

import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { renderSessionList } from "../tui/session-list.js";
import { openWorkflowsListing, type WorkflowsListingDefinition } from "../tui/workflows-listing.js";
import type { PiCommandContext } from "./public-types.js";
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
	/** The registered workflow definitions the `/workflows` sheet lists below the runs. */
	readonly definitions?: () => readonly WorkflowsListingDefinition[];
	/** Starts a definition chosen in the sheet, asking for its inputs first. */
	readonly startDefinition?: (name: string) => Promise<void>;
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

/** `/workflows [run]`. */
export async function handleWorkflowsCommand(
	args: string,
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowsCommandDeps,
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
	const definitions = deps.definitions?.() ?? [];
	if (runs.length === 0 && (definitions.length === 0 || !interactive))
		return reporter.info("No workflows in this session.");
	if (!interactive) return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	if (runs.length === 1) {
		openWorkflowRun(runs[0]!.id, ctx, deps);
		return;
	}
	if (typeof ctx.ui?.custom !== "function")
		return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	// Several runs, or none but definitions to start: the sheet of runs and definitions. Esc at a run's graph comes back.
	const reopen = (): void => void handleWorkflowsCommand("", ctx, reporter, deps);
	const picked = await openWorkflowsListing(ctx.ui, {
		runs: () => store.runs(),
		definitions: () => deps.definitions?.() ?? [],
		subscribe: (listener) => subscribeStoreInvalidation(store, listener),
	});
	if (picked?.kind === "run") openWorkflowRun(picked.runId, ctx, deps, { onReturn: reopen });
	else if (picked?.kind === "definition") await deps.startDefinition?.(picked.name);
}
