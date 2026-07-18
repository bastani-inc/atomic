import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { CompactionRequestPrefix } from "../src/core/compaction/compaction-types.ts";
import {
	capturedProviderMessageOffset,
	cloneJsonWire,
	restoreCapturedProviderPrefix,
} from "../src/core/compaction/provider-payload-restoration.ts";

const baseModel: Model<Api> = {
	id: "gpt-5.6-sol", name: "Restoration", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://example.test", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const hostMessages: Message[] = [
	{ role: "user", content: [{ type: "text", text: "old user" }], timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "old assistant" }], timestamp: 2 },
];

function responsesItems(messages = hostMessages): Array<Record<string, unknown>> {
	return messages.map((message) => ({
		role: message.role,
		content: [{
			type: message.role === "user" ? "input_text" : "output_text",
			text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
		}],
	}));
}

function prefix(finalPayload: unknown, extra: Partial<CompactionRequestPrefix> = {}): CompactionRequestPrefix {
	return {
		identity: { api: baseModel.api, provider: baseModel.provider, model: baseModel.id, baseUrl: baseModel.baseUrl },
		messages: hostMessages,
		finalPayload,
		...extra,
	};
}

function suffix(type: "input_text" | "text" = "input_text"): Record<string, unknown> {
	return { role: "user", content: [{ type, text: "SYSTEM TASK OVERRIDE suffix" }] };
}

describe("complete captured provider-prefix restoration", () => {
	it("restores a complete installed Codex Responses body and changes only output plus one suffix", () => {
		const captured = {
			model: "gpt-5.6-sol", store: false, stream: true, instructions: "captured instructions",
			input: responsesItems(), text: { verbosity: "low" }, include: ["reasoning.encrypted_content"],
			prompt_cache_key: "stable-routing", tool_choice: "auto", parallel_tool_calls: true,
			tools: [{ type: "function", name: "read", parameters: { type: "object" }, strict: null }],
			reasoning: { effort: "high", summary: "auto" }, max_output_tokens: 8_192,
		};
		const candidate = {
			...captured, instructions: "candidate drift", tools: [{ name: "changed" }], text: { verbosity: "high" },
			reasoning: { effort: "low" }, prompt_cache_key: "changed-routing",
			input: [...responsesItems(), suffix()], max_output_tokens: 1_000,
		};
		const restored = restoreCapturedProviderPrefix(candidate, prefix(captured), baseModel);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		expect(restored.payload).toMatchObject({
			instructions: captured.instructions, tools: captured.tools, text: captured.text,
			reasoning: captured.reasoning, prompt_cache_key: captured.prompt_cache_key, max_output_tokens: 1_000,
		});
		expect((restored.payload.input as unknown[]).slice(0, 2)).toEqual(captured.input);
		expect(restored.payload.input).toHaveLength(3);
		expect(JSON.stringify(restored.payload)).not.toContain("prompt_cache_breakpoint");
	});

	it("recognizes exactly one public Responses system/developer item and preserves its marker", () => {
		const openAI = { ...baseModel, api: "openai-responses", provider: "openai", id: "gpt-5.6" } as Model<Api>;
		const leading = { role: "developer", content: "public system" };
		const historical = responsesItems();
		((historical[1].content as Array<Record<string, unknown>>)[0]).prompt_cache_breakpoint = { mode: "explicit" };
		const captured = { model: openAI.id, input: [leading, ...historical], stream: true, max_output_tokens: 8_192 };
		const publicPrefix = prefix(captured, { systemPrompt: "public system" });
		expect(capturedProviderMessageOffset(publicPrefix, openAI)).toBe(1);
		const restored = restoreCapturedProviderPrefix({ ...captured, input: [leading, ...responsesItems(), suffix()], max_output_tokens: 500 }, publicPrefix, openAI);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		expect((restored.payload.input as unknown[])[0]).toEqual(leading);
		expect(JSON.stringify((restored.payload.input as unknown[])[2])).toContain("prompt_cache_breakpoint");
		expect(restored.payload.input).toHaveLength(4);
	});

	it.each([3, 4])("keeps %s captured Anthropic breakpoints and never exceeds four after suffix shaping", (breakpoints) => {
		const anthropic = { ...baseModel, api: "anthropic-messages", provider: "anthropic", id: "claude" } as Model<Api>;
		const captured = {
			model: "claude", system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "read", input_schema: {}, ...(breakpoints >= 2 ? { cache_control: { type: "ephemeral" } } : {}) }],
			thinking: { type: "enabled", budget_tokens: 2_048 }, output_config: { effort: "high" },
			messages: [
				{ role: "user", content: [{ type: "text", text: "old user", ...(breakpoints >= 3 ? { cache_control: { type: "ephemeral" } } : {}) }] },
				{ role: "assistant", content: [{ type: "text", text: "old assistant", ...(breakpoints >= 4 ? { cache_control: { type: "ephemeral" } } : {}) }] },
			], max_tokens: 8_192,
		};
		const nextSuffix = suffix("text");
		((nextSuffix.content as Array<Record<string, unknown>>)[0]).cache_control = { type: "ephemeral" };
		const restored = restoreCapturedProviderPrefix({ ...captured, messages: [
			{ role: "user", content: [{ type: "text", text: "old user" }] },
			{ role: "assistant", content: [{ type: "text", text: "old assistant" }] },
			nextSuffix,
		] }, prefix(captured), anthropic);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		const markerCount = JSON.stringify(restored.payload).split('"cache_control"').length - 1;
		expect(markerCount).toBe(4);
		expect(restored.payload.system).toEqual(captured.system);
		expect(restored.payload.tools).toEqual(captured.tools);
		expect(restored.payload.thinking).toEqual(captured.thinking);
	});

	it("deliberately supports a simple OpenAI Chat body with one known leading system item", () => {
		const chat = { ...baseModel, api: "openai-completions", provider: "openai", id: "gpt-5.5" } as Model<Api>;
		const captured = { model: chat.id, messages: [
			{ role: "system", content: "chat system" },
			{ role: "user", content: [{ type: "text", text: "old user" }] },
			{ role: "assistant", content: "old assistant" },
		], tools: [{ type: "function", function: { name: "read" } }], max_completion_tokens: 8_192 };
		const chatPrefix = prefix(captured, { systemPrompt: "chat system" });
		expect(capturedProviderMessageOffset(chatPrefix, chat)).toBe(1);
		const restored = restoreCapturedProviderPrefix({ ...captured, messages: [...captured.messages, suffix("text")], max_completion_tokens: 700 }, chatPrefix, chat);
		expect(restored.ok).toBe(true);
		if (restored.ok) expect(restored.payload).toMatchObject({ tools: captured.tools, max_completion_tokens: 700 });
	});

	it.each([
		["missing sequence", { max_output_tokens: 100 }],
		["wrong length", { input: responsesItems(), max_output_tokens: 100 }],
		["changed text", { input: [{ role: "user", content: [{ type: "input_text", text: "changed" }] }, responsesItems()[1], suffix()] }],
		["changed role", { input: [{ ...responsesItems()[0], role: "assistant" }, responsesItems()[1], suffix()] }],
		["non-isolatable suffix", { input: [...responsesItems(), { role: "assistant", content: [{ type: "output_text", text: "bad" }] }] }],
		["extra leading item", { input: [{ role: "developer", content: "extra" }, ...responsesItems(), suffix()] }],
		["media", { input: [...responsesItems(), { role: "user", content: [{ type: "input_image", image_url: "data:x" }] }] }],
	])("declines %s before warm transport", (_label, candidate) => {
		const captured = { input: responsesItems(), max_output_tokens: 8_192 };
		expect(restoreCapturedProviderPrefix(candidate, prefix(captured), baseModel).ok).toBe(false);
	});

	it("uses capture-compatible JSON wire semantics for sparse, undefined, and nonfinite values", () => {
		const sparse = ["a", , undefined, Number.POSITIVE_INFINITY];
		expect(cloneJsonWire({ omitted: undefined, sparse, nonfinite: Number.NaN })).toEqual({
			sparse: ["a", null, null, null], nonfinite: null,
		});
		expect(() => cloneJsonWire(new Map())).toThrow("custom prototype");
	});
});
