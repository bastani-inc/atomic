import { formatTokenCount } from "../../../utils/token-count.ts";

export { formatTokenCount };

export type TokenSegmentMode = "requesting" | "receiving";

export function formatTokenSegment(segment: { readonly mode: TokenSegmentMode; readonly count: number }): string {
	if (!(segment.count > 0)) return "";
	return `${segment.mode === "requesting" ? "↑" : "↓"} ${formatTokenCount(segment.count)} tokens`;
}
