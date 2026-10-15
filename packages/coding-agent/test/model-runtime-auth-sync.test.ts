import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, OAuthCredential } from "@bastani/pi-ai";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ProviderConfig } from "../src/core/extensions/provider-types.js";
import { ModelRuntime } from "../src/core/model-runtime.js";

const PROVIDER = "corp-oauth";
const HOUR_MS = 60 * 60 * 1000;

function oauthCredential(access: string, expires = Date.now() + HOUR_MS): OAuthCredential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires };
}

function extensionOAuthProvider(refreshToken: NonNullable<ProviderConfig["oauth"]>["refreshToken"]): ProviderConfig {
	return {
		baseUrl: "https://corp.example.test/v1",
		api: "openai-completions",
		models: [
			{
				id: "corp-model",
				name: "Corp Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
		],
		oauth: {
			name: "Corp SSO",
			login: async () => oauthCredential("login-access"),
			refreshToken,
			getApiKey: (credential) => credential.access,
		},
	};
}

describe("extension OAuth credentials stay in sync with auth.json", () => {
	let dir: string;
	let authPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "model-runtime-auth-sync-"));
		authPath = join(dir, "auth.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	type RefreshToken = NonNullable<ProviderConfig["oauth"]>["refreshToken"];

	const unexpectedRefresh: RefreshToken = async () => {
		throw new Error("unexpected refresh");
	};

	async function sessionRuntime(
		refreshToken: RefreshToken = unexpectedRefresh,
		config: Partial<ProviderConfig> = {},
	): Promise<ModelRuntime> {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.create(authPath), modelsPath: null });
		runtime.registerProvider(PROVIDER, { ...extensionOAuthProvider(refreshToken), ...config });
		await runtime.getAvailable();
		return runtime;
	}

	test("reports an extension OAuth login saved by another process (#3620)", async () => {
		const runtime = await sessionRuntime();
		assert.equal(runtime.hasConfiguredAuth(PROVIDER), false);

		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("other-window-access"));

		assert.equal(runtime.hasConfiguredAuth(PROVIDER), true);
		assert.equal(runtime.isUsingOAuth(PROVIDER), true);
		assert.deepEqual(runtime.getProviderAuthStatus(PROVIDER), { configured: true, source: "stored" });
		assert.equal(runtime.getStoredCredentialType(PROVIDER), "oauth");
	});

	test("drops an extension OAuth login removed by another process (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("startup-access"));
		const runtime = await sessionRuntime();
		assert.equal(runtime.isUsingOAuth(PROVIDER), true);

		await AuthStorage.create(authPath).delete(PROVIDER);

		assert.equal(runtime.isUsingOAuth(PROVIDER), false);
		assert.equal(runtime.hasConfiguredAuth(PROVIDER), false);
		assert.deepEqual(runtime.getProviderAuthStatus(PROVIDER), { configured: false });
	});

	test("keeps configured provider auth after another process logs out (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("startup-access"));
		const runtime = await sessionRuntime(unexpectedRefresh, { apiKey: "corp-configured-literal-key" });
		assert.equal(runtime.isUsingOAuth(PROVIDER), true);

		await AuthStorage.create(authPath).delete(PROVIDER);

		assert.equal(runtime.isUsingOAuth(PROVIDER), false);
		await vi.waitFor(() => assert.equal(runtime.hasConfiguredAuth(PROVIDER), true));
	});

	test("uses an extension OAuth token another process saved instead of refreshing (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("startup-access"));
		const runtime = await sessionRuntime();

		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("other-window-access"));

		assert.equal((await runtime.getAuth(PROVIDER))?.auth.apiKey, "other-window-access");
	});

	test("shares an extension OAuth refresh with other sessions through auth.json (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("expired-access", 1));
		let refreshes = 0;
		const refreshing = await sessionRuntime(async (credential) => {
			refreshes += 1;
			return { ...credential, access: "refreshed-access", expires: Date.now() + HOUR_MS };
		});
		const otherSession = await sessionRuntime();

		assert.equal((await refreshing.getAuth(PROVIDER))?.auth.apiKey, "refreshed-access");
		assert.equal((await otherSession.getAuth(PROVIDER))?.auth.apiKey, "refreshed-access");
		assert.equal(refreshes, 1);
		const persisted = await AuthStorage.create(authPath).read(PROVIDER);
		assert.equal(persisted?.type === "oauth" ? persisted.access : undefined, "refreshed-access");
	});

	test("reports a failed extension OAuth refresh instead of using the expired token (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("expired-access", 1));
		const runtime = await sessionRuntime(async () => {
			throw new Error("refresh token revoked");
		});

		await assert.rejects(runtime.getAuth(PROVIDER), /OAuth refresh failed for corp-oauth/);
		const persisted = await AuthStorage.create(authPath).read(PROVIDER);
		assert.equal(persisted?.type === "oauth" ? persisted.access : undefined, "expired-access");
	});

	function saveRestrictedCopilotLogin(
		entitlements: { availableModelIds?: string[]; fastModelIds?: string[]; access?: string } = {},
	): Promise<void> {
		return AuthStorage.create(authPath).modify("github-copilot", async () => ({
			type: "oauth",
			access: entitlements.access ?? "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "copilot-refresh",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: entitlements.availableModelIds ?? ["claude-opus-4.8"],
			...(entitlements.fastModelIds ? { fastModelIds: entitlements.fastModelIds } : {}),
		}));
	}

	function copilotAvailable(runtime: ModelRuntime): string[] {
		return runtime
			.getAvailableSnapshot()
			.filter((model) => model.provider === "github-copilot")
			.map((model) => model.id);
	}

	test("keeps credential-filtered availability when another process logs in elsewhere (#3620)", async () => {
		await saveRestrictedCopilotLogin();
		const runtime = await sessionRuntime();
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);

		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("other-window-access"));

		assert.equal(runtime.hasConfiguredAuth(PROVIDER), true);
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);
		assert.ok(runtime.getAvailableSnapshot().some((model) => model.provider === PROVIDER));

		await AuthStorage.create(authPath).delete(PROVIDER);

		assert.equal(runtime.hasConfiguredAuth(PROVIDER), false);
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);
		assert.equal(
			runtime.getAvailableSnapshot().some((model) => model.provider === PROVIDER),
			false,
		);
	});

	test("publishes only the entitled models of a login saved by another process (#3620)", async () => {
		const runtime = await sessionRuntime();
		assert.equal(runtime.hasConfiguredAuth("github-copilot"), false);
		assert.deepEqual(copilotAvailable(runtime), []);

		await saveRestrictedCopilotLogin();

		assert.equal(runtime.hasConfiguredAuth("github-copilot"), true);
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);
	});

	test("publishes the entitled models of a Copilot account another process switched to (#3620)", async () => {
		await saveRestrictedCopilotLogin();
		const runtime = await sessionRuntime();
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);

		await saveRestrictedCopilotLogin({
			access: "tid=other-account;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			availableModelIds: ["claude-sonnet-5"],
		});

		assert.equal(runtime.hasConfiguredAuth("github-copilot"), true);
		assert.deepEqual(copilotAvailable(runtime), ["claude-sonnet-5"]);
	});

	test("publishes the entitled fast models of a first login saved by another process (#3620)", async () => {
		const runtime = await sessionRuntime();
		assert.deepEqual(copilotAvailable(runtime), []);

		await saveRestrictedCopilotLogin({ fastModelIds: ["claude-opus-4.8-fast"] });

		assert.equal(runtime.hasConfiguredAuth("github-copilot"), true);
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8", "claude-opus-4.8-fast"]);
	});

	test("an OAuth token rotation saved by another process keeps catalog passes shareable (#3620)", async () => {
		await saveRestrictedCopilotLogin();
		const runtime = await sessionRuntime();
		const generation = runtime.getCatalogInputsGeneration();

		await saveRestrictedCopilotLogin({
			access: "tid=rotated;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
		});

		assert.equal(runtime.hasConfiguredAuth("github-copilot"), true);
		assert.deepEqual(copilotAvailable(runtime), ["claude-opus-4.8"]);
		assert.equal(runtime.getCatalogInputsGeneration(), generation);
	});

	test("reports a login saved by another process after an authoritative engine logout (#3620)", async () => {
		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("startup-access"));
		const runtime = await sessionRuntime();
		runtime.applyExternalProviderAuthStatus(PROVIDER, { configured: false });
		assert.equal(runtime.hasConfiguredAuth(PROVIDER), false);

		await AuthStorage.create(authPath).modify(PROVIDER, async () => oauthCredential("other-window-access"));

		assert.equal(runtime.hasConfiguredAuth(PROVIDER), true);
		assert.deepEqual(runtime.getProviderAuthStatus(PROVIDER), { configured: true, source: "stored" });
	});

	test("an older availability refresh cannot restore auth another process removed (#3620)", async () => {
		const gatedProvider = "gated-auth";
		const model: Model<Api> = {
			id: "gated-model",
			name: "Gated model",
			provider: gatedProvider,
			api: "openai-completions",
			baseUrl: "https://gated.example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		await AuthStorage.create(authPath).modify(gatedProvider, async () => ({ type: "api_key", key: "fixture-key" }));
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.create(authPath), modelsPath: null });
		let gate: Promise<void> | undefined;
		let release = () => {};
		let heldChecks = 0;
		runtime.registerNativeProvider({
			id: gatedProvider,
			name: "Gated auth",
			auth: {
				apiKey: {
					name: "Gated key",
					check: async ({ credential }) => {
						if (credential && gate) {
							heldChecks += 1;
							await gate;
						}
						return credential ? { type: "api_key", source: "stored" } : undefined;
					},
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
				},
			},
			getModels: () => [model],
			stream: () => {
				throw new Error("unexpected stream");
			},
			streamSimple: () => {
				throw new Error("unexpected stream");
			},
		});
		await runtime.refresh({ allowNetwork: false });
		assert.equal(runtime.hasConfiguredAuth(gatedProvider), true);
		const gatedAvailable = () =>
			runtime.getAvailableSnapshot().filter((candidate) => candidate.provider === gatedProvider).length;
		assert.equal(gatedAvailable(), 1);

		gate = new Promise((resolve) => {
			release = resolve;
		});
		const refreshing = runtime.getAvailable();
		await vi.waitFor(() => assert.ok(heldChecks > 0));

		await AuthStorage.create(authPath).delete(gatedProvider);
		assert.equal(runtime.hasConfiguredAuth(gatedProvider), false);
		assert.equal(gatedAvailable(), 0);

		release();
		const available = await refreshing;

		assert.equal(
			available.some((candidate) => candidate.provider === gatedProvider),
			false,
		);
		assert.equal(gatedAvailable(), 0);
		assert.equal(runtime.hasConfiguredAuth(gatedProvider), false);
	});
});
