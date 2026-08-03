import { getDurableBackend } from "../durable/factory.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { quitAllRuns, quitRun } from "../runs/background/quit.js";
import { abortToolNode } from "../runs/background/quit-tool-node.js";
import { interruptAllRuns, interruptRun, pauseAllRuns, pauseRun, resumeRun } from "../runs/background/status.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import { store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowExecutionPolicy, WorkflowToolNodeIdentity } from "../shared/types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowReloadReport, formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { resolveWorkflowResumeTarget } from "./workflow-durable-resume-command.js";
import { normalizeWorkflowReloadReport, type WorkflowReloadReport } from "./workflow-reload-report.js";
import { classifyDurableResumeShadow } from "./workflow-resume-shadow.js";
import {
	allStageConflictMessage,
	reloadFailureMessage,
	resolveControlNodeTarget,
	resolveToolRunTarget,
	resolveToolStageTarget,
	stageFailureMessage,
	toolNodePauseRejectionMessage,
} from "./workflow-targets.js";

export interface WorkflowControlActionDeps {
	reloadWorkflowResources: () => Promise<WorkflowReloadReport | undefined> | undefined;
	getRuntime: () => ExtensionRuntime;
	policy: WorkflowExecutionPolicy;
	ensureWorkflowResourcesLoaded: () => Promise<void> | void;
}

function controlFailure(
	action: "pause" | "interrupt" | "quit" | "resume",
	runId: string,
	error: unknown,
): WorkflowToolResult {
	return {
		action,
		runId,
		status: "noop",
		message: `Failed to ${action} run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
	};
}

function resumeControlFailure(runId: string, error: unknown): WorkflowToolResult {
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
	};
}

export async function workflowPauseAction(args: WorkflowToolArgs): Promise<WorkflowToolResult> {
	const target = resolveToolRunTarget(args, "No in-flight runs to pause.");
	const action = "pause";
	if (target.kind === "all") {
		if (args.stageId !== undefined && args.stageId.length > 0) {
			return { action, runId: "--all", status: "noop", message: allStageConflictMessage("pause") };
		}
		try {
			const results = await pauseAllRuns();
			const paused = results.filter((result) => result.ok).length;
			return {
				action,
				runId: "--all",
				status: paused > 0 ? "paused" : "noop",
				message: paused > 0 ? `Paused ${paused} run(s).` : "No in-flight runs to pause.",
			};
		} catch (error) {
			return controlFailure(action, "--all", error);
		}
	}
	if (target.kind === "malformed" || target.kind === "not_found")
		return { action, runId: target.target, status: "noop", message: target.message };
	const controlNode = resolveControlNodeTarget(target.runId, args.stageId);
	// Tool nodes have no turn boundary to stop at, so pause rejects them loudly
	// instead of silently resolving to nothing.
	if (!controlNode.ok) return { action, runId: target.runId, status: "noop", message: controlNode.message };
	if (controlNode.kind === "tool") {
		return {
			action,
			runId: target.runId,
			status: "noop",
			message: toolNodePauseRejectionMessage(controlNode.name, controlNode.nodeId),
		};
	}
	const stage = resolveToolStageTarget(target.runId, args.stageId);
	if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message };
	const stageRunId = stage.runId ?? target.runId;
	try {
		const result = await pauseRun(stageRunId, { stageId: stage.stageId });
		return result.ok
			? {
					action,
					runId: result.runId,
					status: "paused",
					message: `Paused ${result.paused.length} stage(s) on run ${result.runId}.`,
				}
			: {
					action,
					runId: stageRunId,
					status: "noop",
					message: stageFailureMessage(stageRunId, result.reason, "pause"),
				};
	} catch (error) {
		return controlFailure(action, stageRunId, error);
	}
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

function bulkQuitFailureMessage(results: Awaited<ReturnType<typeof quitAllRuns>>): string {
	const successes = results.filter((result) => result.ok).length;
	const failures = results.length - successes;
	const outcomes = results
		.map((result) =>
			result.ok
				? `${result.runId}: quit${abandonedToolSuffix(result.abandonedTools)}`
				: `${result.runId}: ${result.reason}${"message" in result ? ` (${result.message})` : ""}`,
		)
		.join(", ");
	return `${successes > 0 ? `Quit ${successes} run(s); ` : ""}failed to quit ${failures} run(s); outcomes: ${outcomes}.`;
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
	action: "quit" | "interrupt",
): Promise<WorkflowToolResult> {
	const aborted = await abortToolNode(runId, nodeId);
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

export async function workflowQuitAction(args: WorkflowToolArgs): Promise<WorkflowToolResult> {
	const target = resolveToolRunTarget(args, "No in-flight runs to quit.");
	const action = "quit";
	if (target.kind === "all") {
		if (args.stageId !== undefined && args.stageId.length > 0) {
			return { action, runId: "--all", status: "noop", message: allStageConflictMessage("quit") };
		}
		const results = await quitAllRuns();
		const successes = results.filter((result) => result.ok);
		const quitCount = successes.length;
		const failures = results.filter((result) => !result.ok);
		return {
			action,
			runId: "--all",
			status: failures.length > 0 ? (quitCount > 0 ? "partial" : "noop") : quitCount > 0 ? "paused" : "noop",
			message:
				failures.length > 0
					? bulkQuitFailureMessage(results)
					: quitCount > 0
						? `Quit ${quitCount} run(s); resume with /workflow resume.`
						: "No in-flight runs to quit.",
		};
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return { action, runId: target.target, status: "noop", message: target.message };
	}
	const controlNode = resolveControlNodeTarget(target.runId, args.stageId);
	if (!controlNode.ok) return { action, runId: target.runId, status: "noop", message: controlNode.message };
	if (controlNode.kind === "tool") return quitToolNodeAction(controlNode.runId, controlNode.nodeId, action);
	try {
		const result = await quitRun(target.runId);
		if (result.ok) {
			return {
				action,
				runId: result.runId,
				status: "paused",
				message: `Run ${result.runId} quit and can be resumed with /workflow resume.${cancelledToolSummary(result)}`,
			};
		}
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
		};
	} catch (error) {
		return controlFailure(action, target.runId, error);
	}
}

export async function workflowInterruptAction(args: WorkflowToolArgs): Promise<WorkflowToolResult> {
	const target = resolveToolRunTarget(args, "No in-flight runs to interrupt.");
	const action = "interrupt";
	if (target.kind === "all") {
		if (args.stageId !== undefined && args.stageId.length > 0) {
			return { action, runId: "--all", status: "noop", message: allStageConflictMessage("interrupt") };
		}
		try {
			const results = await interruptAllRuns();
			const interrupted = results.filter((result) => result.ok).length;
			return {
				action,
				runId: "--all",
				status: interrupted > 0 ? "paused" : "noop",
				message: interrupted > 0 ? `Interrupted ${interrupted} run(s).` : "No in-flight runs to interrupt.",
			};
		} catch (error) {
			return controlFailure(action, "--all", error);
		}
	}
	if (target.kind === "malformed" || target.kind === "not_found")
		return { action, runId: target.target, status: "noop", message: target.message };
	const controlNode = resolveControlNodeTarget(target.runId, args.stageId);
	if (!controlNode.ok) return { action, runId: target.runId, status: "noop", message: controlNode.message };
	if (controlNode.kind === "tool") return quitToolNodeAction(controlNode.runId, controlNode.nodeId, action);
	const stage = resolveToolStageTarget(target.runId, args.stageId);
	if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message };
	const stageRunId = stage.runId ?? target.runId;
	try {
		const result = await interruptRun(stageRunId, { stageId: stage.stageId });
		if (result.ok) {
			return {
				action,
				runId: result.runId,
				status: "paused",
				message: stage.stageId
					? `Stage ${stage.stageId} interrupted on run ${result.runId} and can be resumed.`
					: `Run ${result.runId} interrupted and can be resumed.`,
			};
		}
		return {
			action,
			runId: stageRunId,
			status: "noop",
			message: stageFailureMessage(stageRunId, result.reason, "interrupt"),
		};
	} catch (error) {
		return controlFailure(action, stageRunId, error);
	}
}

async function resumeDurableShadow(
	runId: string,
	deps: Pick<WorkflowControlActionDeps, "getRuntime" | "policy" | "ensureWorkflowResourcesLoaded">,
): Promise<WorkflowToolResult> {
	const runtime = deps.getRuntime();
	let warning: string | undefined;
	try {
		await deps.ensureWorkflowResourcesLoaded();
		// Targeted read: the shadow run id is exact, so avoid a full catalog scan.
		if (runtime.prepareDurableResumableForIds !== undefined) await runtime.prepareDurableResumableForIds([runId]);
		else await runtime.prepareDurableResumable(runId);
	} catch (error) {
		warning = formatWorkflowResourceLoadWarning(error);
	}
	const resumed = await runtime.resumeDurableWorkflow(runId, { policy: deps.policy });
	const message = warning === undefined ? resumed.message : `${warning}\n\n${resumed.message}`;
	return {
		action: "resume",
		runId: resumed.ok ? resumed.runId : runId,
		status: resumed.ok ? "running" : "noop",
		message,
	};
}

async function resumePreparedDurableTarget(
	runId: string,
	deps: Pick<WorkflowControlActionDeps, "getRuntime" | "policy">,
): Promise<WorkflowToolResult> {
	try {
		const resumed = await deps.getRuntime().resumeDurableWorkflow(runId, { policy: deps.policy });
		return {
			action: "resume",
			runId: resumed.ok ? resumed.runId : runId,
			status: resumed.ok ? "running" : "noop",
			message: resumed.message,
		};
	} catch (error) {
		return controlFailure("resume", runId, error);
	}
}
async function resolveExplicitDurableTarget(
	target: string,
	args: WorkflowToolArgs,
	deps: Pick<WorkflowControlActionDeps, "getRuntime" | "policy" | "ensureWorkflowResourcesLoaded">,
	liveRuns: readonly RunSnapshot[] = [],
): Promise<WorkflowToolResult> {
	const runtime = deps.getRuntime();
	let durable: readonly ResumableWorkflowEntry[];
	try {
		await deps.ensureWorkflowResourcesLoaded();
		durable = await runtime.prepareDurableResumable(target);
	} catch (error) {
		return controlFailure("resume", target, error);
	}
	const resolved = resolveWorkflowResumeTarget(target, liveRuns, durable, []);
	if (resolved.kind === "malformed") {
		return { action: "resume", runId: target, status: "noop", message: resolved.message };
	}
	if (resolved.kind === "durable") return resumePreparedDurableTarget(resolved.workflowId, deps);
	if (resolved.kind === "live") {
		return workflowResumeAction({ ...args, runId: resolved.workflowId }, deps);
	}
	if (resolved.kind === "completed") {
		return {
			action: "resume",
			runId: resolved.workflowId,
			status: "noop",
			message: `Workflow ${resolved.workflowId} is completed, not resumable.`,
		};
	}
	const durableHandle = getDurableBackend().getWorkflow(target);
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
		};
	}
	if (durableHandle !== undefined) return resumePreparedDurableTarget(target, deps);
	return { action: "resume", runId: target, status: "noop", message: `Run not found: ${target}` };
}

export async function workflowResumeAction(
	args: WorkflowToolArgs,
	deps: Pick<WorkflowControlActionDeps, "getRuntime" | "policy" | "ensureWorkflowResourcesLoaded">,
): Promise<WorkflowToolResult> {
	const target = resolveToolRunTarget(args, "No active run to resume.");
	if (target.kind === "all")
		return { action: "resume", runId: "--all", status: "noop", message: "Resume does not support --all." };
	if (target.kind === "malformed") {
		return { action: "resume", runId: target.target, status: "noop", message: target.message };
	}
	if (target.kind === "not_found") {
		const explicitTarget = args.runId?.trim();
		if (explicitTarget !== undefined && explicitTarget.length > 0) {
			return resolveExplicitDurableTarget(explicitTarget, args, deps);
		}
		return { action: "resume", runId: target.target, status: "noop", message: target.message };
	}
	// An explicit target now resolves only by exact id, so it can never disagree
	// with the resolved run; the old re-resolution branch here is unreachable.
	const backend = getDurableBackend();
	const exact = store.runs().find((run) => run.id === target.runId);
	const shadow = exact === undefined ? "not_shadow" : classifyDurableResumeShadow(exact, store, { backend });
	if (shadow === "eligible") return resumeDurableShadow(target.runId, deps);
	if (shadow === "ineligible") {
		return {
			action: "resume",
			runId: target.runId,
			status: "noop",
			message: `Workflow ${target.runId} has no durable checkpoint or pending prompt progress and is not resumable.`,
		};
	}
	if (!backend.isWorkflowLoadable(target.runId)) {
		try {
			await deps.ensureWorkflowResourcesLoaded();
			const runtime = deps.getRuntime();
			if (runtime.prepareDurableResumableForIds !== undefined)
				await runtime.prepareDurableResumableForIds([target.runId]);
			else await runtime.prepareDurableResumable(target.runId);
		} catch {
			// Compatibility preparation remains best-effort before the authoritative check.
		}
		if (!backend.isWorkflowLoadable(target.runId)) {
			store.removeRun(target.runId);
			return { action: "resume", runId: target.runId, status: "noop", message: `Run not found: ${target.runId}` };
		}
	}
	let warning: string | undefined;
	const stage = resolveToolStageTarget(target.runId, args.stageId);
	if (!stage.ok) return { action: "resume", runId: target.runId, status: "noop", message: stage.message };
	const stageRunId = stage.runId ?? target.runId;
	const run = store.runs().find((candidate) => candidate.id === stageRunId);
	const hadPausedRunState = run?.status === "paused";
	const hadPausedStageState = run !== undefined && workflowHasPausedStages(store, stageRunId);
	const isPaused = run !== undefined && workflowHasPausedState(store, stageRunId);
	const isResumableContinuation =
		run !== undefined &&
		!isPaused &&
		run.exitReason !== "quit" &&
		isWorkflowRunResumable(workflowRunResumeCandidate(run));
	if (isResumableContinuation) {
		try {
			await deps.ensureWorkflowResourcesLoaded();
		} catch (error) {
			warning = formatWorkflowResourceLoadWarning(error);
		}
		const continuation = await deps.getRuntime().resumeFailedRun(stageRunId, stage.stageId, { policy: deps.policy });
		const message = warning === undefined ? continuation.message : `${warning}\n\n${continuation.message}`;
		return {
			action: "resume",
			runId: continuation.ok ? continuation.runId : stageRunId,
			status: continuation.ok ? "running" : "noop",
			message,
		};
	}
	try {
		const result = await resumeRun(stageRunId, { stageId: stage.stageId, message: args.message });
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
			const status = result.mode === "partial" ? "partial" : noPausedProgress ? "noop" : "ok";
			return { action: "resume", runId: result.runId, status, message };
		}
		return { action: "resume", runId: stageRunId, status: "noop", message: `Run not found: ${stageRunId}` };
	} catch (error) {
		return resumeControlFailure(stageRunId, error);
	}
}
