import type {
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthInteraction,
  AuthResult,
  AuthType,
  Context,
  Credential,
  CredentialInfo,
  Models,
  ModelsApiStreamOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsSimpleStreamOptions,
  Provider,
  ProviderHeaders,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getAgentConfigPaths } from "../config.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { AuthStatus } from "./auth-storage.ts";
import { ModelRegistry } from "./model-registry.ts";

export interface CreateModelRuntimeOptions {
  authStorage?: AuthStorage;
  authPath?: string | string[];
  modelRegistry?: ModelRegistry;
  modelsPath?: string | string[] | null;
  allowModelNetwork?: boolean;
  modelRefreshTimeoutMs?: number;
}

export interface ModelRuntimeAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
}

function mergeHeaders(base?: ProviderHeaders, override?: ProviderHeaders): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

/** Canonical model/auth facade for SDK consumers. */
export class ModelRuntime implements Models {
  readonly modelRegistry: ModelRegistry;
  readonly authStorage: AuthStorage;

  constructor(modelRegistry: ModelRegistry, authStorage: AuthStorage = modelRegistry.authStorage) {
    this.modelRegistry = modelRegistry;
    this.authStorage = authStorage;
  }

  static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
    const authStorage = options.authStorage ?? AuthStorage.create(options.authPath);
    const paths = options.modelsPath === null ? [] : (options.modelsPath ?? getAgentConfigPaths("models.json"));
    const modelRegistry = options.modelRegistry ?? (
      Array.isArray(paths) && paths.length === 0
        ? ModelRegistry.inMemory(authStorage)
        : ModelRegistry.create(authStorage, paths)
    );
    const runtime = new ModelRuntime(modelRegistry, authStorage);
    await modelRegistry.refresh({
      allowNetwork: options.allowModelNetwork ?? false,
      timeoutMs: options.modelRefreshTimeoutMs,
    });
    return runtime;
  }

  getProviders(): readonly Provider[] { return this.modelRegistry.getProviders(); }
  getProvider(providerId: string): Provider | undefined { return this.modelRegistry.getProvider(providerId); }
  getModels(providerId?: string): readonly Model<Api>[] {
    return providerId ? this.modelRegistry.getAll().filter((model) => model.provider === providerId) : this.modelRegistry.getAll();
  }
  getModel(providerId: string, modelId: string): Model<Api> | undefined { return this.modelRegistry.find(providerId, modelId); }
  checkAuth(providerId: string) { return this.modelRegistry.checkAuth(providerId); }
  async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    const models = this.modelRegistry.getAvailable();
    return providerId ? models.filter((model) => model.provider === providerId) : models;
  }
  getAvailableSnapshot(): readonly Model<Api>[] { return this.modelRegistry.getAvailable(); }
  getError(): string | undefined {
    const errors = [this.modelRegistry.getError(), this.authStorage.getLoadError()?.message].filter((value): value is string => Boolean(value));
    return errors.length ? errors.join("\n\n") : undefined;
  }
  getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(providerOrModel: string | Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined> {
    return typeof providerOrModel === "string"
      ? this.modelRegistry.getAuth(providerOrModel, overrides)
      : this.modelRegistry.getAuth(providerOrModel, overrides);
  }
  getProviderAuthStatus(providerId: string): AuthStatus { return this.modelRegistry.getProviderAuthStatus(providerId); }
  isUsingOAuth(providerId: string): boolean { return this.authStorage.get(providerId)?.type === "oauth"; }
  hasConfiguredAuth(providerId: string): boolean { return this.modelRegistry.getProviderAuthStatus(providerId).configured; }
  async setRuntimeApiKey(providerId: string, apiKey: string, options: ModelsRefreshOptions = {}): Promise<void> {
    this.authStorage.setRuntimeApiKey(providerId, apiKey);
    await this.refresh(options);
  }
  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.authStorage.removeRuntimeApiKey(providerId);
    await this.refresh({ allowNetwork: false });
  }
  async listCredentials(): Promise<readonly CredentialInfo[]> { return this.authStorage.asCredentialStore().list(); }

  private async prepare(
    model: Model<Api>,
    options: (StreamOptions & { transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders> }) | undefined,
  ) {
    const provider = this.getProvider(model.provider);
    if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const { transformHeaders, ...providerOptions } = options ?? {};
    let headers = mergeHeaders(auth.headers, providerOptions.headers);
    if (transformHeaders) headers = await transformHeaders(headers ?? {});
    return {
      provider,
      model: auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      options: { ...providerOptions, apiKey: providerOptions.apiKey ?? auth.apiKey, headers },
    };
  }
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream {
    return lazyStream(model, async () => {
      const prepared = await this.prepare(model, options as StreamOptions | undefined);
      return prepared.provider.stream(prepared.model as Model<TApi>, context, prepared.options as ApiStreamOptions<TApi>);
    });
  }
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage> {
    return this.stream(model, context, options).result();
  }
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
    return lazyStream(model, async () => {
      const prepared = await this.prepare(model, options);
      return prepared.provider.streamSimple(prepared.model, context, prepared.options);
    });
  }
  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
    return this.streamSimple(model, context, options).result();
  }
  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    const credential = await this.modelRegistry.login(providerId, type, interaction);
    this.authStorage.reload();
    await this.refresh({ allowNetwork: false });
    return credential;
  }
  async logout(providerId: string): Promise<void> {
    await this.modelRegistry.logoutProvider(providerId);
    await this.refresh({ allowNetwork: false });
  }
  async reloadConfig(): Promise<void> { await this.refresh({ allowNetwork: false }); }
  refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> { return this.modelRegistry.refresh(options); }
  registerProvider(provider: Provider): void { this.modelRegistry.registerProvider(provider); }
  unregisterProvider(providerId: string): void { this.modelRegistry.unregisterProvider(providerId); }
}
