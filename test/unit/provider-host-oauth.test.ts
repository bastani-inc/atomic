import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { ProviderModelSelectionError } from "../../packages/coding-agent/src/core/provider-model-reference.js";
import { validateCursorHostOAuthCredential } from "../../packages/cursor/src/account-scope.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

const future = Date.now() + 60_000;
const credential = (access: string): OAuthCredentials => ({ access, refresh: `${access}-refresh`, expires: future });
const liveModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "live",
	name: "Live",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function config(discover: () => Promise<NonNullable<ProviderConfigInput["models"]>>): ProviderConfigInput {
	return {
		name: "Required OAuth",
		baseUrl: "https://example.invalid",
		api: "openai-completions",
		models: [],
		requiresPreparation: true,
		requiresHostOAuth: true,
		refreshModels: discover,
		oauth: {
			name: "Required OAuth",
			login: async () => credential("login"),
			refreshToken: async (value) => value,
			getApiKey: (value) => value.access,
		},
	};
}

describe("host OAuth-only required providers", () => {
	test("request auth ignores runtime and environment API keys", async () => {
		const auth = AuthStorage.inMemory({ cursor: { type: "oauth", ...credential("stored-oauth") } });
		const registry = ModelRegistry.create(auth, []);
		registry.registerProvider("cursor", config(async () => [liveModel]));
		await registry.prepareRequiredProviders();
		const model = registry.resolveExactModel("cursor", "live");
		auth.setRuntimeApiKey("cursor", "forbidden-runtime");
		const previous = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "forbidden-environment";
		try {
			const resolved = await registry.getApiKeyAndHeaders(model);
			assert.equal(resolved.ok, true);
			if (resolved.ok) assert.equal(resolved.apiKey, "stored-oauth");
		} finally {
			if (previous === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previous;
		}
	});

	test("logout and replacement discovery failure clear prior authoritative routes", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("account-a") } });
		const registry = ModelRegistry.create(auth, []);
		let failDiscovery = false;
		registry.registerProvider("required", config(async () => {
			if (failDiscovery) throw new Error("replacement discovery failed");
			return [liveModel];
		}));
		await registry.prepareRequiredProviders();
		assert.equal(registry.resolveExactModel("required", "live").id, "live");

		auth.remove("required");
		await assert.rejects(() => registry.prepareRequiredProviders(), /AuthenticationMissing/u);
		assert.throws(() => registry.resolveExactModel("required", "live"));

		auth.set("required", { type: "oauth", ...credential("account-b") });
		failDiscovery = true;
		await assert.rejects(() => registry.prepareRequiredProviders(), /replacement discovery failed/u);
		assert.throws(() => registry.resolveExactModel("required", "live"));
	});

	test("rejects expired partial OAuth before host refresh or discovery", async () => {
		for (const malformed of [
			{ type: "oauth", refresh: "only-refresh", expires: 0 },
			{ type: "oauth", access: "only-access", expires: 0 },
		]) {
			const auth = AuthStorage.inMemory({ required: malformed as never });
			const registry = ModelRegistry.create(auth, []);
			let refreshes = 0;
			let discoveries = 0;
			const provider = config(async () => { discoveries += 1; return [liveModel]; });
			provider.validateHostOAuth = (value) => validateCursorHostOAuthCredential(value as never, Number.NEGATIVE_INFINITY);
			provider.oauth = { ...provider.oauth!, refreshToken: async () => { refreshes += 1; return credential("replacement"); } };
			registry.registerProvider("required", provider);
			await assert.rejects(registry.prepareRequiredProviders(), (error: Error) =>
				error instanceof CursorError && error.code === "AuthenticationMalformed");
			assert.equal(refreshes, 0);
			assert.equal(discoveries, 0);
		}
	});

	test("valid expired OAuth still refreshes after shape validation", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", access: "expired", refresh: "expired-refresh", expires: 0 } });
		const registry = ModelRegistry.create(auth, []);
		let refreshes = 0;
		let discoveries = 0;
		const provider = config(async () => { discoveries += 1; return [liveModel]; });
		provider.validateHostOAuth = (value) => validateCursorHostOAuthCredential(value as never, Number.NEGATIVE_INFINITY);
		provider.oauth = { ...provider.oauth!, refreshToken: async () => { refreshes += 1; return credential("replacement"); } };
		registry.registerProvider("required", provider);
		await registry.prepareRequiredProviders();
		assert.equal(refreshes, 1);
		assert.equal(discoveries, 1);
	});

	test("request auth rejects partial OAuth mutations as AuthenticationMalformed", async () => {
		for (const malformed of [
			{ type: "oauth", refresh: "only-refresh", expires: future },
			{ type: "oauth", access: "only-access", expires: future },
		]) {
			const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("initial") } });
			const registry = ModelRegistry.create(auth, []);
			const provider = config(async () => [liveModel]);
			provider.validateHostOAuth = (value) => validateCursorHostOAuthCredential(value as never, Number.NEGATIVE_INFINITY);
			registry.registerProvider("required", provider);
			await registry.prepareRequiredProviders();
			const selected = registry.resolveExactModel("required", "live");
			auth.set("required", malformed as never);
			await assert.rejects(registry.getApiKeyAndHeaders(selected), (error: Error) =>
				error instanceof CursorError && error.code === "AuthenticationMalformed");
		}
	});

	test("request auth validates malformed OAuth returned by refresh", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("initial") } });
		const registry = ModelRegistry.create(auth, []);
		const provider = config(async () => [liveModel]);
		provider.validateHostOAuth = (value) => validateCursorHostOAuthCredential(value as never, Number.NEGATIVE_INFINITY);
		provider.oauth = { ...provider.oauth!, refreshToken: async () => ({ access: "refreshed-access", expires: future } as never) };
		registry.registerProvider("required", provider);
		await registry.prepareRequiredProviders();
		const selected = registry.resolveExactModel("required", "live");
		auth.set("required", { type: "oauth", access: "expired", refresh: "expired-refresh", expires: 0 });
		await assert.rejects(registry.getApiKeyAndHeaders(selected), (error: Error) =>
			error instanceof CursorError && error.code === "AuthenticationMalformed");
	});

	test("request auth validates the credential synchronized from the backing host store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-host-oauth-race-"));
		try {
			const authPath = join(dir, "auth.json");
			const auth = AuthStorage.create(authPath);
			auth.set("required", { type: "oauth", ...credential("initial") });
			const registry = ModelRegistry.create(auth, []);
			const provider = config(async () => [liveModel]);
			provider.validateHostOAuth = (value) => validateCursorHostOAuthCredential(value as never, Number.NEGATIVE_INFINITY);
			registry.registerProvider("required", provider);
			await registry.prepareRequiredProviders();
			const selected = registry.resolveExactModel("required", "live");
			auth.set("required", { type: "oauth", access: "expired", refresh: "expired-refresh", expires: 0 });
			writeFileSync(authPath, JSON.stringify({ required: { type: "oauth", access: "synchronized-access", expires: future } }));
			await assert.rejects(registry.getApiKeyAndHeaders(selected), (error: Error) =>
				error instanceof CursorError && error.code === "AuthenticationMalformed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("request auth retries when OAuth changes while host conversion is pending", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("account-a") } });
		const registry = ModelRegistry.create(auth, []);
		registry.registerProvider("required", config(async () => [liveModel]));
		await registry.prepareRequiredProviders();
		const selected = registry.resolveExactModel("required", "live");
		const originalGetModelAuth = auth.getModelAuth.bind(auth);
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let reportFirst!: () => void;
		const firstPending = new Promise<void>((resolve) => { reportFirst = resolve; });
		let calls = 0;
		auth.getModelAuth = async (...args) => {
			const resolved = await originalGetModelAuth(...args);
			calls += 1;
			if (calls === 1) {
				reportFirst();
				await firstGate;
			}
			return resolved;
		};

		const pending = registry.getApiKeyAndHeaders(selected);
		await firstPending;
		auth.set("required", { type: "oauth", ...credential("account-b") });
		releaseFirst();
		const resolved = await pending;

		assert.equal(resolved.ok, true);
		if (resolved.ok) assert.equal(resolved.apiKey, "account-b");
		assert.ok(calls >= 2);
	});

	test("request auth preserves structured AuthenticationMissing after logout", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("account") } });
		const registry = ModelRegistry.create(auth, []);
		registry.registerProvider("required", config(async () => [liveModel]));
		await registry.prepareRequiredProviders();
		const selected = registry.resolveExactModel("required", "live");
		auth.remove("required");
		await assert.rejects(registry.getApiKeyAndHeaders(selected), (error: Error) =>
			error instanceof ProviderModelSelectionError && error.code === "AuthenticationMissing" &&
			error.provider === "required" && error.modelId === "live" && error.operation === "authentication");
	});

	test("authoritative empty registration suppresses pre-existing static provider rows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-required-empty-"));
		try {
			const path = join(dir, "models.json");
			writeFileSync(path, JSON.stringify({ providers: { required: {
				baseUrl: "https://static.invalid",
				apiKey: "static-key",
				api: "openai-completions",
				models: [{ ...liveModel, id: "static" }],
			} } }));
			const auth = AuthStorage.inMemory({ required: { type: "oauth", ...credential("account") } });
			const registry = ModelRegistry.create(auth, path);
			assert.equal(registry.find("required", "static")?.id, "static");
			registry.registerProvider("required", config(async () => []));
			assert.equal(registry.find("required", "static"), undefined);
			await registry.prepareRequiredProviders();
			assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
