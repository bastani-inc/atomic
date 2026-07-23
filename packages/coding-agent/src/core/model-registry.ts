/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	createModels,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Credential,
	type CredentialStore,
	type ModelAuth,
	type ModelsRefreshResult,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModelDataUrl, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { dirname, join } from "node:path";
import { getAgentConfigPaths } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { copilotApiBaseUrlFromToken, copilotCatalogCachePath, copilotTokenFromEnvironment, seedActiveCopilotModelCatalogFromCache } from "./copilot-model-catalog.ts";
import { getModelRequestAuth, getApiKeyForProviderFromConfig, getProviderAuthStatusFromConfig, getProviderResolvedAuth } from "./model-registry-auth.ts";
import { applyProviderConfigToModels, migrateLegacyRegisterProviderConfigValues, unregisterProviderRuntime, validateProviderConfig } from "./model-registry-dynamic.ts";
import { loadModelRegistryModels } from "./model-registry-loader.ts";
import type { ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { type CodingAgentModelsStore, FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
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
	private nativeProviders: Map<string, Provider> = new Map();
	private builtInProviders: Set<string> = new Set();
	private customOpenAICompatibleProviders: Set<string> = new Set();
	private loadError: string | undefined = undefined;
	private refreshGeneration = 0;
	private resolvedCustomAuthProviders = new Set<string>();
	private readonly registrationSource = `atomic:model-registry:${++nextRegistryRegistrationId}`;
	declare private readonly modelsStore: CodingAgentModelsStore;
	declare private readonly credentialStore: CredentialStore;
	declare private readonly providerModels: MutableModels;
	private readonly defaultProviders = new Map<string, Provider>();
	private configuredProviderIds = new Set<string>();

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
			const configured = provider.id === "radius" ? provider : withRemoteCatalog(provider, undefined, getBuiltinModelDataUrl(provider.id as BuiltinProvider));
			this.defaultProviders.set(provider.id, configured);
			this.providerModels.setProvider(configured);
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

	static inMemory(authStorage: AuthStorage): ModelRegistry { return new ModelRegistry(authStorage, []); }

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
				const legacyOAuthProviders = new Set([
					...this.models.map((model) => model.provider),
					...[...this.registeredProviders]
						.filter(([, config]) => config.oauth !== undefined)
						.map(([providerId]) => providerId),
				].filter((providerId) => getLegacyOAuthProvider(providerId) !== undefined));
				const refreshLegacyOAuth = Promise.all([...legacyOAuthProviders].map(async (providerId) => {
					const credential = this.authStorage.get(providerId);
					if (credential?.type !== "oauth" || Date.now() < credential.expires) return;
					await this.authStorage.getModelAuth(providerId, { includeFallback: false });
				}));
				await Promise.race([refreshLegacyOAuth, aborted]);
			}

			const extensionRefreshes = controller.signal.aborted ? [] : [...this.registeredProviders].map(async ([providerName, config]) => {
				if (!config.refreshModels) return;
				const isCurrentExtensionRefresh = () => !controller.signal.aborted
					&& generation === this.refreshGeneration
					&& this.registeredProviders.get(providerName) === config;
				const store = {
					read: () => this.modelsStore.read(providerName),
					write: (entry: Parameters<typeof this.modelsStore.write>[1]) =>
						this.modelsStore.writeIf(providerName, entry, isCurrentExtensionRefresh),
					delete: () => this.modelsStore.deleteIf(providerName, isCurrentExtensionRefresh),
				};
				try {
					let credential = await this.credentialStore.read(providerName);
					if (credential?.type === "api_key") {
						const effectiveApiKey = await this.authStorage.getApiKey(providerName, { includeFallback: false });
						credential = { ...credential, key: effectiveApiKey };
					}
					if (credential === undefined) {
						const customAuth = await getProviderResolvedAuth(providerName, this.authStorage, this.providerRequestConfigs);
						if (customAuth) { this.resolvedCustomAuthProviders.add(providerName); credential = { type: "api_key", key: customAuth.auth.apiKey, env: customAuth.env }; }
						else this.resolvedCustomAuthProviders.delete(providerName);
						const configuredApiKey = customAuth ? undefined : await getApiKeyForProviderFromConfig(providerName, this.authStorage, this.providerRequestConfigs);
						if (configuredApiKey !== undefined) credential = { type: "api_key", key: configuredApiKey };
					}
					if (!isCurrentExtensionRefresh()) return;
					const models = await config.refreshModels({
						credential,
						store,
						allowNetwork: options.allowNetwork ?? true,
						force: options.force,
						signal: controller.signal,
					});
					if (!isCurrentExtensionRefresh()) return;
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

	private providerRegistrationSource(providerName: string): string { return `${this.registrationSource}:${providerName}`; }

	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(baseModels?: readonly Model<Api>[]): void {
		const loaded = loadModelRegistryModels(this.authStorage, this.modelsJsonPaths, baseModels);
		for (const providerId of this.configuredProviderIds) {
			const fallback = this.defaultProviders.get(providerId);
			if (fallback) this.providerModels.setProvider(fallback);
			else this.providerModels.deleteProvider(providerId);
		}
		for (const provider of loaded.configuredProviders.values()) this.providerModels.setProvider(provider);
		this.configuredProviderIds = new Set(loaded.configuredProviders.keys());
		this.modelOverrides = loaded.modelOverrides;
		this.models = loaded.models;
		this.providerRequestConfigs = loaded.providerRequestConfigs;
		this.modelRequestHeaders = loaded.modelRequestHeaders;
		this.builtInProviders = loaded.builtInProviders;
		this.customOpenAICompatibleProviders = loaded.customOpenAICompatibleProviders;
		this.loadError = loaded.loadError;
	}

	getAll(): Model<Api>[] { return this.models; }

	getAvailable(): Model<Api>[] {
		const configured = this.models.filter((model) => this.hasConfiguredAuth(model));
		const allowedByProvider = new Map<string, ReadonlySet<string>>();
		for (const provider of this.providerModels.getProviders()) {
			const extension = this.registeredProviders.get(provider.id);
			if (!provider.filterModels || extension?.models || extension?.oauth) continue;
			const providerModels = configured.filter((model) => model.provider === provider.id);
			const runtimeApiKey = this.authStorage.getRuntimeApiKey(provider.id);
			const credential: Credential | undefined = runtimeApiKey === undefined
				? this.authStorage.get(provider.id) as Credential | undefined
				: { type: "api_key", key: runtimeApiKey };
			allowedByProvider.set(
				provider.id,
				new Set(provider.filterModels(providerModels, credential).map((model) => model.id)),
			);
		}
		return configured.filter((model) => allowedByProvider.get(model.provider)?.has(model.id) ?? true);
	}

	find(provider: string, modelId: string): Model<Api> | undefined { return this.models.find((model) => model.provider === provider && model.id === modelId); }
	getProviders(): readonly Provider[] { return this.providerModels.getProviders(); }
	getProvider(providerId: string): Provider | undefined { return this.providerModels.getProvider(providerId); }
	checkAuth(providerId: string) { return this.providerModels.checkAuth(providerId); }
	getAuth(providerId: string, overrides?: { apiKey?: string; env?: Record<string, string> }): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: { apiKey?: string; env?: Record<string, string> }): Promise<AuthResult | undefined>;
	getAuth(providerOrModel: string | Model<Api>, overrides?: { apiKey?: string; env?: Record<string, string> }): Promise<AuthResult | undefined> {
		return typeof providerOrModel === "string" ? this.providerModels.getAuth(providerOrModel, overrides) : this.providerModels.getAuth(providerOrModel, overrides);
	}
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> { return this.providerModels.login(providerId, type, interaction); }
	async logoutProvider(providerId: string): Promise<void> { await this.providerModels.logout(providerId); this.authStorage.reload(); }

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

	private storeProviderRequestConfig(providerName: string, config: ProviderRequestConfig): void {
		if (config.apiKey || config.headers || config.authHeader || config.auth?.apiKey) this.providerRequestConfigs.set(providerName, config);
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
		const status = getProviderAuthStatusFromConfig(provider, this.authStorage, this.providerRequestConfigs);
		return status.source || !this.resolvedCustomAuthProviders.has(provider) ? status : { configured: true, source: "environment" };
	}
	/** Registered extension providers with a custom API-key login contract. */
	getCustomApiKeyAuthProviders(): Array<{ id: string; name: string }> { return [...this.registeredProviders].flatMap(([id, config]) => config.auth?.apiKey ? [{ id, name: config.auth.apiKey.name || this.getProviderDisplayName(id) }] : []); }
	getCustomApiKeyAuth(provider: string) { return this.registeredProviders.get(provider)?.auth?.apiKey; }
	async getProviderAuth(provider: string) { return getProviderResolvedAuth(provider, this.authStorage, this.providerRequestConfigs); }
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

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return getApiKeyForProviderFromConfig(provider, this.authStorage, this.providerRequestConfigs);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName !== "string") {
			if (!providerOrName.id.trim()) throw new Error("Provider id must not be empty.");
			this.registeredProviders.delete(providerOrName.id);
			this.nativeProviders.set(providerOrName.id, providerOrName);
			this.providerModels.setProvider(providerOrName);
			this.rebuildProviderModels();
			return;
		}
		if (!config) throw new Error("Provider config is required");
		this.nativeProviders.delete(providerOrName);
		const migratedConfig = migrateLegacyRegisterProviderConfigValues(providerOrName, config);
		validateProviderConfig(providerOrName, migratedConfig);
		const mergedConfig = this.upsertRegisteredProvider(providerOrName, migratedConfig);
		unregisterProviderRuntime(this.providerRegistrationSource(providerOrName));
		this.rebuildProviderModels();
		this.applyProviderConfig(providerOrName, mergedConfig, true);
	}

	hasRegisteredStreamSimpleForApi(api: Api): boolean {
		for (const config of this.registeredProviders.values()) {
			if (config.api === api && config.streamSimple) {
				return true;
			}
		}
		return false;
	}

	unregisterProvider(providerName: string): void {
		const hadLegacy = this.registeredProviders.delete(providerName);
		const hadNative = this.nativeProviders.delete(providerName);
		if (!hadLegacy && !hadNative) return;
		unregisterProviderRuntime(this.providerRegistrationSource(providerName));
		const fallback = this.defaultProviders.get(providerName);
		if (fallback) this.providerModels.setProvider(fallback);
		else this.providerModels.deleteProvider(providerName);
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
