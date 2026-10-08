import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("Claude Haiku 5.5 catalog", () => {
	it("publishes Anthropic limits, inputs, and prompt-length pricing", () => {
		const model = getModel("anthropic", "claude-haiku-5-5");
		assert.equal(model.contextWindow, 1_000_000);
		assert.equal(model.maxTokens, 128_000);
		assert.deepEqual(model.input, ["text", "image", "pdf"]);
		assert.deepEqual(model.cost, {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
		});
	});

	it("supports adaptive effort and mid-conversation changes without temperature", () => {
		const model = getModel("anthropic", "claude-haiku-5-5");
		assert.equal(model.reasoning, true);
		assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(model.compat?.forceAdaptiveThinking, true);
		assert.equal(model.compat?.supportsTemperature, false);
		assert.equal(model.compat?.supportsMidConvoEffort, true);
		assert.equal(model.compat?.supportsMidConvoSystemMessages, true);
		assert.equal(model.compat?.supportsMidConvoToolChanges, true);
	});
});
