import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { withGitHubCopilotApiVersionHeader } from "./model-registry-builtins.ts";
import type { ModelRequestHeaders, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export async function getModelRequestAuth(
	model: Model<Api>,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
	modelRequestHeaders: ModelRequestHeaders,
): Promise<ResolvedRequestAuth> {
	try {
		const providerConfig = providerRequestConfigs.get(model.provider);
		const apiKeyFromAuthStorage = await authStorage.getApiKey(model.provider, { includeFallback: false });
		const apiKey =
			apiKeyFromAuthStorage ??
			(providerConfig?.apiKey
				? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
				: undefined);

		const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
		const modelHeaders = resolveHeadersOrThrow(
			modelRequestHeaders.get(model.provider)?.get(model.id),
			`model "${model.provider}/${model.id}"`,
		);

		let headers =
			model.headers || providerHeaders || modelHeaders
				? { ...model.headers, ...providerHeaders, ...modelHeaders }
				: undefined;

		if (providerConfig?.authHeader) {
			if (!apiKey) {
				return { ok: false, error: `No API key found for "${model.provider}"` };
			}
			headers = { ...headers, Authorization: `Bearer ${apiKey}` };
		}

		headers = withGitHubCopilotApiVersionHeader(model, headers);

		return {
			ok: true,
			apiKey,
			headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function getProviderAuthStatusFromConfig(
	provider: string,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
): AuthStatus {
	const authStatus = authStorage.getAuthStatus(provider);
	if (authStatus.source) {
		return authStatus;
	}

	const providerApiKey = providerRequestConfigs.get(provider)?.apiKey;
	if (!providerApiKey) {
		return authStatus;
	}

	if (isCommandConfigValue(providerApiKey)) {
		return { configured: true, source: "models_json_command" };
	}

	const envVarNames = getConfigValueEnvVarNames(providerApiKey);
	if (envVarNames.length > 0) {
		return isConfigValueConfigured(providerApiKey)
			? { configured: true, source: "environment", label: envVarNames.join(", ") }
			: { configured: false };
	}

	return { configured: true, source: "models_json_key" };
}

export async function getApiKeyForProviderFromConfig(
	provider: string,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
): Promise<string | undefined> {
	const apiKey = await authStorage.getApiKey(provider, { includeFallback: false });
	if (apiKey !== undefined) {
		return apiKey;
	}

	const providerApiKey = providerRequestConfigs.get(provider)?.apiKey;
	return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
}
