import {
	type Api,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai/compat";
import { normalizeContextWindowOptions, withContextWindowOptions } from "./context-window.ts";
import { copilotApiBaseUrlFromToken, copilotTokenFromEnvironment, DEFAULT_COPILOT_API_BASE_URL, getActiveCopilotModelCatalog } from "./copilot-model-catalog.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import type { ProviderCompat, ProviderOverride } from "./model-registry-types.ts";

const GITHUB_COPILOT_API_VERSION_HEADER = "X-GitHub-Api-Version";
const GITHUB_COPILOT_API_VERSION = "2026-06-01";

const GITHUB_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
const GITHUB_COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const EXTRA_GITHUB_COPILOT_MODELS: Model<Api>[] = [
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: GITHUB_COPILOT_BASE_URL,
		headers: GITHUB_COPILOT_HEADERS,
		compat: { forceAdaptiveThinking: true },
		reasoning: true,
		thinkingLevelMap: { minimal: "low", xhigh: "max" },
		input: ["text", "image"],
		cost: {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		},
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	},
	{
		id: "mai-code-flash-1",
		name: "MAI Code Flash 1",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: GITHUB_COPILOT_BASE_URL,
		headers: GITHUB_COPILOT_HEADERS,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
		input: ["text", "image"],
		cost: {
			input: 0.75,
			output: 4.5,
			cacheRead: 0.075,
			cacheWrite: 0,
		},
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
];

function withExtraGitHubCopilotModels(provider: string, models: Model<Api>[]): Model<Api>[] {
	if (provider !== "github-copilot") return models;
	const existingIds = new Set(models.map((model) => model.id));
	const extras = EXTRA_GITHUB_COPILOT_MODELS.filter((model) => !existingIds.has(model.id));
	return [...models, ...extras];
}

function hasHeader(headers: Record<string, string> | undefined, headerName: string): boolean {
	if (!headers) return false;
	const normalizedHeaderName = headerName.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalizedHeaderName);
}

export function withGitHubCopilotApiVersionHeader(
	model: Model<Api>,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (model.provider !== "github-copilot" || hasHeader(headers, GITHUB_COPILOT_API_VERSION_HEADER)) {
		return headers;
	}
	return { ...(headers ?? {}), [GITHUB_COPILOT_API_VERSION_HEADER]: GITHUB_COPILOT_API_VERSION };
}

function withCopilotEnvironmentBaseUrl(model: Model<Api>): Model<Api> {
	if (model.provider !== "github-copilot") return model;
	const resolvedBaseUrl = copilotApiBaseUrlFromToken(copilotTokenFromEnvironment());
	if (resolvedBaseUrl === DEFAULT_COPILOT_API_BASE_URL || resolvedBaseUrl === model.baseUrl) return model;
	return { ...model, baseUrl: resolvedBaseUrl };
}

function withCopilotContextWindowOptions(model: Model<Api>): Model<Api> {
	if (model.provider !== "github-copilot") return model;
	const context = getActiveCopilotModelCatalog().get(model.id);
	if (!context) return model;
	const base = { ...model, contextWindow: context.contextWindow, maxInputTokens: context.maxInputTokens };
	if (context.contextWindowOptions && context.contextWindowOptions.length > 1) {
		return withContextWindowOptions(base, context.contextWindowOptions);
	}
	return base;
}

export function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"] | Model<Api>["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as ProviderCompat | undefined;
	const override = overrideCompat as ProviderCompat;
	const merged = { ...base, ...override } as ProviderCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	if (baseCompletions?.chatTemplateKwargs || overrideCompletions.chatTemplateKwargs) {
		mergedCompletions.chatTemplateKwargs = {
			...baseCompletions?.chatTemplateKwargs,
			...overrideCompletions.chatTemplateKwargs,
		};
	}

	return merged as Model<Api>["compat"];
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) {
		result.contextWindow = override.contextWindow;
		result.defaultContextWindow = override.contextWindow;
		if (override.contextWindowOptions === undefined) {
			result.contextWindowOptions = undefined;
		}
	}
	if (override.contextWindowOptions !== undefined) {
		result.contextWindowOptions = normalizeContextWindowOptions(override.contextWindowOptions);
	}
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	result.compat = mergeCompat(model.compat, override.compat);
	return result;
}

export function loadBuiltInModels(
	overrides: Map<string, ProviderOverride>,
	modelOverrides: Map<string, Map<string, ModelOverride>>,
): Model<Api>[] {
	return getProviders().flatMap((provider) => {
		const models = withExtraGitHubCopilotModels(provider, getModels(provider as KnownProvider) as Model<Api>[]);
		const providerOverride = overrides.get(provider);
		const perModelOverrides = modelOverrides.get(provider);

		return models.map((m) => {
			let model = withCopilotEnvironmentBaseUrl(m);

			if (providerOverride) {
				model = {
					...model,
					baseUrl: providerOverride.baseUrl ?? model.baseUrl,
					compat: mergeCompat(model.compat, providerOverride.compat),
				};
			}

			model = withCopilotContextWindowOptions(model);
			const modelOverride = perModelOverrides?.get(m.id);
			return modelOverride ? applyModelOverride(model, modelOverride) : model;
		});
	});
}

export function mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
	const merged = [...builtInModels];
	for (const customModel of customModels) {
		const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
		if (existingIndex >= 0) {
			merged[existingIndex] = customModel;
		} else {
			merged.push(customModel);
		}
	}
	return merged;
}
