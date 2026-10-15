import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthResult,
	assertChatModel,
	type Context,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	lazyStream,
	type Model,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@bastani/pi-ai";
import { normalizeModelProvider } from "./azure-provider-compat.js";
import { usesChatGptCodexTransport, withChatGptCodexTransportRouting } from "./fast-model-routing.ts";
import { installCodexFastRouteWebSocketIdentity } from "./fast-model-routing-transport.ts";
import type { ModelRuntimeAuthOverrides } from "./model-runtime-types.ts";

export function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** SDK-owned request-auth result so transport preparation does not start a second deadline. */
export interface PreparedRequestAuth {
	readonly resolution: AuthResult | undefined;
	readonly reprepare?: () => Promise<{ model: Model<Api>; options: ModelRuntimeSimpleStreamOptions }>;
	readonly streamSimple?: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

export type ModelRuntimePreparedStreamOptions = StreamOptions &
	ModelsRequestTransforms & {
		preparedRequestAuth?: PreparedRequestAuth;
	};

export type ModelRuntimeSimpleStreamOptions = ModelsSimpleStreamOptions & {
	preparedRequestAuth?: PreparedRequestAuth;
};

type ResolveAuth = (model: Model<Api>, overrides?: ModelRuntimeAuthOverrides) => Promise<AuthResult | undefined>;
/** Whether an extension owns this model's transport, in which case it owns its serialization too. */
type OwnsExtensionTransport = (model: Model<Api>) => boolean;

/** Streaming request preparation split from ModelRuntime solely for Atomic's 500-line source gate. */
export class ModelRuntimeStreaming {
	private readonly models: MutableModels;
	private readonly resolveAuth: ResolveAuth;
	private readonly ownsExtensionTransport: OwnsExtensionTransport;
	private readonly transportModel: (model: Model<Api>) => Model<Api>;
	private readonly reloadCredentials: () => Promise<void>;
	constructor(
		models: MutableModels,
		resolveAuth: ResolveAuth,
		ownsExtensionTransport: OwnsExtensionTransport,
		transportModel: (model: Model<Api>) => Model<Api> = (model) => model,
		reloadCredentials: () => Promise<void> = async () => {},
	) {
		this.models = models;
		this.resolveAuth = resolveAuth;
		this.ownsExtensionTransport = ownsExtensionTransport;
		this.transportModel = transportModel;
		this.reloadCredentials = reloadCredentials;
	}

	/**
	 * Attach the first-party ChatGPT Codex routing identity to a prepared request.
	 *
	 * This must happen *after* `prepareRequest`, not before it. The wrapper works by mutating the
	 * header object it captures at construction, and `prepareRequest` rebuilds headers through
	 * `mergeHeaders`, which copies — so a wrapper applied upstream is silently inert. The wrapper
	 * decides from the final payload whether the request is priority, so a normal model still ends up
	 * with `originator: pi` and no routing hint.
	 */
	private withCodexRouting<TOptions extends StreamOptions>(model: Model<Api>, options: TOptions): TOptions {
		model = this.transportModel(model);
		if (!usesChatGptCodexTransport(model) || this.ownsExtensionTransport(model)) return options;
		// The WebSocket handshake builds its headers inside pi-ai and the constructor can be cached, so
		// the identity is repaired through the global constructor rather than per-request options. CLI
		// entrypoints install this through the HTTP dispatcher; a pure SDK embedder never does.
		if (options.transport !== "sse") installCodexFastRouteWebSocketIdentity();
		return withChatGptCodexTransportRouting(model, options);
	}

	private async prepareRequest(
		model: Model<Api>,
		options: ModelRuntimePreparedStreamOptions | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions; authIdentity: string }> {
		assertChatModel(model);
		model = normalizeModelProvider(model);
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const { transformHeaders, preparedRequestAuth, ...providerOptions } = options ?? {};
		const resolution = preparedRequestAuth
			? preparedRequestAuth.resolution
			: await this.resolveAuth(model, {
					apiKey: options?.apiKey,
					env: options?.env,
					signal: options?.signal,
				});
		options?.signal?.throwIfAborted();
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		options?.signal?.throwIfAborted();
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		const apiKey = providerOptions.apiKey ?? resolution.auth.apiKey;
		const credentialHeaderNames = new Set(
			Object.keys(resolution.auth.headers ?? {}).map((name) => name.toLowerCase()),
		);
		return {
			provider,
			authIdentity: JSON.stringify({
				apiKey,
				headers: Object.entries(headers ?? {})
					.map(([name, value]) => [name.toLowerCase(), value] as const)
					.filter(
						([name]) =>
							credentialHeaderNames.has(name) ||
							/^(?:authorization|proxy-authorization|x-api-key|api-key|cookie)$/.test(name),
					)
					.sort(([left], [right]) => left.localeCompare(right)),
				env: Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
				baseUrl: resolution.auth.baseUrl ?? model.baseUrl,
			}),
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return this.streamWithCredentialRetry(model, options, (prepared) =>
			prepared.provider.stream(
				prepared.model as Model<TApi>,
				transcript,
				this.withCodexRouting(prepared.model, prepared.options) as ApiStreamOptions<TApi>,
			),
		);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelRuntimeSimpleStreamOptions,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		const dispatch = options?.preparedRequestAuth?.streamSimple;
		return this.streamWithCredentialRetry(model, options, (prepared) =>
			dispatch
				? dispatch(prepared.model, context, prepared.options as SimpleStreamOptions)
				: prepared.provider.streamSimple(
						prepared.model,
						transcript,
						this.withCodexRouting(prepared.model, prepared.options) as SimpleStreamOptions,
					),
		);
	}

	completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelRuntimeSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	private streamWithCredentialRetry(
		model: Model<Api>,
		options: ModelRuntimePreparedStreamOptions | undefined,
		invoke: (prepared: Awaited<ReturnType<ModelRuntimeStreaming["prepareRequest"]>>) => AssistantMessageEventStream,
	): AssistantMessageEventStream {
		const prepare = () => this.prepareRequest(model, options);
		const retry = async (previous: Awaited<ReturnType<typeof prepare>>) => {
			options?.signal?.throwIfAborted();
			await this.reloadCredentials();
			const { preparedRequestAuth: previousAuth, ...callerOptions } = options ?? {};
			const reprepared = previousAuth?.reprepare ? await previousAuth.reprepare() : undefined;
			const next = reprepared
				? await this.prepareRequest(reprepared.model, reprepared.options)
				: await this.prepareRequest(model, callerOptions);
			return next.authIdentity !== previous.authIdentity ? next : undefined;
		};
		const iterate = async function* (): AsyncGenerator<AssistantMessageEvent> {
			let prepared = await prepare();
			for (let attempt = 0; attempt < 2; attempt++) {
				const pending: AssistantMessageEvent[] = [];
				let deliveredContent = false;
				let rejection: AssistantMessageEvent | undefined;
				try {
					const source = invoke(prepared);
					let terminal = false;
					for await (const event of source) {
						if (event.type === "start") {
							pending.push(event);
							continue;
						}
						if (
							event.type === "error" &&
							!deliveredContent &&
							attempt === 0 &&
							isCredentialRejection(event.error.errorMessage)
						) {
							rejection = event;
							break;
						}
						yield* pending.splice(0);
						yield event;
						terminal = event.type === "done" || event.type === "error";
						deliveredContent = true;
					}
					if (!rejection && !terminal) {
						const result = await source.result();
						const event: AssistantMessageEvent =
							result.stopReason === "error" || result.stopReason === "aborted"
								? { type: "error", reason: result.stopReason, error: result }
								: {
										type: "done",
										reason: result.stopReason === "pending" ? "stop" : result.stopReason,
										message: result,
									};
						if (
							!deliveredContent &&
							attempt === 0 &&
							result.stopReason === "error" &&
							isCredentialRejection(result.errorMessage)
						)
							rejection = event;
						else {
							yield* pending;
							yield event;
						}
					}
				} catch (error) {
					if (
						deliveredContent ||
						attempt !== 0 ||
						!isCredentialRejection(error instanceof Error ? error : String(error))
					)
						throw error;
					const next = await retry(prepared);
					if (!next) throw error;
					prepared = next;
					continue;
				}
				if (!rejection) return;
				const next = await retry(prepared);
				if (!next) {
					yield* pending;
					yield rejection;
					return;
				}
				prepared = next;
			}
		};
		return lazyStream(model, async () => iterate());
	}
	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		}).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}
}

function isCredentialRejection(error: object | string | undefined): boolean {
	if (error instanceof Error) {
		if (("status" in error && error.status === 401) || ("statusCode" in error && error.statusCode === 401))
			return true;
		error = error.message;
	}
	return (
		typeof error === "string" &&
		/\b401\b|unauthori[sz]ed|invalid(?:ated)?[_\s-]*(?:api[_\s-]*key|(?:access[_\s-]*|auth[_\s-]*|oauth[_\s-]*)?token)|(?:token|api[_\s-]*key)[_\s-]*(?:(?:is|has[_\s-]*been)[_\s-]*)?(?:invalid|revoked|expired|invalidated)/i.test(
			error,
		)
	);
}
