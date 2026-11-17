export type TokenSegmentMode = "requesting" | "receiving";

export function formatTokenCount(count: number): string {
	const tokens = Math.max(0, Math.round(count));
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 999_500) return `${(tokens / 1000).toFixed(tokens < 99_950 ? 1 : 0)}k`;
	if (tokens < 999_500_000) return `${(tokens / 1_000_000).toFixed(tokens < 99_950_000 ? 1 : 0)}M`;
	return `${(tokens / 1_000_000_000).toFixed(tokens < 99_950_000_000 ? 1 : 0)}B`;
}

export function formatTokenSegment(segment: { readonly mode: TokenSegmentMode; readonly count: number }): string {
	if (!(segment.count > 0)) return "";
	return `${segment.mode === "requesting" ? "↑" : "↓"} ${formatTokenCount(segment.count)} tokens`;
}
