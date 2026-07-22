import type { ModelAuth, ProviderHeaders } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { withGitHubCopilotApiVersionHeader } from "./model-registry-builtins.ts";
import type { ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";
import type { ProviderApiKeyAuthResult } from "./extensions/provider-types.ts";

async function resolveCustomApiKeyAuth(
	provider: string,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
): Promise<ProviderApiKeyAuthResult | undefined> {
	const resolver = providerRequestConfigs.get(provider)?.auth?.apiKey?.resolve;
	if (!resolver) return undefined;
	const stored = authStorage.get(provider);
	const credential = stored?.type === "api_key" ? stored : undefined;
	return resolver({
		credential,
		ctx: { env: async (name) => credential?.env?.[name] ?? process.env[name] },
	});
}

export async function getProviderResolvedAuth(
	provider: string,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
): Promise<ProviderApiKeyAuthResult | undefined> {
	return resolveCustomApiKeyAuth(provider, authStorage, providerRequestConfigs);
}
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged: ProviderHeaders = {};
	for (const source of [base, override]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			for (const existing of Object.keys(merged)) {
				if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
			}
			merged[name] = value;
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function getModelRequestAuth(
	model: Model<Api>,
	authStorage: AuthStorage,
	providerRequestConfigs: Map<string, ProviderRequestConfig>,
	modelRequestHeaders: Map<string, Record<string, string>>,
	providerAuth?: ModelAuth,
): Promise<ResolvedRequestAuth> {
	try {
		const providerConfig = providerRequestConfigs.get(model.provider);
		const customAuth = await resolveCustomApiKeyAuth(model.provider, authStorage, providerRequestConfigs);
		const storedAuth = await authStorage.getModelAuth(model.provider, { includeFallback: false });
		const apiKey =
			providerAuth?.apiKey ??
			customAuth?.auth.apiKey ??
			storedAuth?.apiKey ??
			(providerConfig?.apiKey
				? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
				: undefined);

		const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
		const modelHeaders = resolveHeadersOrThrow(
			modelRequestHeaders.get(`${model.provider}:${model.id}`),
			`model "${model.provider}/${model.id}"`,
		);

		let headers = providerAuth
			? mergeHeaders(model.headers, providerAuth.headers)
			: mergeHeaders(storedAuth?.headers, model.headers);
		headers = mergeHeaders(headers, customAuth?.auth.headers);
		headers = mergeHeaders(headers, providerHeaders);
		headers = mergeHeaders(headers, modelHeaders);

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
			baseUrl: providerAuth?.baseUrl ?? customAuth?.auth.baseUrl ?? storedAuth?.baseUrl,
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
