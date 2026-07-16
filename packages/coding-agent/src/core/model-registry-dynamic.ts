import {
	type Api,
	type Model,
	type OAuthProviderInterface,
	registerApiProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { applyModelModifierPreservingCursor, publishImmutableCursorModel } from "./model-registry-cursor-modifier.ts";
import { warnDeprecation } from "../utils/deprecation.ts";
import { normalizeContextWindowOptions, validateContextWindowValue } from "./context-window.ts";
import { applyModelOverride } from "./model-registry-builtins.ts";
import type { DynamicProviderApplyInput, ProviderConfigInput } from "./model-registry-types.ts";
import { isLegacyEnvVarNameConfigValue } from "./resolve-config-value.ts";

function validateContextWindowOptions(providerName: string, modelId: string, options: readonly number[] | undefined): void {
	for (const option of options ?? []) {
		if (validateContextWindowValue(option)) {
			throw new Error(`Provider ${providerName}, model ${modelId}: invalid contextWindowOptions value`);
		}
	}
}

function migrateLegacyRegisterProviderConfigValue(providerName: string, field: string, value: string): string {
	if (!isLegacyEnvVarNameConfigValue(value) || process.env[value] === undefined) return value;
	warnDeprecation(
		`registerProvider("${providerName}") ${field} value "${value}" is treated as a legacy environment variable reference. This will no longer be detected as an environment variable reference in a future release. Pass "$${value}" instead.`,
	);
	return `$${value}`;
}

function migrateLegacyRegisterProviderHeaders(
	providerName: string,
	field: string,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	let migratedHeaders: Record<string, string> | undefined;
	for (const [key, value] of Object.entries(headers)) {
		const migratedValue = migrateLegacyRegisterProviderConfigValue(providerName, `${field} header "${key}"`, value);
		if (migratedValue === value) continue;
		migratedHeaders ??= { ...headers };
		migratedHeaders[key] = migratedValue;
	}
	return migratedHeaders ?? headers;
}

export function migrateLegacyRegisterProviderConfigValues(
	providerName: string,
	config: ProviderConfigInput,
): ProviderConfigInput {
	let migratedConfig: ProviderConfigInput | undefined;

	const setMigratedConfigValue = <TKey extends keyof ProviderConfigInput>(
		key: TKey,
		value: ProviderConfigInput[TKey],
	) => {
		migratedConfig ??= { ...config };
		migratedConfig[key] = value;
	};

	if (config.apiKey) {
		const apiKey = migrateLegacyRegisterProviderConfigValue(providerName, "apiKey", config.apiKey);
		if (apiKey !== config.apiKey) {
			setMigratedConfigValue("apiKey", apiKey);
		}
	}

	const headers = migrateLegacyRegisterProviderHeaders(providerName, "headers", config.headers);
	if (headers !== config.headers) {
		setMigratedConfigValue("headers", headers);
	}

	if (config.models) {
		let models: ProviderConfigInput["models"] | undefined;
		for (let index = 0; index < config.models.length; index++) {
			const model = config.models[index];
			const modelHeaders = migrateLegacyRegisterProviderHeaders(
				providerName,
				`model "${model.id}" headers`,
				model.headers,
			);
			if (modelHeaders === model.headers) continue;
			models ??= [...config.models];
			models[index] = { ...model, headers: modelHeaders };
		}
		if (models) {
			setMigratedConfigValue("models", models);
		}
	}

	return migratedConfig ?? config;
}

export function validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
	if (config.streamSimple && !config.api) {
		throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
	}

	if (!config.models || config.models.length === 0) {
		return;
	}

	if (!config.baseUrl) {
		throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
	}
	if (!config.apiKey && !config.oauth) {
		throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
	}

	for (const modelDef of config.models) {
		const api = modelDef.api || config.api;
		if (!api) {
			throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
		}
		if (validateContextWindowValue(modelDef.contextWindow)) {
			throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
		}
		validateContextWindowOptions(providerName, modelDef.id, modelDef.contextWindowOptions);
		if (modelDef.maxTokens <= 0) {
			throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
		}
	}
}
function canonicalCursorModel(providerName: string, model: NonNullable<ProviderConfigInput["models"]>[number]): Model<Api> | undefined {
	if (providerName !== "cursor") return undefined;
	const candidate = model as Model<Api>;
	return candidate.provider === "cursor" && candidate.api === "cursor-agent"
		? publishImmutableCursorModel(candidate)
		: undefined;
}

export function applyProviderConfigToModels(input: DynamicProviderApplyInput): Model<Api>[] {
	const { providerName, config, authStorage, modelOverrides, storeProviderRequestConfig, storeModelHeaders } = input;
	let models = input.models;

	if (config.oauth) {
		const oauthProvider: OAuthProviderInterface = {
			...config.oauth,
			id: providerName,
		};
		registerOAuthProvider(oauthProvider);
	}

	if (config.streamSimple) {
		const streamSimple = config.streamSimple;
		registerApiProvider(
			{
				api: config.api!,
				stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
				streamSimple,
			},
			`provider:${providerName}`,
		);
	}

	storeProviderRequestConfig(providerName, config);

	if (config.models !== undefined) {
		models = models.filter((m) => m.provider !== providerName);

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			const modelOverride = modelOverrides.get(providerName)?.get(modelDef.id);
			storeModelHeaders(providerName, modelDef.id, {
				...modelDef.headers,
				...modelOverride?.headers,
			});

			const canonical = canonicalCursorModel(providerName, modelDef);
			const model = canonical ?? {
				id: modelDef.id,
				name: modelDef.name,
				api: api as Api,
				provider: providerName,
				baseUrl: modelDef.baseUrl ?? config.baseUrl!,
				reasoning: modelDef.reasoning,
				thinkingLevelMap: modelDef.thinkingLevelMap,
				input: modelDef.input as ("text" | "image")[],
				cost: modelDef.cost,
				contextWindow: modelDef.contextWindow,
				defaultContextWindow: modelDef.contextWindow,
				contextWindowOptions: normalizeContextWindowOptions([
					modelDef.contextWindow,
					...(modelDef.contextWindowOptions ?? []),
				]),
				maxTokens: modelDef.maxTokens,
				headers: undefined,
				compat: modelDef.compat,
			} as Model<Api>;
			models.push(modelOverride ? applyModelOverride(model, modelOverride) : model);
		}

		if (config.models.length > 0 && config.oauth?.modifyModels) {
			const cred = authStorage.get(providerName);
			if (cred?.type === "oauth") {
				models = applyModelModifierPreservingCursor(models, cred, config.oauth.modifyModels);
			}
		}
	} else if (config.baseUrl || config.headers) {
		models = models.map((m) => {
			if (m.provider !== providerName) return m;
			return {
				...m,
				baseUrl: config.baseUrl ?? m.baseUrl,
			};
		});
	}

	return models;
}
