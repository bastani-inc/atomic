import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ApiKeyAuth, AuthContext, Credential } from "../src/auth/types.ts";
import { createModels, type Provider } from "../src/models.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function chatModel(provider: string): Model<Api> {
	return {
		id: "model-a",
		name: "model-a",
		api: "test-api",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

function ambientEnv(env: Record<string, string | undefined>): AuthContext {
	return { env: async (name) => env[name], fileExists: async () => false };
}

function keyAuth(borrowCredentialsFrom?: readonly string[]): ApiKeyAuth {
	return {
		name: "Test API key",
		borrowCredentialsFrom,
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			const value = await ctx.env("TEST_API_KEY");
			return value ? { auth: { apiKey: value }, source: "TEST_API_KEY" } : undefined;
		},
	};
}

function provider(id: string, apiKey: ApiKeyAuth, refreshed?: (credential: Credential | undefined) => void): Provider {
	const models = [chatModel(id)];
	return {
		id,
		name: id,
		auth: { apiKey },
		getModels: () => models,
		refreshModels: refreshed ? async ({ credential }) => refreshed(credential) : undefined,
		stream: (model, _context, options) => respond(model, options),
		streamSimple: (model, _context, options) => respond(model, options),
	};
}

const requests: Array<string | undefined> = [];

function respond(model: Model<Api>, options: StreamOptions | undefined) {
	requests.push(options?.apiKey);
	const stream = new AssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

async function storeApiKey(credentials: InMemoryCredentialStore, providerId: string, key: string | undefined) {
	await credentials.modify(providerId, async () => ({ type: "api_key", key }));
}

async function storeOAuth(credentials: InMemoryCredentialStore, providerId: string) {
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		access: "oauth-access",
		refresh: "oauth-refresh",
		expires: Date.now() + 3_600_000,
	}));
}

function setup(env: Record<string, string | undefined> = {}) {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials, authContext: ambientEnv(env) });
	models.setProvider(provider("lender-a", keyAuth()));
	models.setProvider(provider("lender-b", keyAuth()));
	models.setProvider(provider("borrower", keyAuth(["lender-a", "lender-b"])));
	models.setProvider(provider("bystander", keyAuth()));
	return { credentials, models };
}

describe("borrowed provider credentials", () => {
	it("uses the first listed provider's stored API key when the provider has none of its own", async () => {
		const { credentials, models } = setup();
		await storeApiKey(credentials, "lender-b", "key-b");
		assert.equal((await models.getAuth("borrower"))?.auth.apiKey, "key-b");

		await storeApiKey(credentials, "lender-a", "key-a");
		const resolution = await models.getAuth("borrower");
		assert.equal(resolution?.auth.apiKey, "key-a");
		assert.equal(resolution?.source, "stored credential");
		assert.deepEqual(await models.checkAuth("borrower"), { source: "stored credential", type: "api_key" });
		assert.deepEqual(
			(await models.getAvailable("borrower")).map((model) => model.provider),
			["borrower"],
		);
		assert.deepEqual(
			(await models.getAllAvailable()).map((model) => model.provider),
			["lender-a", "lender-b", "borrower"],
		);
	});

	it("ignores a credential stored under the borrowing provider and lets explicit request keys win", async () => {
		const { credentials, models } = setup({ TEST_API_KEY: "env-key" });
		await storeApiKey(credentials, "lender-a", "key-a");
		await storeApiKey(credentials, "borrower", "own-key");
		assert.equal((await models.getAuth("borrower"))?.auth.apiKey, "key-a");
		assert.equal((await models.getAuth("borrower", { apiKey: "explicit-key" }))?.auth.apiKey, "explicit-key");

		await credentials.delete("lender-a");
		assert.equal((await models.getAuth("borrower"))?.auth.apiKey, "env-key");
	});

	it("skips OAuth credentials and key-less API credentials, then falls back to ambient auth", async () => {
		const { credentials, models } = setup({ TEST_API_KEY: "env-key" });
		await storeOAuth(credentials, "lender-a");
		await storeApiKey(credentials, "lender-b", undefined);
		const resolution = await models.getAuth("borrower");
		assert.equal(resolution?.auth.apiKey, "env-key");
		assert.equal(resolution?.source, "TEST_API_KEY");

		await storeApiKey(credentials, "lender-b", "key-b");
		assert.equal((await models.getAuth("borrower"))?.auth.apiKey, "key-b");
	});

	it("is unavailable when only unusable credentials and no ambient auth exist", async () => {
		const { credentials, models } = setup();
		await storeOAuth(credentials, "lender-a");
		await storeApiKey(credentials, "lender-b", "");
		assert.equal(await models.getAuth("borrower"), undefined);
		assert.equal(await models.checkAuth("borrower"), undefined);
		assert.deepEqual(await models.getAvailable("borrower"), []);
	});

	it("lends nothing to providers that do not declare it", async () => {
		const { credentials, models } = setup();
		await storeApiKey(credentials, "lender-a", "key-a");
		assert.equal(await models.getAuth("bystander"), undefined);
		assert.equal(await models.checkAuth("bystander"), undefined);
	});

	it("reads borrowed credentials by normalized provider id", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials, authContext: ambientEnv({}) });
		models.setProvider(provider("azure", keyAuth()));
		models.setProvider(provider("borrower", keyAuth(["azure-openai-responses"])));
		await storeApiKey(credentials, "azure", "azure-key");
		assert.equal((await models.getAuth("borrower"))?.auth.apiKey, "azure-key");
	});

	it("sends the borrowed key with requests", async () => {
		const { credentials, models } = setup();
		await storeApiKey(credentials, "lender-b", "key-b");
		requests.length = 0;
		await models.complete(chatModel("borrower"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		assert.deepEqual(requests, ["key-b"]);
	});

	it("shows the borrowed credential to model refresh", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials, authContext: ambientEnv({}) });
		const seen: Array<Credential | undefined> = [];
		models.setProvider(provider("lender-a", keyAuth()));
		models.setProvider(provider("borrower", keyAuth(["lender-a"]), (credential) => seen.push(credential)));
		await storeApiKey(credentials, "lender-a", "key-a");
		await models.refresh();
		assert.equal(seen.length, 2);
		for (const credential of seen) assert.equal(credential?.type === "api_key" ? credential.key : undefined, "key-a");
	});
});
