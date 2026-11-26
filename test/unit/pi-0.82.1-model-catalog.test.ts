import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";

describe("Pi 0.82.1 generated catalogs through Atomic", () => {
	test("exposes Claude Opus 5 adaptive xhigh metadata when published by Anthropic", async ({ skip }) => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		const anthropic = runtime.getModel("anthropic", "claude-opus-5");
		if (!anthropic) return skip("claude-opus-5 is not in the generated Anthropic catalog");
		assert.equal(anthropic.reasoning, true);
		assert.equal(anthropic.thinkingLevelMap?.xhigh, "xhigh");
		assert.equal(
			anthropic.compat && "forceAdaptiveThinking" in anthropic.compat
				? anthropic.compat.forceAdaptiveThinking
				: undefined,
			true,
		);
		assert.equal(
			anthropic.compat && "supportsTemperature" in anthropic.compat
				? anthropic.compat.supportsTemperature
				: undefined,
			false,
		);
		assert.equal(
			anthropic.compat && "supportsStrictTools" in anthropic.compat
				? anthropic.compat.supportsStrictTools
				: undefined,
			true,
		);
	});

	test.for(["au", "eu", "global", "jp", "us"])(
		"exposes Claude Opus 5 adaptive xhigh metadata for the Bedrock %s profile when published",
		async (region, { skip }) => {
			const runtime = await ModelRuntime.create({ modelsPath: null });
			const id = `${region}.anthropic.claude-opus-5`;
			const bedrock = runtime.getModel("amazon-bedrock", id);
			if (!bedrock) return skip(`${id} is not in the generated Bedrock catalog`);
			assert.equal(bedrock.api, "bedrock-converse-stream");
			assert.equal(bedrock.reasoning, true);
			assert.equal(bedrock.thinkingLevelMap?.xhigh, "xhigh");
		},
	);
});
