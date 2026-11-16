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
	readonly onReturn?: () => void;

	readonly stageId?: string;

	readonly stageRunId?: string;
}

export interface WorkflowsCommandDeps {
	readonly overlay: GraphOverlayPort;
	readonly store: Store;
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

	const reopen = (): void => void handleWorkflowsCommand("", ctx, reporter, deps, { selectRunId: picked.runId });
	openWorkflowRun(picked.runId, ctx, deps, { onReturn: reopen });
}

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
