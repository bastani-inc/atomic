import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { LineRange, NumberedRegion, VerbatimCompactionParameters } from "./compaction-types.js";
import { validateDeletedRanges } from "./deleted-ranges.js";
import { buildStructuredCompactionInput, mapMessageRanges } from "./structured-compaction-input.js";

const responseSchema = Type.Object({
	messages: Type.Array(
		Type.Object({
			compacted_line_ranges: Type.Array(Type.Object({ start: Type.Number(), end: Type.Number() })),
		}),
	),
});

export interface MorphRangeDiagnostics {
	droppedRangeCount: number;
	acceptedRangeCount: number;
}

export async function planMorphRanges(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
	options: {
		apiKey: string | undefined;
		signal?: AbortSignal;
		fetchFn?: typeof fetch;
		onDiagnostics?: (diagnostics: MorphRangeDiagnostics) => void;
	},
): Promise<LineRange[]> {
	if (options.signal?.aborted) throw new Error("Compaction cancelled");
	if (!options.apiKey) throw new Error("Morph compaction requires /login morph or MORPH_API_KEY");
	const input = buildStructuredCompactionInput(region, parameters);
	const response = await (options.fetchFn ?? fetch)("https://api.morphllm.com/v1/compact", {
		method: "POST",
		headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: input.messages.map((message) => ({ role: message.role, content: message.lines.join("\n") })),
			query: input.query,
			compression_ratio: input.compression_ratio,
			preserve_recent: 0,
			include_markers: false,
		}),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Morph compaction HTTP ${response.status}`);
	const body: Static<typeof responseSchema> = await response.json();
	if (!Value.Check(responseSchema, body) || body.messages.length !== input.messages.length)
		throw new Error("Malformed Morph compaction response");
	let droppedRangeCount = 0;
	const records = body.messages.flatMap((message, index) =>
		message.compacted_line_ranges.flatMap((range) => {
			if (
				!Number.isSafeInteger(range.start) ||
				!Number.isSafeInteger(range.end) ||
				range.start < 1 ||
				range.end < range.start ||
				range.end > input.messages[index].lines.length
			) {
				droppedRangeCount++;
				return [];
			}
			return [{ id: input.messages[index].id, ...range }];
		}),
	);
	options.onDiagnostics?.({ droppedRangeCount, acceptedRangeCount: records.length });
	const ranges = validateDeletedRanges(mapMessageRanges(records, input), region);
	if (!ranges.length) throw new Error("Morph compaction produced no usable ranges");
	return [...ranges];
}
