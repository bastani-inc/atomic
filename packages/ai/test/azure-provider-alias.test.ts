import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";
import { azureProvider } from "../src/providers/azure.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "../src/providers/azure-openai-responses.models.ts";
import { azureOpenAIResponsesProvider } from "../src/providers/azure-openai-responses.ts";
import type { StreamOptions } from "../src/types.ts";

test("legacy Azure provider references resolve to the canonical catalog and credentials", async () => {
	const model = getModel("azure-openai-responses", "gpt-4o-mini");
	assert.equal(model.provider, "azure");
	assert.equal(model.api, "azure-openai-responses");
	assert.equal(azureOpenAIResponsesProvider().id, "azure");
	assert.equal(AZURE_OPENAI_RESPONSES_MODELS["gpt-4o-mini"]?.provider, "azure");
	assert.ok(getModels("azure-openai-responses").every((entry) => entry.provider === "azure"));
	const env = { AZURE_OPENAI_API_KEY: "legacy-key" };
	assert.equal(getEnvApiKey("azure-openai-responses", env), "legacy-key");
	assert.deepEqual(findEnvKeys("azure-openai-responses", env), ["AZURE_OPENAI_API_KEY"]);
	const models = builtinModels({
		authContext: {
			env: async (name) => (name === "AZURE_OPENAI_API_KEY" ? env.AZURE_OPENAI_API_KEY : undefined),
			fileExists: async () => false,
		},
	});
	assert.equal(models.getProvider("azure-openai-responses")?.id, "azure");
	assert.equal(models.getModel("azure-openai-responses", model.id)?.provider, "azure");
	assert.equal((await models.getAuth("azure-openai-responses"))?.auth.apiKey, "legacy-key");
	assert.ok(await models.checkAuth("azure-openai-responses"));
	assert.ok((await models.getAvailable("azure-openai-responses")).length > 0);
});

test("Azure credentials retain legacy stored keys without overriding canonical credentials", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("azure-openai-responses", async () => ({ type: "api_key", key: "old-key" }));
	const models = builtinModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	assert.equal((await models.getAuth("azure"))?.auth.apiKey, "old-key");
	assert.ok(await models.checkAuth("azure-openai-responses"));
	await credentials.modify("azure", async () => ({ type: "api_key", key: "canonical-key" }));
	assert.equal((await models.getAuth("azure-openai-responses"))?.auth.apiKey, "canonical-key");
});

test("legacy Azure model objects stream with canonical identity without mutating callers", async () => {
	const models = builtinModels({
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const model = Object.freeze({ ...getModel("azure", "deepseek-v4-pro"), provider: "azure-openai-responses" });
	const original = structuredClone(model);
	let requests = 0;
	const options: StreamOptions = {
		apiKey: "test-key",
		env: { AZURE_OPENAI_BASE_URL: "https://resource.services.ai.azure.com" },
		maxRetries: 0,
		fetch: async () => {
			requests++;
			return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	};
	for (const simple of [false, true]) {
		const stream = simple
			? models.streamSimple(model, { messages: [] }, options)
			: models.stream(model, { messages: [] }, options);
		for await (const event of stream) {
			assert.equal(
				event.type === "error"
					? event.error.provider
					: event.type === "done"
						? event.message.provider
						: event.partial.provider,
				"azure",
			);
		}
		const result = await stream.result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.provider, "azure");
		assert.deepEqual(model, original);
	}
	assert.equal(requests, 2);
});

for (const providerId of ["azure", "azure-openai-responses"]) {
	test(`logout ${providerId} clears canonical and legacy Azure credentials`, async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("azure", async () => ({ type: "api_key", key: "canonical-key" }));
		await credentials.modify("azure-openai-responses", async () => ({ type: "api_key", key: "legacy-key" }));
		const models = builtinModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		assert.ok(await models.checkAuth("azure"));
		assert.ok(await models.checkAuth("azure-openai-responses"));
		await models.logout(providerId);
		assert.equal(await credentials.read("azure"), undefined);
		assert.equal(await credentials.read("azure-openai-responses"), undefined);
		assert.equal(await models.checkAuth("azure"), undefined);
		assert.equal(await models.checkAuth("azure-openai-responses"), undefined);
		assert.equal(await models.getAuth("azure"), undefined);
		assert.equal(await models.getAuth("azure-openai-responses"), undefined);
	});
}

test("legacy Azure login resolves the canonical provider and stores canonical credentials", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const azure = azureProvider();
	models.setProvider({
		...azure,
		auth: {
			...azure.auth,
			apiKey: {
				...azure.auth.apiKey!,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "key" }),
				}),
			},
		},
	});
	const credential = await models.login("azure-openai-responses", "api_key", {
		prompt: async () => "login-key",
		notify: () => {},
	});
	assert.deepEqual(credential, { type: "api_key", key: "login-key" });
	assert.deepEqual(await credentials.read("azure"), credential);
	assert.equal(await credentials.read("azure-openai-responses"), undefined);
	assert.equal((await models.getAuth("azure-openai-responses"))?.auth.apiKey, "login-key");
});

test("legacy native Azure registrations share canonical lookup, auth and removal identity", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("azure-openai-responses", async () => ({ type: "api_key", key: "legacy-key" }));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const azure = azureProvider();
	const deployment = { ...getModel("azure", "deepseek-v4-pro"), id: "deployment", provider: "azure-openai-responses" };
	models.setProvider({ ...azure, id: "azure-openai-responses", getModels: () => [deployment] });
	for (const id of ["azure", "azure-openai-responses"]) {
		assert.equal(models.getProvider(id)?.id, "azure");
		assert.equal(models.getModel(id, "deployment")?.provider, "azure");
		assert.equal((await models.getAuth(id))?.auth.apiKey, "legacy-key");
		assert.equal((await models.getAvailable(id))[0]?.id, "deployment");
	}
	assert.equal(deployment.provider, "azure-openai-responses");
	models.setProvider(azure);
	assert.equal(models.getProviders().length, 1);
	models.deleteProvider("azure-openai-responses");
	assert.equal(models.getProviders().length, 0);
});
