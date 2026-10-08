import { openAIImagesApi } from "../api/openai-images.lazy.ts";
import { sharedApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ImageModel } from "../types.ts";
import { OPENAI_IMAGES_IMAGE_MODELS } from "./openai-images.models.ts";

export function openaiImagesProvider(): Provider {
	return createProvider({
		id: "openai-images",
		name: "OpenAI Images",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: sharedApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"], ["openai-api", "openai"]),
		},
		models: Object.values<ImageModel<"openai-images">>(OPENAI_IMAGES_IMAGE_MODELS),
		images: {
			"openai-images": openAIImagesApi(),
		},
	});
}
