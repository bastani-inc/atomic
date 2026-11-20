export type TokenSegmentMode = "requesting" | "receiving";

const COMPACT_TOKEN_COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * A token count in compact units: "999", "1.2k", "3.4M", "5B". Thousands use a lowercase "k"; millions, billions and
 * trillions use an uppercase "M", "B" and "T", so a count never ends in an "m" that reads as minutes beside an elapsed
 * time.
 */
export function formatTokenCount(count: number): string {
	return COMPACT_TOKEN_COUNT.format(Math.max(0, Math.round(count))).replace("K", "k");
}

export function formatTokenSegment(segment: { readonly mode: TokenSegmentMode; readonly count: number }): string {
	if (!(segment.count > 0)) return "";
	return `${segment.mode === "requesting" ? "↑" : "↓"} ${formatTokenCount(segment.count)} tokens`;
}
