import { formatTokenCount, sliceHead, TASK_MARKS, type TaskMark } from "@bastani/atomic";
import { isParentCancellation } from "../runs/shared/cancellation-recovery.js";
import { formatDuration, formatToolCall } from "../shared/formatters.js";
import { formatActivityLabel } from "../shared/status-format.js";
import type { AgentProgress, Details } from "../shared/types.js";
import { getDisplayItems } from "../shared/utils.js";
import { getTermWidth, type Theme } from "./render-layout.js";

export function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:(?:[^\S\n]*\n)*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

export function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

export function getToolCallLines(
	result: Pick<Details["results"][number], "messages" | "toolCalls">,
	expanded: boolean,
): string[] {
	if (result.messages) {
		return getDisplayItems(result.messages)
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return result.toolCalls?.map((toolCall) => (expanded ? toolCall.expandedText : toolCall.text)) ?? [];
}

export function snapshotNowForProgress(
	progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">,
	now?: number,
): number | undefined {
	if (now !== undefined) return now;
	if (progress.lastActivityAt !== undefined) return progress.lastActivityAt;
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined)
		return progress.currentToolStartedAt + progress.durationMs;
	return undefined;
}

export function formatCurrentToolLine(
	progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
	availableWidth: number,
	expanded: boolean,
	snapshotNow?: number,
): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${sliceHead(progress.currentToolArgs, maxToolArgsLen)}...`
		: "";
	const durationSuffix =
		progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
			? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
			: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

export function buildLiveStatusLine(
	progress: Pick<AgentProgress, "activityState" | "lastActivityAt">,
	snapshotNow?: number,
): string | undefined {
	if (progress.lastActivityAt !== undefined && snapshotNow !== undefined)
		return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
	if (progress.activityState === "needs_attention") return "needs attention";
	if (progress.activityState === "active_long_running") return "active but long-running";
	if (progress.lastActivityAt !== undefined) return "active";
	return undefined;
}

export function themeBold(theme: Theme, text: string): string {
	return (theme as { bold?: (value: string) => string }).bold?.(text) ?? text;
}

export function statJoin(theme: Theme, parts: string[]): string {
	return parts
		.filter(Boolean)
		.map((part) => theme.fg("dim", part))
		.join(` ${theme.fg("dim", "·")} `);
}

export function formatTokenStat(tokens: number): string {
	return `${formatTokenCount(tokens)} token${tokens === 1 ? "" : "s"}`;
}

export function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

export function displayProgressDurationMs(
	progress: Pick<AgentProgress, "durationMs"> & Partial<Pick<AgentProgress, "lastActivityAt" | "status">>,
	now?: number,
): number {
	if (progress.status === "running" && progress.lastActivityAt !== undefined && now !== undefined) {
		return progress.durationMs + Math.max(0, now - progress.lastActivityAt);
	}
	return progress.durationMs;
}

export function formatProgressStats(
	theme: Theme,
	progress:
		| (Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> &
				Partial<Pick<AgentProgress, "lastActivityAt" | "status">>)
		| undefined,
	includeDuration = true,
	now?: number,
): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	const durationMs = displayProgressDurationMs(progress, now);
	if (includeDuration && durationMs > 0) parts.push(formatDuration(durationMs));
	return statJoin(theme, parts);
}

export function firstOutputLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? ""
	);
}

export function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.status === "continued") return "Continued";
	if (result.status === "killed") return "Killed (non-resumable)";
	if (isParentCancellation(result.cause) && (result.interrupted || result.status === "interrupted"))
		return "Cancelled";
	if (result.interrupted || result.status === "interrupted") return "Interrupted";
	if (result.status === "skipped") return result.error ? `Skipped: ${result.error}` : "Skipped";
	if (result.status === "error") return `Error: ${result.error ?? (firstOutputLine(output) || "failed")}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

/** A mark in its colour. */
export function markText(theme: Theme, mark: TaskMark): string {
	return theme.fg(mark.color, mark.glyph);
}

/**
 * A result's mark, the one the agent panel and `/tasks` show its state with: running, or continued on its own, an open
 * grey circle; killed, interrupted or skipped, the stopped mark; failed, a cross; done, a filled circle, also when it
 * left no text output (its words say so).
 */
export function resultGlyph(
	result: Details["results"][number],
	theme: Theme,
	running = result.progress?.status === "running",
): string {
	if (running) return markText(theme, TASK_MARKS.running);
	if (result.detached || result.status === "continued") return markText(theme, TASK_MARKS.running);
	if (
		result.status === "killed" ||
		result.interrupted ||
		result.status === "interrupted" ||
		result.status === "skipped"
	)
		return markText(theme, TASK_MARKS.stopped);
	if (result.status === "error") return markText(theme, TASK_MARKS.failed);
	return markText(theme, TASK_MARKS.done);
}

export function compactCurrentActivity(progress: AgentProgress, now?: number): string {
	const snapshotNow = snapshotNowForProgress(progress, now);
	return (
		formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ??
		buildLiveStatusLine(progress, snapshotNow) ??
		"thinking…"
	);
}
