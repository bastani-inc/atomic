import { resumableEntryFromHandle } from "../durable/backend.js";
import { getDurableBackend } from "../durable/factory.js";
import { isDurableWorkflowResumable, isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { quitAllRuns, quitRun } from "../runs/background/quit.js";
import { abortToolNode } from "../runs/background/quit-tool-node.js";
import { pauseAllRuns, pauseRun, resumeRun } from "../runs/background/status.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import { isFullRunId, isRunIdPrefix } from "../shared/run-id.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowExecutionPolicy, WorkflowToolNodeIdentity } from "../shared/types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowReloadReport, formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import {
	classifyControlError,
	resumeFailureCode,
	type WorkflowControlFailedRun,
	type WorkflowControlFailureCode,
} from "./workflow-control-failure.js";
import { resolveWorkflowResumeTarget, stageScopedDurableResumeMessage } from "./workflow-durable-resume-command.js";
import { WorkflowInstanceOwnershipError } from "./workflow-instance-owner.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { normalizeWorkflowReloadReport, type WorkflowReloadReport } from "./workflow-reload-report.js";
import { classifyDurableResumeShadow } from "./workflow-resume-shadow.js";
import {
	allStageConflictMessage,
	reloadFailureMessage,
	resolveControlNodeTarget,
	resolveToolRunTarget,
	resolveToolStageTarget,
	stageFailureMessage,
} from "./workflow-targets.js";

export interface WorkflowControlActionDeps {
	reloadWorkflowResources: () => Promise<WorkflowReloadReport | undefined> | undefined;
	getRuntime: () => ExtensionRuntime;
	policy: WorkflowExecutionPolicy;
	ensureWorkflowResourcesLoaded: () => Promise<void> | void;
	signal?: AbortSignal;
	onRunAccepted?: (runId: string) => void;
	owner?: WorkflowOwnerResources;
	/** Model-tool boundary only; slash/internal callers retain their explicit exception. */
	authorize?: (runId: string) => void;
}

export type WorkflowForeignRunGuard = Pick<WorkflowControlActionDeps, "getRuntime" | "authorize">;

async function foreignRunFailure(
	action: "pause" | "quit",
	target: string,
	guard: WorkflowForeignRunGuard | undefined,
): Promise<WorkflowToolResult | undefined> {
	if (guard === undefined || !isFullRunId(target)) return undefined;
	let durable: Awaited<ReturnType<ExtensionRuntime["inspectDurableWorkflow"]>>;
	try {
		durable = await guard.getRuntime().inspectDurableWorkflow(target);
	} catch (error) {
		return controlFailure(action, target, error);
	}
	if (durable.kind !== "found") return undefined;
	const runId = durable.detail.runId;
	const foreign = (message: string): WorkflowToolResult => ({
		action,
		runId,
		status: "noop",
		message,
		code: "owned_elsewhere",
	});
	try {
		guard.authorize?.(runId);
	} catch (error) {
		if (error instanceof WorkflowInstanceOwnershipError) return foreign(error.message);
		throw error;
	}
	return durable.detail.ownerActiveElsewhere === true
		? foreign(
				`Workflow ${runId} is actively running in another Atomic session. Control it from that session; it can be ${action === "pause" ? "paused" : "quit"} only by its owner.`,
			)
		: undefined;
}

function controlFailure(action: "pause" | "quit" | "resume", runId: string, error: unknown): WorkflowToolResult {
	return {
		action,
		runId,
		status: "noop",
		message: `Failed to ${action} run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
		code: classifyControlError(error),
	};
}

function resumeControlFailure(runId: string, error: unknown, store: Store): WorkflowToolResult {
	const run = store.runs().find((candidate) => candidate.id === runId);
	const visiblyRunning =
		run?.status === "running" ||
		run?.stages.some(
			(stage) => stage.status === "running" || stage.status === "pending" || stage.status === "awaiting_input",
		) === true;
	const detail = error instanceof Error ? error.message : String(error);
	return {
		action: "resume",
		runId,
		status: visiblyRunning ? "partial" : "noop",
		message: `Failed to resume run ${runId}: ${detail}`,
		...(visiblyRunning ? {} : { code: classifyControlError(error) }),
	};
}

export async function workflowReloadAction(
	args: WorkflowToolArgs,
	deps: Pick<WorkflowControlActionDeps, "reloadWorkflowResources">,
): Promise<WorkflowToolResult> {
	try {
		const report = normalizeWorkflowReloadReport(await deps.reloadWorkflowResources());
		return {
			action: "reload",
			status: report.outcome === "applied" ? "ok" : "noop",
			message: formatWorkflowReloadReport(report, args.reason),
			...report,
		};
	} catch (error) {
		return {
			action: "reload",
			status: "noop",
			message: reloadFailureMessage(error),
			outcome: "failed",
			error: error instanceof Error ? error.message : String(error),
			generation: 0,
			workflowCount: 0,
			coalescedRequests: 1,
			diagnostics: [],
		};
	}
}

type BulkRunResult =
	| { readonly ok: true; readonly runId: string; readonly message?: string }
	| { readonly ok: false; readonly runId: string; readonly reason: string; readonly message?: string };

function bulkFailedRuns(results: readonly BulkRunResult[]): WorkflowControlFailedRun[] {
	return results.flatMap((result) =>
		result.ok
			? []
			: [
					{
						runId: result.runId,
						reason: result.reason,
						...(result.message === undefined ? {} : { message: result.message }),
					},
				],
	);
}

function bulkFailureMessage<T extends BulkRunResult>(
	verb: "Paused" | "Quit",
	action: "pause" | "quit",
	results: readonly T[],
	describeSuccess: (result: Extract<T, { readonly ok: true }>) => string,
): string {
	const successes = results.filter((result) => result.ok).length;
	const failures = results.length - successes;
	const outcomes = results
		.map((result) =>
			result.ok
				? describeSuccess(result as Extract<T, { readonly ok: true }>)
				: `${result.runId}: ${result.reason}${result.message === undefined ? "" : ` (${result.message})`}`,
		)
		.join(", ");
	return `${successes > 0 ? `${verb} ${successes} run(s); ` : ""}failed to ${action} ${failures} run(s); outcomes: ${outcomes}.`;
}

/**
 * Status for a batch control: any failure downgrades an otherwise `paused` result to `partial`. When nothing
 * succeeded, only failures that leave a run active, other than one with no controllable stage, carry a code.
 */
function bulkFailureStatus(
	succeeded: number,
	failedRuns: readonly WorkflowControlFailedRun[],
): { status: "partial" | "noop"; code?: WorkflowControlFailureCode } {
	if (succeeded > 0) return { status: "partial" };
	const refused = failedRuns.some(
		(failed) => failed.reason !== "already_ended" && failed.reason !== "no_active_stages",
	);
	return refused ? { status: "noop", code: "control_failed" } : { status: "noop" };
}

/** Machine-readable identities also appear in the quit result; this is the readable copy. */
function abandonedToolSuffix(abandonedTools: readonly WorkflowToolNodeIdentity[]): string {
	return abandonedTools.length === 0
		? ""
		: ` (abandoned tool node(s): ${abandonedTools.map(formatToolNodeIdentity).join(", ")})`;
}

/** Nested runs can share a local node id, so identities are printed run-qualified. */
function formatToolNodeIdentity(identity: WorkflowToolNodeIdentity): string {
	return `${identity.runId}/${identity.nodeId}`;
}

function cancelledToolSummary(result: {
	readonly cancelledTools: readonly WorkflowToolNodeIdentity[];
	readonly abandonedTools: readonly WorkflowToolNodeIdentity[];
}): string {
	if (result.cancelledTools.length === 0 && result.abandonedTools.length === 0) return "";
	const cancelled =
		result.cancelledTools.length === 0
			? ""
			: ` Cancelled ${result.cancelledTools.length} in-flight ctx.tool node(s): ${result.cancelledTools
					.map(formatToolNodeIdentity)
					.join(", ")}.`;
	const abandoned =
		result.abandonedTools.length === 0
			? ""
			: ` Abandoned ${result.abandonedTools.length} callback(s) that ignored cancellation: ${result.abandonedTools
					.map(formatToolNodeIdentity)
					.join(", ")}.`;
	return `${cancelled}${abandoned}`;
}

/**
 * Abort one in-flight tool node.
 *
 * The result separates the node outcome (`status: "cancelled"`) from the run's
 * observed status: this action never pauses the run, and whether the run
 * survives its cancelled call is ordinary author control flow.
 */
async function quitToolNodeAction(
	runId: string,
	nodeId: string,
	action: "quit" | "pause",
	owner: WorkflowOwnerResources,
): Promise<WorkflowToolResult> {
	const { store } = owner;
	const aborted = await abortToolNode(runId, nodeId, owner);
	if (!aborted.ok) {
		return {
			action,
			runId,
			status: "noop",
			message: `Tool node ${nodeId} is not running on run ${runId}.`,
		};
	}
	// Let the rejected tool promise reach workflow code before the run status is
	// read, so the reported status is what an author would observe, not a stale
	// pre-abort snapshot.
	await Promise.resolve();
	await Promise.resolve();
	const workflowStatus = store.runs().find((candidate) => candidate.id === runId)?.status ?? "cancelled";
	const abandonedNote = aborted.abandoned ? " The callback ignored its abort signal and was abandoned." : "";
	return {
		action,
		runId,
		stageId: nodeId,
		status: "cancelled",
		workflowStatus,
		abandoned: aborted.abandoned,
		message:
			`Cancelled ctx.tool ${aborted.name} (${nodeId}) on run ${runId}.${abandonedNote}` +
			` Sibling work was not aborted. Current workflow status: ${workflowStatus}.` +
			" If workflow code awaited this call without catching cancellation, the workflow may fail." +
			" A later resume re-runs this call.",
	};
}

export async function workflowQuitAction(
	args: WorkflowToolArgs,
	owner = captureWorkflowOwnerResources(),
	guard?: WorkflowForeignRunGuard,
): Promise<WorkflowToolResult> {
	const { store } = owner;
	const target = resolveToolRunTarget(args, "No in-flight runs to quit.", store);
	const action = "quit";
	if (target.kind === "all") {
		if (args.stageId !== undefined && args.stageId.length > 0) {
			return { action, runId: "--all", status: "noop", message: allStageConflictMessage("quit") };
		}
		const results = await quitAllRuns({ ...owner, actor: "agent" });
		const successes = results.filter((result) => result.ok);
		const quitCount = successes.length;
		const failedRuns = bulkFailedRuns(results);
		if (failedRuns.length > 0) {
			return {
				action,
				runId: "--all",
				...bulkFailureStatus(quitCount, failedRuns),
				message: bulkFailureMessage(
					"Quit",
					action,
					results,
					(result) => result.message ?? `${result.runId}: quit${abandonedToolSuffix(result.abandonedTools)}`,
				),
				failedRuns,
			};
		}
		return {
			action,
			runId: "--all",
			status: quitCount > 0 ? "paused" : "noop",
			message:
				quitCount > 0
					? successes.some((result) => result.message !== undefined)
						? successes.map((result) => result.message ?? `Run ${result.runId} quit.`).join("\n")
						: `Quit ${quitCount} run(s); resume with /workflow resume.`
					: "No in-flight runs to quit.",
		};
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		const foreign = target.kind === "not_found" ? await foreignRunFailure(action, target.target, guard) : undefined;
		return (
			foreign ?? { action, runId: target.target, status: "noop", message: target.message, code: "run_not_found" }
		);
	}
	const controlNode = resolveControlNodeTarget(target.runId, args.stageId, store);
	if (!controlNode.ok) {
		return { action, runId: target.runId, status: "noop", message: controlNode.message, code: controlNode.code };
	}
	if (controlNode.kind === "tool") return quitToolNodeAction(controlNode.runId, controlNode.nodeId, action, owner);
	try {
		const result = await quitRun(target.runId, { ...owner, actor: "agent" });
		if (result.ok) {
			return {
				action,
				runId: result.runId,
				status: "paused",
				message:
					result.message ??
					`Run ${result.runId} quit and can be resumed with /workflow resume.${cancelledToolSummary(result)}`,
			};
		}
		const benign = result.reason === "already_ended" || result.reason === "no_active_stages";
		return {
			action,
			runId: target.runId,
			status: "noop",
			message:
				result.reason === "already_ended"
					? `Run ${target.runId} already ended.`
					: result.reason === "no_active_stages"
						? `No controllable stages on run ${target.runId}; the run remains active.`
						: `Run not found: ${target.runId}`,
			...(benign ? {} : { code: "run_not_found" as const }),
		};
	} catch (error) {
		return controlFailure(action, target.runId, error);
	}
}

export async function workflowPauseAction(
	args: WorkflowToolArgs,
	owner = captureWorkflowOwnerResources(),
	guard?: WorkflowForeignRunGuard,
): Promise<WorkflowToolResult> {
	const { store } = owner;
	const target = resolveToolRunTarget(args, "No in-flight runs to pause.", store);
	const action = "pause";
	if (target.kind === "all") {
		if (args.stageId !== undefined && args.stageId.length > 0) {
			return { action, runId: "--all", status: "noop", message: allStageConflictMessage("pause") };
		}
		try {
			const results = await pauseAllRuns(owner);
			const paused = results.filter((result) => result.ok).length;
			const failedRuns = bulkFailedRuns(results);
			if (failedRuns.length > 0) {
				return {
					action,
					runId: "--all",
					...bulkFailureStatus(paused, failedRuns),
					message: bulkFailureMessage(
						"Paused",
						action,
						results,
						(result) => result.message ?? `${result.runId}: paused`,
					),
					failedRuns,
				};
			}
			return {
				action,
				runId: "--all",
				status: paused > 0 ? "paused" : "noop",
				message: [
					paused > 0 ? `Paused ${paused} run(s).` : "No in-flight runs to pause.",
					...results.flatMap((result) => (result.ok && result.message !== undefined ? [result.message] : [])),
				].join("\n"),
			};
		} catch (error) {
			return controlFailure(action, "--all", error);
		}
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		const foreign = target.kind === "not_found" ? await foreignRunFailure(action, target.target, guard) : undefined;
		return (
			foreign ?? { action, runId: target.target, status: "noop", message: target.message, code: "run_not_found" }
		);
	}
	const controlNode = resolveControlNodeTarget(target.runId, args.stageId, store);
	if (!controlNode.ok) {
		return { action, runId: target.runId, status: "noop", message: controlNode.message, code: controlNode.code };
	}
	if (controlNode.kind === "tool") return quitToolNodeAction(controlNode.runId, controlNode.nodeId, action, owner);
	const stage = resolveToolStageTarget(target.runId, args.stageId, store);
	if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message, code: stage.code };
	const stageRunId = stage.runId ?? target.runId;
	try {
		const result = await pauseRun(stageRunId, { ...owner, stageId: stage.stageId });
		if (result.ok) {
			return {
				action,
				runId: result.runId,
				status: "paused",
				message:
					result.message ??
					(stage.stageId
						? `Stage ${stage.stageId} paused on run ${result.runId} and can be resumed.`
						: `Run ${result.runId} paused and can be resumed.`),
			};
		}
		return {
			action,
			runId: stageRunId,
			status: "noop",
			message: stageFailureMessage(stageRunId, result.reason, "pause"),
			...(result.reason === "not_found" ? { code: "run_not_found" as const } : {}),
			...(result.reason === "stage_not_found" ? { code: "stage_not_found" as const } : {}),
		};
	} catch (error) {
		return controlFailure(action, stageRunId, error);
	}
}

async function resumeDurableShadow(
	runId: string,
	deps: Pick<
		WorkflowControlActionDeps,
		"getRuntime" | "policy" | "ensureWorkflowResourcesLoaded" | "signal" | "onRunAccepted" | "owner" | "authorize"
	>,
	budget?: WorkflowToolArgs["budget"],
): Promise<WorkflowToolResult> {
	const runtime = deps.getRuntime();
	let warning: string | undefined;
	try {
		await deps.ensureWorkflowResourcesLoaded();
		deps.signal?.throwIfAborted();
		// Targeted read: the shadow run id is exact, so avoid a full catalog scan.
		if (runtime.prepareDurableResumableForIds !== undefined) await runtime.prepareDurableResumableForIds([runId]);
		else await runtime.prepareDurableResumable(runId);
	} catch (error) {
		warning = formatWorkflowResourceLoadWarning(error);
	}
	deps.signal?.throwIfAborted();
	deps.authorize?.(runId);
	const resumed = await runtime.resumeDurableWorkflow(runId, {
		policy: deps.policy,
		actor: "agent",
		signal: deps.signal,
		onRunAccepted: deps.onRunAccepted,
		...(budget === undefined ? {} : { budget }),
	});
	const message = warning === undefined ? resumed.message : `${warning}\n\n${resumed.message}`;
	return {
		action: "resume",
		runId: resumed.ok ? resumed.runId : runId,
		status: resumed.ok ? "running" : "noop",
		message,
		...(resumed.ok ? {} : { code: resumeFailureCode(resumed.reason) }),
	};
}

async function resumePreparedDurableTarget(
	runId: string,
	deps: Pick<WorkflowControlActionDeps, "getRuntime" | "policy" | "signal" | "onRunAccepted" | "authorize">,
	budget?: WorkflowToolArgs["budget"],
): Promise<WorkflowToolResult> {
	deps.authorize?.(runId);
	try {
		deps.signal?.throwIfAborted();
		const resumed = await deps.getRuntime().resumeDurableWorkflow(runId, {
			policy: deps.policy,
			actor: "agent",
			signal: deps.signal,
			onRunAccepted: deps.onRunAccepted,
			...(budget === undefined ? {} : { budget }),
		});
		return {
			action: "resume",
			runId: resumed.ok ? resumed.runId : runId,
			status: resumed.ok ? "running" : "noop",
			message: resumed.message,
			...(resumed.ok ? {} : { code: resumeFailureCode(resumed.reason) }),
		};
	} catch (error) {
		return controlFailure("resume", runId, error);
	}
}

function refuseStageScopedDurableResume(runId: string, args: WorkflowToolArgs): WorkflowToolResult | undefined {
	const stageId = args.stageId?.trim();
	if (stageId === undefined || stageId.length === 0) return undefined;
	return {
		action: "resume",
		runId,
		status: "noop",
		message: stageScopedDurableResumeMessage(runId),
		code: "stage_resume_unsupported",
	};
}

async function resolveExplicitDurableTarget(
	target: string,
	args: WorkflowToolArgs,
	deps: Pick<
		WorkflowControlActionDeps,
		"getRuntime" | "policy" | "ensureWorkflowResourcesLoaded" | "signal" | "onRunAccepted" | "owner" | "authorize"
	>,
	liveRuns: readonly RunSnapshot[] = [],
): Promise<WorkflowToolResult> {
	const runtime = deps.getRuntime();
	let durable: readonly ResumableWorkflowEntry[];
	let completed: readonly ResumableWorkflowEntry[];
	try {
		await deps.ensureWorkflowResourcesLoaded();
		deps.signal?.throwIfAborted();
		if (isFullRunId(target) && runtime.prepareDurableResumableForIds !== undefined) {
			durable = await runtime.prepareDurableResumableForIds([target]);
			const handle = getDurableBackend().getLoadableWorkflow(target);
			const historical =
				handle !== undefined &&
				(handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId) &&
				(handle.completedCheckpoints > 0 || handle.pendingPrompts > 0) &&
				(handle.status === "completed" || (handle.status === "failed" && !isDurableWorkflowResumable(handle)));
			completed = historical ? [resumableEntryFromHandle(handle)] : [];
		} else {
			const catalog = await runtime.prepareDurableCatalog?.();
			durable = catalog?.resumable ?? (await runtime.prepareDurableResumable(target));
			completed =
				catalog?.completed ??
				(await runtime.prepareCompletedDurable?.()) ??
				getDurableBackend().listCompletedWorkflows();
		}
	} catch (error) {
		return controlFailure("resume", target, error);
	}
	deps.signal?.throwIfAborted();
	const resolved = resolveWorkflowResumeTarget(target, liveRuns, durable, completed);
	if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
		return { action: "resume", runId: target, status: "noop", message: resolved.message, code: "run_not_found" };
	}
	if (resolved.kind === "durable" || resolved.kind === "live" || resolved.kind === "completed")
		deps.authorize?.(resolved.workflowId);
	if (resolved.kind === "durable") {
		const refusal = refuseStageScopedDurableResume(resolved.workflowId, args);
		if (refusal !== undefined) return refusal;
		return resumePreparedDurableTarget(resolved.workflowId, deps, args.budget);
	}
	if (resolved.kind === "live") {
		return workflowResumeAction({ ...args, runId: resolved.workflowId }, deps);
	}
	if (resolved.kind === "completed") {
		return {
			action: "resume",
			runId: resolved.workflowId,
			status: "noop",
			message: `Workflow ${resolved.workflowId} is completed, not resumable.`,
			code: "not_resumable",
		};
	}
	const durableHandle = getDurableBackend().getWorkflow(target);
	if (durableHandle !== undefined) deps.authorize?.(target);
	const isZeroProgressCandidate =
		durableHandle !== undefined &&
		(durableHandle.status === "paused" || durableHandle.status === "running") &&
		durableHandle.completedCheckpoints === 0 &&
		durableHandle.pendingPrompts === 0;
	if (isZeroProgressCandidate) {
		return {
			action: "resume",
			runId: target,
			status: "noop",
			message: `Workflow ${target} has no durable checkpoint or pending prompt progress and is not resumable.`,
			code: "not_resumable",
		};
	}
	if (durableHandle !== undefined) {
		const refusal = refuseStageScopedDurableResume(target, args);
		if (refusal !== undefined) return refusal;
		return resumePreparedDurableTarget(target, deps, args.budget);
	}
	return {
		action: "resume",
		runId: target,
		status: "noop",
		message: `Run not found: ${target}`,
		code: "run_not_found",
	};
}

export async function workflowResumeAction(
	args: WorkflowToolArgs,
	deps: Pick<
		WorkflowControlActionDeps,
		"getRuntime" | "policy" | "ensureWorkflowResourcesLoaded" | "signal" | "onRunAccepted" | "owner" | "authorize"
	>,
): Promise<WorkflowToolResult> {
	const owner = deps.owner ?? captureWorkflowOwnerResources();
	deps = { ...deps, owner };
	const { store, toolControlRegistry } = owner;
	deps.signal?.throwIfAborted();
	const explicitTarget = args.runId?.trim();
	if (explicitTarget !== undefined && isRunIdPrefix(explicitTarget)) {
		// #2603: resume prefixes must see both live and durable candidates before
		// local precedence can select a run.
		return resolveExplicitDurableTarget(explicitTarget, args, deps, topLevelWorkflowRuns(store.runs()));
	}
	const target = resolveToolRunTarget(args, "No active run to resume.", store);
	if (target.kind === "all")
		return { action: "resume", runId: "--all", status: "noop", message: "Resume does not support --all." };
	if (target.kind === "malformed") {
		return { action: "resume", runId: target.target, status: "noop", message: target.message, code: "run_not_found" };
	}
	if (target.kind === "not_found") {
		if (explicitTarget !== undefined && explicitTarget.length > 0) {
			return resolveExplicitDurableTarget(explicitTarget, args, deps);
		}
		return { action: "resume", runId: target.target, status: "noop", message: target.message, code: "run_not_found" };
	}
	deps.authorize?.(target.runId);
	// Any exact id or unique prefix has been normalized to the canonical full id,
	// so it cannot disagree with the resolved run; the old re-resolution branch
	// here is unreachable.
	const requestedStage = resolveToolStageTarget(target.runId, args.stageId, store);
	if (!requestedStage.ok) {
		return {
			action: "resume",
			runId: target.runId,
			status: "noop",
			message: requestedStage.message,
			code: requestedStage.code,
		};
	}
	const backend = getDurableBackend();
	const exact = store.runs().find((run) => run.id === target.runId);
	const shadow =
		exact === undefined
			? "not_shadow"
			: classifyDurableResumeShadow(exact, store, {
					backend,
					jobs: owner.jobs,
					stageControls: owner.stageControlRegistry,
					toolControls: toolControlRegistry,
				});
	if (shadow === "eligible") {
		const refusal = refuseStageScopedDurableResume(target.runId, args);
		if (refusal !== undefined) return refusal;
		return resumeDurableShadow(target.runId, deps, args.budget);
	}
	if (shadow === "ineligible") {
		return {
			action: "resume",
			runId: target.runId,
			status: "noop",
			message: `Workflow ${target.runId} has no durable checkpoint or pending prompt progress and is not resumable.`,
			code: "not_resumable",
		};
	}
	if (toolControlRegistry.runControl(target.runId) === undefined && !backend.isWorkflowLoadable(target.runId)) {
		try {
			await deps.ensureWorkflowResourcesLoaded();
			deps.signal?.throwIfAborted();
			const runtime = deps.getRuntime();
			if (runtime.prepareDurableResumableForIds !== undefined)
				await runtime.prepareDurableResumableForIds([target.runId]);
			else await runtime.prepareDurableResumable(target.runId);
		} catch {
			// Compatibility preparation remains best-effort before the authoritative check.
		}
		deps.signal?.throwIfAborted();
		if (!backend.isWorkflowLoadable(target.runId)) {
			store.removeRun(target.runId);
			return {
				action: "resume",
				runId: target.runId,
				status: "noop",
				message: `Run not found: ${target.runId}`,
				code: "run_not_found",
			};
		}
	}
	let warning: string | undefined;
	const stage = resolveToolStageTarget(target.runId, args.stageId, store);
	if (!stage.ok) {
		return { action: "resume", runId: target.runId, status: "noop", message: stage.message, code: stage.code };
	}
	const stageRunId = stage.runId ?? target.runId;
	const run = store.runs().find((candidate) => candidate.id === stageRunId);
	const hadPausedRunState = run?.status === "paused";
	const endedBeforeResume = run?.endedAt !== undefined;
	const hadPausedStageState = run !== undefined && workflowHasPausedStages(store, stageRunId);
	const isPaused = run !== undefined && workflowHasPausedState(store, stageRunId);
	const isDurableAuthorExit = run?.exited === true && run.status === "failed" && run.resumable === true;
	const isResumableContinuation =
		run !== undefined &&
		!isPaused &&
		run.exitReason !== "quit" &&
		isWorkflowRunResumable(workflowRunResumeCandidate(run));
	if (isDurableAuthorExit) {
		const refusal = refuseStageScopedDurableResume(stageRunId, args);
		if (refusal !== undefined) return refusal;
		return resumeDurableShadow(stageRunId, deps, args.budget);
	}
	if (isResumableContinuation) {
		try {
			await deps.ensureWorkflowResourcesLoaded();
		} catch (error) {
			warning = formatWorkflowResourceLoadWarning(error);
		}
		deps.signal?.throwIfAborted();
		const continuation = await deps.getRuntime().resumeFailedRun(stageRunId, stage.stageId, {
			policy: deps.policy,
			actor: "agent",
			signal: deps.signal,
			onRunAccepted: deps.onRunAccepted,
			...(args.budget === undefined ? {} : { budget: args.budget }),
		});
		const message = warning === undefined ? continuation.message : `${warning}\n\n${continuation.message}`;
		return {
			action: "resume",
			runId: continuation.ok ? continuation.runId : stageRunId,
			status: continuation.ok ? "running" : "noop",
			message,
			...(continuation.ok ? {} : { code: resumeFailureCode(continuation.reason) }),
		};
	}
	try {
		const result = await resumeRun(stageRunId, {
			...owner,
			stageId: stage.stageId,
			message: args.message,
			actor: "agent",
		});
		if (result.ok) {
			const runLevelResumed =
				hadPausedRunState &&
				!hadPausedStageState &&
				stage.stageId === undefined &&
				result.snapshot.status === "running";
			const noPausedProgress =
				isPaused && result.resumed.length === 0 && result.message === undefined && !runLevelResumed;
			const message =
				result.message ??
				(isPaused
					? result.resumed.length === 0
						? runLevelResumed
							? `Resumed run ${result.runId}.`
							: `No paused stages on run ${result.runId}.`
						: `Resumed ${result.resumed.length} stage(s) on run ${result.runId}${args.message ? ` with message: "${args.message}"` : ""}.`
					: `Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`);
			const noContinuation =
				result.mode === "not_resumable" || (result.mode === "snapshot" && result.snapshot.status === "blocked");
			const status = result.mode === "partial" ? "partial" : noContinuation || noPausedProgress ? "noop" : "ok";
			const notResumable =
				result.mode === "not_resumable" ||
				(endedBeforeResume && result.mode === "snapshot" && result.snapshot.resumable !== true);
			return {
				action: "resume",
				runId: result.runId,
				status,
				message,
				...(notResumable ? { code: "not_resumable" as const } : {}),
			};
		}
		return {
			action: "resume",
			runId: stageRunId,
			status: "noop",
			message: `Run not found: ${stageRunId}`,
			code: "run_not_found",
		};
	} catch (error) {
		return resumeControlFailure(stageRunId, error, store);
	}
}
