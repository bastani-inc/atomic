import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	createModels,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS } from "./model-refresh-timeout.ts";
import {
	addRuntimeApiKeyProvider,
	addStoredCredentialProvider,
	createEmptyModelRuntimeSnapshot,
	createModelRuntimeSnapshot,
	getSnapshotProviderAuthStatus,
	type ModelRuntimeSnapshot,
	removeStoredCredentialProvider,
	replaceStoredCredentialProviders,
	updateSnapshotModels,
} from "./model-runtime-snapshot.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import { collectOAuthProviderMetadata } from "./oauth-provider-metadata.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

export type { CreateModelRuntimeOptions, ModelRuntimeAuthOverrides } from "./model-runtime-types.ts";

import { mergeConfiguredAuthHeaders } from "./model-runtime-auth.ts";
import { configureBuiltinProviders } from "./model-runtime-providers.ts";
import { canRestoreUnknownModel as canRestoreUnknownModelProvider } from "./model-runtime-restoration.ts";
import { ModelRuntimeStreaming } from "./model-runtime-streaming.ts";
import type { CreateModelRuntimeOptions, ModelRuntimeAuthOverrides } from "./model-runtime-types.ts";
/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly streaming: ModelRuntimeStreaming;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = createEmptyModelRuntimeSnapshot();
	private snapshotGeneration = 0;
	private readonly externalProviderAuthStatuses = new Map<string, AuthStatus>();
	private availabilityRefresh: Promise<void> | undefined;
	private availabilityError: string | undefined;
	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.streaming = new ModelRuntimeStreaming(this.models, (model, overrides) => this.getAuth(model, overrides));
		this.rebuildProviders();
	}
	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			!isOfflineModeEnabled(),
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller = refreshFromNetwork ? new AbortController() : undefined;
		const timeout = controller
			? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs ?? 15_000)
			: undefined;
		try {
			await runtime.refresh({ allowNetwork: refreshFromNetwork, signal: controller?.signal });
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}
	private configureRadiusProviders(): void {
		configureBuiltinProviders(this.builtins, this.defaultBuiltins, this.config);
	}
	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}
	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(base);
			else this.models.deleteProvider(providerId);
		}
	}
	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}
	private updateModelSnapshot(): void {
		this.snapshotGeneration += 1;
		this.snapshot = updateSnapshotModels(this.snapshot, [...this.models.getModels()]);
	}
	private async runAvailabilityRefresh(generation: number): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id),
					],
				),
			),
			this.credentials.list(),
		]);
		// Credential and provider mutations publish their own snapshot immediately.
		// A refresh started before that mutation must not overwrite newer state when
		// a slower machine eventually lets it finish.
		if (generation === this.snapshotGeneration) {
			this.snapshot = createModelRuntimeSnapshot([...this.models.getModels()], [...available], checks, credentials);
			this.availabilityError = undefined;
		}
	}
	private queueAvailabilityRefresh(after: Promise<void> | undefined): Promise<void> {
		const generation = this.snapshotGeneration;
		const refresh = (after ?? Promise.resolve()).catch(() => {}).then(() => this.runAvailabilityRefresh(generation));
		const recorded = refresh.catch((error) => {
			if (generation === this.snapshotGeneration) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}
	/** Coalesce concurrent readers onto the pending refresh. */
	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh(undefined);
	}
	/** Mutations must not observe an in-flight refresh started before them. */
	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh(this.availabilityRefresh);
	}
	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}
	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}
	/** Whether an authenticated provider may reconstruct an absent saved model ID. */
	canRestoreUnknownModel(providerId: string): boolean {
		return canRestoreUnknownModelProvider(
			providerId,
			this.defaultBuiltins.get(providerId),
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
			this.nativeExtensionProviders.get(providerId),
		);
	}
	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}
	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}
	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}
	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}
	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}
	getOAuthProviderMetadata() {
		return collectOAuthProviderMetadata(this.getProviders(), this.extensionProviders);
	}
	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		return mergeConfiguredAuthHeaders(
			resolution,
			providerOrModel,
			this.config,
			this.extensionProviders.get(providerOrModel.provider),
			overrides,
		);
	}
	/** Reload credentials changed by the authoritative isolated engine and update auth status snapshots. */
	async reloadCredentials(options: { refreshAvailability?: boolean } = {}): Promise<void> {
		await this.credentials.reload();
		if (options.refreshAvailability === false) {
			const credentials = await this.credentials.list();
			for (const credential of credentials) this.externalProviderAuthStatuses.delete(credential.providerId);
			this.snapshotGeneration += 1;
			this.snapshot = replaceStoredCredentialProviders(this.snapshot, credentials);
			return;
		}
		await this.forceRefreshAvailability();
	}

	async saveCredential(providerId: string, credential: Credential): Promise<void> {
		await this.credentials.modify(providerId, async () => credential);
		await this.refresh();
	}
	async setRuntimeApiKey(
		providerId: string,
		apiKey: string,
		refreshOptions: ModelsRefreshOptions = {},
	): Promise<void> {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		this.snapshot = addRuntimeApiKeyProvider(this.snapshot, providerId);
		await this.refresh(refreshOptions);
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	getStoredCredentialType(providerId: string): CredentialInfo["type"] | undefined {
		return this.snapshot.storedCredentialTypes.get(providerId);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		const localStatus = getSnapshotProviderAuthStatus(
			this.snapshot,
			providerId,
			this.credentials.hasRuntimeApiKey(providerId),
			configuredRequestAuthStatus(this.config.getProvider(providerId), this.extensionProviders.get(providerId)),
		);
		if (localStatus.source === "stored" || localStatus.source === "runtime") return localStatus;
		return this.externalProviderAuthStatuses.get(providerId) ?? localStatus;
	}

	/** Apply authoritative auth state returned by an isolated engine mutation. */
	applyExternalProviderAuthStatus(providerId: string, status: AuthStatus): void {
		this.snapshotGeneration += 1;
		const remainingAuth =
			status.configured && status.source === "environment"
				? ({ type: "api_key", source: status.label ?? "environment" } as const)
				: undefined;
		this.snapshot = removeStoredCredentialProvider(this.snapshot, providerId, remainingAuth);
		this.externalProviderAuthStatuses.set(providerId, status);
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.streaming.stream(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.streaming.complete(model, context, options);
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.streaming.streamSimple(model, context, options);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streaming.completeSimple(model, context, options);
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const credential = await this.models.login(providerId, type, interaction);
		// Credential acquisition and persistence are the login transaction. Publish
		// the provider against the current snapshot immediately; catalog restoration,
		// ambient availability checks, and networking belong to /model's bounded
		// background refresh and must never keep a successful login dialog open.
		this.updateModelSnapshot();
		this.externalProviderAuthStatuses.delete(providerId);
		this.snapshot = addStoredCredentialProvider(this.snapshot, providerId, credential.type);
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		// Reset credential-dependent compatibility projections, then publish the
		// persisted deletion without waiting for model stores or remote catalogs.
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.externalProviderAuthStatuses.delete(providerId);
		this.snapshot = removeStoredCredentialProvider(this.snapshot, providerId);
		const logoutGeneration = this.snapshotGeneration;

		// Environment/runtime auth can remain after stored auth is removed. The
		// probe is normally synchronous, but its deadline is authoritative because
		// extension checks are third-party code and need not honor cancellation.
		let timeout: number | undefined;
		try {
			const remainingAuth = await Promise.race([
				this.checkAuth(providerId).catch(() => undefined),
				new Promise<undefined>((resolve) => {
					timeout = setTimeout(resolve, POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS);
				}),
			]);
			if (logoutGeneration === this.snapshotGeneration && !this.snapshot.storedProviders.has(providerId)) {
				this.snapshot = removeStoredCredentialProvider(this.snapshot, providerId, remainingAuth);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		this.rebuildProviders();
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		this.updateModelSnapshot();
		try {
			await this.forceRefreshAvailability();
		} catch {
			// Availability errors are recorded by forceRefreshAvailability; refreshed models remain usable.
		}
		return result;
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}
