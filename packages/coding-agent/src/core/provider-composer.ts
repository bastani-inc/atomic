import {
	type AnyModel,
	type Api,
	type AssistantMessageEventStream,
	type Credential,
	classifierErrorResult,
	imageErrorResult,
	isModelType,
	lazyStream,
	type Model,
	type OAuthCredentials,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@bastani/pi-ai";
import { getApiProvider } from "@bastani/pi-ai/compat";
import type { ModelConfig, ModelsJsonProvider } from "./model-config.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer-internal.ts";
import {
	applyExtension,
	applyModelOverride,
	applyModelsJson,
	composeApiKeyAuth,
	composeOAuthAuth,
	configuredApiKey,
	configuredHeaders,
	rawModelHeaders,
} from "./provider-composer-internal.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export type { AuthStatus, ExtensionOAuthConfig, ProviderConfigInput } from "./provider-composer-internal.ts";
export { clearApiKeyCache } from "./provider-composer-internal.ts";

function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), modelsConfig), extension);
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let extensionOAuthCredential: OAuthCredentials | undefined;
	let refreshedExtensionModels: ProviderConfigInput["models"];
	const currentExtension = (): ProviderConfigInput | undefined =>
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	const getAllModels = (): AnyModel[] => {
		let models = applyExtension(
			providerId,
			applyModelsJson(providerId, getAllProviderModels(base), config),
			currentExtension(),
		);
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			// The extension hook is chat-only; other model types pass through untouched.
			models = [
				...extension.oauth.modifyModels(
					models.filter((model) => isModelType(model, "chat")),
					extensionOAuthCredential,
				),
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), config), {
										...extension,
										models: refreshed,
									});
									refreshedExtensionModels = refreshed;
								}
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		filterAllModels: base?.filterAllModels
			? (models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	const extensionImages = extension?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = extensionImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	const extensionClassifiers = extension?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = extensionClassifiers?.[model.api];
			if (implementation) return implementation.classify(model, context, options);
			if (classify) return classify(model, context, options);
			return Promise.resolve(
				classifierErrorResult(
					model,
					new Error(`Provider ${providerId} has no classifier implementation for "${model.api}"`),
				),
			);
		};
	}

	return provider;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export function resolveCompatibilityRequestConfig(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
