import { getSupportedThinkingLevels } from "@bastani/pi-ai/compat";
import { toolControlRegistry } from "../engine/run-tool-control-registry.js";
import { inspectRun } from "../runs/background/status.js";
import { workflowBoundarySegments } from "../shared/pending-stage-status.js";
import { store } from "../shared/store.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import { raceWorkflowRequestAbort } from "./workflow-request-abort.js";
import { buildWorkflowStatusListing, setWorkflowStatusRenderRuns } from "./workflow-status-summary.js";
import {
	isResolvedRunId,
	isWorkflowStageToolContext,
	resolveRunId,
	topLevelExpandedSnapshots,
} from "./workflow-targets.js";
import { workflowAnswerAction } from "./workflow-tool-answer.js";
import { workflowGetResult } from "./workflow-tool-content.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowQuitAction,
	workflowReloadAction,
	workflowResumeAction,
} from "./workflow-tool-control.js";
import {
	type WorkflowInspectionSource,
	workflowStageResult,
	workflowStagesResult,
	workflowTranscriptResult,
} from "./workflow-tool-inspection.js";

type DurableInspectionSourceResolution =
	| { readonly kind: "local" }
	| { readonly kind: "durable"; readonly source: WorkflowInspectionSource }
	| { readonly kind: "error"; readonly message: string };

async function resolveDurableInspectionSource(
	args: WorkflowToolArgs,
	runtime: ExtensionRuntime,
): Promise<DurableInspectionSourceResolution> {
	const target = args.runId?.trim();
	if (args.all === true || target === undefined || target.length === 0 || target === "--all") return { kind: "local" };
	const local = resolveRunId(target);
	if (local.kind !== "not_found") return { kind: "local" };
	const durable = await runtime.inspectDurableWorkflow(target);
	if (durable.kind !== "found") return { kind: "error", message: durable.message };
	return { kind: "durable", source: { store: durable.store, allowLiveHandles: false } };
}

function durableInspectionError(
	action: "stages" | "stage" | "transcript",
	runId: string,
	message: string,
): WorkflowToolResult {
	if (action === "stages") return { action, runId, filter: "all", stages: [], error: message };
	if (action === "stage") return { action, runId, error: message };
	return {
		action,
		runId,
		stageId: "",
		source: "error",
		entries: [{ role: "notice", text: message }],
		truncated: false,
	};
}

export function makeExecuteWorkflowTool(
	runtime: ExtensionRuntime | ((ctx: PiExecuteContext) => ExtensionRuntime),
	reloadWorkflowResources: () => Promise<WorkflowReloadReport | undefined> | undefined,
	ensureWorkflowResourcesLoaded: () => Promise<void> | void = () => {},
): (
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	signal?: AbortSignal,
	onRunAccepted?: (runId: string) => void,
) => Promise<WorkflowToolResult> {
	return async function executeWorkflowTool(
		args: WorkflowToolArgs,
		ctx: PiExecuteContext,
		signal?: AbortSignal,
		onRunAccepted?: (runId: string) => void,
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
		const awaitRequest = <T>(operation: Promise<T>): Promise<T> => raceWorkflowRequestAbort(operation, signal);
		const ensureWorkflowResourcesVisible = async (): Promise<void> => {
			try {
				await awaitRequest(Promise.resolve(ensureWorkflowResourcesLoaded()));
			} catch (error) {
				if (signal?.aborted === true) throw signal.reason ?? error;
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
				return awaitRequest(getRuntime().dispatch(args, { policy, signal }));
			}
			case "run": {
				await ensureWorkflowResourcesVisible();
				// A tool launch is the agent's own action: it is attributed as such and
				// the tool result already reports the run, so it raises no chat notice.
				return awaitRequest(getRuntime().dispatch(args, { policy, origin: "agent", signal, onRunAccepted }));
			}
			case "status": {
				const target = args.runId;
				if (target !== undefined) {
					const resolved = resolveRunId(target);
					if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
						return { action: "statusDetail", runId: target, error: resolved.message };
					}
					if (resolved.kind === "not_found") {
						const durable = await awaitRequest(getRuntime().inspectDurableWorkflow(target));
						return durable.kind === "found"
							? { action: "statusDetail", runId: target, detail: durable.detail }
							: { action: "statusDetail", runId: target, error: durable.message };
					}
					if (!isResolvedRunId(resolved)) {
						return { action: "statusDetail", runId: target, error: `run not found: ${target}` };
					}
					const inspected = inspectRun(resolved.runId, { toolControlRegistry });
					if (!inspected.ok) {
						return { action: "statusDetail", runId: target, error: `run not found: ${target}` };
					}
					const detailResult = {
						action: "statusDetail" as const,
						runId: inspected.runId,
						detail: inspected.detail,
					};
					setWorkflowStatusRenderRuns(detailResult, store.graphSnapshot().runs);
					return detailResult;
				}
				const capturedRuns = store.graphSnapshot().runs;
				const statusByRunId = new Map(capturedRuns.map((run) => [run.id, run.status]));
				const listing = buildWorkflowStatusListing(
					topLevelExpandedSnapshots(),
					args.statusFilter ?? "all",
					Date.now(),
					{
						toolControlRegistry,
						owningRunStatus: (owningRunId) => statusByRunId.get(owningRunId),
						resolveBoundarySegments: (runId) => workflowBoundarySegments(capturedRuns, runId),
					},
				);
				const result = {
					action: "status" as const,
					filter: listing.filter,
					runs: listing.runs,
					snapshots: listing.snapshots,
				};
				setWorkflowStatusRenderRuns(result, capturedRuns);
				return result;
			}
			case "stages":
			case "stage":
			case "transcript": {
				const resolved = await awaitRequest(resolveDurableInspectionSource(args, getRuntime()));
				if (resolved.kind === "error") return durableInspectionError(action, args.runId ?? "", resolved.message);
				const source = resolved.kind === "durable" ? resolved.source : undefined;
				if (action === "stages") return workflowStagesResult(args, source);
				if (action === "stage") return workflowStageResult(args, source);
				return workflowTranscriptResult(args, source);
			}
			case "answer":
				return awaitRequest(workflowAnswerAction(args));
			case "pause":
				return awaitRequest(workflowPauseAction(args));
			case "reload":
				return awaitRequest(workflowReloadAction(args, { reloadWorkflowResources }));
			case "quit":
				return awaitRequest(workflowQuitAction(args));
			case "interrupt":
				return awaitRequest(workflowInterruptAction(args));
			case "resume":
				return awaitRequest(workflowResumeAction(args, { getRuntime, policy, ensureWorkflowResourcesLoaded }));
			default: {
				const _exhaustive: never = action;
				throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
			}
		}
	};
}
