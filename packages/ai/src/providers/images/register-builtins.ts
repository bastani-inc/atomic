import type { generateImages as generateImagesOpenAIFunction } from "../../api/openai-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../../types.ts";
import { memoizeAsync } from "../../utils/memoize-async.js";

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

interface OpenAIImagesProviderModule {
	generateImages: typeof generateImagesOpenAIFunction;
}

function createLazyLoadErrorImages(model: ImageModel<ImageApi>, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

const loadOpenRouterImagesProviderModule = memoizeAsync(
	(): Promise<OpenRouterImagesProviderModule> =>
		import("../../api/openrouter-images.ts").then((module) => module as OpenRouterImagesProviderModule),
);

const loadOpenAIImagesProviderModule = memoizeAsync(
	(): Promise<OpenAIImagesProviderModule> =>
		import("../../api/openai-images.ts").then((module) => module as OpenAIImagesProviderModule),
);

export const generateImagesOpenRouter: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export const generateImagesOpenAI: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenAIImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
	registerImagesApiProvider({
		api: "openai-images",
		generateImages: generateImagesOpenAI,
	});
}

registerBuiltInImagesApiProviders();
