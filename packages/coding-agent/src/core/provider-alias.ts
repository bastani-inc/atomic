import {
	type AnyModel,
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	lazyStream,
	type Model,
	type Provider,
	type ProviderRequestOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@bastani/pi-ai";

export interface ProviderAliasConfig {
	id: string;
	name?: string;
	provider: string;
}

function withProvider<T extends { provider: string }>(value: T, provider: string): T {
	return { ...value, provider };
}

function aliasApiKey(auth: ApiKeyAuth): ApiKeyAuth {
	return {
		...auth,
		check: async (input) => {
			if (!input.credential?.key?.trim()) return undefined;
			if (auth.check) return auth.check(input);
			const result = await auth.resolve(input);
			return result ? { type: "api_key", source: result.source } : undefined;
		},
		resolve: async (input) => (input.credential?.key?.trim() ? auth.resolve(input) : undefined),
	};
}

function sourceContext(context: TranscriptContext, alias: string, source: string): TranscriptContext {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant") return message;
			if (message.provider === alias) return withProvider(message, source);
			if (message.provider === source) return withProvider(message, `${source}:other-account`);
			return message;
		}),
	};
}

function aliasOptions<TModel extends AnyModel, T extends ProviderRequestOptions<TModel>>(
	options: T | undefined,
	model: TModel,
): T | undefined {
	if (!options) return undefined;
	return {
		...options,
		onPayload: options.onPayload ? (payload) => options.onPayload!(payload, model) : undefined,
		onResponse: options.onResponse ? (response) => options.onResponse!(response, model) : undefined,
	};
}

function aliasChatOptions<T extends StreamOptions>(options: T | undefined, model: Model<Api>): T | undefined {
	const mapped = aliasOptions(options, model);
	if (!mapped) return undefined;
	return {
		...mapped,
		onProviderStreamEvent: mapped.onProviderStreamEvent
			? (data) => mapped.onProviderStreamEvent!(data, model)
			: undefined,
	};
}

function aliasStream(model: Model<Api>, start: () => AssistantMessageEventStream): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		const source = start();
		async function* events(): AsyncGenerator<AssistantMessageEvent> {
			for await (const event of source) {
				if (event.type === "done") {
					yield { ...event, message: withProvider(event.message, model.provider) };
				} else if (event.type === "error") {
					yield { ...event, error: withProvider(event.error, model.provider) };
				} else {
					yield { ...event, partial: withProvider(event.partial, model.provider) };
				}
			}
		}
		return {
			[Symbol.asyncIterator]: events,
			result: async () => withProvider(await source.result(), model.provider),
		};
	});
}

export function createProviderAlias(config: ProviderAliasConfig, resolve: () => Provider): Provider {
	const source = resolve();
	const sourceModel = <T extends AnyModel>(model: T): T => withProvider(model, config.provider);
	const aliasModel = <T extends AnyModel>(model: T): T => withProvider(model, config.id);
	const apiKey = source.auth.apiKey;
	const oauth = source.auth.oauth;
	const alias: Provider = {
		id: config.id,
		name: config.name ?? config.id,
		baseUrl: source.baseUrl,
		headers: source.headers,
		auth: {
			...(apiKey ? { apiKey: aliasApiKey(apiKey) } : {}),
			...(oauth ? { oauth: { ...oauth, name: config.name ?? config.id } } : {}),
		},
		getModels: () => resolve().getModels().map(aliasModel),
		getAllModels: () => {
			const current = resolve();
			return (current.getAllModels?.() ?? current.getModels()).map(aliasModel);
		},
		filterModels: (models, credential) => {
			const current = resolve();
			return (current.filterModels?.(models.map(sourceModel), credential) ?? models).map(aliasModel);
		},
		filterAllModels: source.filterAllModels
			? (models, credential) => resolve().filterAllModels!(models.map(sourceModel), credential).map(aliasModel)
			: undefined,
		stream: (model, context, options) =>
			aliasStream(model, () =>
				resolve().stream(
					sourceModel(model),
					sourceContext(context, config.id, config.provider),
					aliasChatOptions(options, model),
				),
			),
		streamSimple: (model, context, options) =>
			aliasStream(model, () =>
				resolve().streamSimple(
					sourceModel(model),
					sourceContext(context, config.id, config.provider),
					aliasChatOptions(options, model),
				),
			),
	};
	if (source.fetchDeferred) {
		alias.fetchDeferred = (model, handle, options) =>
			aliasStream(model, () =>
				resolve().fetchDeferred!(sourceModel(model), handle, aliasChatOptions(options, model)),
			);
	}
	if (source.cancelDeferred) {
		alias.cancelDeferred = (model, handle, options) =>
			resolve().cancelDeferred!(sourceModel(model), handle, aliasOptions(options, model));
	}
	if (source.generateImages) {
		alias.generateImages = async (model, context, options) =>
			withProvider(
				await resolve().generateImages!(sourceModel(model), context, aliasOptions(options, model)),
				config.id,
			);
	}
	if (source.classify) {
		alias.classify = async (model, context, options) =>
			withProvider(await resolve().classify!(sourceModel(model), context, aliasOptions(options, model)), config.id);
	}
	return alias;
}
