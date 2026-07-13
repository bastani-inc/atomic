import type { Api, Model } from "@earendil-works/pi-ai/compat";

interface CursorAliasCompat {
	readonly cursorModelAliases?: readonly string[];
}
export function hasModelAlias(
	models: readonly Model<Api>[],
	modelId: string,
	provider?: string,
	caseSensitive = false,
): boolean {
	return matchingModelAliases(models, modelId, provider, caseSensitive).length > 0;
}
export function findUniqueModelAlias(
	models: readonly Model<Api>[],
	modelId: string,
	provider?: string,
	caseSensitive = false,
): Model<Api> | undefined {
	const matches = matchingModelAliases(models, modelId, provider, caseSensitive);
	return matches.length === 1 ? matches[0] : undefined;
}

function matchingModelAliases(
	models: readonly Model<Api>[],
	modelId: string,
	provider: string | undefined,
	caseSensitive: boolean,
): Model<Api>[] {
	const normalize = caseSensitive ? (value: string) => value : (value: string) => value.toLowerCase();
	const expectedId = normalize(modelId);
	const expectedProvider = provider === undefined ? undefined : normalize(provider);
	return models.filter((model) => {
		if (model.provider !== "cursor") return false;
		if (expectedProvider !== undefined && normalize(model.provider) !== expectedProvider) return false;
		return cursorModelAliases(model).some((alias) => normalize(alias) === expectedId);
	});
}

function cursorModelAliases(model: Model<Api>): readonly string[] {
	const compat = model.compat as CursorAliasCompat | undefined;
	return Array.isArray(compat?.cursorModelAliases)
		? compat.cursorModelAliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
		: [];
}
