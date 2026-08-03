import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
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

	it("prefers explicit extension metadata over builtin defaults", () => {
		const extensions = new Map<string, ProviderConfigInput>([
			["anthropic", { oauth: { loginLabel: "Corporate Claude", usesCallbackServer: false } }],
		]);

		expect(collectOAuthProviderMetadata([oauthProvider("anthropic", "Sign in to Claude")], extensions)).toEqual([
			{ id: "anthropic", name: "Anthropic", loginLabel: "Corporate Claude", usesCallbackServer: false },
		]);
	});
});
