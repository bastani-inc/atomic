import assert from "node:assert/strict";
import { test } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { builtinModels, builtinProviders } from "../src/providers/all.js";
import { isModelType } from "../src/utils/model-operations.js";

test("registers Morph as a compactor without exposing it as a chat model (#3470)", () => {
	const models = builtinModels();
	const model = models.getAllModels("morph").find((entry) => entry.id === "morph-compactor");
	assert.ok(model);
	assert.equal(model.type, "compactor");
	assert.ok(isModelType(model, "compactor"));
	assert.deepEqual(models.getModels("morph"), []);
	assert.equal(models.getModel("morph", "morph-compactor"), undefined);
});

test("resolves Morph environment credentials and offers API-key login (#3470)", async () => {
	const provider = builtinProviders().find((entry) => entry.id === "morph");
	assert.ok(provider?.auth.apiKey);
	const signal = new AbortController().signal;
	const resolved = await provider.auth.apiKey.resolve({
		ctx: {
			env: async (name) => (name === "MORPH_API_KEY" ? "morph-test-key" : undefined),
			fileExists: async () => false,
		},
		signal,
	});
	assert.equal(resolved?.auth.apiKey, "morph-test-key");
	assert.ok(provider.auth.apiKey.login);
	const credential = await provider.auth.apiKey.login({
		signal,
		prompt: async () => "stored-morph-key",
		notify: () => {},
	});
	assert.deepEqual(credential, { type: "api_key", key: "stored-morph-key" });
	const previous = process.env.MORPH_API_KEY;
	try {
		process.env.MORPH_API_KEY = "env-morph-key";
		assert.equal(getEnvApiKey("morph"), "env-morph-key");
	} finally {
		if (previous === undefined) delete process.env.MORPH_API_KEY;
		else process.env.MORPH_API_KEY = previous;
	}
});
