import {
	type Api,
	getApiProvider,
	type Model,
	registerApiProvider,
	registerBuiltInApiProviders,
	type SimpleStreamOptions,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { warnDeprecation } from "../utils/deprecation.ts";
import { normalizeContextWindowOptions, validateContextWindowValue } from "./context-window.ts";
import { applyModelOverride } from "./model-registry-builtins.ts";
import type { DynamicProviderApplyInput, ProviderConfigInput } from "./model-registry-types.ts";
import { registerLegacyOAuthProvider, unregisterLegacyOAuthProviders } from "./oauth-provider-bridge.ts";
import { isLegacyEnvVarNameConfigValue } from "./resolve-config-value.ts";


type RuntimeApiProvider = Parameters<typeof registerApiProvider>[0];
type ActiveApiProvider = NonNullable<ReturnType<typeof getApiProvider>>;

interface RuntimeApiRegistration {
	sourceId: string;
	provider: RuntimeApiProvider;
	activeProvider?: ActiveApiProvider;
}

const runtimeApiRegistrations = new Map<Api, RuntimeApiRegistration[]>();
const runtimeApiFallbacks = new Map<Api, ActiveApiProvider>();

function unregisterRuntimeApiProvider(sourceId: string): void {
	for (const [api, registrations] of runtimeApiRegistrations) {
		const index = registrations.findIndex((entry) => entry.sourceId === sourceId);
		if (index < 0) continue;
		const [removed] = registrations.splice(index, 1);
		if (removed && getApiProvider(api) === removed.activeProvider) {
			unregisterApiProviders(sourceId);
			const previous = registrations.at(-1);
			if (previous) {
				registerApiProvider(previous.provider, previous.sourceId);
				previous.activeProvider = getApiProvider(api);
			} else {
				const fallback = runtimeApiFallbacks.get(api);
				if (fallback) registerApiProvider(fallback, `atomic:restored-api:${api}`);
				else registerBuiltInApiProviders();
			}
		}
		if (registrations.length === 0) {
			runtimeApiRegistrations.delete(api);
			runtimeApiFallbacks.delete(api);
		}
	}
}

function registerRuntimeApiProvider(provider: RuntimeApiProvider, sourceId: string): void {
	unregisterRuntimeApiProvider(sourceId);
	const registrations = runtimeApiRegistrations.get(provider.api) ?? [];
	if (registrations.length === 0) {
		const fallback = getApiProvider(provider.api);
		if (fallback) runtimeApiFallbacks.set(provider.api, fallback);
	}
	const registration: RuntimeApiRegistration = { sourceId, provider };
	registrations.push(registration);
	runtimeApiRegistrations.set(provider.api, registrations);
	registerApiProvider(provider, sourceId);
	registration.activeProvider = getApiProvider(provider.api);
}

export function unregisterProviderRuntime(sourceId: string): void {
	unregisterRuntimeApiProvider(sourceId);
	unregisterLegacyOAuthProviders(sourceId);
}
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

export function applyProviderConfigToModels(input: DynamicProviderApplyInput): Model<Api>[] {
	const { providerName, registrationSource, config, authStorage, modelOverrides, storeProviderRequestConfig, storeModelHeaders } = input;
	let models = input.models;

	if (input.registerRuntime && config.oauth) registerLegacyOAuthProvider(providerName, config.oauth, registrationSource);

	if (input.registerRuntime && config.streamSimple) {
		const streamSimple = config.streamSimple;
		registerRuntimeApiProvider({
			api: config.api!,
			stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
			streamSimple,
		}, registrationSource);
	}

	storeProviderRequestConfig(providerName, config);

	if (config.models && config.models.length > 0) {
		models = models.filter((m) => m.provider !== providerName);

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			const modelOverride = modelOverrides.get(providerName)?.get(modelDef.id);
			storeModelHeaders(providerName, modelDef.id, {
				...modelDef.headers,
				...modelOverride?.headers,
			});

			const model = {
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

		if (config.oauth?.modifyModels) {
			const cred = authStorage.get(providerName);
			if (cred?.type === "oauth") {
				models = config.oauth.modifyModels(models, cred);
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
