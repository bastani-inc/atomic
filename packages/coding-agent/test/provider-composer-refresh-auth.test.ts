import {
	createModels,
	createProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type OAuthAuth,
	type Provider,
	type RefreshModelsContext,
} from "@bastani/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";

const PROVIDER_ID = "catalog-oauth";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function oauthAuth(refresh: OAuthAuth["refresh"]): OAuthAuth {
	return {
		name: "Test OAuth",
		login: async () => {
			throw new Error("not used");
		},
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
}

function configuredCatalogBase(
	refresh: OAuthAuth["refresh"],
	seen: Array<RefreshModelsContext["credential"]>,
): Provider {
	return {
		...createProvider({
			id: PROVIDER_ID,
			auth: { oauth: oauthAuth(refresh) },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		refreshModelsAuth: "configured",
		refreshModels: async (context) => {
			if (context.allowNetwork) seen.push(context.credential);
		},
	};
}

async function refreshWithStaleLogin(
	extension: ProviderConfigInput | undefined,
	oauthRefresh: OAuthAuth["refresh"],
	seen: Array<RefreshModelsContext["credential"]>,
): Promise<ReadonlyMap<string, Error>> {
	const provider = composeModelProvider(
		PROVIDER_ID,
		configuredCatalogBase(oauthRefresh, seen),
		await ModelConfig.load(undefined),
		extension,
	);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(PROVIDER_ID, async () => ({
		type: "oauth",
		access: "expired",
		refresh: "old",
		expires: 0,
	}));
	const models = createModels({ credentials, modelsStore: new InMemoryModelsStore() });
	models.setProvider(provider);
	return (await models.refresh({ force: true })).errors;
}

const freshLogin = async () => ({
	type: "oauth" as const,
	access: "fresh",
	refresh: "rotated",
	expires: Date.now() + 3_600_000,
});
const revokedLogin = async (): Promise<never> => {
	throw new Error("invalid_grant");
};

describe("composed provider refresh auth", () => {
	it("keeps a built-in catalog's configured-only refresh, so a stale login neither refreshes nor fails it", async () => {
		const seen: Array<RefreshModelsContext["credential"]> = [];
		const oauthRefresh = vi.fn(revokedLogin);

		const errors = await refreshWithStaleLogin(undefined, oauthRefresh, seen);

		expect(errors.size).toBe(0);
		expect(oauthRefresh).not.toHaveBeenCalled();
		expect(seen).toEqual([undefined]);
	});

	it("keeps configured-only auth when an extension only changes the display name (#4610)", async () => {
		const seen: Array<RefreshModelsContext["credential"]> = [];
		const oauthRefresh = vi.fn(revokedLogin);
		const errors = await refreshWithStaleLogin({ name: "Renamed catalog" }, oauthRefresh, seen);
		expect(errors.size).toBe(0);
		expect(oauthRefresh).not.toHaveBeenCalled();
		expect(seen).toEqual([undefined]);
	});

	it("composes a configured extension-only provider without a built-in base (#4610)", async () => {
		const provider = composeModelProvider("custom", undefined, await ModelConfig.load(undefined), {
			name: "Custom",
			apiKey: "test-key",
		});
		const models = createModels();
		models.setProvider(provider);
		expect(await models.checkAuth("custom")).toBeDefined();
		expect((await models.refresh()).errors.size).toBe(0);
	});

	it("refreshes the login for an extension refreshModels hook that reads the credential", async () => {
		const seen: Array<RefreshModelsContext["credential"]> = [];
		const hookCredentials: Array<RefreshModelsContext["credential"]> = [];
		const oauthRefresh = vi.fn(freshLogin);

		const errors = await refreshWithStaleLogin(
			{
				refreshModels: async ({ credential, allowNetwork }) => {
					if (allowNetwork) hookCredentials.push(credential);
					return [];
				},
			},
			oauthRefresh,
			seen,
		);

		expect(errors.size).toBe(0);
		expect(oauthRefresh).toHaveBeenCalledTimes(1);
		expect(hookCredentials).toEqual([expect.objectContaining({ type: "oauth", access: "fresh" })]);
		expect(seen).toEqual([expect.objectContaining({ type: "oauth", access: "fresh" })]);
	});

	it("refreshes the login for an extension OAuth modifyModels hook", async () => {
		const seen: Array<RefreshModelsContext["credential"]> = [];
		const oauthRefresh = vi.fn(freshLogin);

		const errors = await refreshWithStaleLogin(
			{
				oauth: {
					name: "Extension OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refreshToken: async (credential) => credential,
					getApiKey: (credential) => credential.access,
					modifyModels: (models, credential) =>
						credential.access === "fresh" ? [...models, model("credential-model")] : models,
				},
			},
			oauthRefresh,
			seen,
		);

		expect(errors.size).toBe(0);
		expect(seen).toEqual([expect.objectContaining({ type: "oauth" })]);
	});
});
