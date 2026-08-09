import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	createModels,
	type DeferredHandle,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
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
	snapshotModelKey,
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

export type CredentialSynchronizationOperation =
	| "login"
	| "logout"
	| "saveCredential"
	| "setRuntimeApiKey"
	| "removeRuntimeApiKey";

/** Credentials changed successfully, but local model state could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		// One call rather than assign-then-redefine: the two-step form is
		// equivalent (defineProperty with only `enumerable` preserves the existing
		// value) but reads as a redundant write and trips static analysis. The
		// non-enumerable descriptor is the load-bearing part — it keeps the
		// credential out of JSON.stringify, console.log, and structured error
		// reporting.
		Object.defineProperty(this, "credential", {
			value: credential,
			enumerable: false,
			writable: true,
			configurable: true,
		});
	}
}

function operationSignal(signal: AbortSignal | undefined): AbortSignal {
	return signal ?? new AbortController().signal;
}

function raceWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted)
		return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

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
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	private availabilityError: string | undefined;
	private refreshSequence = 0;
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
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal: controller?.signal });
			}
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
	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		this.snapshot = createModelRuntimeSnapshot([...this.models.getModels()], [...available], checks, credentials);
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}
	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq)
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted)
				this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		});
	}
	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const configuredProviders = new Set(this.snapshot.configuredProviders),
				storedProviders = new Set(this.snapshot.storedProviders),
				storedCredentialTypes = new Map(this.snapshot.storedCredentialTypes),
				authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) {
				storedProviders.add(providerId);
				storedCredentialTypes.set(providerId, credential.type);
			} else {
				storedProviders.delete(providerId);
				storedCredentialTypes.delete(providerId);
			}
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				storedCredentialTypes,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			)
				this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		}
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
	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted)
					this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
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
		await this.queueAvailabilityRefresh();
	}

	private assertCredentialRefreshSucceeded(
		providerId: string,
		result: ModelsRefreshResult,
		signal?: AbortSignal,
	): void {
		if (result.aborted) {
			signal?.throwIfAborted();
			throw new Error(`Model refresh aborted for ${providerId}`);
		}
		const refreshError = result.errors.get(providerId);
		if (refreshError) throw refreshError;
		const compositionError = this.compositionErrors.get(providerId);
		if (compositionError) throw new Error(compositionError);
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}
	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		synchronize: () => void | Promise<void>,
	): Promise<void> {
		try {
			await synchronize();
		} catch (cause) {
			if (cause instanceof CredentialSynchronizationError) throw cause;
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}
	private async refreshRemainingAuthAfterLogout(providerId: string, logoutGeneration: number): Promise<void> {
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

	async saveCredential(providerId: string, credential: Credential): Promise<void> {
		const signal = operationSignal(undefined);
		await this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.credentials.modify(providerId, async () => credential);
			await this.synchronizeCredentialState(providerId, "saveCredential", credential, async () => {
				const result = await this.refresh({ providers: [providerId] });
				this.assertCredentialRefreshSucceeded(providerId, result);
			});
		});
	}
	/**
	 * Apply a process-scoped API key override. This publishes the provider against
	 * the current snapshot and deliberately does not refresh the model catalog;
	 * callers needing catalog freshness call refresh({ providers: [providerId], signal })
	 * separately.
	 */
	async setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options.signal);
		await this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(providerId, "setRuntimeApiKey", { type: "api_key", key: apiKey }, () => {
				this.snapshot = addRuntimeApiKeyProvider(this.snapshot, providerId);
			});
		});
	}

	async removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		await this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, async () => {
				const result = await this.refresh({ allowNetwork: this.modelNetworkEnabled, signal });
				this.assertCredentialRefreshSucceeded(providerId, result, signal);
			});
		});
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

	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streaming.fetchDeferred(model, handle, options);
	}

	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void> {
		return this.streaming.cancelDeferred(model, handle, options);
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal });
			await this.synchronizeCredentialState(providerId, "login", credential, () => {
				// Credential acquisition and persistence are the login transaction. Publish
				// the provider against the current snapshot immediately; catalog restoration,
				// ambient availability checks, and networking belong to /model's bounded
				// background refresh and must never keep a successful login dialog open.
				this.updateModelSnapshot();
				this.externalProviderAuthStatuses.delete(providerId);
				this.snapshot = addStoredCredentialProvider(this.snapshot, providerId, credential.type);
			});
			return credential;
		});
	}

	async logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		const logoutGeneration = await this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			let generation = 0;
			await this.synchronizeCredentialState(providerId, "logout", undefined, () => {
				// Reset credential-dependent compatibility projections, then publish the
				// persisted deletion without waiting for model stores or remote catalogs.
				this.recomposeProvider(providerId);
				this.updateModelSnapshot();
				this.externalProviderAuthStatuses.delete(providerId);
				this.snapshot = removeStoredCredentialProvider(this.snapshot, providerId);
				generation = this.snapshotGeneration;
			});
			return generation;
		});
		await this.refreshRemainingAuthAfterLogout(providerId, logoutGeneration);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		return this.runRefresh(options, ++this.refreshSequence);
	}

	/**
	 * A registration's offline catalog pass must not publish after a newer refresh
	 * that resolves configured credentials.
	 */
	private scheduleRegistrationRefresh(): void {
		const sequence = ++this.refreshSequence;
		void this.runRefresh({ allowNetwork: false }, sequence, true);
	}

	private async runRefresh(
		options: ModelsRefreshOptions,
		sequence: number,
		discardIfSuperseded = false,
	): Promise<ModelsRefreshResult> {
		const config = await ModelConfig.load(this.modelsPath);
		if (discardIfSuperseded && sequence !== this.refreshSequence) {
			return { aborted: true, errors: new Map<string, Error>() };
		}
		this.config = config;
		this.configureRadiusProviders();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else this.rebuildProviders();
		const refreshOptions = { ...options, allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled };
		const result = await this.models.refresh(refreshOptions);
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted)
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		this.scheduleRegistrationRefresh();
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
			// A provider that was already configured has an availability result — possibly
			// a credential-filtered subset of its catalog, as with an additive GitHub
			// Copilot override — and keeps it until the refresh this registration schedules
			// republishes it. Only a provider this registration newly configures has no
			// result to keep, so only its catalog is exposed provisionally.
			let available = this.snapshot.available;
			if (!this.snapshot.configuredProviders.has(providerId)) {
				const preserved = new Set(available.map(snapshotModelKey));
				available = this.snapshot.all.filter(
					(model) => model.provider === providerId || preserved.has(snapshotModelKey(model)),
				);
			}
			this.snapshot = { ...this.snapshot, auth, configuredProviders, available };
		}
		this.scheduleRegistrationRefresh();
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.scheduleRegistrationRefresh();
	}
}
