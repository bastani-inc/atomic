import * as path from "node:path";
import type { AsyncJobState, AsyncJobStep, NestedRunSummary, NestedStepSummary } from "../shared/types.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatDuration, formatModelThinking, shortenPath } from "../shared/formatters.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";
import { buildLiveStatusLine, formatCurrentToolLine, formatTokenStat, formatToolUseStat, statJoin } from "./render-status-progress.ts";
import { runningGlyph, runningSeed, truncLine, type Theme } from "./render-layout.ts";

export function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} ×${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

export function widgetJobName(job: AsyncJobState): string {
	if (job.mode === "parallel") return "parallel";
	if (job.mode === "chain") return "chain";
	if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
	if (job.agents?.length) return formatWidgetAgents(job.agents);
	return job.mode ?? "subagent";
}

export function widgetActivity(job: AsyncJobState): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	if (job.currentPath) facts.push(shortenPath(job.currentPath));
	if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
	const activity = buildLiveStatusLine(job, job.updatedAt);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "running") return "thinking…";
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "failed") return "Failed";
	return "Done";
}

export function widgetStepRunningSeed(step: NonNullable<AsyncJobState["steps"]>[number], fallbackIndex?: number): number | undefined {
	return runningSeed(
		fallbackIndex,
		step.index,
		step.toolCount,
		step.turnCount,
		step.tokens?.total,
		step.lastActivityAt,
		step.currentToolStartedAt,
		step.durationMs,
	);
}

export function widgetStepsRunningSeed(steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined): number | undefined {
	let seed: number | undefined;
	for (const [index, step] of (steps ?? []).entries()) seed = runningSeed(seed, widgetStepRunningSeed(step, index));
	return seed;
}

export function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
	return runningSeed(
		job.updatedAt,
		job.lastActivityAt,
		job.toolCount,
		job.turnCount,
		job.totalTokens?.total,
		job.currentStep,
		job.runningSteps,
		job.completedSteps,
		widgetStepsRunningSeed(job.steps),
	);
}

export function widgetJobsRunningSeed(jobs: AsyncJobState[]): number | undefined {
	let seed: number | undefined;
	for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
	return seed;
}

export function widgetStatusGlyph(job: AsyncJobState, theme: Theme, now?: number): string {
	if (job.status === "running") return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job), now));
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

export function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number, now?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed, now));
	if (status === "complete" || status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	return theme.fg("dim", status);
}

export function widgetStepActivity(step: NonNullable<AsyncJobState["steps"]>[number], snapshotNow?: number): string {
	const facts: string[] = [];
	if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
	else if (step.currentTool) facts.push(step.currentTool);
	if (step.currentPath) facts.push(shortenPath(step.currentPath));
	if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
	if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
	if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	return facts.join(" · ");
}

export function widgetStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
	if (job.activeParallelGroup) {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.mode === "parallel") {
			if (job.status === "running" && running > 0) parts.push(formatAgentRunningLabel(running));
			if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
		} else {
			const activeGroup = job.currentStep !== undefined
				? job.parallelGroups?.find((group) => job.currentStep! >= group.start && job.currentStep! < group.start + group.count)
				: job.parallelGroups?.find((group) => group.start === 0);
			const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
			const total = job.chainStepCount ?? stepsTotal;
			const groupParts = [`${done}/${stepsTotal} done`];
			if (job.status === "running" && running > 0) groupParts.unshift(formatAgentRunningLabel(running));
			parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
		}
	} else if (job.currentStep !== undefined) {
		if (job.mode === "chain" && job.parallelGroups?.length) {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
		} else {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	if (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
	return statJoin(theme, parts);
}

export function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
	return statJoin(theme, [
		step.turnCount !== undefined ? `${step.turnCount} turns` : "",
		step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
		step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
		step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
	]);
}

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string, fastMode?: boolean): string {
	const label = formatModelThinking(model, thinking, fastMode);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

export function widgetStepActivityLine(step: NonNullable<AsyncJobState["steps"]>[number], width: number, expanded: boolean, snapshotNow?: number): string {
	const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
	if (toolLine) return toolLine;
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity) return activity;
	if (step.status === "running") return "thinking…";
	return "";
}

export function widgetOutputPath(job: AsyncJobState, step: NonNullable<AsyncJobState["steps"]>[number]): string | undefined {
	if (typeof step.index !== "number") return undefined;
	return path.join(job.asyncDir, `output-${step.index}.log`);
}

export function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

export function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme, seed?: number, now?: number): string {
	if (state === "running") return theme.fg("accent", runningGlyph(seed, now));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function nestedRunSeed(run: NestedRunSummary): number | undefined {
	return runningSeed(run.lastUpdate, run.lastActivityAt, run.currentStep, run.toolCount, run.turnCount, run.totalTokens?.total, run.currentToolStartedAt);
}

export function nestedActivity(input: Pick<NestedRunSummary | NestedStepSummary, "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount">, state: NestedRunSummary["state"] | NestedStepSummary["status"], snapshotNow?: number): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "failed") return "Failed";
	return "Done";
}

export function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1, now?: number): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
	}
	const lines: string[] = [];
	const maxDepth = 2;
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= lineBudget) return;
		if (depth > maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
			const error = child.error ? ` · ${child.error}` : "";
			lines.push(theme.fg("dim", `${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child), now)} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`));
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedStatusGlyph(step.status, theme, undefined, now)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`));
				append(step.children, depth + 1, `${prefix}    `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, "");
	return lines.map((line) => truncLine(line, width));
}
