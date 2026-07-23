import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStorage } from "./auth-storage.ts";
import { loadBuiltInModels, mergeCustomModels } from "./model-registry-builtins.ts";
import { loadCustomModelsFromPaths } from "./model-registry-custom-loader.ts";
import type { ModelRegistryLoadResult } from "./model-registry-types.ts";

const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);

export function loadModelRegistryModels(
	authStorage: AuthStorage,
	modelsJsonPaths: string[],
	baseModels?: readonly Model<Api>[],
): ModelRegistryLoadResult {
	const {
		models: customModels,
		overrides,
		modelOverrides,
		providerRequestConfigs,
		modelRequestHeaders,
		configuredProviders,
		error,
	} = loadCustomModelsFromPaths(modelsJsonPaths);

	const builtInModels = loadBuiltInModels(overrides, modelOverrides, baseModels);
	const builtInProviders = new Set(builtInModels.map((model) => model.provider));
	const customOpenAICompatibleProviders = new Set(
		customModels
			.filter((model) => !builtInProviders.has(model.provider) && OPENAI_COMPATIBLE_APIS.has(model.api))
			.map((model) => model.provider),
	);
	let combined: Model<Api>[] = mergeCustomModels(builtInModels, customModels);

	for (const oauthProvider of authStorage.getOAuthProviders()) {
		const cred = authStorage.get(oauthProvider.id);
		if (cred?.type === "oauth" && oauthProvider.modifyModels) {
			combined = oauthProvider.modifyModels(combined, cred);
		}
	}

	return {
		modelOverrides,
		models: combined,
		providerRequestConfigs,
		modelRequestHeaders,
		configuredProviders,
		builtInProviders,
		customOpenAICompatibleProviders,
		loadError: error,
	};
}
