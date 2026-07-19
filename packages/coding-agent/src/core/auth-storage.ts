/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type ModelAuth,
	type OAuthCredential as PiOAuthCredential,
	type OAuthCredentials,
} from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { join } from "path";
import { getAgentConfigPaths, getAgentDir } from "../config.ts";
import { FileAuthStorageBackend, InMemoryAuthStorageBackend, type AuthStorageBackend } from "./auth-storage-backends.ts";
import {
	type AtomicOAuthLoginCallbacks,
	getOAuthProviderDescriptors,
	loginOAuthProvider,
	oauthCredentialToAuth,
	refreshOAuthProvider,
} from "./oauth-provider-bridge.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export { FileAuthStorageBackend, InMemoryAuthStorageBackend, type AuthStorageBackend } from "./auth-storage-backends.ts";

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private credentialMutationTail: Promise<void> = Promise.resolve();
	private credentialVersions = new Map<string, number>();

	declare private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(
			new FileAuthStorageBackend(
				authPath ?? join(getAgentDir(), "auth.json"),
				authPath ? [authPath] : getAgentConfigPaths("auth.json"),
			),
		);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}
	/** Read a non-persisted request override without resolving stored credentials. */
	getRuntimeApiKey(provider: string): string | undefined {
		return this.runtimeOverrides.get(provider);
	}


	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		try {
			// Pure read: never take the exclusive write lock. Writers replace
			// auth.json atomically, so a lock-free read always sees a complete
			// snapshot. This keeps many concurrent sessions from starving each other
			// on the lock and misreporting configured providers as unreadable under
			// contention (issue #1431).
			const content = this.readSnapshot();
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	/**
	 * Read the credential snapshot, preferring the backend's lock-free `read()`.
	 * Falls back to a `withLock`-based read for custom backends that predate
	 * `read()` so the released `AuthStorageBackend` interface stays compatible.
	 */
	private readSnapshot(): string | undefined {
		if (this.storage.read) {
			return this.storage.read();
		}
		let content: string | undefined;
		this.storage.withLock((current) => {
			content = current;
			return { result: undefined };
		});
		return content;
	}

	private bumpCredentialVersion(provider: string): void {
		this.credentialVersions.set(provider, (this.credentialVersions.get(provider) ?? 0) + 1);
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			this.reload();
			if (this.loadError) throw this.loadError;
		}

		try {
			const persistedData = this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: merged, next: JSON.stringify(merged, null, 2) };
			});
			this.data = persistedData;
			this.bumpCredentialVersion(provider);
			this.loadError = null;
		} catch (error) {
			this.recordError(error);
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/** Return a copy of all persisted credentials. */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Returns the error from the most recent failed credential load, or null when
	 * the last reload succeeded.
	 *
	 * A non-null value means stored credentials could NOT be read — e.g. the auth
	 * file was temporarily locked by another process (ELOCKED) or contained
	 * invalid JSON — so an empty/absent credential set is NOT authoritative.
	 * Callers that would otherwise report "No API key found" should surface this
	 * load failure instead of treating the provider as unauthenticated
	 * (issue #1431).
	 */
	getLoadError(): Error | null {
		return this.loadError;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: string, callbacks: AtomicOAuthLoginCallbacks): Promise<void> {
		const credential = await loginOAuthProvider(providerId, callbacks);
		await this.asCredentialStore().modify(providerId, async () => credential);
	}

	/** Logout through the preserved synchronous persistence path. */
	logout(provider: string): void {
		this.remove(provider);
	}

	/** Serialized logout for callers that need persistence completion. */
	async logoutAsync(provider: string): Promise<void> {
		await this.asCredentialStore().delete(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: string,
	): Promise<{ auth: ModelAuth; newCredentials: OAuthCredentials } | null> {
		return this.runCredentialMutation(async () => {
			let synchronizedData: AuthStorageData | undefined;
			const credentialVersion = this.credentialVersions.get(providerId) ?? 0;
			const result = await this.storage.withLockAsync(async (current) => {
				const currentData = this.parseStorageData(current);
				synchronizedData = currentData;
				const cred = currentData[providerId];
				if (cred?.type !== "oauth") return { result: null };

				const oauthCredential: PiOAuthCredential = { ...cred, type: "oauth" };
				if (Date.now() < cred.expires) {
					const auth = await oauthCredentialToAuth(providerId, oauthCredential);
					return { result: auth ? { auth, newCredentials: cred } : null };
				}

				const refreshed = await refreshOAuthProvider(providerId, oauthCredential);
				if (!refreshed) return { result: null };
				if ((this.credentialVersions.get(providerId) ?? 0) !== credentialVersion) {
					synchronizedData = undefined;
					return { result: null };
				}
				const merged: AuthStorageData = {
					...currentData,
					[providerId]: refreshed.credential,
				};
				synchronizedData = merged;
				return {
					result: { auth: refreshed.auth, newCredentials: refreshed.credential },
					next: JSON.stringify(merged, null, 2),
				};
			});

			if (synchronizedData) this.data = synchronizedData;
			this.loadError = null;
			return result;
		});
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getModelAuth(providerId: string, options?: { includeFallback?: boolean }): Promise<ModelAuth | undefined> {
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) return { apiKey: runtimeKey };

		const cred = this.data[providerId];
		if (cred?.type === "api_key") return { apiKey: resolveConfigValue(cred.key) };

		if (cred?.type === "oauth") {
			try {
				if (Date.now() >= cred.expires) {
					return (await this.refreshOAuthTokenWithLock(providerId))?.auth;
				}
				return await oauthCredentialToAuth(providerId, { ...cred, type: "oauth" });
			} catch (error) {
				this.recordError(error);
				this.reload();
				const updated = this.data[providerId];
				if (updated?.type === "oauth" && Date.now() < updated.expires) {
					return oauthCredentialToAuth(providerId, { ...updated, type: "oauth" });
				}
				return undefined;
			}
		}

		const envKey = getEnvApiKey(providerId);
		if (envKey) return { apiKey: envKey };
		if (options?.includeFallback !== false) {
			const fallback = this.fallbackResolver?.(providerId);
			if (fallback) return { apiKey: fallback };
		}
		return undefined;
	}

	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		return (await this.getModelAuth(providerId, options))?.apiKey;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviderDescriptors();
	}

	private runCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.credentialMutationTail.then(operation, operation);
		this.credentialMutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Private async adapter for pi-ai's provider-owned Models runtime. */
	asCredentialStore(): CredentialStore {
		const runtimeCredential = (providerId: string): Credential | undefined => {
			const key = this.runtimeOverrides.get(providerId);
			return key === undefined ? undefined : { type: "api_key", key };
		};
		return {
			read: async (providerId) => runtimeCredential(providerId) ?? (this.get(providerId) as Credential | undefined),
			list: async (): Promise<readonly CredentialInfo[]> => {
				const providers = new Set([...this.list(), ...this.runtimeOverrides.keys()]);
				return [...providers].map((providerId) => ({
					providerId,
					type: runtimeCredential(providerId)?.type ?? this.data[providerId].type,
				}));
			},
			modify: (providerId, fn) =>
				this.runCredentialMutation(async () => {
					let synchronizedData: AuthStorageData | undefined;
					try {
						const result = await this.storage.withLockAsync(async (current) => {
							const data = this.parseStorageData(current);
							const next = await fn(data[providerId] as Credential | undefined);
							if (next === undefined) {
								synchronizedData = data;
								return { result: data[providerId] as Credential | undefined };
							}
							const merged = { ...data, [providerId]: next as AuthCredential };
							synchronizedData = merged;
							return { result: next, next: JSON.stringify(merged, null, 2) };
						});
						if (synchronizedData) {
							this.data = synchronizedData;
							this.bumpCredentialVersion(providerId);
						}
						this.loadError = null;
						return result;
					} catch (error) {
						this.recordError(error);
						throw error;
					}
				}),
			delete: (providerId) =>
				this.runCredentialMutation(async () => {
					let synchronizedData: AuthStorageData | undefined;
					try {
						await this.storage.withLockAsync(async (current) => {
							const data = this.parseStorageData(current);
							delete data[providerId];
							synchronizedData = data;
							return { result: undefined, next: JSON.stringify(data, null, 2) };
						});
						if (synchronizedData) {
							this.data = synchronizedData;
							this.bumpCredentialVersion(providerId);
						}
						this.loadError = null;
					} catch (error) {
						this.recordError(error);
						throw error;
					}
				}),
		};
	}
}
