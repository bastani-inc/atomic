import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import { inertDisplayLine, inertDisplayText } from "../tui/display-text.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { withoutStackFrames } from "../tui/run-outcome.js";
import { renderSessionList } from "../tui/session-list.js";
import {
	openWorkflowsListing,
	type WorkflowsListingDefinition,
	type WorkflowsListingInvalidDefinition,
} from "../tui/workflows-listing.js";
import type { PiCommandContext } from "./public-types.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { overlaySurfaceFromContext, resolveRunId } from "./workflow-targets.js";

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
	/** Definitions discovery could not load; the sheet lists them as `✗`, and Enter explains what failed. */
	readonly invalidDefinitions?: () => readonly WorkflowsListingInvalidDefinition[];
}

/**
 * What a definition that could not load shows when chosen: what failed in one line, the file, the error's message lines
 * without stack frames, and how to fix it.
 */
export function formatInvalidDefinitionDetails(definition: WorkflowsListingInvalidDefinition): string {
	const { kept, frames } = withoutStackFrames(inertDisplayText(definition.message));
	// The first message line is the reason, already shown (without the file the row names).
	const first = kept.findIndex((line) => line.trim() !== "");
	const detail = kept.filter((line, index) => index !== first && line.trim() !== "").slice(0, 8);
	const lines = [
		`✗ Workflow "${inertDisplayLine(definition.name)}" could not be loaded (${inertDisplayLine(definition.code)})`,
		"",
	];
	if (definition.source !== undefined) lines.push(`file    ${inertDisplayLine(definition.source)}`);
	lines.push(`reason  ${definition.reason}`);
	for (const line of detail) lines.push(`        ${line}`);
	if (frames > 0) lines.push(`        (${frames} stack ${frames === 1 ? "frame" : "frames"} hidden)`);
	lines.push("", "Fix the file, then run /workflow reload to load it again.");
	return lines.join("\n");
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
	const invalidDefinitions = deps.invalidDefinitions?.() ?? [];
	if (runs.length === 0 && ((definitions.length === 0 && invalidDefinitions.length === 0) || !interactive))
		return reporter.info("No workflows in this session.");
	if (!interactive) return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	if (runs.length === 1) {
		openWorkflowRun(runs[0]!.id, ctx, deps);
		return;
	}
	if (typeof ctx.ui?.custom !== "function")
		return reporter.info(renderSessionList(store.runs(), { theme, includeAll: true }));
	await showWorkflowsListing(ctx, reporter, deps);
}

async function showWorkflowsListing(
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowsCommandDeps,
): Promise<void> {
	const { store } = deps;
	const reopen = (): void => {
		showWorkflowsListing(ctx, reporter, deps).catch((error: unknown) =>
			reporter.error(`/workflows failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	};
	const picked = await openWorkflowsListing(ctx.ui, {
		runs: () => store.runs(),
		definitions: () => deps.definitions?.() ?? [],
		invalidDefinitions: () => deps.invalidDefinitions?.() ?? [],
		subscribe: (listener) => subscribeStoreInvalidation(store, listener),
	});
	if (picked?.kind === "run") openWorkflowRun(picked.runId, ctx, deps, { onReturn: reopen });
	else if (picked?.kind === "definition") await deps.startDefinition?.(picked.name);
	else if (picked?.kind === "invalid-definition") reporter.info(formatInvalidDefinitionDetails(picked.definition));
}
