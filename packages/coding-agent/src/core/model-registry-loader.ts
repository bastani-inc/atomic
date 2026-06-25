import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth-storage.ts";
import { loadBuiltInModels, mergeCustomModels } from "./model-registry-builtins.ts";
import { loadCustomModelsFromPaths } from "./model-registry-custom-loader.ts";
import type { ModelRegistryLoadResult } from "./model-registry-types.ts";

export function loadModelRegistryModels(
	authStorage: AuthStorage,
	modelsJsonPaths: string[],
): ModelRegistryLoadResult {
	const {
		models: customModels,
		overrides,
		modelOverrides,
		providerRequestConfigs,
		modelRequestHeaders,
		error,
	} = loadCustomModelsFromPaths(modelsJsonPaths);

	const builtInModels = loadBuiltInModels(overrides, modelOverrides);
	let combined: Model<Api>[] = mergeCustomModels(builtInModels, customModels);

	for (const oauthProvider of authStorage.getOAuthProviders()) {
		const cred = authStorage.get(oauthProvider.id);
		if (cred?.type === "oauth" && oauthProvider.modifyModels) {
			combined = oauthProvider.modifyModels(combined, cred);
		}
	}

	return {
		models: combined,
		providerRequestConfigs,
		modelRequestHeaders,
		loadError: error,
	};
}
