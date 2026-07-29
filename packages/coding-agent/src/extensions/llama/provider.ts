import { streamSimple, type Model } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "../../core/extensions/types.js";
import { LlamaClient, type LlamaModelInfo, llamaInferenceUrl, normalizeLlamaServerUrl } from "./client.js";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";

export function toLlamaModel(model: LlamaModelInfo, serverUrl: string): Model<"openai-completions"> {
	const reportedContextWindow = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
	return {
		id: model.id,
		api: "openai-completions",
		name: model.id,
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning: false,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

export interface LlamaProviderController {
	config: ProviderConfig;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: Model<"openai-completions">[] = [];
	const setCatalog = (catalog: readonly LlamaModelInfo[], serverUrl: string): void => {
		models = catalog.filter((model) => model.status.value === "loaded").map((model) => toLlamaModel(model, serverUrl));
	};
	const serverUrl = normalizeLlamaServerUrl(process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL);
	const config: ProviderConfig = {
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(serverUrl),
		apiKey: process.env.LLAMA_API_KEY ?? "local",
		api: "openai-completions",
		models,
		refreshModels: async (context) => {
			const stored = await context.store.read();
			if (stored) {
				models = stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
				);
			}
			if (!context.allowNetwork || context.signal?.aborted || context.credential?.type !== "api_key") return models;
			const catalog = await new LlamaClient(serverUrl, context.credential.key).list({ signal: context.signal });
			setCatalog(catalog, serverUrl);
			if (!context.signal?.aborted) await context.store.write({ models, checkedAt: Date.now() });
			return models;
		},
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};
	return { config, setCatalog };
}
