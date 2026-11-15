/**
 * The session's top-level workflow runs as the host's agent panel and `/tasks` list them: one row per run with its
 * status, stage progress, current stage and elapsed time, read from the live store.
 */

import type { WorkflowPanelRun } from "@bastani/atomic";
import { settledStageCount } from "../shared/expanded-workflow-graph.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";

const REASON_WIDTH = 120;

function oneLine(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (line === undefined) return undefined;
	return line.length > REASON_WIDTH ? `${line.slice(0, REASON_WIDTH - 1)}…` : line;
}

function currentStage(stages: readonly StageSnapshot[]): StageSnapshot | undefined {
	return (
		stages.find((stage) => stage.status === "awaiting_input") ??
		stages.find((stage) => stage.status === "running") ??
		stages.find((stage) => stage.status === "paused" || stage.status === "blocked")
	);
}

/** One {@link WorkflowPanelRun} per top-level run in `runs`, in launch order. */
export function panelRunsFromSnapshot(runs: readonly RunSnapshot[], now = Date.now()): WorkflowPanelRun[] {
	const indicator = createRunIndicatorStatusResolver(runs);
	return topLevelWorkflowRuns(runs).map((run): WorkflowPanelRun => {
		const stage = currentStage(run.stages);
		const awaiting = indicator(run) === "awaiting_input";
		const question = stage?.pendingPrompt?.message ?? run.pendingPrompt?.message;
		const status = effectiveRunStatus(run);
		const failed = status === "failed" || status === "killed";
		const reason = failed
			? oneLine(run.error ?? run.stages.find((candidate) => candidate.status === "failed")?.error ?? run.exitReason)
			: undefined;
		return {
			runId: run.id,
			name: run.name,
			status,
			awaitingInput: awaiting,
			...(awaiting && question !== undefined ? { question: oneLine(question) } : {}),
			elapsedMs: elapsedRunMs(run, run.endedAt ?? now),
			...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
			stagesDone: settledStageCount(run.stages),
			stagesTotal: run.stages.length,
			...(stage === undefined ? {} : { currentStage: stage.name }),
			...(reason === undefined ? {} : { reason }),
		};
	});
}
