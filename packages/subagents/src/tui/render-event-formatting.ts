import { formatDuration, formatModelThinking, shortenPath } from "../shared/formatters.ts";
import type { NestedRunSummary, NestedStepSummary } from "../shared/types.ts";
import { runningPulseGlyph, type Theme } from "./render-layout.ts";
import { buildLiveStatusLine } from "./render-status-progress.ts";

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string, fastMode?: boolean): string {
	const label = formatModelThinking(model, thinking, fastMode);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

export function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.join(", ");
	return run.id;
}

export function nestedStatusGlyph(
	state: NestedRunSummary["state"] | NestedStepSummary["status"],
	theme: Theme,
	pulseFrame?: number,
): string {
	if (state === "running") return theme.fg("accent", runningPulseGlyph(pulseFrame));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function nestedActivity(
	input: Pick<
		NestedRunSummary | NestedStepSummary,
		| "activityState"
		| "lastActivityAt"
		| "currentTool"
		| "currentToolStartedAt"
		| "currentPath"
		| "turnCount"
		| "toolCount"
	>,
	state: NestedRunSummary["state"] | NestedStepSummary["status"],
	snapshotNow?: number,
): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined)
		facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
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
