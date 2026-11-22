import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ProviderId,
} from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

type ModelKey<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

type KeyForType<TGroups extends ModelGroups, TType extends ModelType> = Extract<
	ModelKey<TGroups>,
	`${TType}:${string}`
>;

type ModelId<TKey extends string> = TKey extends `${ModelType}:${infer TModelId}` ? TModelId : never;

type ApiForKey<TGroups extends ModelGroups, TKey extends ModelKey<TGroups>> = {
	[TApi in keyof TGroups]: TKey extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups];

export type ChatModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TKey in KeyForType<TGroups, "chat"> as ModelId<TKey>]: Model<ApiForKey<TGroups, TKey> & Api> & {
		id: ModelId<TKey>;
		provider: TProvider;
	};
};

export type ImageModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TKey in KeyForType<TGroups, "image"> as ModelId<TKey>]: ImageModel<ApiForKey<TGroups, TKey> & ImageApi> & {
		id: ModelId<TKey>;
		provider: TProvider;
	};
};

export type ClassifierModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TKey in KeyForType<TGroups, "classifier"> as ModelId<TKey>]: ClassifierModel<
		ApiForKey<TGroups, TKey> & ClassifierApi
	> & {
		id: ModelId<TKey>;
		provider: TProvider;
	};
};

function flattenModelCatalog(groups: ModelGroups, type: ModelType): Record<string, object> {
	const catalog: Record<string, object> = {};
	for (const apiKey in groups) {
		if (!Object.hasOwn(groups, apiKey)) continue;
		const models = groups[apiKey];
		if (!models) continue;
		for (const modelKey in models) {
			if (!Object.hasOwn(models, modelKey)) continue;
			const model = models[modelKey] as { type?: unknown; id: string } | undefined;
			if (model && model.type === type) {
				catalog[model.id] = model;
			}
		}
	}
	return catalog;
}

export function flattenChatModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	provider: TProvider,
	groups: TGroups,
): ChatModelCatalog<TGroups, TProvider> {
	const catalog = flattenModelCatalog(groups, "chat") as ChatModelCatalog<TGroups, TProvider>;
	if (
		provider === "xiaomi" ||
		provider === "xiaomi-token-plan-cn" ||
		provider === "xiaomi-token-plan-ams" ||
		provider === "xiaomi-token-plan-sgp"
	) {
		for (const [id, entry] of Object.entries(catalog)) {
			const model = entry as Model<Api>;
			if (model.api !== "openai-completions") continue;
			Object.assign(catalog, {
				[id]: {
					...model,
					compat: { ...model.compat, supportsReasoningEffort: false },
					...(model.reasoning
						? {
								thinkingLevelMap: {
									off: "off",
									minimal: null,
									low: null,
									medium: null,
									high: "high",
									xhigh: null,
									max: null,
								},
							}
						: {}),
				},
			});
		}
	}
	return catalog;
}

export function flattenImageModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ImageModelCatalog<TGroups, TProvider> {
	return flattenModelCatalog(groups, "image") as ImageModelCatalog<TGroups, TProvider>;
}

export function flattenClassifierModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ClassifierModelCatalog<TGroups, TProvider> {
	return flattenModelCatalog(groups, "classifier") as ClassifierModelCatalog<TGroups, TProvider>;
}
