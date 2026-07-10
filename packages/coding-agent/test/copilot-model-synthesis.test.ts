import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai/compat";
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
		supports: { reasoningEffort: true, reasoningEffortLevels: ["low", "medium", "high"], toolCalls: true },
		limits: { maxPromptTokens: 128_000, maxOutputTokens: 64_000, maxContextWindowTokens: 192_000 },
		modelPickerEnabled: true,
		policyState: "enabled",
		type: "chat",
		...overrides,
	};
}

function supportedThinkingLevels(model: Model<Api> | undefined): readonly string[] {
	return model ? getSupportedThinkingLevels(model) : [];
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
					supports: { adaptiveThinking: true, reasoningEffort: true, reasoningEffortLevels: ["low", "medium", "high", "xhigh", "max"], minThinkingBudget: true, maxThinkingBudget: true, vision: true, toolCalls: true },
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
					supports: { reasoningEffort: true, reasoningEffortLevels: ["low", "medium", "high"], toolCalls: true },
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
		assert.deepEqual(supportedThinkingLevels(claude), ["off", "low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(claude?.thinkingLevelMap?.xhigh, "xhigh");
		assert.deepEqual(claude?.thinkingLevelMap?.max, "max");
		assert.equal(claude?.contextWindow, 200_000);
		assert.deepEqual(claude?.contextWindowOptions, [200_000, 1_000_000]);
		assert.equal(claude?.maxInputTokens, 936_000);
		assert.equal(claude?.maxTokens, 64_000);
		assert.deepEqual(claude?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		assert.equal(mai?.api, "openai-responses");
		assert.deepEqual(mai?.input, ["text"]);
		assert.equal(mai?.reasoning, true);
		assert.deepEqual(supportedThinkingLevels(mai), ["low", "medium", "high"]);
		assert.equal(mai?.maxTokens, 128_000);
	});

	test("copies known pricing for dynamic OpenAI-family catalog models", () => {
		const cost = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }] };
		const models = synthesizeCopilotCatalogModels(new Map([["gpt-5.6-sol", chatEntry({ displayName: "GPT-5.6 Sol" })]]), new Set(), { ...template, costById: new Map([["gpt-5.6-sol", cost]]) });
		const synthesized = models.find((model) => model.id === "gpt-5.6-sol");
		assert.deepEqual(synthesized?.cost, cost);
		assert.notEqual(synthesized?.cost, cost);
		assert.notEqual(synthesized?.cost.tiers, cost.tiers);
	});

	test("gates selectable thinking levels by advertised CAPI reasoning_effort arrays", () => {
		const models = synthesizeCopilotCatalogModels(
			new Map([
				["gpt-5.5-style", chatEntry({ supports: { reasoningEffort: true, reasoningEffortLevels: ["none", "low", "medium", "high", "xhigh"] } })],
				["gemini-3.5-flash-style", chatEntry({ supports: { reasoningEffort: true, reasoningEffortLevels: ["minimal", "low", "medium", "high"] } })],
				["claude-opus-4.6-style", chatEntry({ supportedEndpoints: ["/v1/messages"], supports: { adaptiveThinking: true, reasoningEffort: true, reasoningEffortLevels: ["low", "medium", "high", "max"] } })],
			]),
			new Set(),
			template,
		);

		assert.deepEqual(supportedThinkingLevels(models.find((model) => model.id === "gpt-5.5-style")), ["off", "low", "medium", "high", "xhigh"]);
		assert.deepEqual(supportedThinkingLevels(models.find((model) => model.id === "gemini-3.5-flash-style")), ["minimal", "low", "medium", "high"]);
		const adaptiveMax = models.find((model) => model.id === "claude-opus-4.6-style");
		assert.deepEqual(supportedThinkingLevels(adaptiveMax), ["off", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(adaptiveMax?.thinkingLevelMap?.xhigh, "max");
		assert.equal(adaptiveMax?.thinkingLevelMap?.max, "max");
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
