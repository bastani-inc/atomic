import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { CompactionRequestPrefix, NumberedRegion, VerbatimCompactionParameters } from "../src/core/compaction/compaction-types.js";
import { planFullCollapse } from "../src/core/compaction/collapse-planner.js";
import { RangePlanError } from "../src/core/compaction/range-planner.js";
import { createNumberedRegion, serializeConversationForCompaction } from "../src/core/compaction/transcript-serialization.js";
import type { CompactionDiagnostic } from "../src/core/compaction/range-planner-diagnostics.js";

const model: Model<Api> = {
	id: "retry-evidence", name: "Retry evidence", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://example.com", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000, maxInputTokens: 9_000, maxTokens: 1_000,
};
const parameters: VerbatimCompactionParameters = { compression_ratio: 0.5, preserve_recent: 0, query: "retry" };

function region(): NumberedRegion {
	return createNumberedRegion(Array.from({ length: 80 }, (_, index) => `source-${index + 1}-${"x".repeat(40)}`).join("\n"), new Set([79, 80]));
}

function validOutput(source: NumberedRegion): string {
	return source.lines.filter((_, index) => index === 0 || source.protectedLineNumbers?.has(index + 1)).join("\n");
}

function response(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
}

function completed(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}


function prefixRegion(): { source: NumberedRegion; prefix: CompactionRequestPrefix } {
	const text = Array.from({ length: 80 }, (_, index) => `source-${index + 1}-${"w".repeat(40)}`).join("\n");
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }];
	const source = createNumberedRegion(serializeConversationForCompaction(messages), new Set([79, 80]));
	return { source, prefix: {
		identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "retry" },
		messages, systemPrompt: "active", sessionId: "retry",
		finalPayload: { messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }] },
	} };
}

function nativePayload(context: Context, options?: SimpleStreamOptions): Record<string, unknown> {
	return {
		messages: context.messages.map((message) => ({ role: message.role, content: structuredClone(message.content) })),
		max_tokens: options?.maxTokens,
	};
}

function providerError(message: string): AssistantMessage {
	return { ...response(""), stopReason: "error", errorMessage: message };
}

function lengthResponse(text: string): AssistantMessage {
	return { ...response(text), stopReason: "length" };
}

async function plan(source: NumberedRegion, streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => unknown) {
	return planFullCollapse(source, parameters, model, { apiKey: "key" }, undefined, "off", 1_000, 40, { streamFn: streamFn as never });
}

async function captureRangeError(run: Promise<unknown>): Promise<RangePlanError | undefined> {
	try { await run; } catch (error) { if (error instanceof RangePlanError) return error; throw error; }
	return undefined;
}

describe("full-collapse retry evidence", () => {
	it("records a thrown provider overflow before suppressing an identical later transport", async () => {
		const source = region();
		let entered = 0;
		let transported = 0;
		const fixedPayload = { messages: [{ role: "user", content: "identical transport" }], max_tokens: 1_000 };
		const error = await captureRangeError(plan(source, async (_requestModel, _context, options) => {
			entered++;
			await options?.onPayload?.(structuredClone(fixedPayload), model);
			transported++;
			if (transported === 1) throw new Error("context_length_exceeded");
			return completed(response(validOutput(source)));
		}));
		expect(error).toMatchObject({ providerOverflow: true, attempts: 2 });
		expect(error?.message).toContain("context_length_exceeded");
		expect(entered).toBe(2);
		expect(transported).toBe(1);
	});

	it("fails closed with the original thrown overflow when final payload evidence is incomplete", async () => {
		const source = region();
		let entered = 0;
		const error = await captureRangeError(plan(source, async () => {
			entered++;
			if (entered === 1) throw new Error("context_length_exceeded without finalized payload");
			return completed(response(validOutput(source)));
		}));
		expect(error).toMatchObject({ providerOverflow: true, attempts: 1 });
		expect(error?.message).toContain("without finalized payload");
		expect(entered).toBe(1);
	});

	it.each(["direct", "adapter"] as const)("skips a %s retry-guard block and reaches the smaller elided projection", async (mode) => {
		const { source, prefix } = prefixRegion();
		const projections: string[] = [];
		const transported: string[] = [];
		let rejectedPayload: unknown;
		const result = planFullCollapse(source, parameters, model, { apiKey: "key" }, undefined, "off", 1_000, 40, {
			prefix,
			streamFn: (async (_requestModel, context, options) => {
				const label = JSON.stringify(context).includes("SYSTEM TASK OVERRIDE") ? "warm"
					: JSON.stringify(context).includes("omitted-unprotected-lines") ? "elided" : "full";
				projections.push(label);
				const candidate = label === "full" ? structuredClone(rejectedPayload) : nativePayload(context, options);
				try {
					const payload = await options?.onPayload?.(candidate, model) ?? candidate;
					transported.push(label);
					if (label === "warm") { rejectedPayload = payload; return completed(providerError("context_length_exceeded warm")); }
					return completed(response(validOutput(source)));
				} catch (error) {
					if (mode === "direct") throw error;
					return completed(providerError("adapter resolved retry guard"));
				}
			}) as never,
		});
		await expect(result).resolves.toBeDefined();
		expect(projections).toEqual(["warm", "full", "elided"]);
		expect(transported).toEqual(["warm", "elided"]);
	});

	it("preserves the real overflow after all later projections are locally blocked", async () => {
		const { source, prefix } = prefixRegion();
		let rejectedPayload: unknown;
		let entered = 0;
		let transported = 0;
		const error = await captureRangeError(planFullCollapse(source, parameters, model, { apiKey: "key" }, undefined, "off", 1_000, 40, {
			prefix,
			streamFn: (async (_requestModel, context, options) => {
				entered++;
				const candidate = entered === 1 ? nativePayload(context, options) : structuredClone(rejectedPayload);
				const payload = await options?.onPayload?.(candidate, model) ?? candidate;
				transported++;
				rejectedPayload ??= payload;
				return completed(providerError("context_length_exceeded original overflow"));
			}) as never,
		}));
		expect(error).toMatchObject({ providerOverflow: true, attempts: 3, lastResponseExcerpt: "" });
		expect(error?.message).toContain("original overflow");
		expect(entered).toBe(3);
		expect(transported).toBe(1);
	});

	it("reports an eligible length origin with terminal attempt count and exact sidecar fields", async () => {
		const source = region();
		const dir = mkdtempSync(join(tmpdir(), "compaction-retry-origin-"));
		const raw = "complete invalid line\nunterminated exact tail";
		let firstPayload: unknown;
		let entered = 0;
		try {
			const error = await captureRangeError(planFullCollapse(source, parameters, { ...model, maxInputTokens: 10_000 }, { apiKey: "key" }, undefined, "off", 1_000, 40, {
				sessionFilePath: join(dir, "session.jsonl"),
				providerTokenCounter: async () => ({ tokens: 9_500, confidence: "exact", source: "test" }),
				streamFn: (async (_requestModel, context, options) => {
					entered++;
					const candidate = entered === 1 ? nativePayload(context, options) : structuredClone(firstPayload);
					const payload = await options?.onPayload?.(candidate, model) ?? candidate;
					firstPayload ??= payload;
					return completed(lengthResponse(raw));
				}) as never,
			}));
			expect(error).toMatchObject({ providerOverflow: false, attempts: 2, lastResponseExcerpt: raw });
			expect(error?.message).toContain("500-token limit");
			const diagnostic = JSON.parse(readFileSync(error!.diagnosticPath!, "utf8")) as CompactionDiagnostic;
			expect(diagnostic).toMatchObject({ failureCategory: "output_limit", rawResponse: raw, requestMaxTokens: 500 });
			expect(entered).toBe(2);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("lets a later real overflow supersede an earlier eligible length origin", async () => {
		const { source, prefix } = prefixRegion();
		const lengthRaw = "earlier length\nunterminated";
		const smaller = { messages: [{ role: "user", content: [{ type: "text", text: "smaller" }] }], max_tokens: 500 };
		let entered = 0;
		const error = await captureRangeError(planFullCollapse(source, parameters, { ...model, maxInputTokens: 10_000 }, { apiKey: "key" }, undefined, "off", 1_000, 40, {
			prefix,
			providerTokenCounter: async () => ({ tokens: 9_500, confidence: "exact", source: "test" }),
			streamFn: (async (_requestModel, context, options) => {
				entered++;
				const candidate = entered === 1 ? nativePayload(context, options) : structuredClone(smaller);
				await options?.onPayload?.(candidate, model);
				if (entered === 1) return completed(lengthResponse(lengthRaw));
				return completed(providerError("context_length_exceeded later overflow"));
			}) as never,
		}));
		expect(error).toMatchObject({ providerOverflow: true, attempts: 3, lastResponseExcerpt: "" });
		expect(error?.message).toContain("later overflow");
		expect(error?.message).not.toContain("500-token limit");
		expect(entered).toBe(3);
	});


	it("keeps explicitly numbered later duplicate and blank occurrences in the warm KEEP protocol", async () => {
		const text = "header\nduplicate\n\nduplicate\n\nfinal";
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }];
		const source = createNumberedRegion(serializeConversationForCompaction(messages), new Set([4, 5, 6]));
		const prefix: CompactionRequestPrefix = {
			identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "keep" },
			messages, sessionId: "keep",
			finalPayload: { messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }] },
		};
		const result = await planFullCollapse(source, parameters, model, { apiKey: "key" }, undefined, "off", 1_000, 3, {
			prefix, streamFn: (() => completed(response("KEEP 1,4-6"))) as never,
		});
		expect([...result.ranges]).toEqual([{ start: 2, end: 3 }]);
	});

	it("rejects KEEP indices that select equal earlier duplicate and blank occurrences instead of protected ones", async () => {
		const text = "header\nduplicate\n\nduplicate\n\nfinal";
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }];
		const source = createNumberedRegion(serializeConversationForCompaction(messages), new Set([4, 5, 6]));
		const prefix: CompactionRequestPrefix = {
			identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "keep-wrong" },
			messages, sessionId: "keep-wrong",
			finalPayload: { messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }] },
		};
		const error = await captureRangeError(planFullCollapse(source, parameters, model, { apiKey: "key" }, undefined, "off", 1_000, 3, {
			prefix, streamFn: (() => completed(response("KEEP 1-3,6"))) as never,
		}));
		expect(error?.message).toContain("dropped protected line 4");
	});

});
