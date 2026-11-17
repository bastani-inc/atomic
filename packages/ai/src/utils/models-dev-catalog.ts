// Atomic's model catalog transform: models.dev's api.json into the catalog's chat models. Shared by the build-time
// generator (scripts/generate-models.ts) and the runtime catalog refresh, so both produce the same models.
// Pure: no I/O, no network.

import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../api/cloudflare.ts";
import { githubCopilotApiForSdk } from "../providers/github-copilot-capabilities.ts";
import { OPENAI_MID_CONVO_EFFORT_MODEL_IDS } from "../providers/openai-mid-convo-effort.ts";
import type {
	AnthropicMessagesCompat,
	AnyModel,
	Api,
	BedrockCompat,
	Model,
	ModelCost,
	ModelPromptCache,
	ModelServiceTier,
	ModelServiceTierId,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../types.ts";
import { applyAzureOpenAIListedEfforts, applyAzureOpenAIThinkingOffMasks } from "./azure-openai-thinking-level-map.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

/** Options of `buildModelsDevChatModels()`. */
export interface ModelsDevCatalogOptions {
	/** Fail when a provider with an exact model list does not get exactly those models. The build sets it. */
	strict?: boolean;
	/** NVIDIA NIM's served model IDs, by normalized ID. Without them, models.dev's NVIDIA models are kept as listed. */
	nvidiaNimModelIds?: ReadonlyMap<string, string>;
}

function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	const expectedIds = Array.from(new Set(expected)).sort();
	const actualIds = Array.from(new Set(actual)).sort();
	if (expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index])) return;
	const missing = expectedIds.filter((id) => !actualIds.includes(id));
	const extra = actualIds.filter((id) => !expectedIds.includes(id));
	const difference = [
		missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
		extra.length > 0 ? `extra: ${extra.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("; ");
	// The same message as scripts/model-data.ts, which the generator's strict checks report.
	throw new Error(`${label} model IDs do not match (${difference})`);
}

export interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

export interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

export interface ModelsDevMetadata {
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
	modalities?: { input?: string[] };
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export const CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL_ID = "@cf/moonshotai/kimi-k2.6";
export const CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL = {
	id: CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL_ID,
	name: "Kimi K2.6",
	tool_call: true,
	reasoning: true,
	reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }],
	modalities: { input: ["text", "image"], output: ["text"] },
	cost: { input: 0.95, output: 4, cache_read: 0.16 },
	limit: { context: 262_144, output: 256_000 },
} satisfies ModelsDevModel;

export const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

export const TOGETHER_BASE_URL = "https://api.together.ai/v1";
export const TOGETHER_BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
export const TOGETHER_TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	thinkingFormat: "together",
};
export const TOGETHER_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
export const TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};
export const TOGETHER_REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
export const TOGETHER_TOGGLE_REASONING_EFFORT_MODELS = new Set([
	"deepseek-ai/DeepSeek-V4-Pro",
	"deepseek-ai/DeepSeek-V4-Pro-0813",
]);
export const TOGETHER_REASONING_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
export const TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
} as const;
export const TOGETHER_TOGGLE_REASONING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;

export const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const AI_GATEWAY_TYPESAFE_BASE_URL = "https://ai-gateway.vercel.sh/typesafe/v1";
export const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
export const NVIDIA_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
export const NVIDIA_NIM_UNSUPPORTED_MODELS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
export const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
export const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
export const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);
// Anthropic publishes the permitted server-side `fallbacks` targets per model. Claude Fable 5.1:
// "The permitted fallback targets for Claude Fable 5.1 are Claude Opus 4.8 and Claude Opus 5."
// https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
export const ANTHROPIC_ALLOWED_FALLBACK_MODELS = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-fable-5-1": ["claude-opus-4-8", "claude-opus-5"],
	"claude-fable-5-2": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
} satisfies Record<string, string[]>;

export const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
export const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
export const AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;
// Verified against Fireworks Messages raw_output on 2026-09-10 (#9323).
// Fall back to verified support when models.dev omits effort metadata; this is
// not an allowlist. Any Fireworks Messages model advertising effort uses adaptive thinking.
export const FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS = new Set([
	"accounts/fireworks/models/deepseek-v4-flash-0731",
	"accounts/fireworks/models/deepseek-v4-flash-vision-exp",
	"accounts/fireworks/models/deepseek-v4-pro-0813",
	"accounts/fireworks/models/qwen3p8-max",
	"accounts/fireworks/models/qwen3p8-2p4t-a95b",
]);
export const QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
export const QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS = new Set(["glm-5", "glm-5.1"]);
export const QWEN_TOKEN_PLAN_PROVIDER_IDS = new Set<string>([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"qwen-token-plan-individual-cn",
]);
// Token Plan Individual (Personal) text-model allowlist, verified 2026-11-09 against both regions' docs.
// qwen-token-plan-individual-cn applies it to the China endpoint.
// https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
// https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview
export const QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS = new Set<string>([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"deepseek-v4.1-flash",
	"deepseek-v4.1-flash-1017",
	"glm-5.2",
	"glm-5.3",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
]);

export const KIMI_K3_MAX_TOKENS = 131072;
export const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
} as const;
// Kimi Chat Completions settings shared by Moonshot and Kimi Coding.
export const KIMI_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};
// Kimi K3-style models take reasoning_effort and need earlier reasoning sent back.
export const KIMI_K3_OPENAI_COMPAT: OpenAICompletionsCompat = {
	...KIMI_OPENAI_COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
	supportsReasoningEffort: true,
};
// Kimi K3 and its point releases (kimi-k3.1-pro, kimi-k3.1-pro-highspeed) share K3's request
// format. https://api.moonshot.ai/v1/models reports effort levels and dynamic tool loading for all.
export function isKimiK3FamilyId(modelId: string): boolean {
	return /^kimi-k3(?:\.\d+)?(?:-|$)/.test(modelId);
}

export const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

export const BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);
export const MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);
// GPT-5.5 and older put tools loaded through tool search or additional_tools in a namespace named
// after the tool and reject replayed calls without it, so history from other models fails there
// (earendil-works/pi#11415). Like Codex, dynamic tool loading therefore starts with GPT-5.6, which does not do this.
export const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
export const OPENAI_ADDITIONAL_TOOLS_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
export const OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	...OPENAI_TOOL_SEARCH_MODEL_IDS,
]);
export const OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
// OpenAI documents configuration_update for the GPT-6 family.
// https://developers.openai.com/api/docs/guides/reasoning
export const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
export const OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
export const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
export const DEFAULT_IMAGE_RESIZE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

export function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

// Keep current OpenAI prices authoritative until models.dev and passthrough
// catalogs catch up.
// https://developers.openai.com/api/docs/pricing
export const OPENAI_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
	"gpt-6.2-astra": { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
	"gpt-6.2-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

// Published Fast and Ultrafast rates per model. A model absent from a table does not offer that tier.
// https://developers.openai.com/api/docs/pricing (Fast and Ultrafast tabs)
export const OPENAI_FAST_COSTS: Record<string, ModelCost> = {
	"gpt-6.2-astra": { input: 16, output: 80, cacheRead: 0.8, cacheWrite: 20 },
	"gpt-6.2-sol": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"gpt-6-astra": { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 },
	"gpt-6.1-sol": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	// GPT-6.1 Terra Fast is published as 2x Standard (https://developers.openai.com/api/docs/models/gpt-6.1-terra).
	"gpt-6.1-terra": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-6-luna": { input: 0.2, output: 1, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-sol": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
	"gpt-5.6-terra": { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-luna": { input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5 },
	"gpt-5.5": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
	"gpt-5.4": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.4-mini": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
	"gpt-5.2": { input: 3.5, output: 28, cacheRead: 0.35, cacheWrite: 0 },
	"gpt-5.1": { input: 2.5, output: 20, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5": { input: 2.5, output: 20, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5-mini": { input: 0.45, output: 3.6, cacheRead: 0.045, cacheWrite: 0 },
	"gpt-4.1": { input: 3.5, output: 14, cacheRead: 0.875, cacheWrite: 0 },
	"gpt-4.1-mini": { input: 0.7, output: 2.8, cacheRead: 0.175, cacheWrite: 0 },
	"gpt-4.1-nano": { input: 0.2, output: 0.8, cacheRead: 0.05, cacheWrite: 0 },
	"gpt-4o": { input: 4.25, output: 17, cacheRead: 2.125, cacheWrite: 0 },
	"gpt-4o-2024-05-13": { input: 8.75, output: 26.25, cacheRead: 0, cacheWrite: 0 },
	"gpt-4o-mini": { input: 0.25, output: 1, cacheRead: 0.125, cacheWrite: 0 },
	o3: { input: 3.5, output: 14, cacheRead: 0.875, cacheWrite: 0 },
	"o4-mini": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
};
// GPT-6 Astra and GPT-6.1 Sol Ultrafast rates are published, at 6x Standard for input, cached input, cache write and
// output (https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast). GPT-5.6 Sol Ultrafast is a preview without published
// rates, so it follows the 6x-Standard convention. GPT-6.2 Astra and GPT-6.2 Sol Ultrafast cost 3x Standard through
// February 28, 2027 and 6x Standard from March 1, 2027 (Pacific time); these are the current 3x rates.
export const OPENAI_ULTRAFAST_COSTS: Record<string, ModelCost> = {
	"gpt-6.2-astra": { input: 24, output: 120, cacheRead: 1.2, cacheWrite: 30 },
	"gpt-6.2-sol": { input: 6, output: 30, cacheRead: 0.3, cacheWrite: 7.5 },
	"gpt-6-astra": { input: 60, output: 300, cacheRead: 6, cacheWrite: 75 },
	"gpt-6.1-sol": { input: 12, output: 60, cacheRead: 0.6, cacheWrite: 15 },
	"gpt-5.6-sol": { input: 24, output: 120, cacheRead: 2.4, cacheWrite: 30 },
};

export function openAiServiceTierCost(modelId: string, cost: ModelCost): ModelCost {
	return OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(modelId) ? withOpenAiLongContextPricing(cost) : cost;
}

export function openAiServiceTiers(modelId: string): ModelServiceTier[] {
	const tiers: ModelServiceTier[] = [];
	const fast = OPENAI_FAST_COSTS[modelId];
	if (fast) tiers.push({ id: "priority", cost: openAiServiceTierCost(modelId, fast) });
	const ultrafast = OPENAI_ULTRAFAST_COSTS[modelId];
	if (ultrafast) tiers.push({ id: "ultrafast", cost: openAiServiceTierCost(modelId, ultrafast) });
	return tiers;
}

// Mirrors the service_tiers each model advertises in openai/codex codex-rs/models-manager/models.json
// (90abcfac02665ad882853a04155591cd863b2ca7), priced at the matching OpenAI API tier rates. GPT-6.1 Sol also gets
// Ultrafast, which the ChatGPT backend applies (about 2.7x faster on a ChatGPT sign-in) before Codex lists it.
export const CODEX_SERVICE_TIER_IDS: Record<string, ModelServiceTierId[]> = {
	"gpt-5.3-codex-spark": [],
	"gpt-5.5": ["priority"],
	"gpt-5.6-luna": ["priority"],
	"gpt-5.6-sol": ["priority"],
	"gpt-5.6-terra": ["priority"],
	"gpt-6-astra": ["priority", "ultrafast"],
	"gpt-6.1-sol": ["priority", "ultrafast"],
	// Codex's bundled catalog does not list GPT-6.1 Terra yet, so it advertises no service tiers.
	"gpt-6.1-terra": [],
	"gpt-6-sol": ["priority"],
	"gpt-6-luna": ["priority"],
	// Codex lists Fast for GPT-6.2; OpenAI's launch post adds Ultrafast for Pro subscribers on both models.
	"gpt-6.2-astra": ["priority", "ultrafast"],
	"gpt-6.2-sol": ["priority", "ultrafast"],
};

// The Codex subscription charges no long-context fee for these models, on any service tier (OpenAI announcement).
export const CODEX_NO_LONG_CONTEXT_FEE_MODEL_IDS = new Set(["gpt-6.1-sol"]);

export function codexServiceTiers(modelId: string): ModelServiceTier[] {
	const advertised = CODEX_SERVICE_TIER_IDS[modelId];
	if (!advertised) throw new Error(`Codex model ${modelId} has no advertised service tiers`);
	const priced = CODEX_NO_LONG_CONTEXT_FEE_MODEL_IDS.has(modelId)
		? openAiServiceTiers(modelId).map(({ cost: { tiers: _longContext, ...flat }, ...tier }) => ({
				...tier,
				cost: flat,
			}))
		: openAiServiceTiers(modelId);
	return advertised.map((id) => {
		const tier = priced.find((candidate) => candidate.id === id);
		if (!tier) throw new Error(`Codex model ${modelId} advertises ${id} without published OpenAI rates`);
		return tier;
	});
}

export const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);
export const XAI_BUILTIN_EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-build-0.1",
	"grok-code-fast-1",
]);
export const XAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
};

export const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4.1-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
]);

// GitHub's "Models with extended capabilities" table lists these Copilot models as supporting
// the extended 1 million token context window.
export const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-opus-5.5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
]);

export const GITHUB_COPILOT_CLAUDE_FABLE_MODEL_IDS = ["claude-fable-5", "claude-fable-5-1"] as const;

// GitHub Copilot serves these models, and models.dev's Copilot catalog lists them since they launched
// (Claude Fable 5.2 on 2026-11-09, Gemini 4 Carbon on 2026-11-10). A build that fetches an older
// models.dev snapshot would ship without them, so keep their published rows here. A models.dev row with
// the same ID wins.
export const GITHUB_COPILOT_MODELS_DEV_FALLBACKS: Record<string, ModelsDevModel> = {
	"claude-fable-5.2": {
		id: "claude-fable-5.2",
		name: "Claude Fable 5.2",
		reasoning: true,
		reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
		tool_call: true,
		structured_output: true,
		modalities: { input: ["text", "image", "pdf"], output: ["text"] },
		limit: { context: 1000000, output: 128000 },
		provider: { npm: "@ai-sdk/anthropic" },
		cost: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
	},
	"gemini-4-carbon": {
		id: "gemini-4-carbon",
		name: "Gemini 4 Carbon",
		reasoning: true,
		reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
		tool_call: true,
		structured_output: true,
		modalities: { input: ["text", "image", "pdf"], output: ["text"] },
		limit: { context: 1048576, output: 65536 },
		cost: { input: 2, output: 10, cache_read: 0.1 },
	},
};

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
export const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

export function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

export const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

export function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

export function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

export function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages")
		return (model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking === true;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...(model.compat as OpenAICompletionsCompat | undefined),
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort === true;
}

export function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

export function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

export function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

export function isOpenAiGpt6AstraModelId(modelId: string): boolean {
	return (
		modelId === "gpt-6-astra" ||
		modelId === "openai.gpt-6-astra" ||
		modelId === "global.openai.gpt-6-astra" ||
		modelId === "us.openai.gpt-6-astra"
	);
}

export function isOpenAiGpt6ModelId(modelId: string): boolean {
	return (
		isOpenAiGpt6AstraModelId(modelId) ||
		modelId === "gpt-6-sol" ||
		modelId === "gpt-6-luna" ||
		modelId === "gpt-6.1-sol" ||
		modelId === "gpt-6.1-terra" ||
		modelId === "gpt-6.2-astra" ||
		modelId === "gpt-6.2-sol"
	);
}

const OPENAI_GPT62_MODEL_IDS = new Set(["gpt-6.2-astra", "gpt-6.2-sol"]);

// GPT-6 models whose API rejects reasoning.effort "none", so `off` is unavailable.
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
const OPENAI_GPT6_NO_NONE_EFFORT_MODEL_IDS = new Set(["gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"]);

/** Strips Bedrock's `openai.` model prefix and optional `us.`/`global.` inference-profile prefix. */
export function getOpenAiBaseModelId(model: Model<Api>): string {
	return model.api === "bedrock-converse-stream" ? model.id.replace(/^(?:global\.|us\.)?openai\./, "") : model.id;
}

// Bedrock serves OpenAI's first-party GPT-6 family, so its routes take the same efforts as the direct API.
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-sol.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
export function isBedrockOpenAiGpt6Model(model: Model<Api>): boolean {
	return model.api === "bedrock-converse-stream" && isOpenAiGpt6ModelId(getOpenAiBaseModelId(model));
}

export function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		isOpenAiGpt6ModelId(modelId)
	);
}

export function supportsOpenAiMax(model: Model<Api>): boolean {
	const supportedApi =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "openai-completions";
	return (
		((model.id.includes("gpt-5.6") || isOpenAiGpt6ModelId(model.id)) && supportedApi) ||
		isBedrockOpenAiGpt6Model(model)
	);
}

// OpenCode Zen and Go forward per-message effort and `thinking.block_binding`. Without
// `drop_block`, Go rejects replayed thinking after the system prompt or tools change.
export const VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS = new Set([
	"anthropic",
	"openrouter",
	"opencode",
	"opencode-go",
]);
// OpenRouter rejects `configuration_update` system messages on Opus 5 ("Mid-conversation
// reasoning effort (configuration_update) is not supported on anthropic/claude-opus-5-20260723")
// while accepting them on Fable 5.1, so gate that model there.
export const MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS = new Set(["openrouter:anthropic/claude-opus-5"]);

export function supportsAnthropicMidConvoEffort(modelId: string): boolean {
	const id = modelId.toLowerCase().replace(/^~?anthropic\//, "");
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5[.-][12](?:-\d{8})?$/.test(id)
	);
}

// Claude models that accept `thinking: {type: "disabled"}` alongside per-message effort.
// Opus 5.5, Sonnet 5.5, Fable 5.1/5.2, and Mythos 5.1/5.2 reject it.
// https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking
export const ANTHROPIC_DISABLED_THINKING_MODELS = new Set(["claude-opus-5", "claude-haiku-5-5", "claude-haiku-5.5"]);

export function supportsAnthropicDisabledThinkingWithMidConvoEffort(modelId: string): boolean {
	// Strip OpenRouter's "anthropic/" or "~anthropic/" prefix and any dated snapshot suffix.
	const id = modelId
		.toLowerCase()
		.replace(/^~?anthropic\//, "")
		.replace(/-\d{8}$/, "");
	return ANTHROPIC_DISABLED_THINKING_MODELS.has(id);
}

export function supportsAnthropicMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-][12])?(?:-\d{8})?$/.test(modelId)
	);
}

export function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		// OpenRouter's `~anthropic/claude-*-latest` aliases follow the newest model of each family,
		// all of which use adaptive thinking.
		/^~anthropic\/claude-[a-z]+-latest$/.test(modelId) ||
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("haiku-5") ||
		modelId.includes("haiku.5") ||
		modelId.includes("fable-5") ||
		modelId.includes("mythos-5")
	);
}

// Models that reject non-default `temperature`, `top_p`, or `top_k` with a 400 on every request,
// whether or not thinking is on. The list is published in "Limits and feature compatibility >
// Sampling parameters": https://platform.claude.com/docs/en/build-with-claude/thinking
// The `fable-5` clause covers Claude Fable 5 and Claude Fable 5.1, which the same sentence names.
export function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("opus-4-7") ||
		id.includes("opus-4.7") ||
		id.includes("opus-4-8") ||
		id.includes("opus-4.8") ||
		id.includes("opus-5") ||
		id.includes("opus.5") ||
		id.includes("sonnet-5") ||
		id.includes("sonnet.5") ||
		id.includes("haiku-5-5") ||
		id.includes("haiku-5.5") ||
		id.includes("fable-5")
	);
}

export const OPENAI_COMPLETIONS_DEFAULT_COMPAT: OpenAICompletionsCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

export type OpenAICompletionsResolvedCompat = OpenAICompletionsCompat;

export function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

export function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && /^~?anthropic\//.test(model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		// Preserve built-in behavior as explicit metadata against the conservative runtime default.
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isCerebras,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: isOpenRouter,
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

export function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

export function mergeOpenAICompletionsCompat(model: Model<Api>, compat: OpenAICompletionsCompat): void {
	model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), ...compat };
}

export function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...(model.compat as OpenAICompletionsCompat | undefined) };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

export function applyAnthropicMessagesCompatMetadata(model: Model<Api>): void {
	if (model.api !== "anthropic-messages") return;
	const compat = getAnthropicMessagesCompat(model.provider, model.id);
	if (compat) {
		mergeAnthropicMessagesCompat(model, compat);
		if (compat.supportsMidConvoEffort && !supportsAnthropicDisabledThinkingWithMidConvoEffort(model.id)) {
			mergeThinkingLevelMap(model, { off: null });
		}
	}
}

export function isAnthropicFallbackMetadataModel(model: Model<Api>): model is Model<"anthropic-messages"> {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (
		model.id in ANTHROPIC_ALLOWED_FALLBACK_MODELS ||
		Object.values(ANTHROPIC_ALLOWED_FALLBACK_MODELS).some((fallbackModelIds) => fallbackModelIds.includes(model.id))
	);
}

export function applyAnthropicAllowedFallbackModelMetadata(models: readonly Model<"anthropic-messages">[]): void {
	const modelsById = new Map(models.map((model) => [model.id, model]));
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;

		const compatibleFallbackModelIds = model.compat?.supportsMidConvoEffort
			? fallbackModelIds.filter(supportsAnthropicMidConvoEffort)
			: fallbackModelIds;
		const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			mergeAnthropicMessagesCompat(model, { allowedFallbackModels });
		}
	}
}

// Anthropic's preserved-thinking rules: "A block that fails the model check is always dropped"
// before the prompt reaches the model, and callers should "Send every assistant turn exactly as
// you received it, thinking blocks included, and let the API decide which blocks the model can
// use." That makes the first-party Anthropic Messages API the authority on model binding, so its
// models replay another Claude model's signed thinking blocks instead of flattening them to text.
// Scoped to `provider === "anthropic"`: third-party Anthropic-compatible proxies are not
// documented to adjudicate signatures the same way.
// https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-thinking
export function applyPreservedThinkingCompatMetadata(model: Model<Api>): void {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return;
	mergeAnthropicMessagesCompat(model, { delegatesThinkingModelBinding: true });

	// Only Claude Fable 5.1 runs the *conversation* check. Claude Mythos 5.1 records the same
	// signature but does not run it, and no earlier model records the condition at all.
	// https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
	if (model.id.includes("fable-5-1")) {
		mergeAnthropicMessagesCompat(model, { enforcesPreservedThinkingBinding: true });
	}
}

// "The exceptions are Claude Fable 5.1 and Claude Mythos 5.1, which reject forced tool use on
// every request with a 400 error. On those models, use `tool_choice: {"type": "auto"}`."
// https://platform.claude.com/docs/en/build-with-claude/thinking
//
// Unlike the preserved-thinking flags above, this is a property of the *model*, not of Anthropic's
// first-party endpoint: every mirror routes to the same model and receives the same 400. So this
// rule is gated on the API that can express a forced choice, not on the provider. Mythos 5.1 is
// named by the docs but is invite-only and absent from the live catalog, so its id test is
// forward-safe rather than inventing a catalog entry.
//
// Deliberately version-scoped, unlike the Fable-family match used for `temperature` below. The
// two restrictions are not symmetric: the sampling sentence names Claude Fable 5 alongside
// Claude Fable 5.1, but this one names Fable 5.1 and Mythos 5.1 as *exceptions* to behavior that
// otherwise works. OpenRouter's live metadata agrees — `anthropic/claude-fable-5` lists
// `tool_choice` in `supported_parameters` while `anthropic/claude-fable-5.1` does not. Widening
// this to the family would assert a restriction on Fable 5 that both sources contradict.
//
// The same reasoning leaves `~anthropic/claude-fable-latest` uncovered: an id naming no version
// cannot keep such a claim true if the alias re-points at a model that accepts forced tool use.
export function applyForcedToolChoiceCompatMetadata(model: Model<Api>): void {
	if (!/fable-5[-.]1|mythos-5[-.]1/.test(model.id)) return;
	if (model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsForcedToolChoice: false });
	} else if (model.api === "bedrock-converse-stream") {
		model.compat = { ...(model.compat as BedrockCompat | undefined), supportsForcedToolChoice: false };
	} else if (model.api === "openai-completions") {
		model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), supportsForcedToolChoice: false };
	}
}

// Claude Fable 5.1 rejects non-default `temperature`, `top_p`, and `top_k` on every request, and
// OpenRouter's own `supported_parameters` for `anthropic/claude-fable-5.1` omits `temperature`.
// The Anthropic Messages path already suppresses it via `isAnthropicTemperatureUnsupportedModel`,
// which matches the whole Fable family; the Bedrock Converse and OpenAI-completions paths emitted
// it unconditionally. https://platform.claude.com/docs/en/build-with-claude/thinking
//
// Matched on the Fable family rather than on Fable 5.1 alone, for three reasons: the same doc
// sentence names Claude Fable 5 alongside Claude Fable 5.1; the Anthropic Messages path already
// covers both, so a narrower rule here would leave the three APIs inconsistent; and a version-
// scoped id test cannot reach OpenRouter's `~anthropic/claude-fable-latest` alias, which names no
// version yet carries Fable 5.1's pricing and omits `temperature` from its own
// `supported_parameters`. Every matched entry is covered by that one documented sentence.
//
// Deliberately *not* driven from provider metadata: 79 of OpenRouter's 419 models omit
// `temperature` from `supported_parameters`, including the GPT-5 family, and OpenRouter reports it
// as supported for Opus 5 and Opus 4.8 in contradiction of Anthropic's own docs.
//
// OpenRouter's `~anthropic/claude-fable-latest` alias is an Anthropic Messages entry (upstream pi
// 44f6851b), whose id names no version, so `isAnthropicTemperatureUnsupportedModel` cannot reach it
// either: this family match covers it on that path too.
export function applyFableTemperatureCompatMetadata(model: Model<Api>): void {
	if (!/claude-fable/.test(model.id)) return;
	if (model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	} else if (model.api === "bedrock-converse-stream") {
		model.compat = { ...(model.compat as BedrockCompat | undefined), supportsTemperature: false };
	} else if (model.api === "openai-completions") {
		model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), supportsTemperature: false };
	}
}

export function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if (
		(model.provider === "openai" || model.provider === "cloudflare-ai-gateway") &&
		model.api === "openai-responses"
	) {
		model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	}
}

// Responses endpoints verified (OpenAI, ChatGPT Codex backend, GitHub Copilot,
// opencode zen) or documented (Azure OpenAI, Cloudflare AI Gateway) to pass
// OpenAI custom grammar tools through. OpenAI rejects `type: "custom"` tools
// for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
export const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"azure",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
export const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

export function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsOpenAIGrammarTools: true };
}

export function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isOpenAICodex) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	const supportsAdditionalTools =
		(isOpenAIResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)) ||
		(isOpenAICodex && OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id));
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
		supportsToolSearch: true,
	};
}

// Moonshot Kimi K2.6/K2.7 accept system text after the conversation starts but reject
// tool-bearing system messages. Kimi K3 accepts both forms; Fireworks and OpenCode pass
// its tool-bearing form through. GitHub Copilot forwards K3 text but silently drops its
// tool-bearing message. DeepSeek V4 Pro and OpenAI models behind OpenRouter also accept
// plain system text in place. Kimi Coding sets these flags in createKimiCodingModels().
export function applyOpenAICompletionsTranscriptMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const isKimiK3 =
		(model.provider.startsWith("moonshot") && isKimiK3FamilyId(model.id)) ||
		(model.provider === "fireworks" && model.id.includes("kimi-k3")) ||
		((model.provider === "opencode" || model.provider === "opencode-go") && isKimiK3FamilyId(model.id));
	const isMoonshotKimiK2 =
		model.provider.startsWith("moonshot") &&
		(model.id === "kimi-k2.6" || model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed");
	const isTextOnly =
		isMoonshotKimiK2 ||
		(model.provider === "github-copilot" && model.id === "kimi-k3") ||
		(model.provider === "deepseek" && model.id === "deepseek-v4-pro") ||
		(model.provider === "openrouter" &&
			model.id.startsWith("openai/") &&
			OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id.slice("openai/".length)));
	if (!isKimiK3 && !isTextOnly) return;
	model.compat = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isKimiK3 ? { supportsMidConvoToolAdditions: true } : {}),
	};
}

// Newer OpenAI Responses models accept developer messages after the conversation has started.
// OpenCode Zen, OpenCode Go, and GitHub Copilot pass both those messages and
// `additional_tools` items through to OpenAI unchanged; tool search is not verified
// through those proxies.
export const OPENAI_RESPONSES_PROXY_PROVIDERS = new Set(["opencode", "opencode-go", "github-copilot"]);

export function applyOpenAIResponsesTranscriptMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	const isProxiedResponses = OPENAI_RESPONSES_PROXY_PROVIDERS.has(model.provider) && model.api === "openai-responses";
	if (
		!(isOpenAIResponses || isOpenAICodex || isProxiedResponses) ||
		!OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id)
	) {
		return;
	}
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isProxiedResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)
			? { supportsAdditionalTools: true }
			: {}),
	};
}

// OpenAI charges prompt-cache writes starting with the GPT-5.6 family, and exactly
// those models accept `prompt_cache_options`; older models reject the parameter.
// https://developers.openai.com/api/docs/guides/prompt-caching
export function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!(model.cost.cacheWrite > 0)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsExplicitPromptCacheMode: true,
	};
}

// GPT-6 models accept `configuration_update` input items that change the reasoning effort
// without changing the cached prompt prefix. Not enabled for openai-codex (Codex CLI keeps it
// behind a flag that is off by default) or proxies.
export function applyOpenAIMidConvoEffortMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!OPENAI_MID_CONVO_EFFORT_MODEL_IDS.has(model.id)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsMidConvoEffort: true,
	};
}

// Anthropic ephemeral entries have a hard five-minute lifetime; `ttl: "1h"`
// extends it to one hour. Only direct Anthropic is annotated so cache warming
// does not assume equivalent behavior through proxies.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
export const ANTHROPIC_PROMPT_CACHE: ModelPromptCache = { short: 300, long: 3600 };

export function applyPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		model.promptCache = ANTHROPIC_PROMPT_CACHE;
	}
	// Do not add OpenAI lifetimes yet. Before enabling warming for explicit
	// OpenAI caches, re-evaluate it using observed expiry, replay, and billing
	// behavior; a documented TTL alone does not establish full cache loss.
}

export function applyImageInputMetadata(model: AnyModel): void {
	if (!model.input.includes("image")) return;

	const providerLimits: AnyModel["inputLimits"] =
		model.provider === "anthropic"
			? {
					maxRequestBytes: 32 * 1024 * 1024,
					images: {
						maxPerRequest:
							model.type !== "image" && "contextWindow" in model && model.contextWindow === 200000 ? 100 : 600,
					},
				}
			: model.provider === "amazon-bedrock"
				? { images: { maxPerMessage: 20 } }
				: model.provider === "openai"
					? { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } }
					: model.provider === "google"
						? { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }
						: undefined;
	const configuredImages = model.inputLimits?.images;
	model.inputLimits = {
		...providerLimits,
		...model.inputLimits,
		images: {
			...providerLimits?.images,
			...configuredImages,
			resize: { ...DEFAULT_IMAGE_RESIZE, ...configuredImages?.resize },
		},
	};
}

export function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

export function getGoogleThinkingLevelMap(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[],
): NonNullable<Model<Api>["thinkingLevelMap"]> | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) return effortMap;
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}

export function applyThinkingLevelMetadata(model: Model<any>): void {
	if ((model.api === "openai-responses" || model.api === "azure-openai-responses") && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		(isOpenAiGpt6ModelId(model.id) &&
			(model.api === "openai-responses" ||
				model.api === "azure-openai-responses" ||
				model.api === "openai-codex-responses")) ||
		isBedrockOpenAiGpt6Model(model)
	) {
		const baseModelId = getOpenAiBaseModelId(model);
		mergeThinkingLevelMap(model, {
			// GPT-6 Astra, GPT-6.1 Sol and GPT-6.2 reject reasoning.effort "none"; GPT-6.1 Terra accepts it. All
			// reject "minimal" (verified on Codex, October 2026).
			off:
				isOpenAiGpt6AstraModelId(baseModelId) || OPENAI_GPT6_NO_NONE_EFFORT_MODEL_IDS.has(baseModelId)
					? null
					: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	// xAI models without verified effort options must not send the undocumented
	// "none"/"minimal" efforts.
	if (model.provider === "xai" && model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(model, { off: null, minimal: null });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is only available on Opus 4.7/4.8/5, Sonnet 5, Haiku 5.5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5") ||
		model.id.includes("haiku-5") ||
		model.id.includes("haiku.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	// Anthropic publishes exactly five efforts for Claude Fable 5.1 and 5.2, Claude Opus 5.5, and Claude
	// Sonnet 5.5 — low, medium, high, xhigh, max — and no `minimal`. `getSupportedThinkingLevels`
	// includes any level the map leaves undefined, so on the sparse Anthropic-side maps `minimal` was
	// offered as a sixth option. It is not an API error (`mapThinkingLevelToEffort` collapses it to
	// `low`), but it is not a level the model publishes, so deny it explicitly. The OpenRouter entries
	// already carry a full map with `minimal: null` from models.dev `reasoning_options`, so this is a
	// no-op there.
	// https://platform.claude.com/docs/en/models/fable-5-1/overview
	// https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2
	// https://platform.claude.com/docs/en/models/opus-5-5/overview
	// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
	if (/fable-5[-.][12]|opus-5[-.]5|(?:sonnet|haiku)-5[-.]5/.test(model.id)) {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (model.api === "bedrock-converse-stream" && /claude-haiku-5[-.]5/.test(model.id)) {
		model.compat = { ...(model.compat as BedrockCompat | undefined), supportsTemperature: false };
	}
	if (model.api === "openai-completions" && model.id.includes("deepseek-v4") && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: model.provider === "azure"
					? AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP
					: (model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
							model.id.includes("deepseek-v4-flash")
						? DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP
						: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	// Google publishes LOW | MEDIUM | HIGH for Gemini 3.8 Flash and states outright that "MINIMAL is
	// unsupported for this model". `getSupportedThinkingLevels` offers any level the sparse Google
	// map leaves undefined, so deny it explicitly. Deliberately scoped to 3.8: Gemini 3.5 and 3.6
	// Flash do publish MINIMAL, so the wider Flash rule above must not gain this.
	// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
	if ((model.api === "google-generative-ai" || model.api === "google-vertex") && /gemini-3\.8-flash/.test(model.id)) {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	// Gemini 2.5 Pro cannot turn thinking off: its smallest thinking budget is 128 tokens and it rejects a zero
	// budget. Deny `off` so thinking `off` runs at the smallest budget instead.
	if ((model.api === "google-generative-ai" || model.api === "google-vertex") && /gemini-2\.5-pro/.test(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3.6-27b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	// Codex's `minimal` UI alias sends `low`. GPT-6 Astra and GPT-6.2 list exactly `low` through `max` in Codex's catalog.
	if (
		model.provider === "openai-codex" &&
		supportsOpenAiXhigh(model.id) &&
		!isOpenAiGpt6AstraModelId(model.id) &&
		!OPENAI_GPT62_MODEL_IDS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// Pi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks") {
		if (
			model.api === "anthropic-messages" &&
			(model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking
		) {
			// Qwen Max currently advertises only a toggle. Prefer upstream effort
			// metadata once available instead of replacing it with this fallback.
			if (model.id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap) {
				model.thinkingLevelMap = getEffortThinkingLevelMap([
					{ type: "effort", values: ["low", "medium", "xhigh"] },
				]);
			}
			const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
			if (
				reasoningOptions?.some((option) => option.type === "toggle") ||
				// The 2.4T alias omits the verified toggle in models.dev.
				model.id === "accounts/fireworks/models/qwen3p8-2p4t-a95b"
			) {
				mergeThinkingLevelMap(model, { off: "none" });
			}
			if (model.id === "accounts/fireworks/models/deepseek-v4-pro-0813") {
				mergeThinkingLevelMap(model, { low: "low" });
			}
		}
		if (model.id.includes("glm-5p2")) {
			// GLM 5.2 and its fast router support off/high/max. Fireworks maps low
			// and medium to high, so do not expose those aliases as distinct levels.
			mergeThinkingLevelMap(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		}
		if (model.id.includes("kimi-k3")) {
			// Fireworks maps medium to high on both APIs; do not expose it as a distinct level.
			mergeThinkingLevelMap(model, { medium: null });
		}
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "ant-ling" && model.reasoning) {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = (
			GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES as Record<
				string,
				NonNullable<Model<any>["thinkingLevelMap"]> | undefined
			>
		)[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

export function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (
		VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS.has(provider) &&
		supportsAnthropicMidConvoEffort(modelId) &&
		!MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
	) {
		compat.supportsMidConvoEffort = true;
	}
	if (provider === "anthropic" && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
		compat.supportsMidConvoToolChanges = true;
	}
	// OpenCode Zen and GitHub Copilot forward mid-conversation system messages but reject
	// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level there.
	if ((provider === "opencode" || provider === "github-copilot") && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
	}
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	// OpenCode Qwen 3.8 Flash emits and accepts thinking blocks with empty signatures.
	if ((provider === "opencode" || provider === "opencode-go") && modelId === "qwen3.8-flash") {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/**
 * Input modalities for the two runtimes that can serialize a document block: the Anthropic
 * Messages path and the Amazon Bedrock Converse path.
 *
 * PDF is a platform capability rather than a per-model one — "All active models support PDF
 * processing" — so upstream metadata publishes it for every Claude entry. Gating on the *API*
 * rather than the model is what keeps that honest: a provider that advertises PDF but has no
 * document serializer here keeps `["text", "image"]`, so `Model.input` continues to describe what
 * Atomic can actually send rather than what the upstream model would accept.
 * https://platform.claude.com/docs/en/build-with-claude/pdf-support
 */
export function resolveDocumentCapableInput(m: ModelsDevModel): ("text" | "image" | "pdf")[] {
	const modalities = m.modalities?.input;
	if (!modalities?.includes("image")) return ["text"];
	return modalities.includes("pdf") ? ["text", "image", "pdf"] : ["text", "image"];
}

export function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

export function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

export function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

export function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const base = {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
	};
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? base.input,
				output: tier.output ?? base.output,
				cacheRead: tier.cache_read ?? base.cacheRead,
				cacheWrite: tier.cache_write ?? base.cacheWrite,
			},
		];
	});

	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

export function processZaiModels(data: ModelsDevCatalog): Model<Api>[] {
	const variants = [
		{
			source: "zai-coding-plan",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		},
		{
			source: "zhipuai-coding-plan",
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
	] as const;
	const models: Model<Api>[] = [];

	for (const { source, provider, baseUrl } of variants) {
		for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
			const m = model as ModelsDevModel;
			if (m.tool_call !== true) continue;
			const supportsImage = m.modalities?.input?.includes("image");

			const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
			const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
			if (thinkingLevelMap && isGlm52) {
				thinkingLevelMap.off = "none";
			}
			const supportsReasoningEffort = thinkingLevelMap !== undefined;
			const referenceCost = data.zai?.models?.[modelId]?.cost ?? m.cost;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: supportsImage ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(referenceCost),
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
					...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	return models;
}

export function processBasetenModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const baseUrl = "https://inference.baseten.co/v1";
	const baseCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: true,
		// Baseten automatic prompt caching needs related requests on the same replica.
		// https://docs.baseten.co/inference/model-apis/pricing-and-limits
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const reasoningEffortCompat: OpenAICompletionsCompat = {
		...baseCompat,
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	};
	const toggleReasoningCompat: OpenAICompletionsCompat = {
		...baseCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleReasoningEffortCompat: OpenAICompletionsCompat = {
		...reasoningEffortCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const glm52ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	} as const;
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.status === "deprecated") continue;

		const reasoning = model.reasoning === true;
		const reasoningOptions = model.reasoning_options ?? [];
		const isGlm52 = modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast";
		const supportsToggle = reasoningOptions.some((option) => option.type === "toggle") || isGlm52;
		const supportsEffort = reasoningOptions.some((option) => option.type === "effort") || isGlm52;
		const compat =
			supportsToggle && supportsEffort
				? toggleReasoningEffortCompat
				: supportsToggle
					? toggleReasoningCompat
					: supportsEffort
						? reasoningEffortCompat
						: baseCompat;
		const thinkingLevelMap = isGlm52
			? glm52ThinkingLevelMap
			: supportsToggle
				? toggleThinkingLevelMap
				: getEffortThinkingLevelMap(reasoningOptions);
		// Baseten's GLM-5.2 endpoints are text-only despite models.dev reporting image input.
		const supportsImageInput = !isGlm52 && model.modalities?.input?.includes("image");

		models.push({
			id: modelId,
			name: model.name || modelId,
			api: "openai-completions",
			provider: "baseten",
			baseUrl,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: supportsImageInput ? ["text", "image"] : ["text"],
			cost: getModelsDevCost(model.cost),
			compat,
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		});
	}

	return models;
}

export function processGoogleModels(data: ModelsDevCatalog): Model<Api>[] {
	const models: Model<Api>[] = [];
	const googleModels = data.google?.models;
	if (googleModels) {
		for (const [modelId, model] of Object.entries(googleModels)) {
			if (model.tool_call !== true) continue;
			const source =
				modelId === "gemini-flash-latest"
					? (googleModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (googleModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(source.cost),
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	// The google-vertex models.dev catalog also includes Claude, OpenAI, and other
	// MaaS models that do not use the @google/genai Gemini streaming path.
	const vertexModels = data["google-vertex"]?.models;
	if (vertexModels) {
		for (const [modelId, model] of Object.entries(vertexModels)) {
			if (model.tool_call !== true || !modelId.startsWith("gemini-")) continue;
			if (modelId === "gemini-3.1-flash-lite-preview") continue;
			const source =
				modelId === "gemini-flash-latest"
					? (vertexModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (vertexModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);
			// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
			// do not match the official Gemini API standard pricing table. pi only accounts
			// cachedContentTokenCount as cacheRead.
			const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-vertex",
				provider: "google-vertex",
				baseUrl: VERTEX_BASE_URL,
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: source.cost?.input || 0,
					output: source.cost?.output || 0,
					cacheRead,
					cacheWrite: 0,
				},
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	return models;
}

export function processFireworksModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const anthropicCompat: AnthropicMessagesCompat = {
		allowEmptySignature: true,
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	};
	const openAICompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const kimiK3Compat: OpenAICompletionsCompat = {
		...openAICompat,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "openai",
	};
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.tool_call !== true) continue;

		const input: ("text" | "image")[] = model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
		const common = {
			id: modelId,
			name: model.name || modelId,
			provider: "fireworks",
			reasoning: model.reasoning === true,
			input,
			cost: getModelsDevCost(model.cost),
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		};

		if (modelId.includes("glm-")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: openAICompat,
			});
		} else if (modelId.includes("kimi-k3")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: kimiK3Compat,
			});
		} else {
			models.push({
				...common,
				api: "anthropic-messages",
				// Fireworks Anthropic-compatible API - SDK appends /v1/messages.
				baseUrl: "https://api.fireworks.ai/inference",
				// Fireworks prompt caching uses automatic prefix matching + session affinity.
				// x-session-affinity routes requests to the same replica for cache hits.
				// cache_control on tools and eager_input_streaming are not supported.
				// See: https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
				// Use adaptive thinking for cataloged effort controls, with verified
				// fallbacks where models.dev is incomplete. New models need no allowlist entry.
				compat: {
					...anthropicCompat,
					...(model.reasoning_options?.some((option) => option.type === "effort") ||
					FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS.has(modelId)
						? { forceAdaptiveThinking: true }
						: {}),
				},
			});
		}
		recordModelsDevReasoningOptions("fireworks", modelId, model);
	}

	return models;
}

// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
export const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"k3-256k": KIMI_K3_COST,
	"k3.1-pro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
	"k3.1-pro-highspeed": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
};

// Kimi Coding uses Chat Completions, the same protocol as the official Kimi Code client.
export function createKimiCodingModels(kimiModels: Record<string, ModelsDevModel>): Model<"openai-completions">[] {
	const models: Model<"openai-completions">[] = [];
	for (const [modelId, m] of Object.entries(kimiModels)) {
		if (m.tool_call !== true) continue;

		// K3-style models report effort levels and dynamic tool loading (tools declared in
		// later system messages) in https://api.kimi.com/coding/v1/models; models.dev mirrors
		// the effort levels. kimi-for-coding-highspeed reports neither and rejects
		// tool-bearing system messages with a 400.
		const isK3Style = m.reasoning_options?.some((option) => option.type === "effort") === true;
		const impliedCost = KIMI_CODING_IMPLIED_COSTS[modelId];
		// K3-style models send reasoning_effort, so expose the effort values models.dev lists.
		const effortLevels =
			isK3Style && m.reasoning_options ? getEffortThinkingLevelMap(m.reasoning_options) : undefined;

		models.push({
			id: modelId,
			name: m.name || modelId,
			api: "openai-completions",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding/v1",
			compat: {
				...(isK3Style ? KIMI_K3_OPENAI_COMPAT : KIMI_OPENAI_COMPAT),
				// All models accept system text after the conversation starts.
				supportsMidConvoSystemMessages: true,
				...(isK3Style ? { supportsMidConvoToolAdditions: true } : {}),
			},
			reasoning: m.reasoning === true,
			input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: m.cost?.input || impliedCost?.input || 0,
				output: m.cost?.output || impliedCost?.output || 0,
				cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
				cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
			},
			contextWindow: m.limit?.context || 4096,
			maxTokens: m.limit?.output || 4096,
			// Kimi Code reports every model as always-thinking.
			thinkingLevelMap: { ...effortLevels, off: null },
		});
	}
	return models;
}

/**
 * The chat models Atomic derives from a models.dev `api.json` catalog: the build-time catalog generator and the
 * runtime catalog refresh both call this, so a refreshed catalog has the same shape as the bundled one.
 */
export function buildModelsDevChatModels(data: ModelsDevCatalog, options: ModelsDevCatalogOptions = {}): Model<any>[] {
	modelsDevReasoningOptions.clear();
	const strict = options.strict === true;
	const nvidiaNimModelIds = options.nvidiaNimModelIds ?? new Map<string, string>();
	{
		const models: Model<any>[] = [];

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS.has(modelId)) continue;

				const id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: resolveDocumentCapableInput(m) as ("text" | "image" | "pdf")[],
					// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models.
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
				});
				recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: resolveDocumentCapableInput(m),
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("anthropic", modelId, m);
			}
		}

		models.push(...processGoogleModels(data));

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev lists this alias, but it is not accepted by OpenAI APIs.
				if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("openai", modelId, m);
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("groq", modelId, m);
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("cerebras", modelId, m);
			}
		}

		// This is the built-in default for both Cloudflare providers. Keep its known
		// Workers AI metadata when models.dev temporarily omits or mis-tags it.
		data["cloudflare-workers-ai"] ??= {};
		const cloudflareWorkersAiProvider = data["cloudflare-workers-ai"];
		cloudflareWorkersAiProvider.models ??= {};
		const cloudflareWorkersAiModels = cloudflareWorkersAiProvider.models;
		cloudflareWorkersAiModels[CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL_ID] = {
			...CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL,
			...cloudflareWorkersAiModels[CLOUDFLARE_DEFAULT_WORKERS_AI_MODEL_ID],
			tool_call: true,
		};
		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
			}
		}

		// Process Cloudflare AI Gateway models
		const cloudflareAIGatewayModelIds = new Set<string>();
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId.replaceAll(".", "-");
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// Gateway passthroughs forward session affinity headers to upstreams that
				// use them for cache/routing affinity.
				const compat =
					upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				cloudflareAIGatewayModelIds.add(id);
				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// models.dev may omit Workers AI passthroughs from the AI Gateway provider
		// list even though the gateway /compat endpoint supports routing to them.
		// Mirror the Workers AI catalog under the documented workers-ai/ prefix so
		// the gateway keeps its OpenAI-compatible /compat models stable.
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const id = `workers-ai/${modelId}`;
				if (cloudflareAIGatewayModelIds.has(id)) continue;
				cloudflareAIGatewayModelIds.add(id);

				models.push({
					id,
					name: m.name || id,
					api: "openai-completions",
					provider: "cloudflare-ai-gateway",
					baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					compat: { ...XAI_RESPONSES_COMPAT },
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("xai", modelId, m);
			}
		}

		// Process Meta models
		if (data.meta?.models) {
			for (const [modelId, model] of Object.entries(data.meta.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "meta",
					baseUrl: "https://api.meta.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("meta", modelId, m);
			}
		}

		models.push(...processZaiModels(data));

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const thinkingLevelMap = modelId.startsWith("magistral-")
					? undefined
					: getEffortThinkingLevelMap(m.reasoning_options ?? []);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read ?? (m.cost?.input ? roundCost(m.cost.input * 0.1) : 0),
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("huggingface", modelId, m);
			}
		}

		models.push(...processFireworksModels(data["fireworks-ai"]));

		// Process NVIDIA NIM models
		if (data.nvidia?.models) {
			for (const [modelId, model] of Object.entries(data.nvidia.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!m.modalities?.input?.includes("text")) continue;
				if (!m.modalities?.output?.includes("text")) continue;

				const liveModelId =
					nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
				if (!liveModelId) continue;
				if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

				models.push({
					id: liveModelId,
					name: m.name || liveModelId,
					api: "openai-completions",
					provider: "nvidia",
					baseUrl: NVIDIA_BASE_URL,
					headers: { ...NVIDIA_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: NVIDIA_OPENAI_COMPAT,
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("nvidia", liveModelId, m);
			}
		}

		// Process Together AI models
		const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
		if (togetherProvider?.models) {
			for (const [modelId, model] of Object.entries(togetherProvider.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const reasoning = m.reasoning === true;
				const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "together",
					baseUrl: TOGETHER_BASE_URL,
					reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: getTogetherCompat(modelId, reasoning),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("together", modelId, m);
			}
		}

		models.push(...processBasetenModels(data.baseten));

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/inference" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/inference/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key]?.models ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/openai/v1`;
					compat = { sessionAffinityFormat: "openai-nosession" };
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = `${variant.basePath}/anthropic`;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/google/v1beta`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/openai/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/openai/v1`;
				}

				if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
					compat = { ...(compat ?? {}), supportsReasoningEffort: false };
				}

				if (variant.provider === "opencode" && modelId === "kimi-k2.6") {
					// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
					// and rejects string thinking values or combined reasoning_effort.
					compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but OpenCode Go serves them through the
				// OpenAI-compatible /openai/v1/chat/completions path.
				if (variant.provider === "opencode-go") {
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/openai/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions") {
					compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
					if (
						OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(
							`${variant.provider}:${modelId}`,
						)
					) {
						compat = { ...compat, supportsLongCacheRetention: false };
					}
				}

				let thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> | undefined;
				if (api === "google-generative-ai") {
					thinkingLevelMap = getGoogleThinkingLevelMap(modelId, m.reasoning_options ?? []);
				} else if (variant.provider === "opencode-go" && modelId === "deepseek-v4.1-flash") {
					thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(variant.provider, modelId, m);
			}
		}

		// Keep both Claude Fable generations in the static Copilot catalog. GitHub's authenticated
		// picker still controls account availability; when its models.dev catalog lags a Fable release,
		// reuse that release's models.dev Anthropic metadata instead of maintaining a local snapshot.
		const githubCopilotModels = { ...data["github-copilot"]?.models };
		for (const modelId of GITHUB_COPILOT_CLAUDE_FABLE_MODEL_IDS) {
			const anthropicSource = data.anthropic?.models?.[modelId];
			const source =
				githubCopilotModels[modelId] ??
				(anthropicSource ? { ...anthropicSource, provider: { npm: "@ai-sdk/anthropic" } } : undefined);
			if (source) githubCopilotModels[modelId] = source;
		}
		for (const [modelId, fallback] of Object.entries(GITHUB_COPILOT_MODELS_DEV_FALLBACKS)) {
			githubCopilotModels[modelId] ??= fallback;
		}
		for (const [modelId, m] of Object.entries(githubCopilotModels)) {
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			// The model's own metadata picks the Copilot API, as for OpenCode: models.dev's
			// per-model SDK names the endpoint Copilot serves it on, never the model ID.
			const api: Api = githubCopilotApiForSdk(m.provider?.npm);

			const anthropicCompat =
				api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

			const copilotModel: Model<any> = {
				id: modelId,
				name: m.name || modelId,
				api,
				provider: "github-copilot",
				baseUrl: "https://api.individual.githubcopilot.com",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 128000,
				maxTokens: m.limit?.output || 8192,
				headers: { ...COPILOT_STATIC_HEADERS },
				...(anthropicCompat ? { compat: anthropicCompat } : {}),
				// compat only applies to openai-completions
				...(api === "openai-completions"
					? {
							compat: {
								supportsStore: false,
								supportsDeveloperRole: false,
								supportsReasoningEffort:
									m.reasoning_options?.some((option) => option.type === "effort") ?? false,
							},
						}
					: {}),
			};

			models.push(copilotModel);
			recordModelsDevReasoningOptions("github-copilot", modelId, m);
		}

		// Process MiniMax models
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;
		// MiniMax asked to hide older models from its direct providers (#2596).
		const minimaxHiddenIds = new Set(["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"]);

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true || minimaxHiddenIds.has(modelId)) continue;
					// Models with effort levels (e.g. MiniMax-M3.1-Flash) take adaptive thinking with
					// output_config.effort and reject thinking.type="disabled" (no "none" effort, so off is null).
					const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: getModelsDevCost(m.cost),
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
						...(thinkingLevelMap ? { thinkingLevelMap, compat: { forceAdaptiveThinking: true } } : {}),
					});
				}
			}
		}

		// models.dev renamed the global coding plan; keep the older sources as fallbacks.
		const kimiModels =
			data["kimi-code-plan-global"]?.models ?? data["kimi-code-plan-cn"]?.models ?? data["kimi-for-coding"]?.models;
		if (kimiModels) {
			models.push(...createKimiCodingModels(kimiModels as Record<string, ModelsDevModel>));
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
			const providerModels = data[key]?.models as Record<string, ModelsDevModel> | undefined;
			return providerModels ? { ...providerModels } : {};
		};
		const moonshotModels = {
			moonshotai: getMoonshotProviderModels("moonshotai"),
			"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			for (const [modelId, m] of Object.entries(moonshotModels[key])) {
				if (m.tool_call !== true) continue;

				const isKimiK3 = isKimiK3FamilyId(modelId);
				const compat = { ...(isKimiK3 ? KIMI_K3_OPENAI_COMPAT : KIMI_OPENAI_COMPAT) };
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					// Moonshot does not bill cache writes; models.dev lists the input rate as cache_write for Kimi K3.
					cost:
						modelId === "kimi-k3"
							? { ...KIMI_K3_COST }
							: {
									input: m.cost?.input || 0,
									output: m.cost?.output || 0,
									cacheRead: m.cost?.cache_read || 0,
									cacheWrite: isKimiK3 ? 0 : m.cost?.cache_write || 0,
								},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiCompat: OpenAICompletionsCompat = {
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
		const xiaomiThinkingLevelMap = {
			off: "off",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		} as const;
		const xiaomiVariants = [
			{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
			{
				source: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of xiaomiVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: xiaomiCompat,
					reasoning: m.reasoning === true,
					...(m.reasoning === true ? { thinkingLevelMap: xiaomiThinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Alibaba Cloud Model Studio Token Plan models. International and
		// China use separate endpoints and API keys (sk-sp- prefix). The Individual
		// providers reuse each region's source and endpoint with a narrower catalog.
		// models.dev keys are "alibaba-token-plan[-cn]"; pi exposes them as
		// "qwen-token-plan[-cn]" plus the "qwen-token-plan-individual[-cn]" catalog views.
		const qwenTokenPlanCompat: OpenAICompletionsCompat = {
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		};
		const qwenTokenPlanVariants = [
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan",
				baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
				modelIds: undefined,
			},
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan-individual",
				baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
				modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-cn",
				baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
				modelIds: undefined,
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-individual-cn",
				baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
				modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
			},
		] as const;

		for (const { source, provider, baseUrl, modelIds } of qwenTokenPlanVariants) {
			const providerModels = data[source]?.models;
			const emittedModelIds = modelIds ? new Set<string>() : undefined;

			for (const [modelId, model] of Object.entries(providerModels ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;
				if (modelIds && !modelIds.has(modelId)) continue;
				const thinkingLevelMap =
					getEffortThinkingLevelMap(m.reasoning_options ?? []) ??
					(QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS.has(modelId)
						? QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP
						: undefined);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: thinkingLevelMap
						? qwenTokenPlanCompat
						: { ...qwenTokenPlanCompat, supportsReasoningEffort: false },
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				emittedModelIds?.add(modelId);
			}

			if (modelIds && emittedModelIds && strict) {
				assertExactModelIds(provider, modelIds, emittedModelIds);
			}
		}

		return models;
	}
}

/**
 * Applies Atomic's corrections, additions and metadata to the combined chat models of its catalog sources, models.dev
 * first. The build-time generator and the runtime catalog refresh both call this.
 */
export function finalizeChatModels(sourceModels: readonly Model<any>[]): Model<Api>[] {
	const allModels = sourceModels.filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	// The authenticated Copilot catalog advertised these models on 2026-09-22,
	// but models.dev did not include them yet.
	const missingCopilotModels: Model<Api>[] = [
		{
			id: "claude-opus-5.5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		},
		...(["gpt-6-sol", "gpt-6-luna"] as const).map((id) => ({
			id,
			name: id === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Luna",
			api: "openai-responses" as const,
			provider: "github-copilot" as const,
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[id]),
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		})),
	];
	for (const model of missingCopilotModels) {
		if (!allModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			allModels.push(model);
		}
	}

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "github-copilot" && GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(candidate.id)) {
			candidate.contextWindow = 1000000;
		}

		// models.dev may list Opus 5.5 and Sonnet 5.5 before their effort metadata is complete.
		if (
			(candidate.provider === "anthropic" &&
				(candidate.id === "claude-opus-5-5" || candidate.id === "claude-sonnet-5-5")) ||
			(candidate.provider === "github-copilot" && candidate.id === "claude-opus-5.5")
		) {
			mergeThinkingLevelMap(candidate, {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
		}

		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep direct OpenAI requests in the short-context pricing tier by default. Users can opt into the
		// larger context through model overrides, so retain long-context cost metadata on the capped models.
		if (candidate.provider === "openai" && OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS.has(candidate.id)) {
			candidate.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(candidate.id)) {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			candidate.cost = withOpenAiLongContextPricing(standardCost ?? candidate.cost);
		}
		// Cloudflare AI Gateway passes OpenAI usage through at OpenAI list prices.
		if (candidate.provider === "cloudflare-ai-gateway") {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			if (standardCost) candidate.cost = withOpenAiLongContextPricing(standardCost);
		}
		// models.dev reports gpt-5-pro output as 272000 (a duplicate of the input sub-limit);
		// the actual max output is 128000. Also propagates to the derived Azure clone.
		if (candidate.provider === "openai" && candidate.id === "gpt-5-pro") {
			candidate.maxTokens = 128000;
		}
		// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
		if (
			(candidate.provider === "openrouter" && candidate.id === "~moonshotai/kimi-latest") ||
			((candidate.provider === "openrouter" || candidate.provider === "vercel-ai-gateway") &&
				candidate.id.startsWith("moonshotai/") &&
				isKimiK3FamilyId(candidate.id.slice("moonshotai/".length)))
		) {
			candidate.maxTokens = KIMI_K3_MAX_TOKENS;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id.startsWith("moonshotai/kimi-k2.6")) {
			candidate.compat = {
				...candidate.compat,
				supportsDeveloperRole: false,
				requiresReasoningContentOnAssistantMessages: true,
			};
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}
	}

	// Add missing gpt models
	const gpt6AstraOpenAiModel: Model<"openai-responses"> = {
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		provider: "openai",
		reasoning: true,
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-astra"]),
		contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
		maxTokens: 128000,
	};
	// Provisional Copilot entry requested before its public catalog lists Astra. Reuse the
	// known model capabilities, not OpenAI billing rates. Copilot's authenticated picker
	// controls availability and fast entitlement; a provider-published row takes precedence.
	if (!allModels.some((model) => model.provider === "github-copilot" && model.id === "gpt-6-astra")) {
		allModels.push({
			...gpt6AstraOpenAiModel,
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			headers: { ...COPILOT_STATIC_HEADERS },
		});
	}

	const missingOpenAiModels: Model<"openai-responses">[] = [
		gpt6AstraOpenAiModel,
		{
			id: "gpt-6.2-astra",
			name: "GPT-6.2 Astra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.2-astra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6.2-sol",
			name: "GPT-6.2 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.2-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6.1-terra",
			name: "GPT-6.1 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-terra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];
	for (const model of missingOpenAiModels) {
		if (!allModels.some((m) => m.provider === model.provider && m.id === model.id)) {
			allModels.push(model);
		}
	}

	// Codex 0.153.3 advertises these exact Bedrock Mantle and Runtime IDs while AWS's public
	// catalog and pricing pages have not published Astra yet. Keep the established zero-cost
	// convention until AWS provides authoritative rates; a future models.dev row with the same ID wins.
	// https://github.com/openai/codex/blob/83b62a02fab5c0fc797cbc9896c332148f1fd9d0/codex-rs/model-provider/src/amazon_bedrock/catalog.rs
	// https://github.com/openai/codex/blob/83b62a02fab5c0fc797cbc9896c332148f1fd9d0/codex-rs/model-provider/src/amazon_bedrock/runtime_catalog.rs
	const missingBedrockAstraModels: Model<"bedrock-converse-stream">[] = [
		["openai.gpt-6-astra", "GPT-6-Astra"],
		["global.openai.gpt-6-astra", "GPT-6-Astra (Global)"],
		["us.openai.gpt-6-astra", "GPT-6-Astra (US cross-region)"],
	].map(([id, name]) => ({
		id,
		name,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: getBedrockBaseUrl(id),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
		maxTokens: 128000,
	}));
	for (const model of missingBedrockAstraModels) {
		if (!allModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			allModels.push(model);
		}
	}

	// Released 2026-11-09; models.dev does not list it for Anthropic yet. A future models.dev row
	// with the same ID wins.
	// https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2
	const missingAnthropicModels: Model<"anthropic-messages">[] = [
		{
			id: "claude-fable-5-2",
			name: "Claude Fable 5.2",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
			contextWindow: 1000000,
			maxTokens: 128000,
		},
	];
	for (const model of missingAnthropicModels) {
		if (!allModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			allModels.push(model);
		}
	}

	const deepseekCompat: OpenAICompletionsCompat = {
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const deepseekModels: Model<"openai-completions">[] = [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			thinkingLevelMap: DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP,
			input: ["text", "image"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 0.3,
				output: 1.2,
				cacheRead: 0.006,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 1.32,
				output: 3.96,
				cacheRead: 0.044,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
	];
	allModels.push(...deepseekModels);

	const antLingCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
	};
	const antLingModels: Model<"openai-completions">[] = [
		{
			id: "Ling-2.6-flash",
			name: "Ling 2.6 Flash",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ling-2.6-1T",
			name: "Ling 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ring-2.6-1T",
			name: "Ring 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: { ...antLingCompat, thinkingFormat: "ant-ling" },
		},
	];
	allModels.push(...antLingModels);

	for (const candidate of allModels) {
		if (
			candidate.api === "openai-completions" &&
			candidate.id.includes("deepseek-v4") &&
			!QWEN_TOKEN_PLAN_PROVIDER_IDS.has(candidate.provider)
		) {
			const preservesNativeReasoningEffort =
				candidate.provider === "openrouter" || candidate.provider === "opencode";
			candidate.compat = {
				...candidate.compat,
				...(preservesNativeReasoningEffort
					? {
							requiresReasoningContentOnAssistantMessages:
								deepseekCompat.requiresReasoningContentOnAssistantMessages,
						}
					: deepseekCompat),
			};
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Only list models the Codex backend accepts for ChatGPT accounts. GPT-5.5 and GPT-5.3 Codex Spark are rejected
	// with "not supported when using Codex with a ChatGPT account".
	// GPT-5.6 and GPT-6 use Codex's 272k default catalog limit.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_GPT_56_CONTEXT = 272000;
	// Codex and Work raised GPT-6.1 Sol's default context to 500k (up from 272k) for ChatGPT subscriptions only, and
	// OpenAI does not charge long-context fees for it when usage draws from the subscription. The API model
	// (`openai` and `openai-api`) keeps the 272k cap and the whole-request long-context tier. Codex also serves
	// GPT-6.1 Terra with a 500k context, but OpenAI has not waived its long-context fee. Codex serves GPT-6.2 Sol with
	// 500k and GPT-6.2 Astra with its 272k default, and no long-context fee waiver is announced for either.
	const CODEX_GPT_61_CONTEXT = 500000;
	const CODEX_GPT_62_SOL_CONTEXT = 500000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-6.2-astra",
			name: "GPT-6.2 Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.2-astra"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6.2-sol",
			name: "GPT-6.2 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.2-sol"]),
			contextWindow: CODEX_GPT_62_SOL_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-astra",
			name: "GPT-6-Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-astra"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_STANDARD_COSTS["gpt-6.1-sol"],
			contextWindow: CODEX_GPT_61_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6.1-terra",
			name: "GPT-6.1 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-terra"]),
			contextWindow: CODEX_GPT_61_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	for (const model of codexModels) {
		model.serviceTiers = codexServiceTiers(model.id);
	}
	allModels.push(...codexModels);

	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some((m) => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			thinkingLevelMap: getEffortThinkingLevelMap([{ type: "effort", values: ["none", "high"] }]),
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some((m) => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Add "fusion" alias for openrouter/fusion. OpenRouter exposes Fusion as a
	// router alias/plugin entry point; its model metadata does not advertise
	// tools, but the alias resolves to a concrete model that can invoke caller
	// tools and has the openrouter:fusion server tool auto-injected.
	if (!allModels.some((m) => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// we dont know about the costs because Fusion routes to multiple models
				// and then charges you for the underlying used models
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}

	// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
	// See models-sold-directly-by-azure docs.
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
		"gpt-6-luna": 1050000,
		"gpt-6-sol": 1050000,
		"gpt-6.1-sol": 1050000,
		"gpt-6.1-terra": 1050000,
		"gpt-6.2-astra": 1050000,
		"gpt-6.2-sol": 1050000,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses" && model.id !== "gpt-6-astra")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	allModels.push(...azureOpenAiModels);
	const azureDeepSeekModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "deepseek" && model.id === "deepseek-v4-pro")
		.map((model) => ({
			...model,
			provider: "azure",
			baseUrl: "",
			cost: { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 },
			thinkingLevelMap: AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP,
			compat: {
				...(model.compat as OpenAICompletionsCompat),
				supportsDeveloperRole: false,
				supportsMidConvoSystemMessages: true,
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
			},
		}));
	allModels.push(...azureDeepSeekModels);
	for (const model of allModels) {
		if (model.provider === "openai" && model.api === "openai-responses") {
			model.serviceTiers = openAiServiceTiers(model.id);
		}
	}

	for (const model of allModels) {
		applyOpenAICompletionsCompatMetadata(model);
		applyAnthropicMessagesCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyStrictToolCompatMetadata(model);
		applyPreservedThinkingCompatMetadata(model);
		applyForcedToolChoiceCompatMetadata(model);
		applyFableTemperatureCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAICompletionsTranscriptMetadata(model);
		applyOpenAIResponsesTranscriptMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
		applyOpenAIMidConvoEffortMetadata(model);
		applyPromptCacheMetadata(model);
		applyImageInputMetadata(model);
	}
	applyAnthropicAllowedFallbackModelMetadata(allModels.filter(isAnthropicFallbackMetadataModel));
	applyAzureOpenAIListedEfforts(allModels);
	applyAzureOpenAIThinkingOffMasks(allModels);
	return allModels;
}
