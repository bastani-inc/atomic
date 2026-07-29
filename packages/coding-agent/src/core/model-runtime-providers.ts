import type { Provider } from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { type CopilotRoutingEnv, withCopilotEnvBaseUrl } from "./copilot-env-routing.ts";
import type { ModelConfig } from "./model-config.ts";

/** Rebuild the builtin layer, including configured Radius gateways. */
export function configureBuiltinProviders(
	target: Map<string, Provider>,
	defaults: ReadonlyMap<string, Provider>,
	config: ModelConfig,
	env: CopilotRoutingEnv = process.env,
): void {
	target.clear();
	// Copilot env-token auth needs a routed host; models.json overrides still win
	// because they are composed on top of this builtin layer.
	for (const [providerId, provider] of defaults) {
		target.set(providerId, withCopilotEnvBaseUrl(provider, env));
	}
	for (const providerId of config.getProviderIds()) {
		const providerConfig = config.getProvider(providerId);
		if (providerConfig?.oauth !== "radius" || !providerConfig.baseUrl) continue;
		target.set(
			providerId,
			builtinProviderCatalog.radiusProvider({
				id: providerId,
				name: providerConfig.name ?? providerId,
				gateway: providerConfig.baseUrl.replace(/\/v1\/?$/u, ""),
			}),
		);
	}
}
