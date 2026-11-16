import { durableForkTarget } from "../durable/fork-run.js";
import { hasActiveLiveRun } from "../durable/run-claims.js";
import { availableStoreDurableBackend } from "../durable/store-backend.js";
import { type QuitRunResult, quitRun } from "../runs/background/quit.js";
import { pauseRun } from "../runs/background/status.js";
import type { GraphStageActionResult, GraphStageActions } from "../tui/graph-view-types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { workflowForkAction } from "./workflow-tool-fork.js";

export interface GraphStageActionDeps {
	readonly owner: WorkflowOwnerResources;

	readonly runtime: () => ExtensionRuntime | undefined;

	readonly context: () => { readonly hasUI?: boolean; readonly hasHumanInput?: boolean } | undefined;
}

const PAUSE_REFUSALS: Record<string, string> = {
	not_found: "That run is gone.",
	already_ended: "That stage has already ended.",
	already_paused: "That stage is already stopped.",
	no_active_stages: "That stage is not running.",
	stage_not_found: "That stage is gone.",
};

function quitRefusal(result: Extract<QuitRunResult, { ok: false }>): string {
	return "message" in result && typeof result.message === "string" ? result.message : result.reason;
}

function failure(error: unknown): GraphStageActionResult {
	return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

export function createGraphStageActions(deps: GraphStageActionDeps): GraphStageActions {
	const { owner } = deps;
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
			const runtime = deps.runtime();
			if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
			try {
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
			const backend = availableStoreDurableBackend(owner.store, rootRunId);
			if (backend === undefined) return { ok: false, message: "This run keeps no durable record to fork from." };
			try {
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
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		async fork(rootRunId, stageId) {
			const runtime = deps.runtime();
			if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
			try {
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
	};
}
