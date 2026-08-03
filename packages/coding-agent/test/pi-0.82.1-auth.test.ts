import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel, restoreModelFromSession } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getBuiltinApiKeyLoginOptions } from "../src/modes/interactive/interactive-auth-routing.ts";
import { resolveLoginProviderReference } from "../src/modes/interactive/login-provider-options.ts";
import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

function jsonResponse(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const originalAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
	if (originalAnthropicToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
	else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicToken;
	if (originalAnthropicOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
	else process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOAuthToken;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	vi.restoreAllMocks();
});

describe("Pi 0.82.1 authentication integration", () => {
	it("exposes OpenRouter and Kimi Code through provider-owned OAuth metadata", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		expect(runtime.getProvider("openrouter")?.auth.oauth).toMatchObject({
			name: "OpenRouter OAuth",
		});
		expect(runtime.getProvider("kimi-coding")?.auth.oauth).toMatchObject({
			name: "Kimi Code (subscription)",
		});
	});

	it("routes direct /login references for both subscription providers", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		const oauthOptions = runtime
			.getProviders()
			.filter((provider) => provider.auth.oauth)
			.map((provider) => ({ id: provider.id, name: provider.name ?? provider.id, authType: "oauth" as const }));
		const options = [...oauthOptions, ...getBuiltinApiKeyLoginOptions((id) => registry.getProviderDisplayName(id))];

		expect(resolveLoginProviderReference(options, "openrouter")).toMatchObject({
			kind: "choose_method",
			options: expect.arrayContaining([expect.objectContaining({ id: "openrouter", authType: "oauth" })]),
		});
		expect(resolveLoginProviderReference(options, "kimi-coding")).toMatchObject({
			kind: "choose_method",
			options: expect.arrayContaining([expect.objectContaining({ id: "kimi-coding", authType: "oauth" })]),
		});
	});

	it("resolves ANTHROPIC_AUTH_TOKEN as header-only request auth without overwriting custom headers", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const model = registry.getAll().find(({ provider }) => provider === "anthropic");
		expect(model).toBeDefined();

		await expect(registry.getApiKeyAndHeaders({ ...model!, headers: { "X-Custom": "preserved" } })).resolves.toEqual({
			ok: true,
			apiKey: undefined,
			headers: {
				Authorization: "Bearer gateway-token",
				"X-Custom": "preserved",
			},
			baseUrl: undefined,
		});
	});

	it("treats ANTHROPIC_AUTH_TOKEN as configured bearer-only model auth", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		const storage = AuthStorage.inMemory();
		const registry = await createInMemoryModelRegistry(storage);
		const runtime = getModelRuntime(registry);

		expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({
			configured: true,
			source: "environment",
			label: "ANTHROPIC_AUTH_TOKEN",
		});
		expect(runtime.getAvailableSnapshot().some(({ provider }) => provider === "anthropic")).toBe(true);
		await expect(runtime.checkAuth("anthropic")).resolves.toEqual({
			source: "ANTHROPIC_AUTH_TOKEN",
			type: "api_key",
		});
	});

	it("does not treat known but empty Anthropic environment variables as configured", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "";
		process.env.ANTHROPIC_OAUTH_TOKEN = "";
		process.env.ANTHROPIC_API_KEY = "";
		const storage = AuthStorage.inMemory();
		const registry = await createInMemoryModelRegistry(storage);
		const runtime = getModelRuntime(registry);

		expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: false });
		expect(runtime.getAvailableSnapshot().some(({ provider }) => provider === "anthropic")).toBe(false);
	});

	it("selects, restores, and cycles Anthropic models with bearer-only auth", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		const directory = mkdtempSync(join(tmpdir(), "atomic-anthropic-bearer-models-"));
		const storage = AuthStorage.inMemory();
		const registry = await createInMemoryModelRegistry(storage);
		const runtime = getModelRuntime(registry);
		const models = registry
			.getAll()
			.filter(({ provider }) => provider === "anthropic")
			.slice(0, 2);
		expect(models).toHaveLength(2);
		const [first, second] = models;

		try {
			const direct = await findInitialModel({
				cliProvider: first!.provider,
				cliModel: first!.id,
				scopedModels: [],
				isContinuing: false,
				modelRuntime: runtime,
			});
			expect(direct.model).toBe(first);

			const configuredDefault = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: first!.provider,
				defaultModelId: first!.id,
				modelRuntime: runtime,
			});
			expect(configuredDefault.model).toBe(first);
			await expect(restoreModelFromSession(first!.provider, first!.id, undefined, false, runtime)).resolves.toEqual({
				model: first,
				fallbackMessage: undefined,
			});

			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				authStorage: storage,
				modelRuntime: runtime,
				model: first,
				scopedModels: models.map((model) => ({ model })),
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(directory),
			});
			try {
				await expect(session.setModel(first!)).resolves.toBeUndefined();
				await expect(session.cycleModel()).resolves.toMatchObject({ model: second, isScoped: true });
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refreshes an expired Kimi Code credential transactionally and returns bearer headers", async () => {
		const storage = AuthStorage.inMemory({
			"kimi-coding": { type: "oauth", access: "old", refresh: "refresh-old", expires: 0 },
		});
		const registry = await createInMemoryModelRegistry(storage);
		const runtime = getModelRuntime(registry);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				access_token: "access-new",
				refresh_token: "refresh-new",
				expires_in: 3600,
			}),
		);

		await expect(runtime.getAuth("kimi-coding")).resolves.toMatchObject({
			auth: { headers: { Authorization: "Bearer access-new" } },
		});
		expect(await storage.read("kimi-coding")).toMatchObject({
			type: "oauth",
			access: "access-new",
			refresh: "refresh-new",
		});
	});

	it("retains the provider response cause in Atomic model-auth errors", async () => {
		const storage = AuthStorage.inMemory({
			"kimi-coding": { type: "oauth", access: "old", refresh: "revoked", expires: 0 },
		});
		const registry = await createInMemoryModelRegistry(storage);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(
				{
					error: "invalid_grant",
					error_description: "credential revoked by gateway",
				},
				401,
			),
		);
		const model = registry.getAll().find(({ provider }) => provider === "kimi-coding");
		expect(model).toBeDefined();

		await expect(registry.getApiKeyAndHeaders(model!)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("credential revoked by gateway"),
		});
	});

	it("routes configured Radius refresh directly through the declared gateway", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-radius-auth-"));
		try {
			writeFileSync(
				join(directory, "models.json"),
				JSON.stringify({
					providers: {
						"corp-radius": {
							name: "Corporate Radius",
							baseUrl: "https://radius.example.test/v1",
							oauth: "radius",
						},
					},
				}),
			);
			const storage = AuthStorage.inMemory({
				"corp-radius": { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
			});
			const registry = await createModelRegistry(storage, join(directory, "models.json"));
			const runtime = getModelRuntime(registry);
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				jsonResponse({
					access_token: "new-access",
					refresh_token: "new-refresh",
					expires_in: 3600,
				}),
			);

			await expect(runtime.getAuth("corp-radius")).resolves.toMatchObject({
				auth: { apiKey: "new-access" },
			});
			expect(fetchSpy).toHaveBeenCalledWith(
				new URL("https://radius.example.test/v1/oauth/token"),
				expect.objectContaining({ method: "POST" }),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
