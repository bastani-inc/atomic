import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { renderSessionList } from "../tui/session-list.js";
import { openWorkflowsListing, type WorkflowsListingDefinition } from "../tui/workflows-listing.js";
import type { PiCommandContext } from "./public-types.js";
import { tokenizeWorkflowArgs, type WorkflowCommandReporter } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { overlaySurfaceFromContext, resolveRunId, resolveStageTarget } from "./workflow-targets.js";

export interface OpenWorkflowRunOptions {
	readonly onReturn?: () => void;
	readonly stageId?: string;
	readonly stageRunId?: string;
}

export interface WorkflowsCommandDeps {
	readonly overlay: GraphOverlayPort;
	readonly store: Store;
	readonly definitions?: () => readonly WorkflowsListingDefinition[];
	readonly startDefinition?: (name: string) => Promise<void>;
}

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
	readonly selectRunId?: string;
}

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
	const tokens = tokenizeWorkflowArgs(args);
	const target = tokens[0] ?? "";
	const stageTarget = tokens[1];
	if (target.length > 0) {
		const resolved = resolveRunId(target, store);
		if (resolved.kind === "malformed" || resolved.kind === "ambiguous") return reporter.error(resolved.message);
		if (resolved.kind === "not_found")
			return reporter.error(
				`Run not found: ${target}\n\n${renderSessionList(store.runs(), { theme, includeAll: true })}`,
			);
		const resolvedStage = resolveStageTarget(resolved.runId, stageTarget, store);
		if (!resolvedStage.ok) return reporter.error(resolvedStage.message);
		if (!interactive) return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
		openWorkflowRun(
			resolved.runId,
			ctx,
			deps,
			resolvedStage.stageId === undefined
				? {}
				: { stageId: resolvedStage.stageId, stageRunId: resolvedStage.runId ?? resolved.runId },
		);
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
	await showWorkflowsListing(ctx, reporter, deps, options.selectRunId);
}

async function showWorkflowsListing(
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowsCommandDeps,
	selectRunId?: string,
): Promise<void> {
	const { store } = deps;
	const reopen = (): void => {
		showWorkflowsListing(ctx, reporter, deps, picked?.kind === "run" ? picked.runId : undefined).catch(
			(error: unknown) =>
				reporter.error(`/workflows failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	};
	const picked = await openWorkflowsListing(ctx.ui, {
		runs: () => store.runs(),
		definitions: () => deps.definitions?.() ?? [],
		subscribe: (listener) => subscribeStoreInvalidation(store, listener),
		initialId: selectRunId === undefined ? undefined : `run:${selectRunId}`,
	});
	if (picked?.kind === "run") openWorkflowRun(picked.runId, ctx, deps, { onReturn: reopen });
	else if (picked?.kind === "definition") await deps.startDefinition?.(picked.name);
}
