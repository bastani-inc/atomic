import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { redactCredentialShapes } from "../../utils/credential-redaction.js";
import type { LineRange, NumberedRegion, VerbatimCompactionParameters } from "./compaction-types.js";
import { validateDeletedRanges } from "./deleted-ranges.js";
import { isProviderPolicyRefusal } from "./planner-outcome.js";
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
	failureCategory?: "provider_error" | "policy_refusal";
	failureMessage?: string;
}

const HTTP_ERROR_EXCERPT_MAX_CHARS = 500;
const HTTP_ERROR_BODY_MAX_BYTES = 8192;

async function readHttpErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (bytes < HTTP_ERROR_BODY_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			const remaining = HTTP_ERROR_BODY_MAX_BYTES - bytes;
			text += decoder.decode(value.subarray(0, remaining), { stream: true });
			bytes += value.length;
		}
		const completeLinesEnd = Math.max(0, text.lastIndexOf("\n"));
		return text.slice(0, completeLinesEnd);
	} catch {
		return "";
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function morphHttpErrorMessage(response: Response, apiKey: string): Promise<string> {
	const body = await readHttpErrorBody(response);
	const excerpt = redactCredentialShapes(body.replaceAll(apiKey, "[redacted]"))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, HTTP_ERROR_EXCERPT_MAX_CHARS);
	return `Morph compaction HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`;
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
	if (!response.ok) {
		const message = await morphHttpErrorMessage(response, options.apiKey);
		options.onDiagnostics?.({
			droppedRangeCount: 0,
			acceptedRangeCount: 0,
			failureCategory: isProviderPolicyRefusal(message) ? "policy_refusal" : "provider_error",
			failureMessage: message,
		});
		throw new Error(message);
	}
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
