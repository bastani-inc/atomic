/**
 * The session's top-level workflow runs as items of the host's agent panel and `/tasks`: one item per run with its
 * state, stage progress, current stage, waiting question and elapsed time, read from the live store (#5224).
 */

import type { AgentPanelItem, AgentPanelState } from "@bastani/atomic";
import { settledStageCount } from "../shared/expanded-workflow-graph.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { PendingPrompt, RunSnapshot, RunStatus, StageSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";

const REASON_WIDTH = 120;
/** The id prefix of a run's item. */
export const PANEL_RUN_PREFIX = "run:";

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

function panelState(status: RunStatus, awaiting: boolean, live: boolean): AgentPanelState {
	if (awaiting) return "input";
	if (status === "completed" || status === "skipped") return "done";
	if (status === "failed" || status === "killed") return "failed";
	if (status === "cancelled") return "stopped";
	if (status === "paused" || status === "blocked") return "paused";
	return live ? "running" : "stopped";
}

/** The run id an item names, for a run's item. */
export function panelRunId(id: string): string | undefined {
	return id.startsWith(PANEL_RUN_PREFIX) ? id.slice(PANEL_RUN_PREFIX.length) : undefined;
}

/** One panel item per top-level run in `runs`, in launch order. */
export function panelItemsFromSnapshot(runs: readonly RunSnapshot[], now = Date.now()): AgentPanelItem[] {
	const indicator = createRunIndicatorStatusResolver(runs);
	return topLevelWorkflowRuns(runs).map((run): AgentPanelItem => {
		const stage = currentStage(run.stages);
		const status = effectiveRunStatus(run);
		const state = panelState(status, indicator(run) === "awaiting_input", run.endedAt === undefined);
		const prompt: PendingPrompt | undefined = stage?.pendingPrompt ?? run.pendingPrompt;
		const question = state === "input" ? oneLine(prompt?.message) : undefined;
		const reason =
			state === "failed"
				? oneLine(
						run.error ?? run.stages.find((candidate) => candidate.status === "failed")?.error ?? run.exitReason,
					)
				: undefined;
		const task =
			state === "input"
				? (question ?? (stage === undefined ? "waiting for input" : `stage ${stage.name}`))
				: state === "failed"
					? (reason ?? "failed")
					: stage === undefined
						? ""
						: `stage ${stage.name}`;
		const showProgress = state === "running" || state === "paused" || state === "done";
		return {
			id: `${PANEL_RUN_PREFIX}${run.id}`,
			kind: "workflow",
			state,
			name: run.name,
			task,
			elapsedMs: elapsedRunMs(run, run.endedAt ?? now),
			...(showProgress ? { progress: { done: settledStageCount(run.stages), total: run.stages.length } } : {}),
			...(question === undefined ? {} : { question }),
			...(state === "input" && prompt?.choices?.length ? { choices: [...prompt.choices] } : {}),
			...(reason === undefined ? {} : { reason }),
			...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		};
	});
}
