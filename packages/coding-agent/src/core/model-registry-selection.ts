import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	getPersistedProviderSelection,
	getProviderModelReference,
	ProviderModelSelectionError,
	providerReferenceMatchesSelection,
	providerModelsAreExactlyEqual,
} from "./provider-model-reference.js";

export function resolveProviderModelSelection(input: {
	readonly models: readonly Model<Api>[];
	readonly provider: string;
	readonly modelId: string;
	readonly selection?: unknown;
	readonly requirePersistedSelection: boolean;
	readonly restoring: boolean;
}): Model<Api> {
	const matches = input.models.filter((model) => model.provider === input.provider && model.id === input.modelId);
	if (matches.length === 0) {
		throw selectionError("UnsupportedSelection", input, `Model ${input.provider}/${JSON.stringify(input.modelId)} is not in the current authoritative catalog.`);
	}
	if (input.restoring && input.requirePersistedSelection) {
		const runtimeOnly = matches.some((model) => {
			const reference = getProviderModelReference(model);
			return reference !== undefined && reference.selection === undefined;
		});
		if (runtimeOnly) {
			throw selectionError("PersistenceUnavailable", input, `Current ${input.provider} routes cannot be persisted without a stable authenticated account scope; select an exact route again in this session.`);
		}
		if (input.selection === undefined) throw selectionError("MissingSelection", input, `Saved ${input.provider} model lacks the required exact selection record; select a model again.`);
	}
	if (input.selection !== undefined) {
		const exact = matches.filter((model) => providerReferenceMatchesSelection(model, input.selection));
		if (exact.length === 1) return exact[0];
		if (exact.length > 1) {
			throw selectionError("AmbiguousSelection", input, `Saved ${input.provider} selection matches multiple current occurrences; select a model again.`);
		}
		throw selectionError("MismatchedSelection", input, `Saved ${input.provider} selection is not present in the current authenticated catalog; select a model again.`);
	}
	if (matches.length === 1) return matches[0];
	throw selectionError("AmbiguousSelection", input, `Model ${input.provider}/${JSON.stringify(input.modelId)} matches ${matches.length} exact occurrences; select an occurrence explicitly.`);
}

export function validateSelectedProviderModel(
	model: Model<Api>,
	registry: {
		requiresExactSelectionPersistence(provider: string): boolean;
		restoreExactModel(provider: string, modelId: string, selection: unknown): Model<Api>;
		getAll(): Model<Api>[];
	},
): Model<Api> {
	if (!registry.requiresExactSelectionPersistence(model.provider)) return model;
	const selection = getPersistedProviderSelection(model);
	if (selection !== undefined) return registry.restoreExactModel(model.provider, model.id, selection);
	if (getProviderModelReference(model)) {
		const exact = registry.getAll().filter((candidate) => providerModelsAreExactlyEqual(candidate, model));
		if (exact.length === 1) return exact[0];
	}
	throw new ProviderModelSelectionError("MissingSelection", `Model ${model.provider}/${JSON.stringify(model.id)} lacks a current exact provider reference.`, model.provider, model.id);
}

function selectionError(
	code: ConstructorParameters<typeof ProviderModelSelectionError>[0],
	input: { readonly provider: string; readonly modelId: string },
	message: string,
): ProviderModelSelectionError {
	return new ProviderModelSelectionError(code, message, input.provider, input.modelId);
}
