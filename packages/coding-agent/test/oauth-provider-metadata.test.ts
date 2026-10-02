import type { Provider } from "@bastani/pi-ai";
import { builtinProviders } from "@bastani/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { collectOAuthProviderMetadata } from "../src/core/oauth-provider-metadata.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";

function oauthProvider(id: string, loginLabel?: string): Provider {
	return {
		id,
		name: id === "anthropic" ? "Anthropic" : "OpenAI Codex",
		auth: {
			oauth: {
				name: `${id} OAuth`,
				...(loginLabel ? { loginLabel } : {}),
				login: async () => ({ type: "oauth", access: "token" }),
				refresh: async (credential) => credential,
				toAuth: async () => ({ key: "token" }),
			},
		},
	} as Provider;
}

describe("collectOAuthProviderMetadata", () => {
	it.each(["anthropic", "openai", "openai-codex", "openrouter"])(
		"preserves callback metadata when native %s is registered under a new ID (#3400)",
		(id) => {
			const builtin = builtinProviders().find((provider) => provider.id === id)!;
			const clone = { ...builtin, id: `${id}-3` };
			const [metadata] = collectOAuthProviderMetadata([clone], new Map());
			expect(metadata).toMatchObject({
				id: `${id}-3`,
				usesCallbackServer: true,
				isSubscription: builtin.auth.oauth?.isSubscription === true,
			});
		},
	);

	it.each(["anthropic", "corp"])("honors native callback opt-out for %s (#3400)", (id) => {
		const provider = oauthProvider(id);
		provider.auth.oauth!.usesCallbackServer = false;
		expect(collectOAuthProviderMetadata([provider], new Map())[0]).toMatchObject({ usesCallbackServer: false });
	});

	it("keeps legacy overrides ahead of native callback metadata (#3400)", () => {
		const provider = oauthProvider("corp");
		provider.auth.oauth!.usesCallbackServer = true;
		const extensions = new Map<string, ProviderConfigInput>([["corp", { oauth: { usesCallbackServer: false } }]]);
		expect(collectOAuthProviderMetadata([provider], extensions)[0]).toMatchObject({ usesCallbackServer: false });
	});

	it("leaves callback metadata absent for undeclared custom flows (#3400)", () => {
		expect(collectOAuthProviderMetadata([oauthProvider("corp")], new Map())[0]).not.toHaveProperty(
			"usesCallbackServer",
		);
	});

	it("preserves builtin callback-server and login-label metadata", () => {
		const metadata = collectOAuthProviderMetadata(builtinProviders(), new Map());

		expect(metadata.find(({ id }) => id === "anthropic")).toMatchObject({ usesCallbackServer: true });
		expect(metadata.find(({ id }) => id === "openai-codex")).toMatchObject({ usesCallbackServer: true });
		// pi 0.83.0 gave OpenRouter's OAuth flow the same manual redirect-URL
		// fallback (upstream 61da9e2). Without this flag the terminal never shows
		// the input its `manual_code` prompt is waiting on, so a remote or headless
		// login has no way through and ends at the callback timeout.
		expect(metadata.find(({ id }) => id === "openrouter")).toMatchObject({ usesCallbackServer: true });
		expect(metadata.find(({ id }) => id === "xai")).toMatchObject({
			loginLabel: "Sign in with SuperGrok or X Premium",
		});
	});

	it("marks only subscription-backed builtin sign-ins as subscriptions and leaves extension sign-ins unlabeled", () => {
		const metadata = collectOAuthProviderMetadata(builtinProviders(), new Map());

		expect(metadata.find(({ id }) => id === "anthropic")).toMatchObject({ isSubscription: true });
		expect(metadata.find(({ id }) => id === "openrouter")).toMatchObject({ isSubscription: false });

		const extensions = new Map<string, ProviderConfigInput>([["corp", { oauth: { loginLabel: "Corporate SSO" } }]]);
		const [corp] = collectOAuthProviderMetadata([oauthProvider("corp")], extensions);
		expect(corp).not.toHaveProperty("isSubscription");
	});

	it("prefers explicit extension metadata over builtin defaults", () => {
		const extensions = new Map<string, ProviderConfigInput>([
			["anthropic", { oauth: { loginLabel: "Corporate Claude", usesCallbackServer: false } }],
		]);

		expect(collectOAuthProviderMetadata([oauthProvider("anthropic", "Sign in to Claude")], extensions)).toEqual([
			{ id: "anthropic", name: "Anthropic", loginLabel: "Corporate Claude", usesCallbackServer: false },
		]);
	});
});
