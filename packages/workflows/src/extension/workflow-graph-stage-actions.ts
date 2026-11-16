/**
 * The graph's stage controls, wired to the same run operations the `/workflow` commands use: `x x` stops a stage so it
 * can be resumed, `r` continues a failed run from its failed stage, and `f` forks the run into a new one.
 */

import { pauseRun } from "../runs/background/status.js";
import type { GraphStageActionResult, GraphStageActions } from "../tui/graph-view-types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { workflowForkAction } from "./workflow-tool-fork.js";

export interface GraphStageActionDeps {
	readonly owner: WorkflowOwnerResources;
	/** The session's workflow runtime; absent before the session starts, when retry and fork are unavailable. */
	readonly runtime: () => ExtensionRuntime | undefined;
	/** Whether the session has a person to answer prompts, as the slash commands read it. */
	readonly context: () => { readonly hasUI?: boolean; readonly hasHumanInput?: boolean } | undefined;
}

const PAUSE_REFUSALS: Record<string, string> = {
	not_found: "That run is gone.",
	already_ended: "That stage has already ended.",
	already_paused: "That stage is already stopped.",
	no_active_stages: "That stage is not running.",
	stage_not_found: "That stage is gone.",
};

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
		async fork(runId) {
			const runtime = deps.runtime();
			if (runtime === undefined) return { ok: false, message: "Workflows are not ready in this session yet." };
			try {
				const result = await workflowForkAction(
					{ runId },
					{ getRuntime: () => runtime, policy: workflowPolicyFromContext(deps.context()), source: "cli" },
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
