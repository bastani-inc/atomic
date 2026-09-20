// Jev's per-question budget is 30 KB. The task excerpt shares it with the evals
// document (<= 16 KB), the static model-selection guide (~3 KB), agent metadata and
// a candidate batch. Count JSON-encoded UTF-8 bytes, including escapes, not JS characters.
export const MODEL_ROUTING_TASK_BYTES = 9_000;
const omitted = "\n[... text omitted for model selection only ...]\n";
const notice = "[Model-routing excerpt. Omitted text remains in the execution task.]\n";
type Range = { start: number; end: number };

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

/** Bound only the model selector's copy. Execution and hard constraints stay intact. */
export function modelRoutingTask(task: string): string {
	const fits = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") <= MODEL_ROUTING_TASK_BYTES;
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
			if (range.start > end) parts.push(omitted);
			parts.push(task.slice(Math.max(end, range.start), range.end));
			end = range.end;
		}
		if (end < task.length) parts.push(omitted);
		return parts.join("");
	};
	let result = excerpt(0);
	// Keep the original context when protection cannot fit. The existing transport
	// budget guard still prevents oversized Jev requests and handles chat fallback.
	if (!fits(result)) return task;
	let low = 0;
	let high = Math.min(Math.floor(task.length / 2), MODEL_ROUTING_TASK_BYTES);
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
