import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.js";
import { OPENAI_MODELS } from "./openai.models.ts";

import { openaiSubscriptionModels } from "./openai-subscription-models.js";

const MID_CONVO_EFFORT_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);

function modelsWithMidConvoEffort(): Model<"openai-responses">[] {
	return Object.values(OPENAI_MODELS).map((model) => ({
		...model,
		...(MID_CONVO_EFFORT_MODEL_IDS.has(model.id)
			? { compat: { ...model.compat, supportsMidConvoEffort: true } }
			: {}),
	}));
}
export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider<"openai-responses">({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT subscription)",
				usesCallbackServer: true,
				isSubscription: true,
				loginLabel: "Sign in with ChatGPT",
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		models: modelsWithMidConvoEffort(),
		filterModels: (models, credential) => (credential?.type === "oauth" ? openaiSubscriptionModels(models) : models),
		api: openAIResponsesApi(),
	});
}

export function openaiApiProvider(): Provider<"openai-responses"> {
	return createProvider<"openai-responses">({
		id: "openai-api",
		name: "OpenAI (API key)",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
		},
		models: modelsWithMidConvoEffort().map((model) => ({ ...model, provider: "openai-api" })),
		api: openAIResponsesApi(),
	});
}
