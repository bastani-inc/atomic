import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { LegacyOAuthProvider } from "./oauth-provider-bridge.ts";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth-storage.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import type { ProviderApiKeyAuth } from "./extensions/provider-types.ts";

export interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

export interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	auth?: { apiKey?: ProviderApiKeyAuth };
}

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
	  }
	| {
			ok: false;
			error: string;
	  };

export type ModelRequestHeaderSource = "model" | "modelOverride";

export interface CustomModelsResult {
	models: Model<Api>[];
	overrides: Map<string, ProviderOverride>;
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	providerRequestConfigs: Map<string, ProviderRequestConfig>;
	modelRequestHeaders: Map<string, Record<string, string>>;
	modelRequestHeaderSources: Map<string, ModelRequestHeaderSource>;
	configuredProviders: Map<string, Provider>;
	error: string | undefined;
}

export interface ModelRegistryLoadResult {
	models: Model<Api>[];
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	providerRequestConfigs: Map<string, ProviderRequestConfig>;
	modelRequestHeaders: Map<string, Record<string, string>>;
	configuredProviders: Map<string, Provider>;
	builtInProviders: Set<string>;
	customOpenAICompatibleProviders: Set<string>;
	loadError: string | undefined;
}

export interface DynamicProviderApplyInput {
	providerName: string;
	registrationSource: string;
	registerRuntime?: boolean;
	config: ProviderConfigInput;
	models: Model<Api>[];
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	authStorage: AuthStorage;
	storeProviderRequestConfig: (providerName: string, config: ProviderRequestConfig) => void;
	storeModelHeaders: (providerName: string, modelId: string, headers?: Record<string, string>) => void;
}

export type ProviderCompat =
	| OpenAICompletionsCompat
	| OpenAIResponsesCompat
	| AnthropicMessagesCompat;

export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	refreshModels?(context: RefreshModelsContext): Promise<NonNullable<ProviderConfigInput["models"]>>;
	auth?: { apiKey?: ProviderApiKeyAuth };
	oauth?: LegacyOAuthProvider;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: Model<Api>["cost"];
		contextWindow: number;
		contextWindowOptions?: readonly number[];
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
