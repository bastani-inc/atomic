import type { AuthStorage } from "./auth-storage.ts";
import type { ProviderConfigInput } from "./model-registry-types.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

export function resolveProviderDisplayName(
	provider: string,
	registered: ProviderConfigInput | undefined,
	oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>,
): string {
	return registered?.name ??
		registered?.oauth?.name ??
		oauthProviders.find((candidate) => candidate.id === provider)?.name ??
		BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
		provider;
}
