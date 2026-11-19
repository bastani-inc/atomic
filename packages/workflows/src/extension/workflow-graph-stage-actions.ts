import { resumableEntryFromHandle } from "../durable/backend.js";
import { durableForkTarget } from "../durable/fork-run.js";
import { isWorkflowRunResumable, workflowRunHasPausedState } from "../durable/resume-eligibility.js";
import { hasActiveLiveRun } from "../durable/run-claims.js";
import { availableStoreDurableBackend } from "../durable/store-backend.js";
import { type QuitRunResult, quitRun } from "../runs/background/quit.js";
import { pauseRun, resumeRun } from "../runs/background/status.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import { unknownErrorMessage } from "../runs/foreground/executor-abort.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import type { GraphStageActions } from "../tui/graph-view-types.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { workflowForkAction } from "./workflow-tool-fork.js";

export interface GraphStageActionDeps {
	readonly owner: WorkflowOwnerResources;

	readonly runtime: () => ExtensionRuntime | undefined;

	readonly context: () =>
		| {
				readonly hasUI?: boolean;
				readonly hasHumanInput?: boolean;
				readonly ui?: { readonly notify?: (message: string, type?: "info" | "warning" | "error") => void };
		  }
		| undefined;

	readonly ensureWorkflowResourcesLoaded?: () => Promise<void> | void;
}

const PAUSE_REFUSALS: Record<string, string> = {
	not_found: "That run is gone.",
	already_ended: "That stage has already ended.",
	already_paused: "That stage is already stopped.",
	no_active_stages: "That stage is not running.",
	stage_not_found: "That stage is gone.",
};

const RUN_PAUSE_REFUSALS: Record<string, string> = {
	not_found: "That run is gone.",
	already_ended: "That run has already ended.",
	already_paused: "That run is already paused.",
	no_active_stages: "That run has no active stages to pause.",
	stage_not_found: "That stage is gone.",
};

const RUN_QUIT_REFUSALS: Record<string, string> = {
	not_found: "That run is gone.",
	already_ended: "That run has already ended.",
	no_active_stages: "That run has no controllable stages to quit.",
	stage_not_found: "That stage is gone.",
};

function quitRefusal(result: Extract<QuitRunResult, { ok: false }>): string {
	return "message" in result && typeof result.message === "string" ? result.message : result.reason;
}

function failure(error: unknown): { readonly ok: false; readonly message: string } {
	return { ok: false, message: unknownErrorMessage(error) };
}

export function createGraphStageActions(deps: GraphStageActionDeps): GraphStageActions {
	const { owner } = deps;
	const ensureWorkflowResourcesVisible = async (): Promise<void> => {
		try {
			await deps.ensureWorkflowResourcesLoaded?.();
		} catch (error) {
			deps.context()?.ui?.notify?.(formatWorkflowResourceLoadWarning(error), "warning");
		}
	};
	return {
		async stop(runId, stageId) {
			try {
				const result = await pauseRun(runId, { ...owner, stageId });
				if (result.ok) {
					const name = result.paused[0]?.name ?? stageId;
					return { ok: true, message: `Stopped ${name} \u00b7 resume it from its stage chat` };
				}
				return { ok: false, message: PAUSE_REFUSALS[result.reason] ?? "That stage could not be stopped." };
			} catch (error) {
				return failure(error);
			}
		},
		async retry(runId, stageId) {
			try {
				await ensureWorkflowResourcesVisible();
				const runtime = deps.runtime();
				if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
				const policy = workflowPolicyFromContext(deps.context());
				const result = await runtime.resumeFailedRun(runId, stageId, { policy, actor: "user" });
				return result.ok
					? { ok: true, message: result.message, runId: result.runId }
					: { ok: false, message: result.message };
			} catch (error) {
				return failure(error);
			}
		},
		async forkTarget(rootRunId, stageId) {
			try {
				await ensureWorkflowResourcesVisible();
				const backend = availableStoreDurableBackend(owner.store, rootRunId);
				if (backend === undefined) return { ok: false, message: "This run keeps no durable record to fork from." };
				const target = await durableForkTarget(backend, rootRunId, stageId);
				if (target === undefined)
					return { ok: false, message: "A fork can't start at this stage: it is still running or never ran." };
				return {
					ok: true,
					stagePath: target.stagePath,
					rerunToolSteps: target.rerunToolSteps,
					live: hasActiveLiveRun(owner.store, rootRunId),
				};
			} catch (error) {
				return failure(error);
			}
		},
		async fork(rootRunId, stageId) {
			try {
				await ensureWorkflowResourcesVisible();
				const runtime = deps.runtime();
				if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
				if (hasActiveLiveRun(owner.store, rootRunId)) {
					const quit = await quitRun(rootRunId, { ...owner, awaitSettlement: true, actor: "user" });
					if (!quit.ok) return { ok: false, message: `Could not stop the run to fork it: ${quitRefusal(quit)}` };
				}
				const backend = availableStoreDurableBackend(owner.store, rootRunId);
				if (backend === undefined) return { ok: false, message: "This run keeps no durable record to fork from." };
				const target = await durableForkTarget(backend, rootRunId, stageId);
				if (target === undefined) return { ok: false, message: "The selected stage is no longer a fork target." };
				const result = await workflowForkAction(
					{ runId: rootRunId, fromStage: target.stagePath },
					{
						getRuntime: () => runtime,
						policy: workflowPolicyFromContext(deps.context()),
						source: "cli",
						expectedStageId: stageId,
					},
				);
				return result.status === "failed"
					? { ok: false, message: result.message }
					: { ok: true, message: result.message, runId: result.runId };
			} catch (error) {
				return failure(error);
			}
		},
		async pauseRun(runId) {
			try {
				const result = await pauseRun(runId, owner);
				if (result.ok) {
					const name = owner.store.run(runId)?.name ?? runId;
					return { ok: true, message: result.message ?? `Paused ${name} \u00b7 press r to resume` };
				}
				return { ok: false, message: RUN_PAUSE_REFUSALS[result.reason] ?? "That run could not be paused." };
			} catch (error) {
				return failure(error);
			}
		},
		canResumeRun(runId) {
			const run = owner.store.run(runId);
			if (run === undefined || run.resumable === false || run.status === "completed" || run.status === "killed")
				return false;
			if (workflowRunHasPausedState(run)) return true;
			if (!isWorkflowRunResumable({ ...run, budgetSystemOwnedStop: run.budgetState?.systemOwnedStop })) return false;
			const backend = availableStoreDurableBackend(owner.store, runId);
			if (backend === undefined) return run.exited === true && run.status === "failed" && run.resumable === true;
			return isWorkflowRunResumable(workflowRunResumeCandidate(run, owner.store.runs(), backend));
		},
		async resumeRun(runId) {
			try {
				const run = owner.store.run(runId);
				if (run === undefined) return { ok: false, message: "That run is gone." };
				const hadPausedRunState = run.status === "paused";
				const hadPausedStageState = workflowHasPausedStages(owner.store, runId);
				const isPaused = workflowHasPausedState(owner.store, runId);
				const backend = availableStoreDurableBackend(owner.store, runId);
				const isDurableAuthorExit = run.exited === true && run.status === "failed" && run.resumable === true;
				const isResumableContinuation =
					!isPaused &&
					run.exitReason !== "quit" &&
					(effectiveRunStatus(run) === "blocked" ||
						(backend !== undefined &&
							isWorkflowRunResumable(workflowRunResumeCandidate(run, owner.store.runs(), backend))));
				if (isDurableAuthorExit) {
					// Pin this attempt's saved version, even if it finishes saving while resources load.
					const savedHandle = () => backend?.getWorkflow(runId);
					const selection = owner.jobs.get(runId)?.promise.then(savedHandle) ?? savedHandle();
					await ensureWorkflowResourcesVisible();
					const runtime = deps.runtime();
					if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
					const policy = workflowPolicyFromContext(deps.context());
					const handle = await selection;
					const resumed = await runtime.resumeDurableWorkflow(runId, {
						policy,
						actor: "user",
						...(handle === undefined ? {} : { selectedEntry: resumableEntryFromHandle(handle) }),
					});
					return resumed.ok
						? { ok: true, message: resumed.message, runId: resumed.runId }
						: { ok: false, message: resumed.message };
				}
				if (isResumableContinuation) {
					await ensureWorkflowResourcesVisible();
					const runtime = deps.runtime();
					if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
					const policy = workflowPolicyFromContext(deps.context());
					const continuation = await runtime.resumeFailedRun(runId, undefined, { policy, actor: "user" });
					return continuation.ok
						? { ok: true, message: continuation.message, runId: continuation.runId }
						: { ok: false, message: continuation.message };
				}
				const result = await resumeRun(runId, { ...owner, actor: "user" });
				if (!result.ok) return { ok: false, message: "That run is gone." };
				if (result.mode === "snapshot" && run.exitReason === "quit") {
					await ensureWorkflowResourcesVisible();
					const runtime = deps.runtime();
					if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
					const policy = workflowPolicyFromContext(deps.context());
					const resumed = await runtime.resumeDurableWorkflow(runId, { policy, actor: "user" });
					return resumed.ok
						? { ok: true, message: resumed.message, runId: resumed.runId }
						: { ok: false, message: resumed.message };
				}
				if (result.mode === "not_resumable" || result.mode === "partial") {
					return { ok: false, message: result.message ?? "That run could not be resumed." };
				}
				const runLevelResumed = hadPausedRunState && !hadPausedStageState && result.snapshot.status === "running";
				if (result.resumed.length === 0 && !runLevelResumed && result.message === undefined) {
					return { ok: false, message: "No paused stages on that run." };
				}
				const name = result.snapshot.name || runId;
				return {
					ok: true,
					runId: result.runId,
					message: result.message ?? `Resumed ${name}`,
				};
			} catch (error) {
				return failure(error);
			}
		},
		async quitRun(runId) {
			try {
				const name = owner.store.run(runId)?.name ?? runId;
				const result = await quitRun(runId, { ...owner, actor: "user" });
				if (result.ok) {
					return { ok: true, message: result.message ?? `Quit ${name} \u00b7 press r to resume` };
				}
				return { ok: false, message: RUN_QUIT_REFUSALS[result.reason] ?? quitRefusal(result) };
			} catch (error) {
				return failure(error);
			}
		},
	};
}
