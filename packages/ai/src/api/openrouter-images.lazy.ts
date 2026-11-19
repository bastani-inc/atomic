import type { ProviderImages } from "../types.ts";
import { loadOpenAITransport } from "./load-openai-transport.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await loadOpenAITransport(() => import("./openrouter-images.ts"))).generateImages(model, context, options),
});
