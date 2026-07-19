import {
	type AuthInteraction,
	type ModelAuth,
	type OAuthAuth,
	type OAuthCredential,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

export interface LegacyOAuthProvider {
	name: string;
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

export interface OAuthProviderDescriptor extends LegacyOAuthProvider {
	id: string;
	loginLabel?: string;
}

export interface AtomicOAuthLoginCallbacks extends OAuthLoginCallbacks {
	onManualCodeCancel?(): void;
}

const GLOBAL_LEGACY_SOURCE = "atomic:legacy-global";
const legacyProviders = new Map<string, Map<string, LegacyOAuthProvider>>();
const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex"]);

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(signal.reason ?? new Error("Authentication prompt cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort?.();
			reject(signal.reason ?? new Error("Authentication prompt cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
function builtinOAuth(providerId: string): OAuthAuth | undefined {
	return builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
}

function toInteraction(callbacks: AtomicOAuthLoginCallbacks): AuthInteraction {
	return {
		signal: callbacks.signal,
		prompt: async (prompt) => {
			switch (prompt.type) {
				case "select":
					return (
						(await callbacks.onSelect({
							message: prompt.message,
							options: prompt.options.map(({ id, label }) => ({ id, label })),
						})) ?? ""
					);
				case "manual_code":
					return abortable(
						callbacks.onManualCodeInput
							? callbacks.onManualCodeInput()
							: callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder }),
						prompt.signal,
						callbacks.onManualCodeCancel,
					);
				default:
					return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode(event);
					break;
				case "progress":
				case "info":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
	};
}

function latestLegacyProvider(providerId: string): LegacyOAuthProvider | undefined {
	const providers = legacyProviders.get(providerId);
	return providers ? [...providers.values()].at(-1) : undefined;
}

export function registerLegacyOAuthProvider(
	providerId: string,
	provider: LegacyOAuthProvider,
	sourceId: string = GLOBAL_LEGACY_SOURCE,
): void {
	const providers = legacyProviders.get(providerId) ?? new Map<string, LegacyOAuthProvider>();
	providers.delete(sourceId);
	providers.set(sourceId, provider);
	legacyProviders.set(providerId, providers);
}
/** Legacy registry aliases retained for Atomic's extension/test compatibility. */
export function registerOAuthProvider(provider: LegacyOAuthProvider & { id: string }): void {
	registerLegacyOAuthProvider(provider.id, provider);
}

export function getOAuthProvider(providerId: string): OAuthProviderDescriptor | undefined {
	const provider = latestLegacyProvider(providerId);
	return provider ? { id: providerId, ...provider } : getOAuthProviderDescriptors().find((entry) => entry.id === providerId);
}

export function resetLegacyOAuthProviders(): void {
	legacyProviders.clear();
}

export function unregisterLegacyOAuthProviders(sourceId: string): void {
	for (const [providerId, providers] of legacyProviders) {
		providers.delete(sourceId);
		if (providers.size === 0) legacyProviders.delete(providerId);
	}
}

export function getLegacyOAuthProvider(providerId: string): LegacyOAuthProvider | undefined {
	return latestLegacyProvider(providerId);
}

export function getOAuthProviders(): OAuthProviderDescriptor[] {
	return getOAuthProviderDescriptors();
}

export const resetOAuthProviders = resetLegacyOAuthProviders;
export function getOAuthProviderDescriptors(): OAuthProviderDescriptor[] {
	const descriptors = new Map<string, OAuthProviderDescriptor>();
	for (const provider of builtinProviders()) {
		const oauth = provider.auth.oauth;
		if (!oauth) continue;
		descriptors.set(provider.id, {
			id: provider.id,
			name: oauth.name,
			loginLabel: oauth.loginLabel,
			usesCallbackServer: CALLBACK_SERVER_PROVIDERS.has(provider.id),
			login: async (callbacks) => oauth.login(toInteraction(callbacks)),
			refreshToken: async (credentials) => oauth.refresh({ ...credentials, type: "oauth" }),
			getApiKey: (credentials) => credentials.access,
		});
	}
	for (const [id, providers] of legacyProviders) {
		const provider = [...providers.values()].at(-1);
		if (provider) descriptors.set(id, { id, ...provider });
	}
	return [...descriptors.values()];
}

export async function loginOAuthProvider(
	providerId: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<OAuthCredential> {
	const legacy = latestLegacyProvider(providerId);
	if (legacy) return { type: "oauth", ...(await legacy.login(callbacks)) };
	const oauth = builtinOAuth(providerId);
	if (!oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
	return oauth.login(toInteraction(callbacks));
}

export async function refreshOAuthProvider(
	providerId: string,
	credential: OAuthCredential,
): Promise<{ credential: OAuthCredential; auth: ModelAuth } | undefined> {
	const legacy = latestLegacyProvider(providerId);
	if (legacy) {
		const { type: _type, ...credentials } = credential;
		const refreshed = { type: "oauth" as const, ...(await legacy.refreshToken(credentials)) };
		return { credential: refreshed, auth: { apiKey: legacy.getApiKey(refreshed) } };
	}
	const oauth = builtinOAuth(providerId);
	if (!oauth) return undefined;
	const refreshed = await oauth.refresh(credential);
	return { credential: refreshed, auth: await oauth.toAuth(refreshed) };
}

export async function oauthCredentialToAuth(
	providerId: string,
	credential: OAuthCredential,
): Promise<ModelAuth | undefined> {
	const legacy = latestLegacyProvider(providerId);
	if (legacy) return { apiKey: legacy.getApiKey(credential) };
	return builtinOAuth(providerId)?.toAuth(credential);
}

export async function getOAuthApiKey(
	providerId: string,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	if (!getOAuthProvider(providerId)) throw new Error(`Unknown OAuth provider: ${providerId}`);
	const selected = credentials[providerId];
	if (!selected) return null;
	const credential: OAuthCredential = { type: "oauth", ...selected };
	const resolved = Date.now() >= credential.expires
		? await refreshOAuthProvider(providerId, credential)
		: { credential, auth: await oauthCredentialToAuth(providerId, credential) };
	const apiKey = resolved?.auth?.apiKey;
	if (!resolved || !apiKey) return null;
	const { type: _type, ...newCredentials } = resolved.credential;
	return { newCredentials, apiKey };
}
