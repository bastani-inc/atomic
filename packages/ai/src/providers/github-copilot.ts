import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

/** Copilot advertises entitlements as string ID arrays on the OAuth credential; ignore any other shape. */
function advertisedModelIds(value: unknown): ReadonlySet<string> | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return new Set(value);
}

export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitHub Copilot", isSubscription: true, load: loadGitHubCopilotOAuth }),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		filterModels: (models, credential) => {
			const oauth = credential?.type === "oauth" ? credential : undefined;
			const entitledFastModelIds = advertisedModelIds(oauth?.fastModelIds);
			const availableModelIds = advertisedModelIds(oauth?.availableModelIds);
			return models.filter((model) => {
				// Fast siblings are advertised per account, so expose only the exact IDs this credential
				// entitles. Fast-ness comes from the explicit route metadata, never from the `-fast` suffix:
				// a Copilot-owned model that merely ends in `-fast` is an ordinary picker model.
				if (model.fastRoute !== undefined) return entitledFastModelIds?.has(model.id) === true;
				return availableModelIds?.has(model.id) ?? true;
			});
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
