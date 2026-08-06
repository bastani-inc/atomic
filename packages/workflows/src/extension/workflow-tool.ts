import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { inspectRun } from "../runs/background/status.js";
import { store } from "../shared/store.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import { buildWorkflowStatusListing, setWorkflowStatusRenderRuns } from "./workflow-status-summary.js";
import { isWorkflowStageToolContext, resolveRunId, topLevelExpandedSnapshots } from "./workflow-targets.js";
import { workflowGetResult } from "./workflow-tool-content.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowQuitAction,
	workflowReloadAction,
	workflowResumeAction,
} from "./workflow-tool-control.js";
import { workflowStageResult, workflowStagesResult, workflowTranscriptResult } from "./workflow-tool-inspection.js";
import { type WorkflowSendDeps, workflowSendAction } from "./workflow-tool-send.js";

export function makeExecuteWorkflowTool(
	runtime: ExtensionRuntime | ((ctx: PiExecuteContext) => ExtensionRuntime),
	reloadWorkflowResources: () => Promise<WorkflowReloadReport | undefined> | undefined,
	ensureWorkflowResourcesLoaded: () => Promise<void> | void = () => {},
	sendDeps: WorkflowSendDeps = {},
): (args: WorkflowToolArgs, ctx: PiExecuteContext) => Promise<WorkflowToolResult> {
	return async function executeWorkflowTool(
		args: WorkflowToolArgs,
		ctx: PiExecuteContext,
	): Promise<WorkflowToolResult> {
		const action = args.action ?? "run";
		const runId = args.runId ?? "";
		if (isWorkflowStageToolContext(ctx)) {
			return {
				action: "run",
				runId,
				status: "failed",
				error: "workflows cannot invoke workflows from workflow stages",
				stages: [],
			};
		}
		const policy: WorkflowExecutionPolicy = workflowPolicyFromContext(ctx);
		const getRuntime = (): ExtensionRuntime => (typeof runtime === "function" ? runtime(ctx) : runtime);
		const ensureWorkflowResourcesVisible = async (): Promise<void> => {
			try {
				await ensureWorkflowResourcesLoaded();
			} catch (error) {
				ctx.ui?.notify?.(formatWorkflowResourceLoadWarning(error), "warning");
			}
		};

		switch (action) {
			case "get":
				await ensureWorkflowResourcesVisible();
				return workflowGetResult(getRuntime(), args);
			case "models": {
				const available = ctx.modelRegistry?.getAvailable() ?? [];
				const current = ctx.model;
				const models = available.map((m) => ({
					provider: m.provider,
					id: m.id,
					fullId: `${m.provider}/${m.id}`,
					isCurrent: current !== undefined && m.provider === current.provider && m.id === current.id,
					availableThinkingLevels: getSupportedThinkingLevels(m),
				}));
				return { action: "models", models };
			}
			case "list":
			case "inputs": {
				await ensureWorkflowResourcesVisible();
				return getRuntime().dispatch(args, { policy });
			}
			case "run": {
				await ensureWorkflowResourcesVisible();
				// A tool launch is the agent's own action: it is attributed as such and
				// the tool result already reports the run, so it raises no chat notice.
				return getRuntime().dispatch(args, { policy, origin: "agent" });
			}
			case "status": {
				const target = args.runId;
				if (target !== undefined) {
					const resolved = resolveRunId(target);
					if (resolved.kind === "malformed") {
						return { action: "statusDetail", runId: target, error: resolved.message };
					}
					if (resolved.kind === "not_found") {
						return { action: "statusDetail", runId: target, error: `run not found: ${target}` };
					}
					const result = inspectRun(resolved.runId);
					return result.ok
						? { action: "statusDetail", runId: result.runId, detail: result.detail }
						: { action: "statusDetail", runId: target, error: `run not found: ${target}` };
				}
				const listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), args.statusFilter ?? "all");
				const result = {
					action: "status" as const,
					filter: listing.filter,
					runs: listing.runs,
					snapshots: listing.snapshots,
				};
				setWorkflowStatusRenderRuns(result, store.graphSnapshot().runs);
				return result;
			}
			case "stages":
				return workflowStagesResult(args);
			case "stage":
				return workflowStageResult(args);
			case "transcript":
				return workflowTranscriptResult(args);
			case "send":
				return workflowSendAction(args, sendDeps);
			case "pause":
				return workflowPauseAction(args);
			case "reload":
				return workflowReloadAction(args, { reloadWorkflowResources });
			case "quit":
				return workflowQuitAction(args);
			case "interrupt":
				return workflowInterruptAction(args);
			case "resume":
				return workflowResumeAction(args, { getRuntime, policy, ensureWorkflowResourcesLoaded });
			default: {
				const _exhaustive: never = action;
				throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
			}
		}
	};
}
