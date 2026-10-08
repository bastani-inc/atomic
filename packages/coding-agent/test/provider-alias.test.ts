import assert from "node:assert/strict";
import { type Api, InMemoryCredentialStore, type Model } from "@bastani/pi-ai";
import { test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { collectOAuthProviderMetadata } from "../src/core/oauth-provider-metadata.js";

async function runtimeWithAccounts() {
	const credentials = new InMemoryCredentialStore();
	for (const id of ["openai", "openai-1", "openai-2"]) {
		await credentials.modify(id, async () => ({
			type: "oauth",
			access: `fake-token-${id}`,
			refresh: `fake-refresh-${id}`,
			expires: Date.now() + 3_600_000,
		}));
	}
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider("openai-1", { aliasOf: "openai", name: "OpenAI account 1" });
	runtime.registerProvider("openai-2", { aliasOf: "openai", name: "OpenAI account 2" });
	return { runtime, credentials };
}

test("OpenAI account aliases isolate credentials and inherit ChatGPT request handling (#3400)", async () => {
	const { runtime, credentials } = await runtimeWithAccounts();
	assert.equal((await runtime.getAuth("openai-1"))?.auth.apiKey, "fake-token-openai-1");
	assert.equal((await runtime.getAuth("openai-2"))?.auth.apiKey, "fake-token-openai-2");
	assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "fake-token-openai");
	const model = runtime.getModel("openai-1", "gpt-6.1-sol-fast");
	assert.ok(model);
	let payload: Record<string, object | string | number | boolean | undefined> | undefined;
	let callbackModel: Model<Api> | undefined;
	const result = await runtime
		.streamSimple(
			model,
			{ messages: [] },
			{
				maxTokens: 128,
				temperature: 0.2,
				cacheRetention: "long",
				onPayload: (value, current) => {
					payload = value as typeof payload;
					callbackModel = current;
					throw new Error("offline capture");
				},
			},
		)
		.result();
	assert.ok(payload);
	assert.equal(payload.max_output_tokens, undefined);
	assert.equal(payload.temperature, undefined);
	assert.equal(payload.prompt_cache_retention, undefined);
	assert.equal(payload.prompt_cache_options, undefined);
	assert.equal(payload.model, "gpt-6.1-sol");
	assert.equal(payload.service_tier, "priority");
	assert.equal(callbackModel?.provider, "openai-1");
	assert.equal(result.provider, "openai-1");
	assert.equal(result.model, "gpt-6.1-sol-fast");
	assert.equal(result.errorMessage, "offline capture");
	await credentials.delete("openai-1");
	assert.equal(await runtime.getAuth("openai-1"), undefined);
	assert.equal((await runtime.getAuth("openai-2"))?.auth.apiKey, "fake-token-openai-2");
});

test("account aliases preserve browser callback metadata and live source models", async () => {
	const { runtime } = await runtimeWithAccounts();
	const alias = runtime.getProvider("openai-1");
	assert.ok(alias);
	const [metadata] = collectOAuthProviderMetadata([alias], new Map());
	assert.equal(metadata.id, "openai-1");
	assert.equal(metadata.name, "OpenAI account 1");
	assert.equal(metadata.usesCallbackServer, true);
	assert.equal(metadata.isSubscription, true);
	const source = runtime.getProvider("openai");
	assert.ok(source);
	const model = source.getModels()[0];
	runtime.registerProvider("openai", {
		models: [{ ...model, id: "new-model", name: "New model" }],
	});
	assert.ok(runtime.getModel("openai-1", "new-model"));
	assert.equal(runtime.getModel("openai-1", "gpt-6.1-sol"), undefined);
	runtime.unregisterProvider("openai-1");
	assert.equal(runtime.getProvider("openai-1"), undefined);
	assert.ok(runtime.getProvider("openai-2"));
});

test("alias registrations survive transactional reload without changing credentials", async () => {
	const { runtime } = await runtimeWithAccounts();
	const transaction = runtime.createExtensionProviderTransaction(["openai-1", "openai-2"]);
	transaction.registerProvider("openai-1", { aliasOf: "openai", name: "Reloaded account" });
	await transaction.commit();
	assert.ok(runtime.getModel("openai-1", "gpt-6.1-sol"));
	assert.equal(runtime.getProvider("openai-1")?.name, "Reloaded account");
	assert.equal(runtime.getProvider("openai-2"), undefined);
	assert.equal((await runtime.getAuth("openai-1"))?.auth.apiKey, "fake-token-openai-1");
});

test("aliases reject missing sources, alias chains, and source replacement without changing registrations", async () => {
	const { runtime } = await runtimeWithAccounts();
	assert.throws(() => runtime.registerProvider("missing", { aliasOf: "not-installed" }), /unavailable/);
	assert.throws(() => runtime.registerProvider("cycle", { aliasOf: "cycle" }), /distinct/);
	assert.throws(() => runtime.registerProvider("nested", { aliasOf: "openai-1" }), /not another alias/);
	assert.throws(() => runtime.registerProvider("openai", { aliasOf: "anthropic" }), /cannot replace/);
	assert.throws(
		() => runtime.registerProvider("openai-1", { aliasOf: "openai", apiKey: "unwanted" }),
		/only aliasOf and name/,
	);
	assert.equal(runtime.getProvider("missing"), undefined);
	assert.equal(runtime.getProvider("nested"), undefined);
	assert.equal(runtime.getProvider("openai-1")?.name, "OpenAI account 1");
	assert.equal((await runtime.getAuth("openai-1"))?.auth.apiKey, "fake-token-openai-1");
});

test("API-key aliases never borrow the source's configured key", async () => {
	const { runtime, credentials } = await runtimeWithAccounts();
	runtime.registerProvider("openai", { apiKey: "source-configured-key" });
	await credentials.delete("openai-1");
	assert.equal(await runtime.getAuth("openai-1"), undefined);
	await credentials.modify("openai-1", async () => ({ type: "api_key", key: "" }));
	assert.equal(await runtime.getAuth("openai-1"), undefined);
	await credentials.modify("openai-1", async () => ({ type: "api_key", key: "sk-alias-key" }));
	assert.equal((await runtime.getAuth("openai-1"))?.auth.apiKey, "sk-alias-key");
	const model = runtime.getModel("openai-1", "gpt-6.1-sol");
	assert.ok(model);
	let maxOutputTokens: number | undefined;
	await runtime
		.streamSimple(
			model,
			{ messages: [] },
			{
				maxTokens: 128,
				onPayload: (payload) => {
					maxOutputTokens = (payload as { max_output_tokens?: number }).max_output_tokens;
					throw new Error("offline capture");
				},
			},
		)
		.result();
	assert.equal(maxOutputTokens, 128);
});

test("OAuth refresh rotates only the selected alias credential", async () => {
	const { runtime, credentials } = await runtimeWithAccounts();
	const source = runtime.getProvider("openai");
	assert.ok(source?.auth.oauth);
	const refreshed: string[] = [];
	runtime.registerNativeProvider({
		...source,
		auth: {
			oauth: {
				...source.auth.oauth,
				refresh: async (credential) => {
					refreshed.push(credential.access);
					return { ...credential, access: "refreshed-alias-token", expires: Date.now() + 3_600_000 };
				},
			},
		},
	});
	await credentials.modify("openai-1", async () => ({
		type: "oauth",
		access: "expired-alias-token",
		refresh: "fake-refresh",
		expires: 0,
	}));
	assert.equal((await runtime.getAuth("openai-1"))?.auth.apiKey, "refreshed-alias-token");
	assert.deepEqual(refreshed, ["expired-alias-token"]);
	assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "fake-token-openai");
	assert.equal((await runtime.getAuth("openai-2"))?.auth.apiKey, "fake-token-openai-2");
});

test("an alias of a login-less shared-credential provider prompts for its own API key", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-api", async () => ({ type: "api_key", key: "sk-shared" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider("decisions-work", { aliasOf: "openai-decisions", name: "Decisions (work)" });

	const aliasAuth = runtime.getProvider("decisions-work")?.auth.apiKey;
	assert.ok(aliasAuth?.login);
	assert.equal(aliasAuth.borrowCredentialsFrom, undefined);
	assert.equal(await runtime.getAuth("decisions-work"), undefined);

	const prompts: string[] = [];
	const credential = await aliasAuth.login({
		signal: new AbortController().signal,
		prompt: async (prompt) => {
			prompts.push(prompt.message);
			return "sk-work";
		},
		notify: () => {},
	});
	assert.deepEqual(credential, { type: "api_key", key: "sk-work" });
	assert.equal(prompts.length, 1);
});
