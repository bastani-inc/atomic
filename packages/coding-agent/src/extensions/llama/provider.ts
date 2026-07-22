import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ApiKeyCredential } from "../../core/auth-storage.js";
import type { ProviderConfig, ProviderModelConfig, ProviderApiKeyAuthContext } from "../../core/extensions/types.js";
import { LlamaClient, type LlamaModelInfo, llamaInferenceUrl, normalizeLlamaServerUrl } from "./client.js";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_TOKENS = 16384;

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: ProviderApiKeyAuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

export function toLlamaModel(model: LlamaModelInfo, serverUrl: string): ProviderModelConfig {
	const reportedContextWindow = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning: false,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
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
	let models: ProviderModelConfig[] = [];
	const setCatalog = (catalog: readonly LlamaModelInfo[], serverUrl: string): void => {
		models = catalog.filter((model) => model.status.value === "loaded").map((model) => toLlamaModel(model, serverUrl));
	};
	const config: ProviderConfig = {
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		api: "openai-completions",
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction) => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (await interaction.prompt({ type: "secret", message: "API key (optional)" })).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return { type: "api_key", key: apiKey || undefined, env: { LLAMA_BASE_URL: serverUrl } };
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl ? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" } : undefined;
				},
				resolve: async ({ ctx, credential }) => {
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
		models,
		refreshModels: async (context) => {
			if (!context.allowNetwork || context.signal?.aborted || context.credential?.type !== "api_key") return models;
			const credential = context.credential as ApiKeyCredential;
			const serverUrl = credentialServerUrl(credential);
			if (!serverUrl) return models;
			const catalog = await new LlamaClient(serverUrl, credential.key).list({ signal: context.signal });
			setCatalog(catalog, serverUrl);
			return models;
		},
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};
	return { config, setCatalog };
}
