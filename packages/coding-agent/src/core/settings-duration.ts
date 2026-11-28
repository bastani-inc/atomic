const DURATION_STRING_PATTERN = /^(\d+)(ms|s|m|h)$/i;

/** Parse a non-negative number of milliseconds or a configured duration such as `30s` or `disabled`. */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;
		const match = DURATION_STRING_PATTERN.exec(trimmed);
		if (match) {
			const unit = match[2].toLowerCase();
			const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
			return parseHttpIdleTimeoutMs(Number(match[1]) * multiplier);
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}
