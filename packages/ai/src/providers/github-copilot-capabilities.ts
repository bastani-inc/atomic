import { getSupportedThinkingLevels } from "../models.ts";
import type { Api, Model, ModelThinkingLevel } from "../types.ts";

/** The API surfaces Atomic calls GitHub Copilot models on. */
export type GitHubCopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * How a model's reasoning returns to it on the next turn, when the model returns reasoning: Responses sends back the
 * encrypted reasoning item; Chat Completions sends back the field the response used (Gemini's opaque
 * `reasoning_opaque`, or readable `reasoning_content`, `reasoning` or `reasoning_text`); Messages sends back signed
 * thinking blocks. `none` for a model without reasoning.
 */
export type GitHubCopilotReasoningReplay =
	| "encrypted-reasoning-item"
	| "returned-reasoning-field"
	| "signed-thinking-block"
	| "none";

/** What one GitHub Copilot model supports and how Atomic talks to it, derived from the model's metadata. */
export interface GitHubCopilotModelCapabilities {
	readonly modelId: string;
	readonly api: GitHubCopilotApi;
	/** `discovered` when the account's model list described the model; `catalog` for the built-in catalog. */
	readonly source: "catalog" | "discovered";
	readonly reasoning: {
		/** Thinking levels Atomic offers, `off` included when the model can run without reasoning. */
		readonly levels: readonly ModelThinkingLevel[];
		readonly replay: GitHubCopilotReasoningReplay;
	};
	readonly toolCalls: {
		/** Several calls in one turn are accepted on every surface. */
		readonly parallel: true;
		/** Tool schemas are sent strict. */
		readonly strictSchemas: boolean;
		/** Responses calls keep `call_id|item_id`; Chat calls keep the call ID; Messages keeps the `tool_use` ID. */
		readonly idFormat: "call-and-item-id" | "call-id" | "tool-use-id";
		/** How arguments stream: indexed Chat chunks, Responses argument deltas, or Messages input JSON deltas. */
		readonly argumentDeltas: "indexed-chunks" | "output-item-deltas" | "input-json-deltas";
		/** A call with no arguments arrives as `{}`. */
		readonly emptyArguments: "empty-object";
	};
	readonly completion: {
		/** The event that ends a complete turn; a stream without it fails as `stream-ended-early`. */
		readonly finishSignal: "finish-reason" | "terminal-response-event" | "message-stop";
		/** A Chat or Responses turn with no text and no tool call fails as `empty-response`. */
		readonly emptyTurn: "empty-response-error" | "accepted";
	};
	readonly usage: {
		/** Where reasoning tokens are read from; they are always counted in `usage.output`. */
		readonly reasoningTokens: "completion-details-or-top-level" | "output-details" | "output-tokens";
	};
	readonly input: {
		readonly images: boolean;
		readonly maxImagesPerRequest: number | undefined;
		/** Largest base64 image payload Atomic sends after resizing. */
		readonly maxImageBytes: number | undefined;
	};
	readonly limits: {
		readonly contextWindow: number;
		readonly maxOutputTokens: number;
	};
}

const SURFACES = {
	"openai-completions": {
		replay: "returned-reasoning-field",
		idFormat: "call-id",
		argumentDeltas: "indexed-chunks",
		finishSignal: "finish-reason",
		emptyTurn: "empty-response-error",
		reasoningTokens: "completion-details-or-top-level",
	},
	"openai-responses": {
		replay: "encrypted-reasoning-item",
		idFormat: "call-and-item-id",
		argumentDeltas: "output-item-deltas",
		finishSignal: "terminal-response-event",
		emptyTurn: "empty-response-error",
		reasoningTokens: "output-details",
	},
	"anthropic-messages": {
		replay: "signed-thinking-block",
		idFormat: "tool-use-id",
		argumentDeltas: "input-json-deltas",
		finishSignal: "message-stop",
		emptyTurn: "accepted",
		reasoningTokens: "output-tokens",
	},
} as const satisfies Record<GitHubCopilotApi, object>;

/**
 * The Copilot API a catalog entry is served on, from the SDK its metadata names (models.dev's per-model
 * `provider.npm`): the Anthropic SDK means Copilot's Messages endpoint, the OpenAI SDK its Responses endpoint, and no
 * per-model SDK (the provider's OpenAI-compatible default) its Chat Completions endpoint. Never the model's ID.
 */
export function githubCopilotApiForSdk(sdk: string | undefined): GitHubCopilotApi {
	if (sdk === "@ai-sdk/anthropic") return "anthropic-messages";
	if (sdk === "@ai-sdk/openai") return "openai-responses";
	return "openai-completions";
}

function isGitHubCopilotApi(api: Api): api is GitHubCopilotApi {
	return api === "openai-completions" || api === "openai-responses" || api === "anthropic-messages";
}

/** Messages models name strict tools `supportsStrictTools`; Chat Completions and Responses models `supportsStrictMode`. */
function strictSchemas(model: Model<Api>): boolean {
	const compat = model.compat as
		| { readonly supportsStrictMode?: boolean; readonly supportsStrictTools?: boolean }
		| undefined;
	return (model.api === "anthropic-messages" ? compat?.supportsStrictTools : compat?.supportsStrictMode) === true;
}

/**
 * Describe a GitHub Copilot model from its metadata: the API surface it is routed to, its thinking levels and how
 * reasoning is replayed, tool-call and stream behaviour, usage accounting, image input and limits. Returns undefined
 * for a model of another provider or on an API Atomic does not call Copilot with.
 */
export function describeGitHubCopilotModel(model: Model<Api>): GitHubCopilotModelCapabilities | undefined {
	if (model.provider !== "github-copilot" || !isGitHubCopilotApi(model.api)) return undefined;
	const surface = SURFACES[model.api];
	const images = model.input.includes("image");
	const levels = getSupportedThinkingLevels(model);
	return {
		modelId: model.id,
		api: model.api,
		source: model.discovered === true ? "discovered" : "catalog",
		reasoning: { levels, replay: model.reasoning ? surface.replay : "none" },
		toolCalls: {
			parallel: true,
			strictSchemas: strictSchemas(model),
			idFormat: surface.idFormat,
			argumentDeltas: surface.argumentDeltas,
			emptyArguments: "empty-object",
		},
		completion: { finishSignal: surface.finishSignal, emptyTurn: surface.emptyTurn },
		usage: { reasoningTokens: surface.reasoningTokens },
		input: {
			images,
			maxImagesPerRequest: images ? model.inputLimits?.images?.maxPerRequest : undefined,
			maxImageBytes: images ? model.inputLimits?.images?.resize?.maxBytes : undefined,
		},
		limits: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens },
	};
}
