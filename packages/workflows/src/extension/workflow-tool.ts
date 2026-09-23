import { getSupportedThinkingLevels } from "@bastani/pi-ai/compat";
import { inspectRun } from "../runs/background/status.js";
import { workflowDependency } from "../sdk-surface.js";
import { workflowBoundarySegments } from "../shared/pending-stage-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { assertWorkflowInstanceOwner, workflowCaller } from "./workflow-instance-owner.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import { raceWorkflowRequestAbort } from "./workflow-request-abort.js";
import { buildWorkflowStatusListing, setWorkflowStatusRenderRuns } from "./workflow-status-summary.js";
import {
	isResolvedRunId,
	isWorkflowStageToolContext,
	resolveRunId,
	resolveToolRunTarget,
	topLevelExpandedSnapshots,
} from "./workflow-targets.js";
import { workflowAnswerAction } from "./workflow-tool-answer.js";
import { workflowGetResult } from "./workflow-tool-content.js";
import {
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
	| { readonly kind: "durable"; readonly runId: string; readonly source: WorkflowInspectionSource }
	| { readonly kind: "error"; readonly message: string };

async function resolveDurableInspectionSource(
	args: WorkflowToolArgs,
	runtime: ExtensionRuntime,
	owner: WorkflowOwnerResources,
): Promise<DurableInspectionSourceResolution> {
	const target = args.runId?.trim();
	if (args.all === true || target === undefined || target.length === 0 || target === "--all") return { kind: "local" };
	const local = resolveRunId(target, owner.store);
	if (local.kind !== "not_found") return { kind: "local" };
	const durable = await runtime.inspectDurableWorkflow(target);
	if (durable.kind !== "found") return { kind: "error", message: durable.message };
	return { kind: "durable", runId: durable.detail.runId, source: { store: durable.store, allowLiveHandles: false } };
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
	owner: WorkflowOwnerResources = captureWorkflowOwnerResources(),
): (
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	signal?: AbortSignal,
	onRunAccepted?: (runId: string) => void,
) => Promise<WorkflowToolResult> {
	const { store, toolControlRegistry } = owner;
	return async function executeWorkflowTool(
		args: WorkflowToolArgs,
		ctx: PiExecuteContext,
		signal?: AbortSignal,
		onRunAccepted?: (runId: string) => void,
	): Promise<WorkflowToolResult> {
		signal?.throwIfAborted();
		if (args.action === undefined)
			return {
				action: "run",
				runId: "",
				status: "failed",
				error: "An explicit action is required.",
			};
		const action = args.action;
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
		const authorize = (id: string): void => assertWorkflowInstanceOwner(id, ctx, store);
		if (action === "status" && args.runId === undefined) {
			for (const run of topLevelWorkflowRuns(store.runs())) authorize(run.id);
		} else if (["stages", "stage", "transcript", "pause", "quit", "answer"].includes(action)) {
			const target = resolveToolRunTarget(args, "", store);
			if (target.kind === "all" && (action === "pause" || action === "quit")) {
				// Preauthorize the entire batch before the first control can mutate anything.
				for (const run of topLevelWorkflowRuns(store.runs()).filter((run) => run.endedAt === undefined))
					authorize(run.id);
			} else if (target.kind === "run") {
				authorize(target.runId);
				args = { ...args, runId: target.runId };
			}
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
				return awaitRequest(
					getRuntime().dispatch(
						{ action: "run", workflow: args.workflow, inputs: args.inputs ?? {}, budget: args.budget },
						{ policy, origin: "agent", signal, modelOwner: workflowCaller(ctx), onRunAccepted },
					),
				);
			}
			case "dependency": {
				const operation = args.operation ?? "status";
				return { action, operation, report: await awaitRequest(workflowDependency(operation)) };
			}
			case "status": {
				const target = args.runId?.trim();
				if (target !== undefined) {
					const resolved = resolveRunId(target, store);
					if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
						return { action: "statusDetail", runId: target, error: resolved.message };
					}
					if (resolved.kind === "not_found") {
						const durable = await awaitRequest(getRuntime().inspectDurableWorkflow(target));
						if (durable.kind === "found") authorize(durable.detail.runId);
						return durable.kind === "found"
							? { action: "statusDetail", runId: durable.detail.runId, detail: durable.detail }
							: { action: "statusDetail", runId: target, error: durable.message };
					}
					if (!isResolvedRunId(resolved)) {
						return { action: "statusDetail", runId: target, error: `run not found: ${target}` };
					}
					authorize(resolved.runId);
					const inspected = inspectRun(resolved.runId, owner);
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
					topLevelExpandedSnapshots(store),
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
				const resolved = await awaitRequest(resolveDurableInspectionSource(args, getRuntime(), owner));
				if (resolved.kind === "error") return durableInspectionError(action, args.runId ?? "", resolved.message);
				if (resolved.kind === "durable") authorize(resolved.runId);
				const source = resolved.kind === "durable" ? resolved.source : owner;
				const canonicalArgs = resolved.kind === "durable" ? { ...args, runId: resolved.runId } : args;
				if (action === "stages") return workflowStagesResult(canonicalArgs, source);
				if (action === "stage") return workflowStageResult(canonicalArgs, source);
				return workflowTranscriptResult(canonicalArgs, source);
			}
			case "answer":
				return awaitRequest(workflowAnswerAction(args, owner));
			case "pause":
				return awaitRequest(workflowPauseAction(args, owner));
			case "reload":
				return awaitRequest(workflowReloadAction(args, { reloadWorkflowResources }));
			case "quit":
				return awaitRequest(workflowQuitAction(args, owner));
			case "resume":
				return awaitRequest(
					workflowResumeAction(args, {
						getRuntime,
						policy,
						ensureWorkflowResourcesLoaded,
						signal,
						onRunAccepted,
						owner,
						authorize,
					}),
				);
			default: {
				const _exhaustive: never = action;
				throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
			}
		}
	};
}
