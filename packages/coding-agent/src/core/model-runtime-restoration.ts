import type { Api, Provider } from "@earendil-works/pi-ai";
import type { ModelsJsonProvider } from "./model-config.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

const REMOTE_CATALOG_PROVIDERS = new Set(["github-copilot", "openrouter", "vercel-ai-gateway"]);
const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);

type ConfiguredModel = {
	api?: Api;
};

function hasOpenAICompatibleModel(
	models: readonly ConfiguredModel[] | undefined,
	defaultApi: Api | undefined,
): boolean {
	return (
		models?.some((model) => {
			const api = model.api ?? defaultApi;
			return api !== undefined && OPENAI_COMPATIBLE_APIS.has(api);
		}) === true
	);
}

/** Whether an authenticated provider may reconstruct an absent saved model ID. */
export function canRestoreUnknownModel(
	providerId: string,
	builtin: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	nativeExtension: Provider | undefined,
): boolean {
	if (REMOTE_CATALOG_PROVIDERS.has(providerId)) return true;
	if (builtin !== undefined) return false;
	if (hasOpenAICompatibleModel(modelsConfig?.models, modelsConfig?.api)) return true;
	if (hasOpenAICompatibleModel(extension?.models, extension?.api)) return true;
	return hasOpenAICompatibleModel(nativeExtension?.getModels(), undefined);
}
