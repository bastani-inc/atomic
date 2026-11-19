import type { ProviderImages } from "../types.ts";
import { loadOpenAITransport } from "./load-openai-transport.ts";

export const openAIImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await loadOpenAITransport(() => import("./openai-images.ts"))).generateImages(model, context, options),
});
