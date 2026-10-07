import {
	type AnyModel,
	type ApiKeyCredential,
	type AuthContext,
	type AuthResult,
	type ClassifierModel,
	isModelType,
	type Model,
	type Provider,
	type ProviderStreamOptions,
	type RefreshModelsContext,
} from "@bastani/pi-ai";
import { llamaCppClassifyApi } from "@bastani/pi-ai/api/llama-cpp-classify.lazy";
import { typesafeSystemOneApi } from "@bastani/pi-ai/api/typesafe-system-one.lazy";
import { stream, streamSimple } from "@bastani/pi-ai/compat";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaServerProps,
	llamaInferenceUrl,
	normalizeLlamaServerUrl,
} from "./client.js";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload = false): boolean {
	if (model.status.value === "loaded" || model.status.value === "sleeping") return true;
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

function configuredContextWindow(model: LlamaModelInfo): number | undefined {
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		if (!["--ctx-size", "-c", "-ctx"].includes(args[index])) continue;
		const contextWindow = Number(args[index + 1]);
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	return undefined;
}

function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number {
	if (model.meta?.n_ctx && model.meta.n_ctx > 0) return model.meta.n_ctx;
	const configured = configuredContextWindow(model);
	if (configured) return configured;
	if (cachedContextWindow && cachedContextWindow > 0) return cachedContextWindow;
	return model.meta?.n_ctx_train && model.meta.n_ctx_train > 0 ? model.meta.n_ctx_train : 128000;
}

type LlamaClassifierApi = "llama-cpp-classify" | "typesafe-system-one";

function isDecisionModel(model: LlamaModelInfo): boolean {
	return model.architecture?.output_modalities?.includes("decisions") === true;
}

function isChatModel(model: LlamaModelInfo): boolean {
	return !isDecisionModel(model) || model.architecture?.output_modalities?.includes("text") === true;
}

function toPiClassifierModel(
	model: LlamaModelInfo,
	serverUrl: string,
	cachedContextWindow?: number,
): ClassifierModel<LlamaClassifierApi> {
	const decision = isDecisionModel(model);
	return {
		type: "classifier",
		id: model.id,
		name: model.id,
		api: decision ? "typesafe-system-one" : "llama-cpp-classify",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: decision ? llamaInferenceUrl(serverUrl) : serverUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowOf(model, cachedContextWindow),
	};
}

function isLlamaClassifierModel(model: AnyModel): model is ClassifierModel<LlamaClassifierApi> {
	return (
		isModelType(model, "classifier") && (model.api === "llama-cpp-classify" || model.api === "typesafe-system-one")
	);
}

function toPiModel(
	model: LlamaModelInfo,
	serverUrl: string,
	props?: LlamaServerProps,
	cachedContextWindow?: number,
): Model<"openai-completions"> {
	const contextWindow = contextWindowOf(model, cachedContextWindow);
	const reasoning = props?.chat_template?.includes("enable_thinking") === true;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning,
		...(reasoning && {
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
		}),
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(reasoning && { thinkingFormat: "qwen-chat-template" }),
		},
	};
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let classifiers: readonly ClassifierModel<LlamaClassifierApi>[] = [];
	const fallbackClassifier = llamaCppClassifyApi();
	const decisionClassifier = typesafeSystemOneApi();

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true));
		models = selectable.filter(isChatModel).map((model) => toPiModel(model, serverUrl));
		classifiers = selectable.map((model) => toPiClassifierModel(model, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		getAllModels: () => [...models, ...classifiers],
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const cachedContextWindows = new Map<string, number>();
			if (context.stored) {
				const stored = context.stored.models.filter((model) => model.provider === LLAMA_PROVIDER_ID);
				const restored = stored.filter(
					(model): model is Model<"openai-completions"> =>
						isModelType(model, "chat") && model.api === "openai-completions",
				);
				const restoredClassifiers = stored.filter(isLlamaClassifierModel);
				for (const model of [...restored, ...restoredClassifiers])
					cachedContextWindows.set(model.id, model.contextWindow);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
							classifiers = restoredClassifiers;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload));
			const refreshed = await Promise.all(
				selectable.filter(isChatModel).map(async (model) => {
					// Query only loaded models: sleeping and autoload presets must not be woken by discovery.
					const cachedContextWindow = cachedContextWindows.get(model.id);
					if (model.status.value !== "loaded") return toPiModel(model, serverUrl, undefined, cachedContextWindow);
					return toPiModel(
						model,
						serverUrl,
						await client.props({ model: model.id, signal: context.signal }),
						cachedContextWindow,
					);
				}),
			);
			const refreshedClassifiers = selectable.map((model) =>
				toPiClassifierModel(model, serverUrl, cachedContextWindows.get(model.id)),
			);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
				update: () => {
					models = refreshed;
					classifiers = refreshedClassifiers;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
		classify: (model, context, options) =>
			(model.api === "typesafe-system-one" ? decisionClassifier : fallbackClassifier).classify(
				model,
				context,
				options,
			),
	};

	return { provider, setCatalog };
}
