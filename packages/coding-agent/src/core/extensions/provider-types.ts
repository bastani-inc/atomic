import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "./api-types.ts";

export interface ApiKeyAuthPrompt {
	type: "text" | "secret";
	message: string;
	placeholder?: string;
}

export interface ApiKeyAuthInteraction {
	prompt(prompt: ApiKeyAuthPrompt): Promise<string>;
	signal: AbortSignal;
}

export interface ProviderApiKeyAuthContext {
	env(name: string): Promise<string | undefined>;
}

export interface ProviderApiKeyAuthResult {
	auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> };
	env?: Record<string, string>;
	source?: string;
}

export interface ProviderApiKeyAuth {
	name: string;
	login(interaction: ApiKeyAuthInteraction): Promise<import("../auth-storage.ts").ApiKeyCredential>;
	check?(input: { ctx: ProviderApiKeyAuthContext; credential?: import("../auth-storage.ts").ApiKeyCredential }): Promise<{ type: "api_key"; source?: string } | undefined>;
	resolve?(input: { ctx: ProviderApiKeyAuthContext; credential?: import("../auth-storage.ts").ApiKeyCredential }): Promise<ProviderApiKeyAuthResult | undefined>;
}
/** Configuration for registering a provider via pi.registerProvider(). */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key or environment variable name. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/** Optional streamSimple handler for custom APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** Refresh this provider's catalog. Successful results replace its extension-provided models. */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** Optional provider-directed API-key authentication flow. */
	auth?: { apiKey?: ProviderApiKeyAuth };
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	oauth?: {
		/** Display name for the provider in login UI. */
		name: string;
		/** Run the login flow, return credentials to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** Refresh expired credentials, return updated credentials to persist. */
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		getApiKey(credentials: OAuthCredentials): string;
		/** Optional: modify models for this provider (e.g., update baseUrl based on credentials). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4-20250514"). */
	id: string;
	/** Display name (e.g., "Claude 4 Sonnet"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** API endpoint URL override for this model. */
	baseUrl?: string;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Request pricing, including optional request-wide long-context tiers. */
	cost: Model<Api>["cost"];
	/** Default/effective context window size in tokens. */
	contextWindow: number;
	/** Selectable context-window sizes in tokens; omit when the model has only one supported window. */
	contextWindowOptions?: readonly number[];
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Inline extension factory, optionally carrying a stable name and display visibility. */
export type InlineExtension =
	| ExtensionFactory
	| { name: string; factory: ExtensionFactory; hidden?: boolean; bundled?: boolean };
