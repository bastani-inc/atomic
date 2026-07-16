/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import { type Api, type Model, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { dirname } from "node:path";
import { getAgentConfigPaths } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { isSelectableModel } from "./cursor-model-reference.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { copilotCatalogCachePath, copilotTokenFromEnvironment, seedActiveCopilotModelCatalogFromCache } from "./copilot-model-catalog.ts";
import { getModelRequestAuth, getApiKeyForProviderFromConfig, getProviderAuthStatusFromConfig } from "./model-registry-auth.ts";
import { applyProviderConfigToModels, migrateLegacyRegisterProviderConfigValues, validateProviderConfig } from "./model-registry-dynamic.ts";
import { loadModelRegistryModels } from "./model-registry-loader.ts";
import { isTrustedCursorProviderSource } from "./extensions/provider-registration-source.ts";
import type { Extension } from "./extensions/runtime-types.ts";
import type { ModelRequestHeaders, ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { clearConfigValueCache, isConfigValueConfigured } from "./resolve-config-value.ts";

const REMOTE_CATALOG_PROVIDERS = new Set(["github-copilot", "openrouter", "vercel-ai-gateway"]);
const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);

export type { ProviderConfigInput, ResolvedRequestAuth } from "./model-registry-types.ts";

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: ModelRequestHeaders = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private builtInProviders: Set<string> = new Set();
	private customOpenAICompatibleProviders: Set<string> = new Set();
	private loadError: string | undefined = undefined;

	declare readonly authStorage: AuthStorage;
	declare private modelsJsonPaths: string[];
	declare private defaultProviderSource: Extension | undefined;

	private constructor(
		authStorage: AuthStorage,
		modelsJsonPaths: string[],
		defaultProviderSource?: Extension,
	) {
		this.authStorage = authStorage;
		this.modelsJsonPaths = modelsJsonPaths.map((path) => normalizePath(path));
		this.defaultProviderSource = isTrustedCursorProviderSource(defaultProviderSource) ? defaultProviderSource : undefined;
		this.seedCopilotModelCatalogFromCache();
		this.loadModels();
	}

	private seedCopilotModelCatalogFromCache(): void {
		if (this.modelsJsonPaths.length === 0) return;
		const cred = this.authStorage.get("github-copilot");
		const token = cred?.type === "oauth" && typeof cred.access === "string" ? cred.access : copilotTokenFromEnvironment();
		if (!token) return;
		seedActiveCopilotModelCatalogFromCache(token, copilotCatalogCachePath(dirname(this.modelsJsonPaths[0])));
	}

	static create(
		authStorage: AuthStorage,
		modelsJsonPath: string | string[] = getAgentConfigPaths("models.json"),
		defaultProviderSource?: Extension,
	): ModelRegistry {
		return new ModelRegistry(authStorage, Array.isArray(modelsJsonPath) ? modelsJsonPath : [modelsJsonPath], defaultProviderSource);
	}

	static inMemory(authStorage: AuthStorage, defaultProviderSource?: Extension): ModelRegistry {
		return new ModelRegistry(authStorage, [], defaultProviderSource);
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
		this.modelOverrides = loaded.modelOverrides;
		this.models = loaded.models;
		this.providerRequestConfigs = loaded.providerRequestConfigs;
		this.modelRequestHeaders = loaded.modelRequestHeaders;
		this.builtInProviders = loaded.builtInProviders;
		this.customOpenAICompatibleProviders = loaded.customOpenAICompatibleProviders;
		this.loadError = loaded.loadError;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models.filter(isSelectableModel);
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((model) => isSelectableModel(model) && this.hasConfiguredAuth(model));
	}

	/** Find a model by provider and exact current ID. */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((model) => model.provider === provider && model.id === modelId && isSelectableModel(model));
	}

	/**
	 * Whether an explicit model object is admissible for selection now.
	 * Cursor objects require identity membership in the current live registry;
	 * caller-created routing-shaped clones do not establish provenance.
	 */
	isCurrentModel(model: Model<Api>): boolean {
		return model.provider !== "cursor" || (this.models.includes(model) && isSelectableModel(model));
	}

	/** Whether an authenticated provider may reconstruct an absent saved model ID. */
	canRestoreUnknownModel(provider: string): boolean {
		if (REMOTE_CATALOG_PROVIDERS.has(provider)) return true;
		if (this.customOpenAICompatibleProviders.has(provider)) return true;
		if (this.builtInProviders.has(provider)) return false;

		const config = this.registeredProviders.get(provider);
		return (
			config?.models?.some((model) => {
				const api = model.api ?? config.api;
				return api !== undefined && OPENAI_COMPATIBLE_APIS.has(api);
			}) === true
		);
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
		const providerHeaders = this.modelRequestHeaders.get(providerName);
		if (!headers || Object.keys(headers).length === 0) {
			providerHeaders?.delete(modelId);
			if (providerHeaders?.size === 0) this.modelRequestHeaders.delete(providerName);
			return;
		}
		const nextProviderHeaders = new Map(providerHeaders ?? []);
		nextProviderHeaders.set(modelId, headers);
		this.modelRequestHeaders.set(providerName, nextProviderHeaders);
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
	registerProvider(providerName: string, config: ProviderConfigInput, source?: Extension): void {
		const registrationSource = isTrustedCursorProviderSource(source) ? source : this.defaultProviderSource;
		if (providerName === "cursor" && !registrationSource) {
			throw new Error("The cursor provider is reserved for authenticated first-party GetUsable discovery.");
		}
		const existingConfig = this.registeredProviders.get(providerName);
		const effectiveApi = config.api ?? existingConfig?.api;
		const effectiveStreamSimple = config.streamSimple ?? existingConfig?.streamSimple;
		if (effectiveApi === "cursor-agent" && effectiveStreamSimple && !registrationSource) {
			throw new Error("The cursor-agent stream boundary is reserved for the authenticated first-party Cursor provider.");
		}
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
	unregisterProvider(providerName: string, source?: Extension): void {
		const registrationSource = isTrustedCursorProviderSource(source) ? source : this.defaultProviderSource;
		if (providerName === "cursor" && !registrationSource) {
			throw new Error("The cursor provider is reserved for authenticated first-party GetUsable discovery.");
		}
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
			modelOverrides: this.modelOverrides,
			authStorage: this.authStorage,
			storeProviderRequestConfig: (name, requestConfig) => this.storeProviderRequestConfig(name, requestConfig),
			storeModelHeaders: (name, modelId, headers) => this.storeModelHeaders(name, modelId, headers),
		});
	}
}
