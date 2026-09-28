// Jev is the smallest routing classifier: 32k tokens for state plus the longest
// question. Measured against Jev 1.13, dense markdown runs about 1.9 JSON bytes per
// token and escaped candidate JSON about 2.4, so 60_000 JSON bytes stays under the
// limit for every input. Larger classifiers and chat fallbacks accept the same copy.
export const ROUTING_REQUEST_BYTES = 60_000;
export const TRUNCATED_MARKER = "\n[... truncated ...]\n";

export function jsonBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Never split a UTF-16 surrogate pair at a cut.
function boundary(text: string, index: number): number {
	const before = text.charCodeAt(index - 1);
	const after = text.charCodeAt(index);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index - 1 : index;
}

/** Keep the longest prefix that fits, marking the cut. Returns "" when not even the marker fits. */
export function truncateToBytes(text: string, maxBytes: number): string {
	if (jsonBytes(text) <= maxBytes) return text;
	if (jsonBytes(TRUNCATED_MARKER) > maxBytes) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (jsonBytes(`${text.slice(0, boundary(text, middle))}${TRUNCATED_MARKER}`) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return `${text.slice(0, boundary(text, low))}${TRUNCATED_MARKER}`;
}
