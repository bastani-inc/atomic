import type { Credential, Provider } from "@bastani/atomic-ai";
import { type CopilotRoutingEnv, withCopilotEnvBaseUrl } from "@bastani/atomic-ai/providers/github-copilot-env";

/** Rebuild the builtin layer. */
export function configureBuiltinProviders(
	target: Map<string, Provider>,
	defaults: ReadonlyMap<string, Provider>,
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
}
