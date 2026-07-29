import type { Provider } from "@earendil-works/pi-ai";
import type { OAuthProviderMetadata } from "./oauth-login.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex"]);

export function collectOAuthProviderMetadata(
	providers: readonly Provider[],
	extensions: ReadonlyMap<string, ProviderConfigInput>,
): OAuthProviderMetadata[] {
	return providers.filter((provider) => provider.auth.oauth).map((provider) => {
		const providerOAuth = provider.auth.oauth;
		const extensionOAuth = extensions.get(provider.id)?.oauth;
		const loginLabel = extensionOAuth?.loginLabel ?? providerOAuth?.loginLabel;
		const hasCallbackServerMetadata = extensionOAuth?.usesCallbackServer !== undefined
			|| CALLBACK_SERVER_PROVIDERS.has(provider.id);
		const usesCallbackServer = extensionOAuth?.usesCallbackServer
			?? CALLBACK_SERVER_PROVIDERS.has(provider.id);
		return {
			id: provider.id,
			name: provider.name ?? provider.id,
			...(loginLabel ? { loginLabel } : {}),
			...(hasCallbackServerMetadata ? { usesCallbackServer } : {}),
		};
	});
}
