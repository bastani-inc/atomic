import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { AuthStorage, type AuthStorageData } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { AuthStorageBackend, LockResult } from "../../packages/coding-agent/src/core/auth-storage-backends.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";

class MutableBackend implements AuthStorageBackend {
	content: string | undefined;
	constructor(data: AuthStorageData) { this.content = JSON.stringify(data); }
	read(): string | undefined { return this.content; }
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const output = fn(this.content);
		if (output.next !== undefined) this.content = output.next;
		return output.result;
	}
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const output = await fn(this.content);
		if (output.next !== undefined) this.content = output.next;
		return output.result;
	}
}

const oauth = (access: string, expires: number) => ({ type: "oauth" as const, access, refresh: `${access}-refresh`, expires });

describe("AuthStorage credential generations", () => {
	test("successful OAuth refresh advances the provider generation", async () => {
		const auth = AuthStorage.inMemory({ "generation-oauth": oauth("expired", 0) });
		const registry = ModelRegistry.create(auth, []);
		registry.registerProvider("generation-oauth", {
			name: "Generation OAuth",
			baseUrl: "https://example.invalid",
			api: "openai-completions",
			models: [],
			oauth: {
				name: "Generation OAuth",
				login: async () => ({ access: "login", refresh: "login-refresh", expires: Date.now() + 60_000 }),
				refreshToken: async () => ({ access: "refreshed", refresh: "refreshed-refresh", expires: Date.now() + 60_000 }),
				getApiKey: (credential) => credential.access,
			},
		});
		const before = auth.getCredentialSnapshot("generation-oauth").generation;
		assert.equal((await auth.getModelAuth("generation-oauth", { storedOAuthOnly: true }))?.apiKey, "refreshed");
		assert.ok(auth.getCredentialSnapshot("generation-oauth").generation > before);
	});

	test("reload advances generations for changed and removed providers only", () => {
		const backend = new MutableBackend({ a: oauth("a", 100), b: oauth("b", 100), stable: { type: "api_key", key: "same" } });
		const auth = AuthStorage.fromStorage(backend);
		const before = {
			a: auth.getCredentialSnapshot("a").generation,
			b: auth.getCredentialSnapshot("b").generation,
			stable: auth.getCredentialSnapshot("stable").generation,
		};
		backend.content = JSON.stringify({ a: oauth("a-new", 200), stable: { type: "api_key", key: "same" } });
		auth.reload();
		assert.ok(auth.getCredentialSnapshot("a").generation > before.a);
		assert.ok(auth.getCredentialSnapshot("b").generation > before.b);
		assert.equal(auth.getCredentialSnapshot("stable").generation, before.stable);
	});
	test("runtime API key generations advance only when the effective override changes", () => {
		const auth = AuthStorage.inMemory();
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 0);
		auth.setRuntimeApiKey("required", "key-a");
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 1);
		auth.setRuntimeApiKey("required", "key-a");
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 1);
		auth.setRuntimeApiKey("required", "key-b");
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 2);
		auth.removeRuntimeApiKey("required");
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 3);
		auth.removeRuntimeApiKey("required");
		assert.equal(auth.getRuntimeApiKeyGeneration("required"), 3);
	});
});
