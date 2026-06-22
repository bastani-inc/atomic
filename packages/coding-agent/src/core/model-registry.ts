/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import { type Api, type Model, resetApiProviders } from "@earendil-works/pi-ai";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { dirname } from "node:path";
import { getAgentConfigPaths } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { copilotCatalogCachePath, seedActiveCopilotModelCatalogFromCache } from "./copilot-model-catalog.ts";
import { getModelRequestAuth, getApiKeyForProviderFromConfig, getProviderAuthStatusFromConfig } from "./model-registry-auth.ts";
import { applyProviderConfigToModels, migrateLegacyRegisterProviderConfigValues, validateProviderConfig } from "./model-registry-dynamic.ts";
import { loadModelRegistryModels } from "./model-registry-loader.ts";
import type { ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { clearConfigValueCache, isConfigValueConfigured } from "./resolve-config-value.ts";

export type { ProviderConfigInput, ResolvedRequestAuth } from "./model-registry-types.ts";

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private loadError: string | undefined = undefined;

	declare readonly authStorage: AuthStorage;
	declare private modelsJsonPaths: string[];

	private constructor(
		authStorage: AuthStorage,
		modelsJsonPaths: string[],
	) {
		this.authStorage = authStorage;
		this.modelsJsonPaths = modelsJsonPaths.map((path) => normalizePath(path));
		this.seedCopilotModelCatalogFromCache();
		this.loadModels();
	}

	private seedCopilotModelCatalogFromCache(): void {
		if (this.modelsJsonPaths.length === 0) return;
		const cred = this.authStorage.get("github-copilot");
		if (!cred || cred.type !== "oauth" || typeof cred.access !== "string") return;
		seedActiveCopilotModelCatalogFromCache(cred.access, copilotCatalogCachePath(dirname(this.modelsJsonPaths[0])));
	}

	static create(
		authStorage: AuthStorage,
		modelsJsonPath: string | string[] = getAgentConfigPaths("models.json"),
	): ModelRegistry {
		return new ModelRegistry(authStorage, Array.isArray(modelsJsonPath) ? modelsJsonPath : [modelsJsonPath]);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, []);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.loadError = undefined;

		resetApiProviders();
		resetOAuthProviders();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		const loaded = loadModelRegistryModels(this.authStorage, this.modelsJsonPaths);
		this.models = loaded.models;
		this.providerRequestConfigs = loaded.providerRequestConfigs;
		this.modelRequestHeaders = loaded.modelRequestHeaders;
		this.loadError = loaded.loadError;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((m) => this.hasConfiguredAuth(m));
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		return (
			this.authStorage.hasAuth(model.provider) ||
			(providerApiKey !== undefined && isConfigValueConfigured(providerApiKey))
		);
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * Get API key and request headers for a model.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		return getModelRequestAuth(model, this.authStorage, this.providerRequestConfigs, this.modelRequestHeaders);
	}

	/**
	 * Return auth status for a provider, including request auth configured in models.json.
	 * This intentionally does not execute command-backed config values.
	 */
	getProviderAuthStatus(provider: string): AuthStatus {
		return getProviderAuthStatusFromConfig(provider, this.authStorage, this.providerRequestConfigs);
	}

	/**
	 * Get display name for a provider.
	 */
	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);
		const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

		return (
			registeredProvider?.name ??
			registeredProvider?.oauth?.name ??
			oauthProvider?.name ??
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			provider
		);
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return getApiKeyForProviderFromConfig(provider, this.authStorage, this.providerRequestConfigs);
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically (from extensions).
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		const migratedConfig = migrateLegacyRegisterProviderConfigValues(providerName, config);
		validateProviderConfig(providerName, migratedConfig);
		this.applyProviderConfig(providerName, migratedConfig);
		this.upsertRegisteredProvider(providerName, migratedConfig);
	}

	/**
	 * Check whether extensions have registered custom streamSimple dispatch for an API.
	 */
	hasRegisteredStreamSimpleForApi(api: Api): boolean {
		for (const config of this.registeredProviders.values()) {
			if (config.api === api && config.streamSimple) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Unregister a previously registered provider.
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, config);
			return;
		}
		for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[k] !== undefined) {
				(existing as Record<string, unknown>)[k] = config[k];
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		this.models = applyProviderConfigToModels({
			providerName,
			config,
			models: this.models,
			authStorage: this.authStorage,
			storeProviderRequestConfig: (name, requestConfig) => this.storeProviderRequestConfig(name, requestConfig),
			storeModelHeaders: (name, modelId, headers) => this.storeModelHeaders(name, modelId, headers),
		});
	}
}
