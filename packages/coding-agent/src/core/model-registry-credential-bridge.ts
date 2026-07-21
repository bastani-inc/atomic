import type { CredentialStore, ModelAuth } from "@earendil-works/pi-ai";
import { dirname } from "node:path";
import type { AuthStorage } from "./auth-storage.ts";
import { copilotApiBaseUrlFromToken, copilotCatalogCachePath, copilotTokenFromEnvironment, seedActiveCopilotModelCatalogFromCache } from "./copilot-model-catalog.ts";
import { getLegacyOAuthProvider, oauthCredentialToAuth } from "./oauth-provider-bridge.ts";

export function copilotBaseUrlFromRuntimeToken(apiKey: string): string | undefined {
	return /(?:^|;)proxy-ep=[^;]+/.test(apiKey) ? copilotApiBaseUrlFromToken(apiKey) : undefined;
}

export function overlayRuntimeApiKey(
	runtimeApiKey: string,
	resolvedAuth: ModelAuth | undefined,
	storedOAuthAuth: ModelAuth | undefined,
	runtimeBaseUrl: string | undefined,
): ModelAuth {
	const headers = storedOAuthAuth?.headers || resolvedAuth?.headers
		? { ...storedOAuthAuth?.headers, ...resolvedAuth?.headers }
		: undefined;
	return {
		...storedOAuthAuth,
		...resolvedAuth,
		apiKey: runtimeApiKey,
		headers,
		baseUrl: runtimeBaseUrl ?? storedOAuthAuth?.baseUrl ?? resolvedAuth?.baseUrl,
	};
}

export function createProviderCredentialStore(credentials: CredentialStore): CredentialStore {
	return {
		...credentials,
		read: async (providerId) => {
			const credential = await credentials.read(providerId);
			if (credential?.type !== "oauth" || !getLegacyOAuthProvider(providerId)) return credential;
			const auth = await oauthCredentialToAuth(providerId, credential);
			return auth?.apiKey === undefined ? undefined : { type: "api_key", key: auth.apiKey };
		},
	};
}

export function seedModelRegistryCopilotCatalog(authStorage: AuthStorage, modelsJsonPaths: readonly string[]): void {
	const firstPath = modelsJsonPaths[0];
	if (!firstPath) return;
	const credential = authStorage.get("github-copilot");
	const token = credential?.type === "oauth" && typeof credential.access === "string" ? credential.access : copilotTokenFromEnvironment();
	if (token) seedActiveCopilotModelCatalogFromCache(token, copilotCatalogCachePath(dirname(firstPath)));
}
