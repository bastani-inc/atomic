import type { Credential, Provider } from "@bastani/pi-ai";
import * as builtinProviderCatalog from "@bastani/pi-ai/providers/all";
import { type CopilotRoutingEnv, withCopilotEnvBaseUrl } from "@bastani/pi-ai/providers/github-copilot-env";
import type { ModelConfig } from "./model-config.ts";

/** Rebuild the builtin layer, including configured Radius gateways. */
export function configureBuiltinProviders(
	target: Map<string, Provider>,
	defaults: ReadonlyMap<string, Provider>,
	config: ModelConfig,
	env: CopilotRoutingEnv = process.env,
	getStoredCredential: (providerId: string) => Credential | undefined = () => undefined,
): void {
	target.clear();
	// Raw Copilot tokens, from the environment or saved through /login, need a routed
	// host; models.json overrides still win because they compose on top of this layer.
	for (const [providerId, provider] of defaults) {
		const getStoredApiKey = () => {
			const credential = getStoredCredential(providerId);
			return credential?.type === "api_key" ? credential.key : undefined;
		};
		target.set(providerId, withCopilotEnvBaseUrl(provider, env, getStoredApiKey));
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
