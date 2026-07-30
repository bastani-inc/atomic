import assert from "node:assert/strict";
import { builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import { describe, test } from "vitest";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";

function requiredModel(runtime: ModelRuntime, provider: string, id: string) {
	const model = runtime.getModel(provider, id);
	assert.ok(model, `missing ${provider}/${id}`);
	return model;
}

describe("Pi 0.82.1 generated catalogs through Atomic", () => {
	test("exposes Claude Opus 5 adaptive xhigh metadata", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		const anthropic = requiredModel(runtime, "anthropic", "claude-opus-5");
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

		for (const region of ["au", "eu", "global", "jp", "us"]) {
			const bedrock = requiredModel(runtime, "amazon-bedrock", `${region}.anthropic.claude-opus-5`);
			assert.equal(bedrock.api, "bedrock-converse-stream");
			assert.equal(bedrock.reasoning, true);
			assert.equal(bedrock.thinkingLevelMap?.xhigh, "xhigh");
		}
	});

	test("exposes the refreshed generated image catalog from the upgraded dependency", () => {
		const ids = builtinImagesModels()
			.getModels()
			.map((model) => model.id);
		assert.ok(ids.includes("black-forest-labs/flux.2-flex"));
		assert.ok(ids.includes("bytedance-seed/seedream-4.5"));
	});
});
