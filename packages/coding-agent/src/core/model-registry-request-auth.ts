import type { MutableModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStorage } from "./auth-storage.ts";
import { copilotBaseUrlFromRuntimeToken, overlayRuntimeApiKey } from "./model-registry-credential-bridge.ts";
import { getModelRequestAuth } from "./model-registry-auth.ts";
import type { ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import { getLegacyOAuthProvider, oauthCredentialToAuth } from "./oauth-provider-bridge.ts";
import { ProviderModelSelectionError } from "./provider-model-reference.ts";

export async function resolveRegistryRequestAuth(input: {
	readonly model: Model<Api>;
	readonly authStorage: AuthStorage;
	readonly providerModels: MutableModels;
	readonly registeredConfig: ProviderConfigInput | undefined;
	readonly providerRequestConfigs: Map<string, ProviderRequestConfig>;
	readonly modelRequestHeaders: Map<string, Record<string, string>>;
}): Promise<ResolvedRequestAuth> {
	const { model, authStorage, registeredConfig } = input;
	if (registeredConfig?.requiresHostOAuth) {
		while (true) {
			const before = authStorage.getCredentialSnapshot(model.provider);
			if (before.credential?.type === "oauth") registeredConfig.validateHostOAuth?.(before.credential);
			const storedOAuth = await authStorage.getModelAuth(model.provider, { includeFallback: false, storedOAuthOnly: true });
			const after = authStorage.getCredentialSnapshot(model.provider);
			if (after.credential?.type === "oauth") registeredConfig.validateHostOAuth?.(after.credential);
			if (before.generation !== after.generation) continue;
			if (!storedOAuth?.apiKey) throw new ProviderModelSelectionError("AuthenticationMissing", `AuthenticationMissing: Host-stored OAuth authentication is required for "${model.provider}".`, model.provider, model.id);
			const resolved = await getModelRequestAuth(model, authStorage, input.providerRequestConfigs, input.modelRequestHeaders, storedOAuth);
			const completed = authStorage.getCredentialSnapshot(model.provider);
			if (completed.credential?.type === "oauth") registeredConfig.validateHostOAuth?.(completed.credential);
			if (after.generation !== completed.generation) continue;
			return resolved;
		}
	}
	const runtimeApiKey = authStorage.getRuntimeApiKey(model.provider);
	const extensionReplacesOAuth = registeredConfig?.oauth !== undefined || getLegacyOAuthProvider(model.provider) !== undefined;
	const resolvedProviderAuth = input.providerModels.getProvider(model.provider) && !extensionReplacesOAuth
		? (await input.providerModels.getAuth(model, runtimeApiKey === undefined ? undefined : { apiKey: runtimeApiKey }))?.auth
		: undefined;
	const storedCredential = authStorage.get(model.provider);
	const storedOAuthAuth = runtimeApiKey !== undefined && !extensionReplacesOAuth && storedCredential?.type === "oauth"
		? await oauthCredentialToAuth(model.provider, storedCredential)
		: undefined;
	const runtimeBaseUrl = runtimeApiKey !== undefined && model.provider === "github-copilot"
		? copilotBaseUrlFromRuntimeToken(runtimeApiKey)
		: undefined;
	const providerAuth = runtimeApiKey === undefined
		? resolvedProviderAuth
		: overlayRuntimeApiKey(runtimeApiKey, resolvedProviderAuth, storedOAuthAuth, runtimeBaseUrl);
	return getModelRequestAuth(model, authStorage, input.providerRequestConfigs, input.modelRequestHeaders, providerAuth);
}
