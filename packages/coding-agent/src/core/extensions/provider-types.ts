import type {
	AnyModel,
	ClassifierApi,
	ClassifierModel,
	CompactorApi,
	ImageApi,
	ImageModelCapabilities,
	ProviderClassifier,
	ProviderImages,
	RefreshModelsContext,
} from "@bastani/atomic-ai";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@bastani/atomic-ai/compat";
import type { AtomicProviderCompat } from "../model-capabilities.ts";
import type { ExtensionAPI } from "./api-types.ts";

export type { AtomicProviderCompat } from "../model-capabilities.ts";
export type { ProviderAliasConfig } from "../provider-alias.js";

/** Configuration for registering a provider via atomic.registerProvider(). */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	aliasOf?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key or environment variable name. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/**
	 * Optional streamSimple handler for custom APIs. Implementations may invoke
	 * `options.onProviderStreamEvent(data, model)` with parsed stream events before normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Image API implementations keyed by each image model's api. */
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** Classifier API implementations keyed by each classifier model's api. */
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** Refresh this provider's catalog. Successful results replace its extension-provided models. */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	oauth?: {
		/** Display name for the provider in login UI. */
		name: string;
		/** Optional provider-specific login label. */
		loginLabel?: string;
		/** Whether the flow accepts a browser callback/manual redirect. */
		usesCallbackServer?: boolean;
		/** Run the login flow, return credentials to persist. */
		login(callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials>;
		/**
		 * Refresh expired credentials. Pass `signal` to the network call, but add no timeout or abort of your own: Atomic
		 * never aborts it on a timeout, because once the request is sent the provider may already have rotated the
		 * refresh token. The caller stops waiting after 60 seconds; a later result is still saved, and a graceful exit
		 * waits briefly for it. It is a required parameter so the contract is stated in the type.
		 * When the provider rejects the stored login (for example `invalid_grant`),
		 * throw `OAuthRefreshRejectedError` so the user is told to run `/login <provider>`.
		 */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		getApiKey(credentials: OAuthCredentials): string;
		/** Optional: modify models for this provider (e.g., update baseUrl based on credentials). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

interface ProviderModelConfigBase {
	/** Model ID (e.g., "claude-sonnet-4-20250514"). */
	id: string;
	/** Display name. */
	name: string;
	api?: string;
	baseUrl?: string;
	input: AnyModel["input"];
	inputLimits?: AnyModel["inputLimits"];
	cost: AnyModel["cost"];
	headers?: Record<string, string>;
}

/** Chat models are the default when `type` is omitted. */
export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	/** Default/effective context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Default sampling parameters merged into OpenAI-compatible request bodies. */
	samplingParams?: Record<string, unknown>;
	samplingParamsByThinkingLevel?: Model<Api>["samplingParamsByThinkingLevel"];
	/** Provider capability settings, including Atomic's `supportsGrammarTools` alias. */
	compat?: AtomicProviderCompat;
}

export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
	/** Optional request features the model supports, for example `complexity` or `svg` on `openai-images`. */
	capabilities?: ImageModelCapabilities;
}

export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
	compat?: ClassifierModel<ClassifierApi>["compat"];
}

export interface ProviderCompactorModelConfig extends ProviderModelConfigBase {
	type: "compactor";
	/** Compactor API identifier. Required at model or provider level unless overriding an existing compactor model. */
	api?: CompactorApi;
	endpointPath?: string;
	compactionParams?: Record<string, unknown>;
	timeoutMs?: number;
	maxTokens?: number;
}

/** Models for all supported operations in a provider registration. */
export type ProviderModelConfig =
	| ProviderChatModelConfig
	| ProviderImageModelConfig
	| ProviderClassifierModelConfig
	| ProviderCompactorModelConfig;

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (atomic: ExtensionAPI) => void | Promise<void>;

/** Inline extension factory, optionally carrying a stable name and display visibility. */
export type InlineExtension =
	| ExtensionFactory
	| {
			name: string;
			factory: ExtensionFactory;
			hidden?: boolean;
			bundled?: boolean;
			builtin?: boolean;
			replaceable?: boolean;
	  };
