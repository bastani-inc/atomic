import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@bastani/pi-ai";
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
});
