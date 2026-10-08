import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";
import { OPENAI_DECISIONS_CLASSIFIER_MODELS } from "./openai-decisions.models.ts";

export function openaiDecisionsProvider(): Provider {
	return createProvider({
		id: "openai-decisions",
		name: "OpenAI Decisions",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
		},
		models: Object.values<ClassifierModel<"openai-decisions">>(OPENAI_DECISIONS_CLASSIFIER_MODELS),
		classifiers: {
			"openai-decisions": openAIDecisionsApi(),
		},
	});
}
