// Jev is the smallest routing classifier: 32k tokens for state plus the longest
// question. Measured against Jev 1.13, dense markdown runs about 1.9 JSON bytes per
// token and escaped candidate JSON about 2.4, so 60_000 JSON bytes stays under the
// limit for every input. Larger classifiers and chat fallbacks accept the same copy.
export const ROUTING_REQUEST_BYTES = 60_000;
// The task excerpt's share of the request when everything else leaves room for it.
// Count JSON-encoded UTF-8 bytes, including escapes, not JS characters.
export const MODEL_ROUTING_TASK_BYTES = 9_000;
export const TRUNCATED_MARKER = "\n[... truncated ...]\n";
const notice = "[Model-routing excerpt. Truncated text remains in the execution task.]\n";
type Range = { start: number; end: number };

export function jsonBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function protectedRanges(task: string): Range[] {
	const ranges: Range[] = [];
	let depth = 0;
	let start = 0;
	for (const match of task.matchAll(/<\/?keepContext>/gi)) {
		if (match[0][1] !== "/") {
			if (depth++ === 0) start = match.index;
		} else if (depth > 0 && --depth === 0) {
			ranges.push({ start, end: match.index + match[0].length });
		}
	}
	// An unclosed protected span protects through the end rather than losing it.
	if (depth > 0) ranges.push({ start, end: task.length });
	return ranges;
}

// Never split a UTF-16 surrogate pair at an excerpt boundary.
function boundary(task: string, index: number, direction: -1 | 1): number {
	const before = task.charCodeAt(index - 1);
	const after = task.charCodeAt(index);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index + direction : index;
}

/** Keep the longest prefix that fits, marking the cut. Returns "" when not even the marker fits. */
export function truncateToBytes(text: string, maxBytes: number): string {
	if (jsonBytes(text) <= maxBytes) return text;
	if (jsonBytes(TRUNCATED_MARKER) > maxBytes) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (jsonBytes(`${text.slice(0, boundary(text, middle, -1))}${TRUNCATED_MARKER}`) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return `${text.slice(0, boundary(text, low, -1))}${TRUNCATED_MARKER}`;
}

/** Bound only the model selector's copy. Execution and hard constraints stay intact. */
export function modelRoutingTask(task: string, maxBytes = MODEL_ROUTING_TASK_BYTES): string {
	const fits = (text: string) => jsonBytes(text) <= maxBytes;
	if (fits(task)) return task;
	const protectedSpans = protectedRanges(task);
	const excerpt = (edgeChars: number): string => {
		const ranges = [
			{ start: 0, end: boundary(task, edgeChars, -1) },
			...protectedSpans,
			{ start: boundary(task, task.length - edgeChars, 1), end: task.length },
		];
		const parts = [notice];
		let end = 0;
		for (const range of ranges) {
			if (range.end <= end) continue;
			if (range.start > end) parts.push(TRUNCATED_MARKER);
			parts.push(task.slice(Math.max(end, range.start), range.end));
			end = range.end;
		}
		if (end < task.length) parts.push(TRUNCATED_MARKER);
		return parts.join("");
	};
	let result = excerpt(0);
	// Protected spans that alone exceed the budget are cut too: an oversized
	// routing request fails outright, and the execution task keeps every span.
	if (!fits(result)) return truncateToBytes(result, maxBytes);
	let low = 0;
	let high = Math.min(Math.floor(task.length / 2), maxBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = excerpt(middle);
		if (fits(candidate)) {
			result = candidate;
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return result;
}
