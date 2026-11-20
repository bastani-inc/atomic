const TOKEN_COUNT_UNITS = ["k", "M", "B", "T", "Q"] as const;

/**
 * A token count as every view shows it: the whole count below 1,000, then one decimal and a unit, as in "1.0k",
 * "248.6k", "1.2M", "1.0B" and "1.0T". Thousands use a lowercase "k" and larger units an uppercase letter, so a count
 * never ends in an "m" that reads as minutes beside an elapsed time. A count that rounds to 1000.0 of a unit shows as
 * 1.0 of the next one: 999,950 is "1.0M". Fractional counts round to whole tokens; a negative or non-finite count is "0".
 */
export function formatTokenCount(count: number): string {
	// A JavaScript caller can pass a numeric string such as "1500"; any other non-number is malformed.
	const input = count as number | string;
	const value = typeof input === "number" || typeof input === "string" ? Number(input) : Number.NaN;
	const tokens = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	if (tokens < 1000) return String(tokens);
	let unit = 0;
	let tenthStep = 100;
	let tenths = Math.round(tokens / tenthStep);
	while (tenths >= 10_000 && unit < TOKEN_COUNT_UNITS.length - 1) {
		unit++;
		tenthStep *= 1000;
		tenths = Math.round(tokens / tenthStep);
	}
	return `${Math.floor(tenths / 10)}.${tenths % 10}${TOKEN_COUNT_UNITS[unit]}`;
}
