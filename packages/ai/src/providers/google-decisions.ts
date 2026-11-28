import { googleDecisionsApi } from "../api/google-decisions.lazy.ts";
import { sharedApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_DECISIONS_CLASSIFIER_MODELS } from "./google-decisions.models.ts";

export function googleDecisionsProvider(): Provider {
	return createProvider({
		id: "google-decisions",
		name: "Gemini Decisions",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: sharedApiKeyAuth("Gemini API key", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], ["google"]) },
		models: Object.values(GOOGLE_DECISIONS_CLASSIFIER_MODELS),
		classifiers: { "google-decisions": googleDecisionsApi() },
	});
}
