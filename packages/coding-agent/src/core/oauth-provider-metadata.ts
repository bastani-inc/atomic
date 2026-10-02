import type { Provider } from "@bastani/pi-ai";
import type { OAuthProviderMetadata } from "./oauth-login.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai", "openai-codex", "openrouter"]);

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
			const usesCallbackServer =
				extensionOAuth?.usesCallbackServer ??
				providerOAuth?.usesCallbackServer ??
				(CALLBACK_SERVER_PROVIDERS.has(provider.id) ? true : undefined);
			return {
				id: provider.id,
				name: provider.name ?? provider.id,
				...(loginLabel ? { loginLabel } : {}),
				...(usesCallbackServer !== undefined ? { usesCallbackServer } : {}),
				...(extensionOAuth ? {} : { isSubscription: providerOAuth?.isSubscription === true }),
			};
		});
}
