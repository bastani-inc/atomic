import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("Claude Haiku 5.5 catalog", () => {
	it("publishes Anthropic limits, inputs, and prompt-length pricing", () => {
		const model = getModel("anthropic", "claude-haiku-5-5");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.input).toEqual(["text", "image", "pdf"]);
		expect(model.cost).toEqual({
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
		});
	});

	it("supports adaptive effort and mid-conversation changes without temperature", () => {
		const model = getModel("anthropic", "claude-haiku-5-5");
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(model.compat).toMatchObject({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
		});
	});
});
