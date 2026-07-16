import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStorage } from "./auth-storage.ts";
import { loadBuiltInModels, mergeCustomModels } from "./model-registry-builtins.ts";
import { applyModelModifierPreservingCursor } from "./model-registry-cursor-modifier.ts";
import { loadCustomModelsFromPaths } from "./model-registry-custom-loader.ts";
import type { ModelRegistryLoadResult } from "./model-registry-types.ts";

const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);
const RESERVED_CURSOR_PROVIDER = "cursor";

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
	// Exact Cursor configuration is wholly reserved for authenticated discovery:
	// static rows, provider overrides, request auth/headers, and model overrides
	// must not create or mutate GetUsable/AvailableModels authority. Model request
	// headers use nested provider/model maps so arbitrary provider and model bytes
	// cannot collide.
	overrides.delete(RESERVED_CURSOR_PROVIDER);
	modelOverrides.delete(RESERVED_CURSOR_PROVIDER);
	providerRequestConfigs.delete(RESERVED_CURSOR_PROVIDER);
	modelRequestHeaders.delete(RESERVED_CURSOR_PROVIDER);

	const builtInModels = loadBuiltInModels(overrides, modelOverrides);
	const builtInProviders = new Set(builtInModels.map((model) => model.provider));
	// Exact lowercase Cursor models are published only by authenticated
	// GetUsable discovery. JSON configuration cannot manufacture that origin by
	// copying the private routing metadata shape; case/whitespace variants remain
	// ordinary custom providers.
	const selectableCustomModels = customModels.filter((model) => model.provider !== RESERVED_CURSOR_PROVIDER);
	const customOpenAICompatibleProviders = new Set(
		selectableCustomModels
			.filter((model) => !builtInProviders.has(model.provider) && OPENAI_COMPATIBLE_APIS.has(model.api))
			.map((model) => model.provider),
	);
	let combined: Model<Api>[] = mergeCustomModels(builtInModels, selectableCustomModels);

	for (const oauthProvider of authStorage.getOAuthProviders()) {
		const cred = authStorage.get(oauthProvider.id);
		if (cred?.type === "oauth" && oauthProvider.modifyModels) {
			combined = applyModelModifierPreservingCursor(combined, cred, oauthProvider.modifyModels);
		}
	}

	return {
		modelOverrides,
		models: combined,
		providerRequestConfigs,
		modelRequestHeaders,
		builtInProviders,
		customOpenAICompatibleProviders,
		loadError: error,
	};
}
