import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "./model-registry.js";
import { getPersistedProviderSelection } from "./provider-model-reference.js";
import type { SettingsManager } from "./settings-manager.js";

/** Persist a default only when an exact-selection provider exposes a persistable identity. */
export function persistProviderModelDefault(
	settingsManager: SettingsManager,
	modelRegistry: ModelRegistry,
	model: Model<Api>,
): boolean {
	const selection = getPersistedProviderSelection(model);
	if (modelRegistry.requiresExactSelectionPersistence(model.provider) && selection === undefined) return false;
	settingsManager.setDefaultModelAndProvider(model.provider, model.id, selection);
	return true;
}
