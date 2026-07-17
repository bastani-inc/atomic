import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { CACHE_REUSE_COLLAPSE_DIRECTIVE } from "../src/core/compaction/collapse-planner.js";
import {
	composeCompactionPayloadHooks,
	createCompactionCachePayloadHook,
	normalizeCompactionCacheTelemetry,
	supportsOpenAIExplicitCacheBreakpoint,
} from "../src/core/compaction/compaction-cache.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { compactionRequestIdentityMatches, type CompactionRequestPrefix, type NumberedRegion } from "../src/core/compaction/compaction-types.js";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { convertToLlm } from "../src/core/messages.js";
import {
	createProviderPayloadFitHook,
	FinalPayloadFitError,
	providerAwarePayloadTokenEstimate,
	ProviderPayloadRetryError,
	type ProviderPayloadTokenCounter,
} from "../src/core/compaction/provider-payload-fit.js";
import { SessionManager } from "../src/core/session-manager.js";

const anthropicModel: Model<Api> = {
	id: "collapse-test", name: "Collapse Test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.com",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
};

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "test", model: "collapse-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp,
	};
}


function buildUsage(partial?: Partial<Usage>): Usage {
	return {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...partial,
	};
}

/** A valid subsequence: keep line 1 plus every protected line, delete the rest. */
function validCollapseOutput(region: NumberedRegion): string {
	const keep = new Set<number>([1, ...(region.protectedLineNumbers ?? [])]);
	return region.lines.filter((_, index) => keep.has(index + 1)).join("\n");
}
function validKeepRecord(region: NumberedRegion): string {
	return `KEEP ${[1, ...(region.protectedLineNumbers ?? [])].sort((left, right) => left - right).join(",")}`;
}

interface Capture {
	context: Context;
	options?: SimpleStreamOptions;
	transportPayload?: unknown;
}

function createCapturingStreamFn(responses: { text: string; usage?: Partial<Usage>; stopReason?: AssistantMessage["stopReason"] }[]): {
	streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessageEventStream>;
	calls: Capture[];
} {
	const calls: Capture[] = [];
	let index = 0;
	const streamFn = async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
		const resp = responses[index % responses.length];
		index++;
		const native = model.api === "openai-responses" || model.api === "openai-codex-responses"
			? nativeOpenAIResponsesPayload(context.messages, options?.sessionId, options?.maxTokens)
			: nativeAnthropicPayload(context.messages, false, options?.maxTokens);
		const transportPayload = await options?.onPayload?.(native, model) ?? native;
		calls.push({ context, options, transportPayload });
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: resp.text }], api: model.api,
			provider: model.provider, model: model.id, usage: buildUsage(resp.usage), stopReason: resp.stopReason ?? "stop", timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return { streamFn, calls };
}

function seedSession(assistantTurns: number): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "kick off the long task\nwith much detail" }], timestamp: 1 });
	for (let i = 0; i < assistantTurns; i++) {
		manager.appendMessage(i % 2 === 0
			? assistant(`step ${i}\nwork line ${i}`, i + 2)
			: { role: "user", content: [{ type: "text", text: `result ${i}\noutput line ${i}` }], timestamp: i + 2 });
	}
	return manager;
}

function prefixFor(manager: SessionManager, extra?: Partial<CompactionRequestPrefix>): CompactionRequestPrefix {
	const messages = convertToLlm(manager.buildSessionContext().messages);
	return {
		identity: { api: anthropicModel.api, provider: anthropicModel.provider, model: anthropicModel.id, baseUrl: anthropicModel.baseUrl, sessionId: "session-abc", transport: "auto" },
		finalPayload: nativeAnthropicPayload(messages, true),
		systemPrompt: "You are the ACTIVE coding agent system prompt.",
		tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }],
		messages,
		sessionId: "session-abc",
		transport: "auto",
		...extra,
	};
}

describe("compaction cache-reuse request shape", () => {
	it("starts with the exact active prefix once and carries only post-prefix context", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const full = prefixFor(manager);
		const prefix = { ...full, messages: full.messages.slice(0, -1), finalPayload: nativeAnthropicPayload(full.messages.slice(0, -1), true) };
		const capture = createCapturingStreamFn([{ text: validKeepRecord(prep.region), usage: { cacheRead: 1200 } }]);
		await runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: capture.streamFn, prefix });

		expect(capture.calls).toHaveLength(1);
		const { context, options } = capture.calls[0];
		expect(context.systemPrompt).toBe(prefix.systemPrompt);
		expect(context.tools).toEqual(prefix.tools);
		expect(context.messages.slice(0, prefix.messages.length)).toEqual(prefix.messages);
		const appended = context.messages.at(-1)!;
		expect(appended.role).toBe("user");
		const text = Array.isArray(appended.content) && appended.content[0].type === "text" ? appended.content[0].text : "";
		expect(text).toContain(CACHE_REUSE_COLLAPSE_DIRECTIVE);
		expect(text).toContain("result 39");
		expect(text).toContain("<cached-message-line-map>");
		expect(text).not.toContain("[User]: kick off the long task");
		expect(options?.sessionId).toBe("session-abc");
		expect(options?.transport).toBe("auto");
		expect(typeof options?.onPayload).toBe("function");
	});

	it("reuses an unmarked Codex prefix exactly once with an empty delta and provider-gated cache telemetry", async () => {
		const codexModel: Model<Api> = {
			...anthropicModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			baseUrl: "https://chatgpt.com/backend-api",
		};
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const historicalPayload = nativeOpenAIResponsesPayload(messages, "stable-cache-key");
		const historicalBytes = JSON.stringify(historicalPayload);
		const prefix: CompactionRequestPrefix = {
			identity: {
				api: codexModel.api, provider: codexModel.provider, model: codexModel.id,
				baseUrl: codexModel.baseUrl, sessionId: "stable-cache-key", transport: "auto",
			},
			finalPayload: historicalPayload,
			messages,
			sessionId: "stable-cache-key",
			transport: "auto",
		};
		const capture = createCapturingStreamFn([{ text: validKeepRecord(prep.region), usage: { cacheRead: 777 } }]);

		const result = await runFullCollapseCompaction(prep, codexModel, "key", undefined, undefined, "off", {
			streamFn: capture.streamFn,
			prefix,
		});

		const payload = capture.calls[0].transportPayload as { input: unknown[]; prompt_cache_key?: string };
		const historical = (historicalPayload as { input: unknown[] }).input;
		expect(JSON.stringify(prefix.finalPayload)).toBe(historicalBytes);
		expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint");
		expect(payload.prompt_cache_key).toBe("stable-cache-key");
		expect(JSON.stringify(payload.input.slice(0, historical.length))).toBe(JSON.stringify(historical));
		expect(payload.input).toHaveLength(historical.length + 1);
		const suffixItem = payload.input.at(-1) as { content: Array<{ text: string }> };
		const suffix = JSON.stringify(suffixItem);
		const suffixText = suffixItem.content[0].text;
		expect(suffix.match(/SYSTEM TASK OVERRIDE/g)).toHaveLength(1);
		expect(suffixText).toContain("<new-context-after-cached-prefix>\n\n</new-context-after-cached-prefix>");
		expect(suffixText).not.toMatch(/\n[0-9]+→/);
		expect(result.cache).toMatchObject({ cacheHit: true, cacheReadTokens: 777, provider: "openai-codex" });
		expect(normalizeCompactionCacheTelemetry(codexModel, buildUsage({ cacheRead: 0, cacheWrite: 777 })).cacheHit).toBe(false);
	});

	it("rejects a warm canonical subsequence that does not use the KEEP protocol", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const prefix = prefixFor(manager);
		const capture = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 1_000 } }]);

		await expect(runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", {
			streamFn: capture.streamFn,
			prefix,
		})).rejects.toThrow("Warm compaction output must be exactly one KEEP record");
	});

	it("reports a cache hit only when provider usage has nonzero cache reads", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const prefix = prefixFor(manager);
		const hit = createCapturingStreamFn([{ text: validKeepRecord(prep.region), usage: { cacheRead: 3210, cacheWrite: 44 } }]);
		const result = await runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: hit.streamFn, prefix });
		expect(result.cache).toBeDefined();
		expect(result.cache?.cacheHit).toBe(true);
		expect(result.cache?.cacheReadTokens).toBe(3210);
		expect(result.cache?.cacheWriteTokens).toBe(44);
		expect(result.cache?.provider).toBe("anthropic");
	});

	it("does not claim a hit on a cache miss (zero cache reads)", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const prefix = prefixFor(manager);
		const miss = createCapturingStreamFn([{ text: validKeepRecord(prep.region), usage: { cacheRead: 0, cacheWrite: 9000 } }]);
		const result = await runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: miss.streamFn, prefix });
		expect(result.cache?.cacheHit).toBe(false);
		expect(result.cache?.cacheReadTokens).toBe(0);
		expect(result.cache?.cacheWriteTokens).toBe(9000);
	});

	it("omits cache telemetry entirely on the legacy isolated request (no prefix)", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const capture = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 5000 } }]);
		const result = await runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: capture.streamFn });
		expect(result.cache).toBeUndefined();
		// Isolated request uses its own compaction system prompt, not an active prefix.
		expect(capture.calls[0].context.messages).toHaveLength(1);
		expect(typeof capture.calls[0].options?.onPayload).toBe("function");
	});

	it("falls back when a cached prefix cannot leave output headroom", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const hugePrefix = prefixFor(manager, { systemPrompt: "z".repeat(100_000) });
		const constrained = { ...anthropicModel, contextWindow: 20_000, maxTokens: 1_000 };
		const capture = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 999 } }]);
		const providerTokenCounter: ProviderPayloadTokenCounter = async (payload) => ({
			tokens: ((payload as { messages?: object[] }).messages?.length ?? 0) > 1 ? 20_000 : 1_000,
			confidence: "exact", source: "test-provider",
		});
		const result = await runFullCollapseCompaction(prep, constrained, "key", undefined, undefined, "off", { streamFn: capture.streamFn, prefix: hugePrefix, providerTokenCounter });
		expect(result.cache).toBeUndefined();
		expect(capture.calls[0].context.messages).toHaveLength(1);
		expect(capture.calls[0].options?.maxTokens).toBeGreaterThan(0);
		expect(capture.calls[0].options?.maxTokens).toBeLessThanOrEqual(1_000);
	});

	it("classifies provider input exhaustion before dispatch", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const capture = createCapturingStreamFn([{ text: validCollapseOutput(prep.region) }]);
		const capped = { ...anthropicModel, maxInputTokens: 50 };
		const providerTokenCounter: ProviderPayloadTokenCounter = async () => ({ tokens: 51, confidence: "exact", source: "test-provider" });
		let error: import("../src/core/compaction/range-planner.js").RangePlanError | undefined;
		try { await runFullCollapseCompaction(prep, capped, "key", undefined, undefined, "off", { streamFn: capture.streamFn, providerTokenCounter }); }
		catch (caught) { if (caught instanceof Error && caught.name === "RangePlanError") error = caught as import("../src/core/compaction/range-planner.js").RangePlanError; else throw caught; }
		expect(error?.message).toContain("input exhausted the provider budget");
		expect(error?.providerOverflow).toBe(false);
		expect(capture.calls).toHaveLength(0);
	});

	it("diagnoses output exhaustion separately from input overflow", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const capture = createCapturingStreamFn([{ text: "partial retained line", stopReason: "length", usage: { output: 1_000 } }]);
		await expect(runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: capture.streamFn })).rejects.toThrow("output reached its");
		expect(capture.calls).toHaveLength(1);
	});

	it("bounds output at the independently counted remaining total-context boundary", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const inputTokens = 10_000;
		const providerTokenCounter: ProviderPayloadTokenCounter = async () => ({ tokens: inputTokens, confidence: "exact", source: "test-provider" });
		const justFits = { ...anthropicModel, contextWindow: inputTokens + 500, maxTokens: 1_000 };
		const fit = createCapturingStreamFn([{ text: validCollapseOutput(prep.region) }]);
		await runFullCollapseCompaction(prep, justFits, "key", undefined, undefined, "off", { streamFn: fit.streamFn, providerTokenCounter });
		expect((fit.calls[0].transportPayload as { max_tokens: number }).max_tokens).toBe(500);

		const noHeadroom = { ...justFits, contextWindow: inputTokens };
		const rejected = createCapturingStreamFn([{ text: validCollapseOutput(prep.region) }]);
		await expect(runFullCollapseCompaction(prep, noHeadroom, "key", undefined, undefined, "off", { streamFn: rejected.streamFn, providerTokenCounter })).rejects.toThrow("input exhausted");
		expect(rejected.calls).toHaveLength(0);
	});
});

function nativeAnthropicPayload(messages: Context["messages"], marked = false, maxTokens?: number): Record<string, unknown> {
	return { messages: messages.map((message, index) => {
		const text = Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text" ? message.content[0].text : "";
		return { role: message.role, content: [{ type: "text", text,
			...(marked && index === messages.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) }] };
	}), ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}) };
}
function nativeOpenAIResponsesPayload(messages: Context["messages"], sessionId?: string, maxTokens?: number): Record<string, unknown> {
	return {
		input: messages.map((message) => ({
			role: message.role,
			content: [{
				type: message.role === "user" ? "input_text" : "output_text",
				text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
			}],
		})),
		...(sessionId !== undefined ? { prompt_cache_key: sessionId } : {}),
		...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
	};
}
function anthropicPayload(): Record<string, unknown> {
	return {
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "read", cache_control: { type: "ephemeral" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "old-1" }] },
			{ role: "assistant", content: [{ type: "text", text: "old-2" }] },
			{ role: "user", content: [{ type: "text", text: "appended instruction", cache_control: { type: "ephemeral" } }] },
		],
	};
}

describe("compaction cache provider-shape hook", () => {
	it("adds an explicit cache_control breakpoint on the final old Anthropic block", () => {
		const hook = createCompactionCachePayloadHook(anthropicModel)!;
		expect(hook).toBeDefined();
		const payload = anthropicPayload();
		hook(payload, anthropicModel);
		const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
		// Final old-conversation block (assistant "old-2") now carries the breakpoint.
		expect(messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
		// The appended instruction breakpoint is untouched.
		expect(messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("respects the four-breakpoint Anthropic limit", () => {
		const hook = createCompactionCachePayloadHook(anthropicModel)!;
		const payload = anthropicPayload();
		// Already at 4: system + tool + a mid block + instruction.
		(payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[0].cache_control = { type: "ephemeral" };
		hook(payload, anthropicModel);
		// No new breakpoint added to the final old (assistant) block.
		expect((payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[1].content[0].cache_control).toBeUndefined();
	});

	it("marks prompt_cache_breakpoint on GPT-5.6+ Responses payloads", () => {
		const model: Model<Api> = { ...anthropicModel, api: "openai-responses", provider: "openai", id: "gpt-5.6" };
		const hook = createCompactionCachePayloadHook(model)!;
		expect(hook).toBeDefined();
		const payload: Record<string, unknown> = {
			input: [
				{ role: "user", content: [{ type: "input_text", text: "old" }] },
				{ role: "user", content: [{ type: "input_text", text: "instruction" }] },
			],
		};
		hook(payload, model);
		const input = payload.input as Array<{ content: Array<Record<string, unknown>> }>;
		expect(input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
		expect(input[1].content[0].prompt_cache_breakpoint).toBeUndefined();
	});

	it("never marks a non-cacheable OpenAI block type", () => {
		const model: Model<Api> = { ...anthropicModel, api: "openai-responses", provider: "openai", id: "gpt-5.6" };
		const hook = createCompactionCachePayloadHook(model)!;
		const payload: Record<string, unknown> = {
			input: [
				{ role: "assistant", content: [{ type: "reasoning", text: "old" }] },
				{ role: "user", content: [{ type: "input_text", text: "instruction" }] },
			],
		};
		hook(payload, model);
		const input = payload.input as Array<{ content: Array<Record<string, unknown>> }>;
		expect(input[0].content[0].prompt_cache_breakpoint).toBeUndefined();
	});

	it("falls back to automatic caching for older OpenAI models and custom providers", () => {
		const older: Model<Api> = { ...anthropicModel, api: "openai-responses", provider: "openai", id: "gpt-5.5" };
		expect(supportsOpenAIExplicitCacheBreakpoint(older)).toBe(false);
		expect(createCompactionCachePayloadHook(older)).toBeUndefined();
		const custom: Model<Api> = { ...anthropicModel, api: "custom-thing", provider: "acme" };
		expect(createCompactionCachePayloadHook(custom)).toBeUndefined();
	});
});

describe("normalizeCompactionCacheTelemetry", () => {
	it("gates the hit flag on nonzero cache-read usage and truncates negatives", () => {
		const model = { provider: "anthropic", id: "claude" };
		expect(normalizeCompactionCacheTelemetry(model, buildUsage({ cacheRead: 10, cacheWrite: 2 }))).toEqual({
			cacheReadTokens: 10, cacheWriteTokens: 2, cacheHit: true, provider: "anthropic", model: "claude",
		});
		expect(normalizeCompactionCacheTelemetry(model, buildUsage({ cacheRead: 0, cacheWrite: 5 })).cacheHit).toBe(false);
		expect(normalizeCompactionCacheTelemetry(model, undefined)).toEqual({
			cacheReadTokens: 0, cacheWriteTokens: 0, cacheHit: false, provider: "anthropic", model: "claude",
		});
	});

	it("composes originating hooks that return undefined before cache shaping", async () => {
		const cache = createCompactionCachePayloadHook(anthropicModel)!;
		for (const mutate of [false, true]) {
			const originating = (payload: unknown): undefined => {
				if (mutate) (payload as Record<string, unknown>).transformed = true;
				return undefined;
			};
			const composed = composeCompactionPayloadHooks(originating, cache)!;
			const payload = anthropicPayload();
			const result = await composed(payload, anthropicModel) as Record<string, unknown>;
			expect(result).toBe(payload);
			expect(result.transformed).toBe(mutate ? true : undefined);
			const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
			expect(messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
		}
	});
});

describe("final provider payload fit and identity", () => {
	it("preserves provider-fit diagnostics on the public error instance", () => {
		const error = new FinalPayloadFitError(101, 100, 200);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "FinalPayloadFitError", inputUpperBound: 101, inputBudget: 100, contextWindow: 200, failure: "input_headroom",
		});
	});

	it("reuses the captured provider-native prefix byte-semantically and appends the suffix once", async () => {
		const prior = anthropicPayload();
		const prefix = prefixFor(seedSession(4), { finalPayload: prior });
		const candidate = anthropicPayload();
		(candidate.messages as unknown[]).push({ role: "user", content: [{ type: "text", text: "fresh-suffix" }] });
		const state = { maxTokens: 0, inputUpperBound: 0, finalPayloadProven: false };
		const result = await createProviderPayloadFitHook(anthropicModel, 100, state, prefix)(candidate) as Record<string, unknown>;
		const messages = result.messages as unknown[];
		expect(messages.slice(0, (prior.messages as unknown[]).length)).toEqual(prior.messages);
		expect(JSON.stringify(messages).split("fresh-suffix")).toHaveLength(2);
		expect(state.finalPayloadProven).toBe(true);
	});

	it("invalidates reuse independently across provider, model, API, and base URL", () => {
		const identity = prefixFor(seedSession(4)).identity;
		expect(compactionRequestIdentityMatches(identity, anthropicModel)).toBe(true);
		for (const changed of [
			{ ...anthropicModel, provider: "other" }, { ...anthropicModel, id: "other" },
			{ ...anthropicModel, api: "openai-responses" as Api }, { ...anthropicModel, baseUrl: "https://other.example" },
		]) expect(compactionRequestIdentityMatches(identity, changed)).toBe(false);
	});

	it("uses injected provider counts for exact input/output boundaries instead of serialized bytes", async () => {
		const payload = { input: [{ role: "user", content: [{ type: "input_text", text: "🔥漢字".repeat(150_000) }] }], max_output_tokens: 100 };
		expect(JSON.stringify(payload).length).toBeGreaterThan(372_000);
		const exactCount = 81_000;
		const counter: ProviderPayloadTokenCounter = async () => ({ tokens: exactCount, confidence: "exact", source: "test-provider" });
		const base: Model<Api> = { ...anthropicModel, api: "openai-responses", provider: "openai", id: "gpt-5.6", contextWindow: exactCount + 16, maxInputTokens: exactCount, maxTokens: 100 };
		const state = { maxTokens: 0, inputTokens: 0, countConfidence: "unavailable" as const, finalPayloadProven: false };
		await expect(createProviderPayloadFitHook(base, 100, state, undefined, counter)(structuredClone(payload))).resolves.toBeDefined();
		expect(state).toMatchObject({ maxTokens: 16, inputTokens: exactCount, countConfidence: "exact", finalPayloadProven: true });
		for (const testCase of [
			{ label: "remaining context 15", model: { ...base, contextWindow: exactCount + 15 }, desired: 100, failure: "input_headroom" },
			{ label: "max input -1", model: { ...base, maxInputTokens: exactCount - 1 }, desired: 100, failure: "input_headroom" },
			{ label: "reserve 15", model: base, desired: 15, failure: "output_budget" },
			{ label: "model max 15", model: { ...base, maxTokens: 15 }, desired: 100, failure: "output_budget" },
		] as const) {
			let caught: FinalPayloadFitError | undefined;
			try { await createProviderPayloadFitHook(testCase.model, testCase.desired, { ...state }, undefined, counter)(structuredClone(payload)); }
			catch (error) { if (error instanceof FinalPayloadFitError) caught = error; else throw error; }
			expect(caught?.failure, testCase.label).toBe(testCase.failure);
			expect(caught?.requestMaxTokens, testCase.label).toBeGreaterThanOrEqual(0);
		}
	});

	it("uses an explicit uncertain provider-aware heuristic without bytes-as-token hard rejection", async () => {
		const cyclic: Record<string, object | string> = { text: "é🔥漢字".repeat(100_000) };
		cyclic.self = cyclic;
		const estimate = await providerAwarePayloadTokenEstimate(cyclic, anthropicModel);
		expect(estimate.confidence).toBe("unavailable");
		const state = { maxTokens: 0, inputTokens: 0, countConfidence: "unavailable" as const, finalPayloadProven: false };
		await expect(createProviderPayloadFitHook({ ...anthropicModel, contextWindow: 100 }, 16, state)(cyclic)).resolves.toBe(cyclic);
		expect(state.finalPayloadProven).toBe(true);
		expect(state.maxTokens).toBe(16);
	});

	it("suppresses an identical rejected final provider payload before transport", async () => {
		const payload = { messages: [{ role: "user", content: [{ type: "text", text: "same" }] }], max_tokens: 16 };
		const firstState = { maxTokens: 0, finalPayloadProven: false };
		await createProviderPayloadFitHook(anthropicModel, 16, firstState)(structuredClone(payload));
		const guard = {
			rejectedTransportFingerprints: new Set([firstState.payloadFingerprint!]),
			rejectedInputFingerprints: new Set([firstState.inputFingerprint!]),
			strictlySmallerThanInputBytes: firstState.inputBytes,
		};
		await expect(createProviderPayloadFitHook(anthropicModel, 16, { maxTokens: 0, finalPayloadProven: false }, undefined, undefined, guard)(structuredClone(payload)))
			.rejects.toBeInstanceOf(ProviderPayloadRetryError);
	});
});
