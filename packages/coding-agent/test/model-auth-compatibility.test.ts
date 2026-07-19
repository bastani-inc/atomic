import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getModelRequestAuth } from "../src/core/model-registry-auth.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { FileModelsStore } from "../src/core/models-store.ts";
import {
	getOAuthApiKey,
	getOAuthProvider,
	registerOAuthProvider,
	resetLegacyOAuthProviders,
} from "../src/core/oauth-provider-bridge.ts";

afterEach(() => {
	vi.restoreAllMocks();
	resetLegacyOAuthProviders();
});

describe("Pi 0.80.10 model auth compatibility", () => {
	test("preserves the synchronous AuthStorage API behind an async CredentialStore adapter", async () => {
		const storage = AuthStorage.inMemory({ alpha: { type: "api_key", key: "one" } });
		const credentials = storage.asCredentialStore();

		expect(storage.list()).toEqual(["alpha"]);
		expect(await credentials.list()).toEqual([{ providerId: "alpha", type: "api_key" }]);
		await credentials.modify("alpha", async (current) => ({ ...current!, type: "api_key", key: "two" }));
		expect(storage.get("alpha")).toEqual({ type: "api_key", key: "two" });
		await credentials.delete("alpha");
		expect(storage.list()).toEqual([]);
	});

	test("exposes runtime-only API keys to provider-owned auth without persisting them", async () => {
		const storage = AuthStorage.inMemory({ alpha: { type: "api_key", key: "stored" } });
		storage.setRuntimeApiKey("runtime", "temporary");
		const credentials = storage.asCredentialStore();

		expect(await credentials.read("runtime")).toEqual({ type: "api_key", key: "temporary" });
		expect(await credentials.list()).toEqual([
			{ providerId: "alpha", type: "api_key" },
			{ providerId: "runtime", type: "api_key" },
		]);
		expect(storage.get("runtime")).toBeUndefined();
		expect(storage.list()).toEqual(["alpha"]);
	});

	test("preserves callback login and provider-owned label metadata", () => {
		const providers = AuthStorage.inMemory().getOAuthProviders();
		expect(providers.find((provider) => provider.id === "anthropic")?.usesCallbackServer).toBe(true);
		expect(providers.find((provider) => provider.id === "openai-codex")?.usesCallbackServer).toBe(true);
		expect(providers.find((provider) => provider.id === "xai")?.loginLabel).toBe(
			"Sign in with SuperGrok or X Premium",
		);
		const anthropic = providers.find((provider) => provider.id === "anthropic")!;
		expect(typeof anthropic.login).toBe("function");
		expect(typeof anthropic.refreshToken).toBe("function");
		expect(anthropic.getApiKey({ refresh: "r", access: "a", expires: 1 })).toBe("a");
		expect(getOAuthProvider("anthropic")?.name).toBe(anthropic.name);
	});

	test("preserves the legacy credentials-map OAuth API-key helper", async () => {
		const original = { refresh: "old-refresh", access: "old-access", expires: 0 };
		const refreshed = { refresh: "new-refresh", access: "new-access", expires: Date.now() + 60_000 };
		const refreshToken = vi.fn(async () => refreshed);
		registerOAuthProvider({
			id: "legacy-probe",
			name: "Legacy Probe",
			login: async () => original,
			refreshToken,
			getApiKey: (credentials) => `key:${credentials.access}`,
		});

		expect(await getOAuthApiKey("legacy-probe", {
			decoy: { refresh: "decoy", access: "decoy", expires: 1 },
			"legacy-probe": original,
		})).toEqual({ newCredentials: refreshed, apiKey: "key:new-access" });
		expect(refreshToken).toHaveBeenCalledWith(original);
		expect(await getOAuthApiKey("legacy-probe", {})).toBeNull();
		await expect(getOAuthApiKey("missing-provider", {})).rejects.toThrow("Unknown OAuth provider");
		refreshToken.mockRejectedValueOnce(new Error("sensitive upstream detail"));
		await expect(getOAuthApiKey("legacy-probe", { "legacy-probe": original })).rejects.toThrow(
			"Failed to refresh OAuth token for legacy-probe",
		);
	});

	test("runtime API-key overrides bypass expired stored OAuth", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", refresh: "expired", access: "expired", expires: 0 },
		});
		storage.setRuntimeApiKey("anthropic", "runtime-wins");
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "anthropic")!;

		await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
			ok: true,
			apiKey: "runtime-wins",
		});
	});

	test("legacy OAuth replacement for a built-in provider bypasses built-in auth", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", refresh: "expired", access: "expired", expires: 0 },
		});
		const registry = ModelRegistry.inMemory(storage);
		const refreshToken = vi.fn(async () => ({
			refresh: "custom-refresh",
			access: "custom-access",
			expires: Date.now() + 60_000,
		}));
		registry.registerProvider("anthropic", {
			oauth: {
				name: "Custom Anthropic",
				login: async () => ({ refresh: "r", access: "a", expires: 1 }),
				refreshToken,
				getApiKey: (credential) => `legacy:${credential.access}`,
			},
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const model = registry.getAll().find((candidate) => candidate.provider === "anthropic")!;

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ ok: true, apiKey: "legacy:custom-access" });
		expect(refreshToken).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("global legacy OAuth registration replaces built-in provider auth", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", refresh: "expired", access: "expired", expires: 0 },
		});
		const refreshToken = vi.fn(async () => ({
			refresh: "global-refresh",
			access: "global-access",
			expires: Date.now() + 60_000,
		}));
		registerOAuthProvider({
			id: "anthropic",
			name: "Global Anthropic",
			login: async () => ({ refresh: "r", access: "a", expires: 1 }),
			refreshToken,
			getApiKey: (credential) => `global:${credential.access}`,
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "anthropic")!;

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ ok: true, apiKey: "global:global-access" });
		expect(refreshToken).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("runtime-only credentials authorize provider-owned catalog refresh", async () => {
		const storage = AuthStorage.inMemory();
		storage.setRuntimeApiKey("anthropic", "runtime-only");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, { status: 404 }));
		const registry = ModelRegistry.inMemory(storage);

		const result = await registry.refresh({ force: true });

		expect(result.aborted).toBe(false);
		expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/providers/anthropic"))).toBe(true);
		expect(storage.get("anthropic")).toBeUndefined();
	});

	test("retains credential-specific Copilot apiKey and baseUrl from provider-owned OAuth", async () => {
		const storage = AuthStorage.inMemory({
			"github-copilot": {
				type: "oauth",
				refresh: "github-token",
				access: "tid=example;proxy-ep=proxy.enterprise.example.com;",
				expires: Date.now() + 60_000,
			},
		});
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "github-copilot");
		expect(model).toBeDefined();

		const auth = await registry.getApiKeyAndHeaders(model!);

		expect(auth).toMatchObject({
			ok: true,
			apiKey: "tid=example;proxy-ep=proxy.enterprise.example.com;",
			baseUrl: "https://api.enterprise.example.com",
		});
	});

	test("derives a credential-specific Copilot baseUrl from a runtime token", async () => {
		const token = "tid=example;proxy-ep=proxy.enterprise.example.com;";
		const storage = AuthStorage.inMemory();
		storage.setRuntimeApiKey("github-copilot", token);
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "github-copilot");
		expect(model).toBeDefined();

		const auth = await registry.getApiKeyAndHeaders(model!);

		expect(auth).toMatchObject({
			ok: true,
			apiKey: token,
			baseUrl: "https://api.enterprise.example.com",
			headers: { "X-GitHub-Api-Version": "2026-06-01" },
		});
	});

	test("keeps the stored Copilot enterprise endpoint when a runtime key overrides only apiKey", async () => {
		const storage = AuthStorage.inMemory({
			"github-copilot": {
				type: "oauth",
				refresh: "github-token",
				access: "tid=stored;proxy-ep=proxy.stored.example.com;",
				expires: Date.now() + 60_000,
			},
		});
		storage.setRuntimeApiKey("github-copilot", "runtime-key");
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "github-copilot")!;

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: "runtime-key",
			baseUrl: "https://api.stored.example.com",
			headers: { "X-GitHub-Api-Version": "2026-06-01" },
		});
	});

	test("prefers a runtime Copilot proxy endpoint over the stored OAuth endpoint", async () => {
		const storage = AuthStorage.inMemory({
			"github-copilot": {
				type: "oauth",
				refresh: "github-token",
				access: "tid=stored;proxy-ep=proxy.stored.example.com;",
				expires: Date.now() + 60_000,
			},
		});
		const runtimeToken = "tid=runtime;proxy-ep=proxy.runtime.example.com;";
		storage.setRuntimeApiKey("github-copilot", runtimeToken);
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "github-copilot")!;

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: runtimeToken,
			baseUrl: "https://api.runtime.example.com",
		});
	});

	test("preserves provider-owned auth headers and null removals", async () => {
		const storage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(storage);
		const model = {
			...registry.getAll()[0],
			provider: "header-provider",
			headers: { "X-Removed": "static", "X-Static": "kept-by-provider-auth" },
		};
		const auth = await getModelRequestAuth(
			model,
			storage,
			new Map([["header-provider", { headers: { "X-Config": "config" } }]]),
			new Map(),
			{ apiKey: "provider-key", headers: { "x-removed": null, "X-Auth": "oauth" }, baseUrl: "https://auth.example/v1" },
		);

		expect(auth).toEqual({
			ok: true,
			apiKey: "provider-key",
			headers: { "x-removed": null, "X-Auth": "oauth", "X-Config": "config" },
			baseUrl: "https://auth.example/v1",
		});
	});

	test("restores persisted provider catalogs before dependent reads", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-model-runtime-"));
		try {
			const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
			const baseline = ModelRegistry.inMemory(storage).getAll().find((model) => model.provider === "anthropic")!;
			await new FileModelsStore(join(directory, "models-store.json")).write("anthropic", {
				models: [
					{ ...baseline, name: "Refreshed Existing" },
					{ ...baseline, id: "persisted-dynamic", name: "Persisted Dynamic" },
				],
				checkedAt: Date.now(),
			});
			writeFileSync(join(directory, "models.json"), JSON.stringify({
				providers: { anthropic: { baseUrl: "https://proxy.example/v1" } },
			}));
			const registry = ModelRegistry.create(storage, join(directory, "models.json"));

			await registry.refresh({ allowNetwork: false });

			expect(registry.find("anthropic", baseline.id)?.name).toBe("Refreshed Existing");
			expect(registry.find("anthropic", baseline.id)?.baseUrl).toBe("https://proxy.example/v1");
			expect(registry.find("anthropic", "persisted-dynamic")?.baseUrl).toBe("https://proxy.example/v1");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("retains a first persisted provider overlay when network refresh times out", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-model-timeout-"));
		try {
			const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
			const baseline = ModelRegistry.inMemory(storage).getAll().find((model) => model.provider === "anthropic")!;
			await new FileModelsStore(join(directory, "models-store.json")).write("anthropic", {
				models: [{ ...baseline, id: "cached-dynamic", name: "Cached Dynamic" }],
				checkedAt: 0,
			});
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>(() => {}));
			const registry = ModelRegistry.create(storage, join(directory, "models.json"));

			const result = await registry.refresh({ timeoutMs: 5 });

			expect(result.aborted).toBe(true);
			expect(registry.find("anthropic", "cached-dynamic")?.name).toBe("Cached Dynamic");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("persists provider-scoped refreshed catalogs across runtime instances", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-model-store-"));
		const path = join(directory, "models-store.json");
		try {
			const first = new FileModelsStore(path);
			await first.write("dynamic", { models: [], checkedAt: 123 });
			const second = new FileModelsStore(path);
			expect(await second.read("dynamic")).toEqual({ models: [], checkedAt: 123 });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
