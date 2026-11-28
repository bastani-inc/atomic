/** The API surfaces Atomic calls GitHub Copilot models on. */
export type GitHubCopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

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
