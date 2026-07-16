import { type Api, type BuiltinProvider, getModels, getProviders, type Model } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync } from "fs";
import { normalizeContextWindowOptions, validateContextWindowValue } from "./context-window.ts";
import { mergeCompat, mergeCustomModels } from "./model-registry-builtins.ts";
import {
	formatValidationPath,
	type ModelsConfig,
	type ModelOverride,
	stripJsonComments,
	validateModelsConfig,
} from "./model-registry-schemas.ts";
import type {
	CustomModelsResult,
	ModelRequestHeaders,
	ModelRequestHeaderSource,
	ModelRequestHeaderSources,
	ProviderOverride,
	ProviderRequestConfig,
} from "./model-registry-types.ts";

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return {
		models: [],
		overrides: new Map(),
		modelOverrides: new Map(),
		providerRequestConfigs: new Map(),
		modelRequestHeaders: new Map(),
		modelRequestHeaderSources: new Map(),
		error,
	};
}

function mergeModelOverrides(
	base: Map<string, Map<string, ModelOverride>>,
	incoming: Map<string, Map<string, ModelOverride>>,
): Map<string, Map<string, ModelOverride>> {
	const merged = new Map<string, Map<string, ModelOverride>>(
		[...base].map(([providerName, overrides]) => [providerName, new Map(overrides)]),
	);
	for (const [providerName, incomingOverrides] of incoming) {
		const providerOverrides = new Map(merged.get(providerName) ?? []);
		for (const [modelId, modelOverride] of incomingOverrides) {
			providerOverrides.set(modelId, modelOverride);
		}
		merged.set(providerName, providerOverrides);
	}
	return merged;
}

interface MergedModelRequestHeaders {
	headers: ModelRequestHeaders;
	sources: ModelRequestHeaderSources;
}

function cloneNestedMap<T>(source: Map<string, Map<string, T>>): Map<string, Map<string, T>> {
	return new Map([...source].map(([providerName, models]) => [providerName, new Map(models)]));
}

function setNestedValue<T>(target: Map<string, Map<string, T>>, providerName: string, modelId: string, value: T): void {
	const models = new Map(target.get(providerName) ?? []);
	models.set(modelId, value);
	target.set(providerName, models);
}

function deleteNestedValue<T>(target: Map<string, Map<string, T>>, providerName: string, modelId: string): void {
	const models = target.get(providerName);
	if (!models) return;
	models.delete(modelId);
	if (models.size === 0) target.delete(providerName);
}

function mergeModelRequestHeaders(
	base: CustomModelsResult,
	incoming: CustomModelsResult,
): MergedModelRequestHeaders {
	const headers = cloneNestedMap(base.modelRequestHeaders);
	const sources = cloneNestedMap(base.modelRequestHeaderSources);
	const invalidate = (providerName: string, modelId: string, source: ModelRequestHeaderSource): void => {
		if (sources.get(providerName)?.get(modelId) !== source) return;
		deleteNestedValue(headers, providerName, modelId);
		deleteNestedValue(sources, providerName, modelId);
	};

	for (const model of incoming.models) invalidate(model.provider, model.id, "model");
	for (const [providerName, overrides] of incoming.modelOverrides) {
		for (const modelId of overrides.keys()) invalidate(providerName, modelId, "modelOverride");
	}
	for (const [providerName, models] of incoming.modelRequestHeaders) {
		for (const [modelId, value] of models) setNestedValue(headers, providerName, modelId, value);
	}
	for (const [providerName, models] of incoming.modelRequestHeaderSources) {
		for (const [modelId, source] of models) setNestedValue(sources, providerName, modelId, source);
	}
	return { headers, sources };
}

function mergeCustomModelResults(base: CustomModelsResult, incoming: CustomModelsResult): CustomModelsResult {
	const mergedHeaders = mergeModelRequestHeaders(base, incoming);
	return {
		models: mergeCustomModels(base.models, incoming.models),
		overrides: new Map([...base.overrides, ...incoming.overrides]),
		modelOverrides: mergeModelOverrides(base.modelOverrides, incoming.modelOverrides),
		providerRequestConfigs: new Map([...base.providerRequestConfigs, ...incoming.providerRequestConfigs]),
		modelRequestHeaders: mergedHeaders.headers,
		modelRequestHeaderSources: mergedHeaders.sources,
		error: undefined,
	};
}

function collectProviderRequestConfig(
	providerName: string,
	config: ProviderRequestConfig,
	requestConfigs: Map<string, ProviderRequestConfig>,
): void {
	if (!config.apiKey && !config.headers && !config.authHeader) return;
	requestConfigs.set(providerName, {
		apiKey: config.apiKey,
		headers: config.headers,
		authHeader: config.authHeader,
	});
}

function collectModelHeaders(
	providerName: string,
	modelId: string,
	headers: Record<string, string> | undefined,
	modelHeaders: ModelRequestHeaders,
	modelHeaderSources: ModelRequestHeaderSources,
	source: ModelRequestHeaderSource,
): void {
	if (!headers || Object.keys(headers).length === 0) return;
	setNestedValue(modelHeaders, providerName, modelId, headers);
	setNestedValue(modelHeaderSources, providerName, modelId, source);
}

function validateContextWindowOptions(providerName: string, modelId: string, options: readonly number[] | undefined): void {
	for (const option of options ?? []) {
		if (validateContextWindowValue(option)) {
			throw new Error(`Provider ${providerName}, model ${modelId}: invalid contextWindowOptions value`);
		}
	}
}

function validateConfig(config: ModelsConfig): void {
	const builtInProviders = new Set<string>(getProviders());

	for (const [providerName, providerConfig] of Object.entries(config.providers)) {
		const isBuiltIn = builtInProviders.has(providerName);
		const hasProviderApi = !!providerConfig.api;
		const models = providerConfig.models ?? [];
		const hasModelOverrides =
			providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

		if (models.length === 0) {
			if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
				);
			}
		} else if (!isBuiltIn) {
			if (!providerConfig.baseUrl) {
				throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
			}
			if (!providerConfig.apiKey) {
				throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
			}
		}

		for (const modelDef of models) {
			const hasModelApi = !!modelDef.api;

			if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
				throw new Error(
					`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
				);
			}

			if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
			if (modelDef.contextWindow !== undefined && validateContextWindowValue(modelDef.contextWindow)) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			validateContextWindowOptions(providerName, modelDef.id, modelDef.contextWindowOptions);
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}

		for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides ?? {})) {
			if (modelOverride.contextWindow !== undefined && validateContextWindowValue(modelOverride.contextWindow)) {
				throw new Error(`Provider ${providerName}, model ${modelId}: invalid contextWindow`);
			}
			validateContextWindowOptions(providerName, modelId, modelOverride.contextWindowOptions);
			if (modelOverride.maxTokens !== undefined && modelOverride.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelId}: invalid maxTokens`);
			}
		}
	}
}

function parseModels(
	config: ModelsConfig,
	modelHeaders: ModelRequestHeaders,
	modelHeaderSources: ModelRequestHeaderSources,
): Model<Api>[] {
	const models: Model<Api>[] = [];
	const builtInProviders = new Set<string>(getProviders());
	const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
	const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
		if (!builtInProviders.has(providerName)) return undefined;
		if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
		const builtIn = getModels(providerName as BuiltinProvider) as Model<Api>[];
		if (builtIn.length === 0) return undefined;
		const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
		builtInDefaultsCache.set(providerName, defaults);
		return defaults;
	};

	for (const [providerName, providerConfig] of Object.entries(config.providers)) {
		const modelDefs = providerConfig.models ?? [];
		if (modelDefs.length === 0) continue;

		const builtInDefaults = getBuiltInDefaults(providerName);

		for (const modelDef of modelDefs) {
			const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
			if (!api) continue;

			const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
			if (!baseUrl) continue;

			const compat = mergeCompat(providerConfig.compat, modelDef.compat);
			collectModelHeaders(providerName, modelDef.id, modelDef.headers, modelHeaders, modelHeaderSources, "model");

			const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			const contextWindow = modelDef.contextWindow ?? 128000;
			models.push({
				id: modelDef.id,
				name: modelDef.name ?? modelDef.id,
				api: api as Api,
				provider: providerName,
				baseUrl,
				reasoning: modelDef.reasoning ?? false,
				thinkingLevelMap: modelDef.thinkingLevelMap,
				input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
				cost: modelDef.cost ?? defaultCost,
				contextWindow,
				defaultContextWindow: contextWindow,
				contextWindowOptions: normalizeContextWindowOptions([contextWindow, ...(modelDef.contextWindowOptions ?? [])]),
				maxTokens: modelDef.maxTokens ?? 16384,
				headers: undefined,
				compat,
			} as Model<Api>);
		}
	}

	return models;
}

function loadCustomModels(modelsJsonPath: string): CustomModelsResult {
	if (!existsSync(modelsJsonPath)) {
		return emptyCustomModelsResult();
	}

	try {
		const content = readFileSync(modelsJsonPath, "utf-8");
		const parsed = JSON.parse(stripJsonComments(content)) as unknown;

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
		}

		const config = parsed as ModelsConfig;
		validateConfig(config);

		const overrides = new Map<string, ProviderOverride>();
		const modelOverrides = new Map<string, Map<string, ModelOverride>>();
		const providerRequestConfigs = new Map<string, ProviderRequestConfig>();
		const modelRequestHeaders: ModelRequestHeaders = new Map();
		const modelRequestHeaderSources: ModelRequestHeaderSources = new Map();

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			if (providerConfig.baseUrl || providerConfig.compat) {
				overrides.set(providerName, {
					baseUrl: providerConfig.baseUrl,
					compat: providerConfig.compat as Model<Api>["compat"],
				});
			}

			collectProviderRequestConfig(providerName, providerConfig, providerRequestConfigs);

			if (providerConfig.modelOverrides) {
				modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
				for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
					collectModelHeaders(
						providerName,
						modelId,
						modelOverride.headers,
						modelRequestHeaders,
						modelRequestHeaderSources,
						"modelOverride",
					);
				}
			}
		}

		return {
			models: parseModels(config, modelRequestHeaders, modelRequestHeaderSources),
			overrides,
			modelOverrides,
			providerRequestConfigs,
			modelRequestHeaders,
			modelRequestHeaderSources,
			error: undefined,
		};
	} catch (error) {
		if (error instanceof SyntaxError) {
			return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
		}
		return emptyCustomModelsResult(
			`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
		);
	}
}

export function loadCustomModelsFromPaths(modelsJsonPaths: string[]): CustomModelsResult {
	let combined = emptyCustomModelsResult();
	const errors: string[] = [];
	for (let i = modelsJsonPaths.length - 1; i >= 0; i--) {
		const result = loadCustomModels(modelsJsonPaths[i]!);
		if (result.error) {
			errors.push(result.error);
			continue;
		}
		combined = mergeCustomModelResults(combined, result);
	}
	return { ...combined, error: errors.length > 0 ? errors.join("\n\n") : undefined };
}
