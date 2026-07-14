import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple, isContextOverflow } from "@earendil-works/pi-ai/compat";
import { getEffectiveInputBudget } from "../context-window.js";
import { validateDeletedRanges } from "./deleted-ranges.js";
import {
	CHUNK_TOKEN_MARGIN,
	MAX_RANGE_PLAN_ATTEMPTS,
	RATIO_DRIFT_TOLERANCE,
	type NumberedRegion,
	type RawLineEndpoint,
	type RawLineRange,
	type VerbatimCompactionParameters,
} from "./compaction-types.js";
import { numberRegionLines } from "./transcript-serialization.js";

export const RANGE_PLANNER_SYSTEM_PROMPT =
	"You are a transcript line-compaction engine. You select which lines of a numbered conversation transcript to DELETE. You never rewrite, summarize, or reorder content. You output only JSON.";

export class RangePlanError extends Error {
	readonly attempts: number;
	readonly lastResponseExcerpt: string;
	readonly providerOverflow: boolean;

	constructor(message: string, attempts: number, lastResponseExcerpt: string, providerOverflow: boolean) {
		super(message);
		this.name = "RangePlanError";
		this.attempts = attempts;
		this.lastResponseExcerpt = lastResponseExcerpt;
		this.providerOverflow = providerOverflow;
	}
}

export interface RangePlannerOptions {
	streamFn?: StreamFn;
}

export interface LineChunk {
	start: number;
	end: number;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function firstBalancedObject(text: string): string | undefined {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = index;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

function endpoint(value: JsonValue | undefined): RawLineEndpoint | undefined {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? value
		: undefined;
}

export function extractDeletedRanges(text: string): RawLineRange[] | undefined {
	const objectText = firstBalancedObject(text);
	if (!objectText) return undefined;
	try {
		const parsed = JSON.parse(objectText) as JsonValue;
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
		const ranges = parsed.deleted_ranges;
		if (!Array.isArray(ranges)) return undefined;
		return ranges
			.filter((item): item is { [key: string]: JsonValue } => Boolean(item) && !Array.isArray(item) && typeof item === "object")
			.map((item) => ({ start: endpoint(item.start), end: endpoint(item.end) }));
	} catch {
		return undefined;
	}
}

export function splitRegionChunks(region: NumberedRegion, model: Model<Api>): LineChunk[] {
	const inputBudget = Math.max(1, getEffectiveInputBudget(model) - CHUNK_TOKEN_MARGIN);
	const promptTokens = 700;
	if (region.tokenEstimate + promptTokens <= inputBudget) return [{ start: 1, end: region.lines.length }];
	const charBudget = Math.max(4, (inputBudget - promptTokens) * 4);
	const chunks: LineChunk[] = [];
	let start = 1;
	while (start <= region.lines.length) {
		let end = start;
		let chars = 0;
		while (end <= region.lines.length && (chars === 0 || chars + region.lines[end - 1].length + 1 <= charBudget)) {
			chars += region.lines[end - 1].length + 1;
			end++;
		}
		end = Math.max(start, end - 1);
		if (end < region.lines.length) {
			let boundary = end;
			while (boundary > start && !region.headerLineNumbers.has(boundary + 1)) boundary--;
			if (boundary > start) end = boundary;
		}
		chunks.push({ start, end });
		start = end + 1;
	}
	return chunks;
}

export function buildRangePlannerPrompt(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
	chunk: LineChunk,
	promptSuffix = "",
): string {
	const total = chunk.end - chunk.start + 1;
	const deleteBudget = Math.round((1 - parameters.compression_ratio) * total);
	const percent = Math.round((1 - parameters.compression_ratio) * 100);
	return `<compaction-task>\nDelete approximately ${deleteBudget} of the ${total} lines below (${percent}% — a LINE count budget, not a token budget). Output ONLY this JSON, nothing else:\n{"deleted_ranges":[{"start":<int>,"end":<int>}, …]}\nRanges are 1-based, inclusive, refer to the N→ line numbers, must be sorted ascending and non-overlapping.\n</compaction-task>\n\n<rules>\n- NEVER delete a role header line ([User]:, [Assistant]:, [Assistant thinking]:, [Assistant tool calls]:, [Tool result]:). Keep the conversation skeleton intact.\n- Prefer thinning INSIDE sections: keep each section's first 1-2 lines (the topic sentence), delete the elaboration.\n- KEEP (most→least protected): assistant final answers, error lines and unresolved failures, the user's actual objective/task statements, decisions and their reasons, key file paths / test names / verification commands, one-line tool-call signatures.\n- DELETE aggressively: assistant thinking narration, prompt/template boilerplate and closing tags, blank lines, bulk tool-output bodies, repeated instruction blocks, the middle of long enumerations/tables.\n- Lines that already read \"(filtered N lines)\" are prior compaction markers; treat them as ordinary deletable/keepable lines.\n- Relevance focus: ${parameters.query}. Prefer keeping content related to it, but structural importance outweighs relevance.\n</rules>${promptSuffix}\n\n<numbered-transcript lines="${chunk.start}-${chunk.end}">\n${numberRegionLines(region, chunk.start, chunk.end)}\n</numbered-transcript>`;
}

function responseText(message: AssistantMessage): string {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function providerErrorMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

async function callPlanner(
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	prompt: string,
	streamFn: StreamFn | undefined,
): Promise<AssistantMessage> {
	const context = {
		systemPrompt: RANGE_PLANNER_SYSTEM_PROMPT,
		messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
	};
	const request: SimpleStreamOptions = {
		apiKey,
		headers,
		signal,
		maxTokens: Math.min(model.maxTokens, 32768),
		...(model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
	};
	return streamFn ? await (await streamFn(model, context, request)).result() : await completeSimple(model, context, request);
}

/** Plan untrusted deleted ranges using bounded, range-only completion calls. */
function clampRangesToChunk(ranges: RawLineRange[], chunk: LineChunk): RawLineRange[] {
	const clamped: RawLineRange[] = [];
	for (const range of ranges) {
		let start = Number(range.start);
		let end = Number(range.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		start = Math.trunc(start);
		end = Math.trunc(end);
		if (start > end) [start, end] = [end, start];
		start = Math.max(chunk.start, start);
		end = Math.min(chunk.end, end);
		if (start <= end) clamped.push({ start, end });
	}
	return clamped;
}

export async function planDeletedLineRanges(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
	model: Model<Api>,
	auth: { apiKey: string; headers?: Record<string, string> },
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	promptSuffix = "",
	options: RangePlannerOptions = {},
): Promise<RawLineRange[]> {
	const planned: RawLineRange[] = [];
	let totalAttempts = 0;
	let lastResponse = "";
	for (const chunk of splitRegionChunks(region, model)) {
		let correction = "";
		let accepted: RawLineRange[] | undefined;
		for (let attempt = 1; attempt <= MAX_RANGE_PLAN_ATTEMPTS; attempt++) {
			if (signal?.aborted) throw new Error("Compaction cancelled");
			totalAttempts++;
			let response: AssistantMessage;
			try {
				response = await callPlanner(model, auth.apiKey, auth.headers, signal, thinkingLevel, buildRangePlannerPrompt(region, parameters, chunk, `${promptSuffix}${correction}`), options.streamFn);
			} catch (error) {
				if (signal?.aborted) throw new Error("Compaction cancelled");
				const message = error instanceof Error ? error.message : String(error);
				const overflow = isContextOverflow(providerErrorMessage(model, message), model.contextWindow);
				throw new RangePlanError(message, totalAttempts, lastResponse.slice(0, 500), overflow);
			}
			lastResponse = responseText(response);
			if (response.stopReason === "aborted") throw new Error("Compaction cancelled");
			if (response.stopReason === "error") {
				const overflow = isContextOverflow(response, model.contextWindow);
				throw new RangePlanError(response.errorMessage || "Compaction provider failed", totalAttempts, lastResponse.slice(0, 500), overflow);
			}
			const extracted = extractDeletedRanges(lastResponse);
			const withinChunk = extracted ? clampRangesToChunk(extracted, chunk) : undefined;
			const validated = withinChunk ? validateDeletedRanges(withinChunk, region) : undefined;
			const deleted = validated?.reduce((sum, range) => sum + range.end - range.start + 1, 0) ?? 0;
			if (withinChunk && deleted > 0) {
				accepted = withinChunk;
				const kept = chunk.end - chunk.start + 1 - deleted;
				const fraction = kept / (chunk.end - chunk.start + 1);
				if (fraction <= parameters.compression_ratio + RATIO_DRIFT_TOLERANCE || attempt === MAX_RANGE_PLAN_ATTEMPTS) break;
				const more = Math.max(1, Math.ceil(kept - parameters.compression_ratio * (chunk.end - chunk.start + 1)));
				correction = `\nYou kept ${kept} of ${chunk.end - chunk.start + 1} lines; delete at least ${more} more lines.`;
				continue;
			}
			correction = `\nYour previous reply was not valid. Reply with ONLY {"deleted_ranges":[…]} using 1-based inclusive line numbers between ${chunk.start} and ${chunk.end}.`;
		}
		if (!accepted) throw new RangePlanError("Compaction range planning produced no valid deleted ranges", totalAttempts, lastResponse.slice(0, 500), false);
		planned.push(...accepted);
	}
	return planned;
}
