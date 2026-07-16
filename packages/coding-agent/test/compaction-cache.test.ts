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
	createCompactionCachePayloadHook,
	normalizeCompactionCacheTelemetry,
	supportsOpenAIExplicitCacheBreakpoint,
} from "../src/core/compaction/compaction-cache.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import type { CompactionRequestPrefix, NumberedRegion } from "../src/core/compaction/compaction-types.js";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { convertToLlm } from "../src/core/messages.js";
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

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tc-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
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

interface Capture {
	context: Context;
	options?: SimpleStreamOptions;
}

function createCapturingStreamFn(responses: { text: string; usage?: Partial<Usage> }[]): {
	streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	calls: Capture[];
} {
	const calls: Capture[] = [];
	let index = 0;
	const streamFn = (_model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const resp = responses[index % responses.length];
		index++;
		calls.push({ context, options });
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: resp.text }], api: "anthropic-messages",
			provider: "anthropic", model: "collapse-test", usage: buildUsage(resp.usage), stopReason: "stop", timestamp: Date.now(),
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
		manager.appendMessage(i % 2 === 0 ? assistant(`step ${i}\nwork line ${i}`, i + 2) : toolResult(`result ${i}\noutput line ${i}`, i + 2));
	}
	return manager;
}

function prefixFor(manager: SessionManager, extra?: Partial<CompactionRequestPrefix>): CompactionRequestPrefix {
	return {
		systemPrompt: "You are the ACTIVE coding agent system prompt.",
		tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }],
		messages: convertToLlm(manager.buildSessionContext().messages),
		sessionId: "session-abc",
		transport: "auto",
		...extra,
	};
}

describe("compaction cache-reuse request shape", () => {
	it("starts with the exact active prefix and appends the instruction after it", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const prefix = prefixFor(manager);
		const capture = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 1200 } }]);

		await runFullCollapseCompaction(prep, anthropicModel, "key", undefined, undefined, "off", { streamFn: capture.streamFn, prefix });

		expect(capture.calls).toHaveLength(1);
		const { context, options } = capture.calls[0];
		// System + tools are the active prefix, byte-identical.
		expect(context.systemPrompt).toBe(prefix.systemPrompt);
		expect(context.tools).toEqual(prefix.tools);
		// Messages = exact prefix messages + one appended instruction.
		expect(context.messages).toHaveLength(prefix.messages.length + 1);
		expect(context.messages.slice(0, -1)).toEqual(prefix.messages);
		const appended = context.messages[context.messages.length - 1];
		expect(appended.role).toBe("user");
		const text = Array.isArray(appended.content) && appended.content[0].type === "text" ? appended.content[0].text : "";
		expect(text).toContain(CACHE_REUSE_COLLAPSE_DIRECTIVE);
		expect(text).toContain("1→"); // numbered transcript embedded AFTER the breakpoint
		// Cache routing matches the active request; provider breakpoint hook is attached.
		expect(options?.sessionId).toBe("session-abc");
		expect(options?.transport).toBe("auto");
		expect(typeof options?.onPayload).toBe("function");
	});

	it("reports a cache hit only when provider usage has nonzero cache reads", async () => {
		const manager = seedSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const prefix = prefixFor(manager);
		const hit = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 3210, cacheWrite: 44 } }]);
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
		const miss = createCapturingStreamFn([{ text: validCollapseOutput(prep.region), usage: { cacheRead: 0, cacheWrite: 9000 } }]);
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
		expect(capture.calls[0].options?.onPayload).toBeUndefined();
	});
});

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
});
