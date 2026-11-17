import { formatWorkingTokens } from "./working-run-meter.ts";

export type TokenSegmentMode = "requesting" | "receiving";

export function formatTokenCount(count: number): string {
	return formatWorkingTokens(Math.max(0, Math.round(count)));
}

export function formatTokenSegment(segment: { readonly mode: TokenSegmentMode; readonly count: number }): string {
	if (!(segment.count > 0)) return "";
	return `${segment.mode === "requesting" ? "↑" : "↓"} ${formatTokenCount(segment.count)} tokens`;
}
