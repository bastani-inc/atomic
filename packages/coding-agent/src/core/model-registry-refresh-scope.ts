import type { ProviderConfigInput } from "./model-registry-types.js";

export interface ModelRegistryRefreshOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly force?: boolean;
	readonly allowNetwork?: boolean;
	readonly explicitRequiredProviders?: ReadonlySet<string>;
	readonly registeredProviders?: ReadonlySet<string>;
	readonly skipRequiredProviderExtensions?: boolean;
	readonly skipBuiltinProviders?: boolean;
}

export function providerIsInRefreshScope(
	provider: string,
	config: ProviderConfigInput | undefined,
	options: ModelRegistryRefreshOptions,
): boolean {
	if (options.registeredProviders) return options.registeredProviders.has(provider);
	if (options.skipRequiredProviderExtensions && config?.requiresPreparation === true) return false;
	return true;
}
