import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { resolveProviderModelSelection } from "./model-registry-selection.js";
import { ProviderModelSelectionError } from "./provider-model-reference.js";

/** Resolve an RPC provider selection only from the current available catalog. */
export function resolveAvailableProviderModel(
	availableModels: readonly Model<Api>[],
	provider: string,
	modelId: string,
	requiresExactSelection: boolean,
	providerSelection?: unknown,
): Model<Api> {
	if (requiresExactSelection) {
		return resolveProviderModelSelection({
			models: availableModels,
			provider,
			modelId,
			selection: providerSelection,
			selectionKind: "transport",
			requirePersistedSelection: false,
			restoring: false,
		});
	}
	const model = availableModels.find((candidate) => candidate.provider === provider && candidate.id === modelId);
	if (model) return model;
	throw new ProviderModelSelectionError(
		"UnsupportedSelection",
		`Model ${provider}/${JSON.stringify(modelId)} is not in the current available catalog.`,
		provider,
		modelId,
	);
}
