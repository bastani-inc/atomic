export type TokenSegmentMode = "requesting" | "receiving";

const COMPACT_TOKEN_COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatTokenCount(count: number): string {
	return COMPACT_TOKEN_COUNT.format(Math.max(0, Math.round(count))).toLowerCase();
}

export function formatTokenSegment(segment: { readonly mode: TokenSegmentMode; readonly count: number }): string {
	if (!(segment.count > 0)) return "";
	return `${segment.mode === "requesting" ? "↑" : "↓"} ${formatTokenCount(segment.count)} tokens`;
}
