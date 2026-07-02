import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { synthesizeCopilotCatalogModels } from "../src/core/copilot-model-synthesis.ts";
import type { CopilotModelContext } from "../src/core/copilot-model-catalog.ts";

const template = {
	baseUrl: "https://api.enterprise.githubcopilot.com",
	headers: { "User-Agent": "test-agent" },
};

function chatEntry(overrides: Partial<CopilotModelContext> = {}): CopilotModelContext {
	return {
		contextWindow: 128_000,
		displayName: "Fixture Model",
		supportedEndpoints: ["/responses"],
		supports: { reasoningEffort: true, toolCalls: true },
		limits: { maxPromptTokens: 128_000, maxOutputTokens: 64_000, maxContextWindowTokens: 192_000 },
		modelPickerEnabled: true,
		policyState: "enabled",
		type: "chat",
		...overrides,
	};
}

describe("synthesizeCopilotCatalogModels", () => {
	test("maps endpoints and capability metadata without model-name special cases", () => {
		const catalog = new Map<string, CopilotModelContext>([
			[
				"claude-sonnet-5",
				chatEntry({
					displayName: "Claude Sonnet 5",
					contextWindow: 200_000,
					contextWindowOptions: [200_000, 1_000_000],
					maxInputTokens: 936_000,
					supportedEndpoints: ["/v1/messages", "/chat/completions"],
					supports: { adaptiveThinking: true, reasoningEffort: true, vision: true, toolCalls: true },
					limits: { maxPromptTokens: 936_000, maxOutputTokens: 64_000, maxContextWindowTokens: 1_000_000 },
				}),
			],
			[
				"mai-code-1-flash-picker",
				chatEntry({
					displayName: "MAI-Code-1-Flash",
					contextWindow: 128_000,
					maxInputTokens: 128_000,
					supportedEndpoints: ["/responses"],
					supports: { reasoningEffort: true, toolCalls: true },
					limits: { maxPromptTokens: 128_000, maxOutputTokens: 128_000, maxContextWindowTokens: 256_000 },
				}),
			],
		]);

		const models = synthesizeCopilotCatalogModels(catalog, new Set(), template);
		const claude = models.find((model) => model.id === "claude-sonnet-5");
		const mai = models.find((model) => model.id === "mai-code-1-flash-picker");

		assert.equal(claude?.api, "anthropic-messages");
		assert.deepEqual(claude?.input, ["text", "image"]);
		assert.equal(claude?.reasoning, true);
		assert.deepEqual(claude?.compat, { forceAdaptiveThinking: true });
		assert.deepEqual(claude?.thinkingLevelMap, { minimal: "low", xhigh: "max" });
		assert.equal(claude?.contextWindow, 200_000);
		assert.deepEqual(claude?.contextWindowOptions, [200_000, 1_000_000]);
		assert.equal(claude?.maxInputTokens, 936_000);
		assert.equal(claude?.maxTokens, 64_000);
		assert.deepEqual(claude?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		assert.equal(mai?.api, "openai-responses");
		assert.deepEqual(mai?.input, ["text"]);
		assert.equal(mai?.reasoning, true);
		assert.equal(mai?.maxTokens, 128_000);
	});

	test("gates out non-picker, non-chat, disabled, unmapped, namespaced, and duplicate entries", () => {
		const catalog = new Map<string, CopilotModelContext>([
			["plain-good", chatEntry()],
			["exec-agent-a", chatEntry({ modelPickerEnabled: false })],
			["chamomile", chatEntry({ modelPickerEnabled: false })],
			["gpt-4o-2024-11-20", chatEntry({ modelPickerEnabled: false })],
			["text-embedding-3-small", chatEntry({ type: "embeddings" })],
			["disabled-model", chatEntry({ policyState: "disabled" })],
			["endpointless-model", chatEntry({ supportedEndpoints: [] })],
			["octodemo/Octodemo_Foundry/DeepSeek-V3.2", chatEntry({ displayName: "DeepSeek-V3.2" })],
			["builtin-wins", chatEntry()],
		]);

		const models = synthesizeCopilotCatalogModels(catalog, new Set(["builtin-wins"]), template);
		assert.deepEqual(models.map((model) => model.id), ["plain-good"]);
	});

	test("prefers CAPI endpoints in deterministic API order", () => {
		const models = synthesizeCopilotCatalogModels(
			new Map([
				["messages", chatEntry({ supportedEndpoints: ["/responses", "/v1/messages"] })],
				["responses", chatEntry({ supportedEndpoints: ["/chat/completions", "/responses"] })],
				["completions", chatEntry({ supportedEndpoints: ["/chat/completions"] })],
			]),
			new Set(),
			template,
		);
		assert.deepEqual(
			models.map((model) => [model.id, model.api]),
			[
				["messages", "anthropic-messages"],
				["responses", "openai-responses"],
				["completions", "openai-completions"],
			],
		);
	});
});
