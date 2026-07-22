/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	createModels,
	type Credential,
	type CredentialStore,
	type ModelsRefreshResult,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { dirname, join } from "node:path";
import { getAgentConfigPaths } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { getApiKeyForProviderFromConfig, getProviderAuthStatusFromConfig } from "./model-registry-auth.ts";
import { applyProviderConfigToModels, mergeProviderConfig, migrateLegacyRegisterProviderConfigValues, unregisterProviderRuntime, validateProviderConfig } from "./model-registry-dynamic.ts";
import { loadModelRegistryModels } from "./model-registry-loader.ts";
import { createProviderCredentialStore, seedModelRegistryCopilotCatalog } from "./model-registry-credential-bridge.ts";
import { resolveProviderModelSelection } from "./model-registry-selection.ts";
import { canRestoreUnknownProviderModel } from "./model-registry-restore-policy.ts";
import { type ModelRegistryRefreshOptions, providerIsInRefreshScope } from "./model-registry-refresh-scope.ts";
import { resolveRegistryRequestAuth } from "./model-registry-request-auth.ts";
import type { ProviderConfigInput, ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-types.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import { type CodingAgentModelsStore, FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import { resolveProviderDisplayName } from "./provider-display-name-resolution.ts";
import { getLegacyOAuthProvider } from "./oauth-provider-bridge.ts";
import { ProviderModelSelectionError } from "./provider-model-reference.ts";
import { RequiredProviderPreparationState } from "./provider-preparation-state.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { clearConfigValueCache, isConfigValueConfigured } from "./resolve-config-value.ts";

let nextRegistryRegistrationId = 0;
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
	private providerInstanceGenerations: Map<string, number> = new Map();
	private requiredPreparation = new RequiredProviderPreparationState();
	private builtInProviders: Set<string> = new Set();
	private customOpenAICompatibleProviders: Set<string> = new Set();
	private loadError: string | undefined = undefined;
	private refreshGeneration = 0;
	private providerRefreshGenerations: Map<string, number> = new Map();
	private readonly registrationSource = `atomic:model-registry:${++nextRegistryRegistrationId}`;
	declare private readonly modelsStore: CodingAgentModelsStore;
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
		seedModelRegistryCopilotCatalog(this.authStorage, this.modelsJsonPaths);
		this.loadModels();
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
	async refresh(options: ModelRegistryRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const generation = ++this.refreshGeneration;
		this.loadError = undefined;
		this.rebuildProviderModels();
		for (const [provider, config] of this.registeredProviders) {
			if (!providerIsInRefreshScope(provider, config, options)) continue;
			this.providerRefreshGenerations.set(provider, (this.providerRefreshGenerations.get(provider) ?? 0) + 1);
			if (config.requiresPreparation) this.registeredProviders.set(provider, { ...config, models: [] });
		}
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
		let extensionSuperseded = false;
		try {
			if (!options.skipBuiltinProviders) {
				const restore = this.providerModels.refresh({ allowNetwork: false, signal: controller.signal }).then((result) => {
					if (controller.signal.aborted || generation !== this.refreshGeneration) return;
					for (const [provider, error] of result.errors) errors.set(provider, error);
					this.publishProviderModels();
				});
				await Promise.race([restore, aborted]);
			}

			if (options.allowNetwork !== false && !controller.signal.aborted) {
				const legacyOAuthProviders = new Set([
					...this.models.map((model) => model.provider),
					...[...this.registeredProviders]
						.filter(([, config]) => config.oauth !== undefined)
						.map(([providerId]) => providerId),
				].filter((providerId) => getLegacyOAuthProvider(providerId) !== undefined
					&& providerIsInRefreshScope(providerId, this.registeredProviders.get(providerId), options)));
				const refreshLegacyOAuth = Promise.all([...legacyOAuthProviders].map(async (providerId) => {
					const credential = this.authStorage.get(providerId);
					if (credential?.type !== "oauth") return;
					this.registeredProviders.get(providerId)?.validateHostOAuth?.(credential);
					if (Date.now() < credential.expires) return;
					await this.authStorage.getModelAuth(providerId, {
						includeFallback: false,
						storedOAuthOnly: this.registeredProviders.get(providerId)?.requiresHostOAuth === true,
					});
				}));
				await Promise.race([refreshLegacyOAuth, aborted]);
			}

			const extensionRefreshes = controller.signal.aborted ? [] : [...this.registeredProviders]
				.filter(([providerName, config]) => providerIsInRefreshScope(providerName, config, options))
				.map(async ([providerName, config]) => {
				if (!config.refreshModels) return;
				const providerInstanceGeneration = this.providerInstanceGenerations.get(providerName) ?? 0;
				const providerRefreshGeneration = this.providerRefreshGenerations.get(providerName) ?? 0;
				const runtimeCredentialGeneration = config.requiresHostOAuth ? 0 : this.authStorage.getRuntimeApiKeyGeneration(providerName);
				let hostCredentialGeneration: number | undefined;
				let currentConfig = config;
				const isCurrentExtensionRefresh = () => !controller.signal.aborted
					&& (this.providerRefreshGenerations.get(providerName) ?? 0) === providerRefreshGeneration
					&& this.registeredProviders.get(providerName) === currentConfig
					&& (this.providerInstanceGenerations.get(providerName) ?? 0) === providerInstanceGeneration
					&& (hostCredentialGeneration === undefined || this.authStorage.getCredentialSnapshot(providerName).generation === hostCredentialGeneration)
					&& (config.requiresHostOAuth || this.authStorage.getRuntimeApiKeyGeneration(providerName) === runtimeCredentialGeneration);
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
						credential = effectiveApiKey === undefined ? undefined : { type: "api_key", key: effectiveApiKey };
					}
					if (credential === undefined) {
						const configuredApiKey = await getApiKeyForProviderFromConfig(
							providerName,
							this.authStorage,
							this.providerRequestConfigs,
						);
						if (configuredApiKey !== undefined) credential = { type: "api_key", key: configuredApiKey };
					}
					if (!isCurrentExtensionRefresh()) { extensionSuperseded = true; return; }
					const hostSnapshot = this.authStorage.getCredentialSnapshot(providerName);
					hostCredentialGeneration = hostSnapshot.generation;
					if (config.requiresHostOAuth) {
						if (hostSnapshot.credential?.type === "oauth") this.requiredPreparation.observeHostOAuth(providerName);
						else if (hostSnapshot.credential !== undefined || this.requiredPreparation.wasAuthenticated(providerName)) {
							throw new ProviderModelSelectionError("AuthenticationMissing", `AuthenticationMissing: Host-stored OAuth is required for "${providerName}".`, providerName, "");
						} else if (!options.explicitRequiredProviders?.has(providerName)) return;
					}
					if (config.requiresPreparation && !config.requiresHostOAuth && hostSnapshot.credential === undefined && credential === undefined) return;
					const models = await config.refreshModels({
						credential,
						hostCredential: hostSnapshot.credential,
						credentialGeneration: hostSnapshot.generation,
						providerInstanceGeneration,
						isCurrentGeneration: isCurrentExtensionRefresh,
						store,
						allowNetwork: options.allowNetwork ?? true,
						force: options.force,
						signal: controller.signal,
					});
					if (!isCurrentExtensionRefresh()) { extensionSuperseded = true; return; }
					const publishedModels = models.length === 0 && !config.requiresPreparation ? config.models ?? [] : models;
					const refreshed = { ...config, models: publishedModels };
					currentConfig = refreshed;
					this.registeredProviders.set(providerName, refreshed);
					this.rebuildProviderModels();
					if (config.requiresPreparation) this.requiredPreparation.mark(providerName, config, this.providerInstanceGenerations, this.authStorage);
				} catch (error) {
					const normalized = error instanceof Error ? error : new Error(String(error));
					if (isCurrentExtensionRefresh()) {
						if (config.requiresPreparation) this.requiredPreparation.invalidate(providerName);
					} else extensionSuperseded = true;
					errors.set(providerName, normalized);
				}
			});
			const builtinRefresh = controller.signal.aborted || options.skipBuiltinProviders
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
		return { aborted: controller.signal.aborted || generation !== this.refreshGeneration || extensionSuperseded, errors };
	}

	/** Await providers whose authoritative catalog is required before host reads. */
	async prepareRequiredProviders(options: { signal?: AbortSignal; timeoutMs?: number; allowNetwork?: boolean; explicit?: boolean; providers?: ReadonlySet<string> } = {}): Promise<void> {
		const required = [...this.registeredProviders].filter(([provider, config]) =>
			config.requiresPreparation === true && (options.providers === undefined || options.providers.has(provider)));
		if (required.length === 0) return;
		const needed = this.requiredPreparation.needed(
			required,
			this.providerInstanceGenerations,
			this.authStorage,
			options.explicit === true,
		);
		if (needed.length === 0) return;
		const explicitRequiredProviders = new Set(needed.map(([provider]) => provider));
		const result = await this.refresh({
			...options,
			explicitRequiredProviders,
			registeredProviders: explicitRequiredProviders,
			skipBuiltinProviders: true,
		});
		for (const [provider] of needed) {
			const error = result.errors.get(provider);
			if (error) throw error;
		}
		if (result.aborted) throw new Error("Required provider preparation was cancelled, timed out, or superseded.");
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

	/** Get any error from loading models.json (undefined if no error). */
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

	/** Get all models (built-in + custom); returns only built-in models if models.json had errors. */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/** Get only models with auth configured (fast check, no OAuth refresh). */
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

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/** Resolve a provider+ID exact selection; duplicate IDs fail rather than selecting the first. */
	resolveExactModel(provider: string, modelId: string): Model<Api> {
		return resolveProviderModelSelection({ models: this.models, provider, modelId, requirePersistedSelection: false, restoring: false });
	}

	/** Restore a saved provider selection, requiring the provider-owned record when configured. */
	restoreExactModel(provider: string, modelId: string, selection: unknown): Model<Api> {
		return resolveProviderModelSelection({
			models: this.models,
			provider,
			modelId,
			selection,
			requirePersistedSelection: this.registeredProviders.get(provider)?.requiresExactSelectionPersistence === true,
			restoring: true,
		});
	}


	requiresProviderPreparation(provider: string): boolean {
		return this.registeredProviders.get(provider)?.requiresPreparation === true;
	}
	requiresExactSelectionPersistence(provider: string): boolean {
		return this.registeredProviders.get(provider)?.requiresExactSelectionPersistence === true;
	}

	/** Whether an authenticated provider may reconstruct an absent saved model ID. */
	canRestoreUnknownModel(provider: string): boolean {
		return canRestoreUnknownProviderModel({
			provider,
			customOpenAICompatibleProviders: this.customOpenAICompatibleProviders,
			builtInProviders: this.builtInProviders,
			config: this.registeredProviders.get(provider),
		});
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		const config = this.registeredProviders.get(model.provider);
		if (config?.requiresHostOAuth) {
			const credential = this.authStorage.getCredentialSnapshot(model.provider).credential;
			return credential?.type === "oauth" && Date.now() < credential.expires;
		}
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		return this.authStorage.hasAuth(model.provider) ||
			(providerApiKey !== undefined && isConfigValueConfigured(providerApiKey));
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

	/** Resolve request credentials while preserving structured provider errors. */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			return await resolveRegistryRequestAuth({
				model, authStorage: this.authStorage, providerModels: this.providerModels,
				registeredConfig: this.registeredProviders.get(model.provider),
				providerRequestConfigs: this.providerRequestConfigs, modelRequestHeaders: this.modelRequestHeaders,
			});
		} catch (error) {
			if (error instanceof ProviderModelSelectionError || (error instanceof Error && error.name === "CursorError" && "code" in error)) throw error;
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

	/** Get display name for a provider. */
	getProviderDisplayName(provider: string): string {
		return resolveProviderDisplayName(provider, this.registeredProviders.get(provider), this.authStorage.getOAuthProviders());
	}

	/** Get API key for a provider. */
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

	/** Register a provider dynamically (from extensions). */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		const migratedConfig = migrateLegacyRegisterProviderConfigValues(providerName, config);
		validateProviderConfig(providerName, migratedConfig);
		const mergedConfig = mergeProviderConfig(this.registeredProviders.get(providerName), migratedConfig);
		this.providerInstanceGenerations.set(providerName, (this.providerInstanceGenerations.get(providerName) ?? 0) + 1);
		this.requiredPreparation.invalidate(providerName);
		this.registeredProviders.set(providerName, mergedConfig);
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

	/** Unregister a previously registered provider. */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.providerInstanceGenerations.set(providerName, (this.providerInstanceGenerations.get(providerName) ?? 0) + 1);
		this.requiredPreparation.invalidate(providerName);
		this.registeredProviders.delete(providerName);
		unregisterProviderRuntime(this.providerRegistrationSource(providerName));
		this.rebuildProviderModels();
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
