import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { AuthContext } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicApiProvider, anthropicProvider } from "../src/providers/anthropic.ts";
import { openaiApiProvider, openaiProvider } from "../src/providers/openai.ts";

function envAuthContext(env: Record<string, string>): AuthContext {
	return { env: async (name) => env[name], fileExists: async () => false };
}

async function subscriptionStore(...providerIds: string[]): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	for (const providerId of providerIds) {
		await store.modify(providerId, async () => ({
			type: "oauth",
			access: "subscription-access",
			refresh: "subscription-refresh",
			expires: Date.now() + 3_600_000,
		}));
	}
	return store;
}

describe("API-key-only providers", () => {
	it("offer only API-key login", () => {
		for (const provider of [openaiApiProvider(), anthropicApiProvider()]) {
			expect(provider.auth.apiKey).toBeDefined();
			expect(provider.auth.oauth).toBeUndefined();
		}
	});

	it("mirror the source chat catalogs under their own provider ID", () => {
		const pairs = [
			[openaiProvider(), openaiApiProvider()],
			[anthropicProvider(), anthropicApiProvider()],
		] as const;
		for (const [source, apiOnly] of pairs) {
			const sourceIds = source.getModels().map((model) => model.id);
			expect(apiOnly.getModels().map((model) => model.id)).toEqual(sourceIds);
			expect(new Set(apiOnly.getModels().map((model) => model.provider))).toEqual(new Set([apiOnly.id]));
		}
	});

	it("use the env API key while the source provider stays on a subscription login", async () => {
		const models = createModels({
			credentials: await subscriptionStore("openai", "anthropic"),
			authContext: envAuthContext({ OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-ant-api" }),
		});
		for (const provider of [openaiProvider(), openaiApiProvider(), anthropicProvider(), anthropicApiProvider()]) {
			models.setProvider(provider);
		}

		expect((await models.checkAuth("openai"))?.type).toBe("oauth");
		expect((await models.checkAuth("anthropic"))?.type).toBe("oauth");
		expect(await models.getAuth("openai-api")).toMatchObject({ auth: { apiKey: "sk-openai" }, source: "OPENAI_API_KEY" });
		expect(await models.getAuth("anthropic-api")).toMatchObject({
			auth: { apiKey: "sk-ant-api" },
			source: "ANTHROPIC_API_KEY",
		});
	});

	it("never treat Anthropic subscription tokens from env as API keys", async () => {
		const models = createModels({
			authContext: envAuthContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat", ANTHROPIC_AUTH_TOKEN: "bearer" }),
		});
		models.setProvider(anthropicApiProvider());

		expect(await models.getAuth("anthropic-api")).toBeUndefined();
	});
});
