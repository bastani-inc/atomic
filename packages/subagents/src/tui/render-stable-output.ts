import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentProgress, AsyncJobState, Details } from "../shared/types.ts";

export function widgetRenderKey(job: AsyncJobState): string {
	return JSON.stringify({
		asyncDir: job.asyncDir,
		status: job.status,
		activityState: job.activityState,
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolStartedAt: job.currentToolStartedAt,
		currentPath: job.currentPath,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		mode: job.mode,
		agents: job.agents,
		currentStep: job.currentStep,
		chainStepCount: job.chainStepCount,
		parallelGroups: job.parallelGroups,
		steps: job.steps,
		nestedChildren: job.nestedChildren,
		stepsTotal: job.stepsTotal,
		runningSteps: job.runningSteps,
		completedSteps: job.completedSteps,
		activeParallelGroup: job.activeParallelGroup,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		totalTokens: job.totalTokens,
	});
}

export function progressRenderKey(progress: Partial<AgentProgress> | undefined): string {
	if (!progress) return "";
	return [
		progress.index,
		progress.agent,
		progress.status,
		progress.durationMs,
		progress.toolCount,
		progress.tokens,
		progress.turnCount ?? "",
		progress.lastActivityAt ?? "",
		progress.currentTool ?? "",
		progress.currentToolStartedAt ?? "",
		progress.currentPath ?? "",
	].join(":");
}

export function isRunningSubagentResult(result: AgentToolResult<Details>): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

export function subagentResultRenderKey(
	result: AgentToolResult<Details>,
	options: { expanded: boolean; isPartial: boolean },
): string {
	const details = result.details;
	if (!details) return `${options.isPartial ? "partial" : "final"}:${result.content.length}`;
	const progressKeys = [
		...(details.progress ?? []).map(progressRenderKey),
		...details.results.map((entry) => [
			entry.agent,
			entry.exitCode,
			entry.interrupted === true ? "interrupted" : "",
			entry.detached === true ? "detached" : "",
			progressRenderKey(entry.progress),
			progressRenderKey(entry.progressSummary),
			entry.finalOutput?.length ?? "",
			entry.error?.length ?? "",
		].join(":")),
	];
	return [
		options.isPartial ? "partial" : "final",
		options.expanded ? "expanded" : "compact",
		details.mode,
		details.currentStepIndex ?? "",
		details.asyncId ?? "",
		details.totalSteps ?? "",
		progressRenderKey(details.progressSummary),
		progressKeys.join("|"),
	].join("|");
}
