import {
	type AuthInfoLink,
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
	loginLabel?: string;
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


/** JSON-safe OAuth metadata transported across isolated-engine boundaries. */
export interface OAuthProviderMetadata {
	id: string;
	name: string;
	loginLabel?: string;
	usesCallbackServer?: boolean;
}
export interface AtomicOAuthLoginCallbacks extends OAuthLoginCallbacks {
	onManualCodeCancel?(): void;
	onInfo?(message: string, links: readonly AuthInfoLink[]): void;
}

const GLOBAL_LEGACY_SOURCE = "atomic:legacy-global";
const legacyProviders = new Map<string, Map<string, LegacyOAuthProvider>>();
const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex"]);
/** Marks failures after credential acquisition so presentation never mistakes nested AbortErrors for cancellation. */
export class OAuthLoginTransactionError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "OAuthLoginTransactionError";
	}
}

/** Cycle-safe classification shared by direct, provider-owned, and isolated OAuth. */
export function isOAuthLoginCancelled(
	error: unknown,
	signal?: AbortSignal,
	options: { includeActiveSignal?: boolean } = {},
): boolean {
	if (error instanceof OAuthLoginTransactionError) return false;
	if (options.includeActiveSignal !== false && signal?.aborted) return true;
	const reason = signal?.reason;
	const seen = new Set<object>();
	let current: unknown = error;
	while (current !== undefined && current !== null) {
		if (current === reason && reason !== undefined) return true;
		if (current === "Login cancelled") return true;
		if (typeof current !== "object") return false;
		if (seen.has(current)) return false;
		seen.add(current);
		const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
		if (candidate.name === "AbortError" || candidate.message === "Login cancelled") return true;
		current = candidate.cause;
	}
	return false;
}

/** Canonicalize only intentional cancellation while retaining the provider error as cause. */
export function normalizeOAuthLoginError(
	error: unknown,
	signal?: AbortSignal,
	options?: { includeActiveSignal?: boolean },
): unknown {
	if (error instanceof Error && error.message === "Login cancelled" && error.cause !== undefined) return error;
	if (!isOAuthLoginCancelled(error, signal, options)) return error;
	return new Error("Login cancelled", { cause: error });
}

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

export function createAuthInteraction(callbacks: AtomicOAuthLoginCallbacks): AuthInteraction {
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
					callbacks.onProgress?.(event.message);
					break;
				case "info":
					callbacks.onInfo?.(event.message, event.links ?? []);
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
			login: async (callbacks) => oauth.login(createAuthInteraction(callbacks)),
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

export function getOAuthProviderMetadata(): OAuthProviderMetadata[] {
	return getOAuthProviderDescriptors().map(({ id, name, loginLabel, usesCallbackServer }) => ({
		id,
		name,
		...(loginLabel === undefined ? {} : { loginLabel }),
		...(usesCallbackServer === undefined ? {} : { usesCallbackServer }),
	}));
}

export async function loginOAuthProvider(
	providerId: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<OAuthCredential> {
	const legacy = latestLegacyProvider(providerId);
	const oauth = legacy ? undefined : builtinOAuth(providerId);
	if (!legacy && !oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
	if (callbacks.signal?.aborted) {
		throw normalizeOAuthLoginError(callbacks.signal.reason, callbacks.signal);
	}
	try {
		const credential = legacy
			? { type: "oauth" as const, ...(await legacy.login(callbacks)) }
			: await oauth!.login(createAuthInteraction(callbacks));
		if (callbacks.signal?.aborted) {
			throw normalizeOAuthLoginError(callbacks.signal.reason, callbacks.signal);
		}
		return credential;
	} catch (error) {
		throw normalizeOAuthLoginError(error, callbacks.signal);
	}
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
	let resolved: { credential: OAuthCredential; auth: ModelAuth | undefined } | undefined;
	if (Date.now() >= credential.expires) {
		try {
			resolved = await refreshOAuthProvider(providerId, credential);
		} catch (cause) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`, { cause });
		}
	} else {
		resolved = { credential, auth: await oauthCredentialToAuth(providerId, credential) };
	}
	const apiKey = resolved?.auth?.apiKey;
	if (!resolved || !apiKey) return null;
	const { type: _type, ...newCredentials } = resolved.credential;
	return { newCredentials, apiKey };
}
