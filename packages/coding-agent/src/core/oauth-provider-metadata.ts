import type { Provider } from "@earendil-works/pi-ai";
import type { OAuthProviderMetadata } from "./oauth-login.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

export function collectOAuthProviderMetadata(
	providers: readonly Provider[],
	extensions: ReadonlyMap<string, ProviderConfigInput>,
): OAuthProviderMetadata[] {
	return providers.filter((provider) => provider.auth.oauth).map((provider) => {
		const extensionOAuth = extensions.get(provider.id)?.oauth;
		return {
			id: provider.id,
			name: provider.name ?? provider.id,
			...(extensionOAuth?.loginLabel ? { loginLabel: extensionOAuth.loginLabel } : {}),
			...(extensionOAuth?.usesCallbackServer !== undefined
				? { usesCallbackServer: extensionOAuth.usesCallbackServer }
				: {}),
		};
	});
}
