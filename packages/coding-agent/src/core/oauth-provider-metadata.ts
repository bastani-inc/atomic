import type { Provider } from "@earendil-works/pi-ai";
import type { OAuthProviderMetadata } from "./oauth-login.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

/**
 * Providers whose login races a loopback callback server against a pasted code.
 *
 * `usesCallbackServer` is what makes the terminal offer that paste input. The
 * flow needs it: the interactive host answers pi-ai's `manual_code` prompt with
 * a promise that only `showManualInput` ever resolves, so a provider missing
 * from this set issues the prompt into a input that is never shown and waits
 * for the callback until it times out.
 *
 * OpenRouter belongs here as of pi 0.83.0, which added the manual redirect-URL
 * fallback to its OAuth flow (upstream `61da9e2`, pi#7114) — its
 * `loginOpenRouter` now races `waitForCredential()` against a `manual_code`
 * prompt exactly as Anthropic and Codex do.
 */
const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex", "openrouter"]);

export function collectOAuthProviderMetadata(
	providers: readonly Provider[],
	extensions: ReadonlyMap<string, ProviderConfigInput>,
): OAuthProviderMetadata[] {
	return providers
		.filter((provider) => provider.auth.oauth)
		.map((provider) => {
			const providerOAuth = provider.auth.oauth;
			const extensionOAuth = extensions.get(provider.id)?.oauth;
			const loginLabel = extensionOAuth?.loginLabel ?? providerOAuth?.loginLabel;
			const hasCallbackServerMetadata =
				extensionOAuth?.usesCallbackServer !== undefined || CALLBACK_SERVER_PROVIDERS.has(provider.id);
			const usesCallbackServer = extensionOAuth?.usesCallbackServer ?? CALLBACK_SERVER_PROVIDERS.has(provider.id);
			return {
				id: provider.id,
				name: provider.name ?? provider.id,
				...(loginLabel ? { loginLabel } : {}),
				...(hasCallbackServerMetadata ? { usesCallbackServer } : {}),
			};
		});
}
