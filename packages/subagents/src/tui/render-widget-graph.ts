import { keyHint } from "@bastani/atomic";
import type { AsyncJobState } from "../shared/types.ts";
import { shortenPath } from "../shared/formatters.ts";
import { aggregateStepStatus, formatParallelOutcome } from "../shared/status-format.ts";
import { buildAsyncChainStepSpans } from "./render-chain-graph.ts";
import { getTermWidth, truncLine, type Theme } from "./render-layout.ts";
import { buildLiveStatusLine, themeBold } from "./render-status-progress.ts";
import {
	formatNestedWidgetLines,
	modelThinkingBadge,
	widgetActivity,
	widgetOutputPath,
	widgetStats,
	widgetStatusGlyph,
	widgetStepActivity,
	widgetStepActivityLine,
	widgetStepPulseGlyph,
	widgetStepStats,
	widgetStepStatus,
	widgetJobName,
} from "./render-event-formatting.ts";

export function widgetChainDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth(), pulseFrame?: number): string[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: string[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			const status = aggregateStepStatus(steps);
			lines.push(`  ${widgetStepPulseGlyph(status, theme, pulseFrame)} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`);
			continue;
		}
		const step = steps[0];
		if (!step) {
			lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
			continue;
		}
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width, pulseFrame));
	}
	return lines;
}

export function widgetParallelAgentDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth(), _now?: number, pulseFrame?: number): string[] {
	if (!job.steps?.length) return [];
	if (job.mode !== "parallel" && job.mode !== "chain") return [];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width, pulseFrame);
	const total = job.stepsTotal ?? job.steps.length;
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		const marker = index === job.steps.length - 1 ? "└" : "├";
		const activity = widgetStepActivity(step, job.updatedAt);
		const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking, step.fastMode);
		lines.push(`  ${theme.fg("dim", `${marker} ${widgetStepPulseGlyph(step.status, theme, pulseFrame)} ${itemTitle} ${index + 1}/${total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 8 : 1, pulseFrame)) lines.push(`    ${nestedLine}`);
	}
	return lines;
}

export function foregroundStyleWidgetStepLines(
	job: AsyncJobState,
	theme: Theme,
	step: NonNullable<AsyncJobState["steps"]>[number],
	itemTitle: "Agent" | "Step",
	index: number,
	total: number,
	expanded: boolean,
	width: number,
	pulseFrame?: number,
): string[] {
	const status = widgetStepStatus(step.status, theme);
	const stats = widgetStepStats(theme, step);
	const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking, step.fastMode);
	const lines = [`  ${widgetStepPulseGlyph(step.status, theme, pulseFrame)} ${itemTitle} ${index}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`];
	const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
	if (activity) lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
	for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, undefined, pulseFrame)) {
		lines.push(`    ${nestedLine}`);
	}
	if (step.status === "running") {
		if (!expanded) lines.push(`    ${theme.fg("accent", `Press ${keyHint("app.tools.expand", "for live detail")}`)}`);
		const output = widgetOutputPath(job, step);
		if (output) lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
		if (expanded) {
			const liveStatus = buildLiveStatusLine(step, job.updatedAt);
			if (liveStatus && liveStatus !== activity) lines.push(`    ${theme.fg("accent", liveStatus)}`);
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				const maxArgsLen = Math.max(40, width - 30);
				const argsPreview = tool.args.length <= maxArgsLen ? tool.args : `${tool.args.slice(0, maxArgsLen)}...`;
				lines.push(`      ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`);
			}
			for (const line of step.recentOutput?.slice(-5) ?? []) {
				lines.push(`      ${theme.fg("dim", line)}`);
			}
		}
	}
	return lines;
}

export function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number, pulseFrame?: number): string[] {
	if (!job.steps?.length) return [
		`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
		...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt, undefined, pulseFrame).map((line) => `  ${line}`),
	];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width, pulseFrame);
	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width, pulseFrame));
	}
	const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
	for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt, undefined, pulseFrame)) {
		lines.push(`  ${nestedLine}`);
	}
	return lines;
}

export function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, expanded: boolean, _now?: number, pulseFrame?: number): string[] {
	const stats = widgetStats(job, theme);
	const count = job.mode === "chain" ? job.chainStepCount : job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
	const mode = widgetJobName(job);
	const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	return [
		`${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
		`${widgetStatusGlyph(job, theme, pulseFrame)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
		...foregroundStyleWidgetDetails(job, theme, expanded, width, pulseFrame),
	].map((line) => truncLine(line, width));
}

export function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, _now?: number, pulseFrame?: number): string[] {
	const fullLines = buildSingleWidgetLines(job, theme, width, false, _now, pulseFrame);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) return fullLines;

	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines = fullLines.slice(0, 2);
	for (const [index, step] of job.steps.entries()) {
		const status = widgetStepStatus(step.status, theme);
		const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
		const stepStats = widgetStepStats(theme, step);
		const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking, step.fastMode);
		lines.push(`  ${widgetStepPulseGlyph(step.status, theme, pulseFrame)} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt, undefined, pulseFrame)) lines.push(`    ${nestedLine}`);
		if (step.status === "running") {
			const output = widgetOutputPath(job, step);
			if (output) lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
		}
	}
	if (job.steps.some((step) => step.status === "running")) lines.push(theme.fg("accent", `  Press ${keyHint("app.tools.expand", "for live detail")}`));
	return lines.map((line) => truncLine(line, width));
}

export function fitWidgetLineBudget(lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
	const rows = process.stdout.rows || 30;
	const budget = expanded
		? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
		: Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
	if (lines.length <= budget) return lines;
	const visibleLines = Math.max(1, budget - 1);
	const hiddenCount = lines.length - visibleLines;
	const hint = expanded
		? `… ${hiddenCount} live-detail lines hidden`
		: `… ${hiddenCount} lines hidden · ${keyHint("app.tools.expand", "expands")}`;
	return [...lines.slice(0, visibleLines), truncLine(theme.fg("dim", hint), width)];
}
