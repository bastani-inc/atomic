/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	createModels,
	type Credential,
	type CredentialStore,
	type ModelAuth,
	type ModelsRefreshResult,
	type ModelsStore,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { dirname, join } from "node:path";
import { getAgentConfigPaths } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { copilotApiBaseUrlFromToken, copilotCatalogCachePath, copilotTokenFromEnvironment, seedActiveCopilotModelCatalogFromCache } from "./copilot-model-catalog.ts";
import { getModelRequestAuth, getApiKeyForProviderFromConfig, getProviderAuthStatusFromConfig } from "./model-registry-auth.ts";
import { applyProviderConfigToModels, migrateLegacyRegisterProviderConfigValues, unregisterProviderRuntime, validateProviderConfig } from "./model-registry-dynamic.ts";
import { loadModelRegistryModels } from "./model-registry-loader.ts";
import type { ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import { getLegacyOAuthProvider, oauthCredentialToAuth } from "./oauth-provider-bridge.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { clearConfigValueCache, isConfigValueConfigured } from "./resolve-config-value.ts";

const REMOTE_CATALOG_PROVIDERS = new Set(["cursor", "github-copilot", "openrouter", "vercel-ai-gateway"]);
const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);
let nextRegistryRegistrationId = 0;

function copilotBaseUrlFromRuntimeToken(apiKey: string): string | undefined {
	return /(?:^|;)proxy-ep=[^;]+/.test(apiKey) ? copilotApiBaseUrlFromToken(apiKey) : undefined;
}

function overlayRuntimeApiKey(
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

function createProviderCredentialStore(credentials: CredentialStore): CredentialStore {
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
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private builtInProviders: Set<string> = new Set();
	private customOpenAICompatibleProviders: Set<string> = new Set();
	private loadError: string | undefined = undefined;
	private refreshGeneration = 0;
	private readonly registrationSource = `atomic:model-registry:${++nextRegistryRegistrationId}`;
	declare private readonly modelsStore: ModelsStore;
	declare private readonly credentialStore: CredentialStore;
	declare private readonly providerModels: MutableModels;

	declare readonly authStorage: AuthStorage;
	declare private modelsJsonPaths: string[];

	private constructor(
		authStorage: AuthStorage,
		modelsJsonPaths: string[],
	) {
		this.authStorage = authStorage;
		this.modelsJsonPaths = modelsJsonPaths.map((path) => normalizePath(path));
		this.modelsStore = this.modelsJsonPaths.length > 0
			? new FileModelsStore(join(dirname(this.modelsJsonPaths[0]), "models-store.json"))
			: new InMemoryCodingAgentModelsStore();
		this.credentialStore = authStorage.asCredentialStore();
		this.providerModels = createModels({
			credentials: createProviderCredentialStore(this.credentialStore),
			modelsStore: this.modelsStore,
		});
		for (const provider of builtinProviders()) {
			this.providerModels.setProvider(provider.id === "radius" ? provider : withRemoteCatalog(provider));
		}
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
	): ModelRegistry {
		return new ModelRegistry(authStorage, Array.isArray(modelsJsonPath) ? modelsJsonPath : [modelsJsonPath]);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, []);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	async refresh(options: { signal?: AbortSignal; timeoutMs?: number; force?: boolean; allowNetwork?: boolean } = {}): Promise<ModelsRefreshResult> {
		const generation = ++this.refreshGeneration;
		this.loadError = undefined;
		this.rebuildProviderModels();

		const controller = new AbortController();
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) controller.abort(options.signal.reason);
		const timeout = setTimeout(abort, options.timeoutMs ?? 15_000);
		const errors = new Map<string, Error>();
		const aborted = new Promise<void>((resolve) => {
			if (controller.signal.aborted) resolve();
			else controller.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		try {
			const restore = this.providerModels
				.refresh({ allowNetwork: false, signal: controller.signal })
				.then((result) => {
					if (controller.signal.aborted || generation !== this.refreshGeneration) return;
					for (const [provider, error] of result.errors) errors.set(provider, error);
					this.publishProviderModels();
				});
			await Promise.race([restore, aborted]);

			if (options.allowNetwork !== false && !controller.signal.aborted) {
				const legacyOAuthProviders = new Set(
					this.models
						.map((model) => model.provider)
						.filter((providerId) => getLegacyOAuthProvider(providerId) !== undefined),
				);
				const refreshLegacyOAuth = Promise.all([...legacyOAuthProviders].map(async (providerId) => {
					const credential = this.authStorage.get(providerId);
					if (credential?.type !== "oauth" || Date.now() < credential.expires) return;
					await this.authStorage.getModelAuth(providerId, { includeFallback: false });
				}));
				await Promise.race([refreshLegacyOAuth, aborted]);
			}

			const extensionRefreshes = controller.signal.aborted ? [] : [...this.registeredProviders].map(async ([providerName, config]) => {
				if (!config.refreshModels) return;
				const store = {
					read: () => this.modelsStore.read(providerName),
					write: (entry: Parameters<typeof this.modelsStore.write>[1]) => this.modelsStore.write(providerName, entry),
					delete: () => this.modelsStore.delete(providerName),
				};
				try {
					const credential = await this.credentialStore.read(providerName);
					if (
						controller.signal.aborted ||
						generation !== this.refreshGeneration ||
						this.registeredProviders.get(providerName) !== config
					) return;
					const models = await config.refreshModels({
						credential,
						store,
						allowNetwork: options.allowNetwork ?? true,
						force: options.force,
						signal: controller.signal,
					});
					if (
						controller.signal.aborted ||
						generation !== this.refreshGeneration ||
						this.registeredProviders.get(providerName) !== config
					) return;
					const refreshed = { ...config, models };
					this.registeredProviders.set(providerName, refreshed);
					this.rebuildProviderModels();
				} catch (error) {
					if (generation === this.refreshGeneration && !controller.signal.aborted) {
						errors.set(providerName, error instanceof Error ? error : new Error(String(error)));
					}
				}
			});
			const builtinRefresh = controller.signal.aborted
				? Promise.resolve()
				: this.providerModels
					.refresh({ allowNetwork: options.allowNetwork ?? true, force: options.force, signal: controller.signal })
					.then((result) => {
						if (controller.signal.aborted || generation !== this.refreshGeneration) return;
						for (const [provider, error] of result.errors) errors.set(provider, error);
						this.publishProviderModels();
					});
			await Promise.race([Promise.all(extensionRefreshes), aborted]);
			await Promise.race([builtinRefresh, aborted]);
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
		return { aborted: controller.signal.aborted, errors };
	}

	private publishProviderModels(): void {
		this.rebuildProviderModels();
	}

	private rebuildProviderModels(): void {
		this.loadModels(this.providerModels.getModels());
		for (const [providerName, config] of this.registeredProviders) {
			this.applyProviderConfig(providerName, config);
		}
	}

	private providerRegistrationSource(providerName: string): string {
		return `${this.registrationSource}:${providerName}`;
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(baseModels?: readonly Model<Api>[]): void {
		const loaded = loadModelRegistryModels(this.authStorage, this.modelsJsonPaths, baseModels);
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
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		const configured = this.models.filter((model) => this.hasConfiguredAuth(model));
		const allowedByProvider = new Map<string, ReadonlySet<string>>();
		for (const provider of this.providerModels.getProviders()) {
			const extension = this.registeredProviders.get(provider.id);
			if (!provider.filterModels || extension?.models || extension?.oauth) continue;
			const providerModels = configured.filter((model) => model.provider === provider.id);
			const credential = this.authStorage.get(provider.id) as Credential | undefined;
			allowedByProvider.set(
				provider.id,
				new Set(provider.filterModels(providerModels, credential).map((model) => model.id)),
			);
		}
		return configured.filter((model) => allowedByProvider.get(model.provider)?.has(model.id) ?? true);
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
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
		try {
			const runtimeApiKey = this.authStorage.getRuntimeApiKey(model.provider);
			const extensionReplacesOAuth = this.registeredProviders.get(model.provider)?.oauth !== undefined
				|| getLegacyOAuthProvider(model.provider) !== undefined;
			const resolvedProviderAuth = this.providerModels.getProvider(model.provider) && !extensionReplacesOAuth
				? (await this.providerModels.getAuth(
					model,
					runtimeApiKey === undefined ? undefined : { apiKey: runtimeApiKey },
				))?.auth
				: undefined;
			const storedCredential = this.authStorage.get(model.provider);
			const storedOAuthAuth = runtimeApiKey !== undefined && !extensionReplacesOAuth && storedCredential?.type === "oauth"
				? await oauthCredentialToAuth(model.provider, storedCredential)
				: undefined;
			const runtimeBaseUrl = runtimeApiKey !== undefined && model.provider === "github-copilot"
				? copilotBaseUrlFromRuntimeToken(runtimeApiKey)
				: undefined;
			const providerAuth = runtimeApiKey === undefined
				? resolvedProviderAuth
				: overlayRuntimeApiKey(runtimeApiKey, resolvedProviderAuth, storedOAuthAuth, runtimeBaseUrl);
			return getModelRequestAuth(
				model,
				this.authStorage,
				this.providerRequestConfigs,
				this.modelRequestHeaders,
				providerAuth,
			);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
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
		const mergedConfig = this.upsertRegisteredProvider(providerName, migratedConfig);
		unregisterProviderRuntime(this.providerRegistrationSource(providerName));
		this.rebuildProviderModels();
		this.applyProviderConfig(providerName, mergedConfig, true);
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
		unregisterProviderRuntime(this.providerRegistrationSource(providerName));
		this.rebuildProviderModels();
	}

	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): ProviderConfigInput {
		const definedConfig = Object.fromEntries(
			Object.entries(config).filter(([, value]) => value !== undefined),
		) as ProviderConfigInput;
		const merged = { ...this.registeredProviders.get(providerName), ...definedConfig };
		this.registeredProviders.set(providerName, merged);
		return merged;
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput, registerRuntime = false): void {
		this.models = applyProviderConfigToModels({
			registrationSource: this.providerRegistrationSource(providerName),
			registerRuntime,
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
