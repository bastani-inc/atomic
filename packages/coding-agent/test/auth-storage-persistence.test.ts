import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.ts";
import { registerLegacyOAuthProvider, resetLegacyOAuthProviders } from "../src/core/oauth-provider-bridge.ts";

class ControllableAuthBackend implements AuthStorageBackend {
	value: string | undefined;
	writeError: Error | undefined;

	constructor(value?: string) {
		this.value = value;
	}

	read(): string | undefined {
		return this.value;
	}

	withLock<T>(fn: Parameters<AuthStorageBackend["withLock"]>[0]): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			if (this.writeError) throw this.writeError;
			this.value = next;
		}
		return result as T;
	}

	async withLockAsync<T>(fn: Parameters<AuthStorageBackend["withLockAsync"]>[0]): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			if (this.writeError) throw this.writeError;
			this.value = next;
		}
		return result as T;
	}
}

afterEach(() => resetLegacyOAuthProviders());

describe("AuthStorage persistence failures", () => {
	test("surfaces malformed storage and preserves in-memory credentials", () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.value = "{invalid-json";
		storage.reload();

		expect(() => storage.set("openai", { type: "api_key", key: "new" })).toThrow();
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(storage.get("openai")).toBeUndefined();
		expect(backend.value).toBe("{invalid-json");
	});

	test("surfaces write failures without mutating in-memory credentials", () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.writeError = new Error("disk full");

		expect(() => storage.set("anthropic", { type: "api_key", key: "replacement" })).toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(() => storage.remove("anthropic")).toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(JSON.parse(backend.value ?? "{}")).toEqual({ anthropic: { type: "api_key", key: "existing" } });
		expect(() => storage.logout("anthropic")).toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
	});

	test("credential adapter keeps failed writes transactional", async () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.writeError = new Error("disk full");

		await expect(
			storage.asCredentialStore().modify("anthropic", async () => ({ type: "api_key", key: "replacement" })),
		).rejects.toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
	});

	test("failed async logout keeps the persisted credential in memory", async () => {
		const backend = new ControllableAuthBackend(
			JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }),
		);
		const storage = AuthStorage.fromStorage(backend);
		backend.writeError = new Error("disk full");

		await expect(storage.logoutAsync("anthropic")).rejects.toThrow("disk full");
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
	});

	test("credential adapter serializes delete behind an in-flight modify", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "existing" } });
		const credentials = storage.asCredentialStore();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const modify = credentials.modify("anthropic", async () => {
			await gate;
			return { type: "api_key", key: "replacement" };
		});
		const deletion = credentials.delete("anthropic");

		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		release();
		await Promise.all([modify, deletion]);
		expect(storage.get("anthropic")).toBeUndefined();
	});

	test("serialized logout wins over an in-flight legacy OAuth refresh", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		registerLegacyOAuthProvider("legacy", {
			name: "Legacy",
			login: async () => ({ refresh: "r", access: "a", expires: 1 }),
			refreshToken: async () => {
				await gate;
				return { refresh: "r2", access: "a2", expires: Date.now() + 60_000 };
			},
			getApiKey: (credentials) => credentials.access,
		});
		const storage = AuthStorage.inMemory({
			legacy: { type: "oauth", refresh: "r", access: "a", expires: 0 },
		});
		const refresh = storage.getModelAuth("legacy");
		const logout = storage.logoutAsync("legacy");

		release();
		await Promise.all([refresh, logout]);

		expect(storage.get("legacy")).toBeUndefined();
	});

	test("login is serialized after an in-flight legacy OAuth refresh", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		registerLegacyOAuthProvider("login-race", {
			name: "Login Race",
			login: async () => ({ refresh: "login-r", access: "login-a", expires: Date.now() + 60_000 }),
			refreshToken: async () => {
				await gate;
				return { refresh: "refresh-r", access: "refresh-a", expires: Date.now() + 60_000 };
			},
			getApiKey: (credentials) => credentials.access,
		});
		const storage = AuthStorage.inMemory({
			"login-race": { type: "oauth", refresh: "old-r", access: "old-a", expires: 0 },
		});
		const refresh = storage.getModelAuth("login-race");
		const login = storage.login("login-race", {
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});

		release();
		await Promise.all([refresh, login]);

		expect(storage.get("login-race")).toMatchObject({ access: "login-a", refresh: "login-r" });
	});

	test("legacy synchronous logout is serialized behind an in-flight OAuth refresh", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => { markEntered = resolve; });
		registerLegacyOAuthProvider("legacy-sync", {
			name: "Legacy Sync",
			login: async () => ({ refresh: "r", access: "a", expires: 1 }),
			refreshToken: async () => {
				markEntered();
				await gate;
				return { refresh: "r2", access: "a2", expires: Date.now() + 60_000 };
			},
			getApiKey: (credentials) => credentials.access,
		});
		const storage = AuthStorage.inMemory({
			"legacy-sync": { type: "oauth", refresh: "r", access: "a", expires: 0 },
		});
		const refresh = storage.getModelAuth("legacy-sync");
		await entered;

		storage.logout("legacy-sync");
		expect(storage.get("legacy-sync")).toBeUndefined();
		release();
		await refresh;

		expect(storage.get("legacy-sync")).toBeUndefined();
	});

	test("recovers after the credential snapshot is repaired", () => {
		const backend = new ControllableAuthBackend("{invalid-json");
		const storage = AuthStorage.fromStorage(backend);
		expect(storage.getLoadError()).toBeInstanceOf(Error);

		backend.value = JSON.stringify({ anthropic: { type: "api_key", key: "existing" } });
		storage.set("openai", { type: "api_key", key: "new" });

		expect(storage.getLoadError()).toBeNull();
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "existing" });
		expect(storage.get("openai")).toEqual({ type: "api_key", key: "new" });
	});
});
