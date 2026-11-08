import type { Api, Model, ThinkingLevelMap } from "../src/types.ts";

type CatalogModel = Pick<Model<Api>, "id" | "provider" | "api" | "thinkingLevelMap">;

const LEVELS_THINKING_OFF_CAN_FALL_BACK_TO = ["minimal", "low", "medium"] as const;

function getOpenAIThinkingLevelMaps(models: readonly CatalogModel[]): Map<string, ThinkingLevelMap | undefined> {
	return new Map(
		models
			.filter((model) => model.provider === "openai" && model.api === "openai-responses")
			.map((model) => [model.id, model.thinkingLevelMap]),
	);
}

function getAzureOpenAIModels(models: readonly CatalogModel[]): CatalogModel[] {
	return models.filter((model) => model.provider === "azure" && model.api === "azure-openai-responses");
}

function mergeThinkingLevelMap(model: CatalogModel, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

/**
 * Azure serves the same OpenAI models, but its copies are made before the OpenAI thinking maps are
 * complete. Copy the OpenAI map's `off` entry and the efforts it lists under their own level name, except
 * `xhigh` and `max`: such an entry changes no request for a level the copy already offers, and `off` changes
 * only thinking `off`, while a remapped effort, `xhigh` and `max` would change an explicit Azure level or
 * which levels Azure offers. This is what lets thinking `off` send `none`, or fall back to a listed effort,
 * on Azure.
 */
export function applyAzureOpenAIListedEfforts(models: readonly CatalogModel[]): void {
	const openAIThinkingLevelMaps = getOpenAIThinkingLevelMaps(models);
	for (const model of getAzureOpenAIModels(models)) {
		const copied = Object.entries(openAIThinkingLevelMaps.get(model.id) ?? {}).filter(
			([level, value]) => level === "off" || (level === value && level !== "xhigh" && level !== "max"),
		);
		if (copied.length > 0) mergeThinkingLevelMap(model, Object.fromEntries(copied));
	}
}

/**
 * A session at thinking `off` on a model that cannot disable thinking runs at the lowest level the map
 * offers, so where the OpenAI map denies `off`, the Azure copy must not offer a lower level than the model
 * accepts. Copy the OpenAI map's `minimal`, `low` and `medium` masks onto it.
 */
export function applyAzureOpenAIThinkingOffMasks(models: readonly CatalogModel[]): void {
	const openAIThinkingLevelMaps = getOpenAIThinkingLevelMaps(models);
	for (const model of getAzureOpenAIModels(models)) {
		const openAIThinkingLevelMap = openAIThinkingLevelMaps.get(model.id);
		if (openAIThinkingLevelMap?.off !== null) continue;
		const masked = LEVELS_THINKING_OFF_CAN_FALL_BACK_TO.filter((level) => openAIThinkingLevelMap[level] === null);
		if (masked.length > 0) mergeThinkingLevelMap(model, Object.fromEntries(masked.map((level) => [level, null])));
	}
}
