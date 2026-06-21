import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthProviderInterface,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth-storage.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";

export interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

export interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export interface CustomModelsResult {
	models: Model<Api>[];
	overrides: Map<string, ProviderOverride>;
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	providerRequestConfigs: Map<string, ProviderRequestConfig>;
	modelRequestHeaders: Map<string, Record<string, string>>;
	error: string | undefined;
}

export interface ModelRegistryLoadResult {
	models: Model<Api>[];
	providerRequestConfigs: Map<string, ProviderRequestConfig>;
	modelRequestHeaders: Map<string, Record<string, string>>;
	loadError: string | undefined;
}

export interface DynamicProviderApplyInput {
	providerName: string;
	config: ProviderConfigInput;
	models: Model<Api>[];
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
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		contextWindowOptions?: readonly number[];
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
