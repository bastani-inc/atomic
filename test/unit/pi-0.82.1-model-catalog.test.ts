import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";

function requiredModel(registry: ModelRegistry, provider: string, id: string) {
	const model = registry.find(provider, id);
	assert.ok(model, `missing ${provider}/${id}`);
	return model;
}

describe("Pi 0.82.1 generated catalogs through Atomic", () => {
	test("exposes Claude Opus 5 adaptive xhigh metadata", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const anthropic = requiredModel(registry, "anthropic", "claude-opus-5");
		assert.equal(anthropic.reasoning, true);
		assert.equal(anthropic.thinkingLevelMap?.xhigh, "xhigh");
		assert.equal(anthropic.compat && "forceAdaptiveThinking" in anthropic.compat ? anthropic.compat.forceAdaptiveThinking : undefined, true);
		assert.equal(anthropic.compat && "supportsTemperature" in anthropic.compat ? anthropic.compat.supportsTemperature : undefined, false);
		assert.equal(anthropic.compat && "supportsStrictTools" in anthropic.compat ? anthropic.compat.supportsStrictTools : undefined, true);

		for (const region of ["au", "eu", "global", "jp", "us"]) {
			const bedrock = requiredModel(registry, "amazon-bedrock", `${region}.anthropic.claude-opus-5`);
			assert.equal(bedrock.api, "bedrock-converse-stream");
			assert.equal(bedrock.reasoning, true);
			assert.equal(bedrock.thinkingLevelMap?.xhigh, "xhigh");
		}
	});

	test("exposes the refreshed generated image catalog from the upgraded dependency", () => {
		const ids = builtinImagesModels().getModels().map((model) => model.id);
		assert.ok(ids.includes("black-forest-labs/flux.2-flex"));
		assert.ok(ids.includes("bytedance-seed/seedream-4.5"));
	});
});
