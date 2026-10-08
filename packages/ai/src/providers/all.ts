import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import { normalizeProviderId } from "../provider-id.ts";
import type { AnyModel, Api, ClassifierApi, ClassifierModel, ImageApi, ImageModel, Model } from "../types.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicApiProvider, anthropicProvider } from "./anthropic.ts";
import { azureProvider } from "./azure.ts";
import { basetenProvider } from "./baseten.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { metaProvider } from "./meta.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { morphProvider } from "./morph.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiApiProvider, openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { openaiDecisionsProvider } from "./openai-decisions.ts";
import { openaiImagesProvider } from "./openai-images.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { typesafeProvider } from "./typesafe.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

export { radiusProvider };

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
type BuiltinCatalog = typeof MODELS & { "azure-openai-responses": (typeof MODELS)["azure"] };
type BuiltinImageCatalog = typeof IMAGE_MODELS & { "azure-openai-responses": (typeof IMAGE_MODELS)["azure"] };
type BuiltinClassifierCatalog = typeof CLASSIFIER_MODELS & {
	"azure-openai-responses": (typeof CLASSIFIER_MODELS)["azure"];
};
export type BuiltinProvider = keyof BuiltinCatalog;

type BuiltinChatModelId<TProvider extends BuiltinProvider> = keyof BuiltinCatalog[TProvider];
type BuiltinImageModelId<TProvider extends BuiltinProvider> = keyof BuiltinImageCatalog[TProvider];
type BuiltinClassifierModelId<TProvider extends BuiltinProvider> = keyof BuiltinClassifierCatalog[TProvider];
/** API ids of catalog entries. Built-in getters return `Model<Api>` shapes, not literal entry types. */
type CatalogApi<TEntry> = TEntry extends { api: infer TApi extends string } ? TApi : never;

/** Typed read of one generated built-in chat model. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends BuiltinChatModelId<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): Model<CatalogApi<BuiltinCatalog[TProvider][TModelId]>> {
	return (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[normalizeProviderId(provider)]?.[
		modelId as string
	] as Model<CatalogApi<BuiltinCatalog[TProvider][TModelId]>>;
}

/** Typed read of one generated built-in image model. */
export function getBuiltinImageModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinImageModelId<TProvider>,
>(provider: TProvider, modelId: TModelId): ImageModel<CatalogApi<BuiltinImageCatalog[TProvider][TModelId]>> {
	return (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[
		normalizeProviderId(provider)
	]?.[modelId as string] as ImageModel<CatalogApi<BuiltinImageCatalog[TProvider][TModelId]>>;
}

/** Typed read of one generated built-in classifier model. */
export function getBuiltinClassifierModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinClassifierModelId<TProvider>,
>(provider: TProvider, modelId: TModelId): ClassifierModel<CatalogApi<BuiltinClassifierCatalog[TProvider][TModelId]>> {
	return (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[
		normalizeProviderId(provider)
	]?.[modelId as string] as ClassifierModel<CatalogApi<BuiltinClassifierCatalog[TProvider][TModelId]>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<CatalogApi<BuiltinCatalog[TProvider][BuiltinChatModelId<TProvider>]>>[] {
	const models = (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[normalizeProviderId(provider)];
	return Object.values(models ?? {}) as Model<CatalogApi<BuiltinCatalog[TProvider][BuiltinChatModelId<TProvider>]>>[];
}

export function getBuiltinImageModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ImageModel<CatalogApi<BuiltinImageCatalog[TProvider][BuiltinImageModelId<TProvider>]>>[] {
	const models = (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[
		normalizeProviderId(provider)
	];
	return Object.values(models ?? {}) as ImageModel<
		CatalogApi<BuiltinImageCatalog[TProvider][BuiltinImageModelId<TProvider>]>
	>[];
}

export function getBuiltinClassifierModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ClassifierModel<CatalogApi<BuiltinClassifierCatalog[TProvider][BuiltinClassifierModelId<TProvider>]>>[] {
	const models = (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[
		normalizeProviderId(provider)
	];
	return Object.values(models ?? {}) as ClassifierModel<
		CatalogApi<BuiltinClassifierCatalog[TProvider][BuiltinClassifierModelId<TProvider>]>
	>[];
}

export function getAllBuiltinModels<TProvider extends BuiltinProvider>(provider: TProvider): AnyModel[] {
	return [...getBuiltinModels(provider), ...getBuiltinImageModels(provider), ...getBuiltinClassifierModels(provider)];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		anthropicApiProvider(),
		azureProvider(),
		basetenProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		metaProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		morphProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiApiProvider(),
		openaiCodexProvider(),
		openaiDecisionsProvider(),
		openaiImagesProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		qwenTokenPlanIndividualProvider(),
		radiusProvider(),
		togetherProvider(),
		typesafeProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}
