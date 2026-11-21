#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { type AiGatewayPricing, getAiGatewayCost } from "./ai-gateway-pricing.ts";
import { moveChangedFiles, removeCatalogFile, replaceFile } from "./catalog-files.ts";
import { buildOpenRouterCatalog, type OpenRouterCatalog, type OpenRouterModelListItem } from "./openrouter-catalog.ts";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
} from "../src/api/cloudflare.ts";
import { COPILOT_HEADERS } from "../src/api/github-copilot-headers.ts";
import { githubCopilotApiForSdk } from "../src/providers/github-copilot-capabilities.ts";
import type {
	AnthropicMessagesCompat,
	AnyModel,
	Api,
	BedrockCompat,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownProvider,
	Model,
	ModelCost,
	ModelPromptCache,
	ModelServiceTier,
	ModelServiceTierId,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	type ModelDataStructure,
	MODEL_DATA_MANIFEST_FILE,
	modelDataInputsHash,
	readModelDataProviderIds,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";
import {
	AI_GATEWAY_BASE_URL,
	AI_GATEWAY_MODELS_URL,
	AI_GATEWAY_TYPESAFE_BASE_URL,
	type ModelsDevCatalog,
	type ModelsDevMetadata,
	NVIDIA_BASE_URL,
	applyImageInputMetadata,
	buildModelsDevChatModels,
	finalizeChatModels,
	normalizeNvidiaModelId,
	withOpenAiLongContextPricing,
} from "../src/utils/models-dev-catalog.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

function readGeneratorOptions(args: string[]): {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
} {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir)) throw new Error("--data-only cannot be combined with JSON catalog output");
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty };
}

const generatorOptions = readGeneratorOptions(process.argv.slice(2));

const MODEL_FETCH_ATTEMPTS = 3;
const MODEL_FETCH_RETRY_DELAY_MS = 250;
/** One attempt's deadline, body included: a stalled connection fails the attempt instead of the whole job. */
const MODEL_FETCH_ATTEMPT_TIMEOUT_MS = Number(process.env.ATOMIC_MODEL_FETCH_TIMEOUT_MS) || 60_000;
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
]);

function isTransientNetworkError(error: unknown, visited = new Set<Error>()): boolean {
	if (!(error instanceof Error) || visited.has(error)) return false;
	visited.add(error);
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	if (error instanceof TypeError && error.message === "fetch failed") return true;

	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;
	return "cause" in error && isTransientNetworkError(error.cause, visited);
}

/** Runs `load` again after a transient network failure, as `fetchModelCatalog` does for catalogs it fetches itself. */
async function withTransientRetries<T>(url: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await load(AbortSignal.timeout(MODEL_FETCH_ATTEMPT_TIMEOUT_MS));
		} catch (error) {
			if (!isTransientNetworkError(error) || attempt === MODEL_FETCH_ATTEMPTS) throw error;
			console.warn(`Model fetch from ${url} failed transiently; retrying (attempt ${attempt + 1}/${MODEL_FETCH_ATTEMPTS})`);
			await new Promise((resolve) => setTimeout(resolve, MODEL_FETCH_RETRY_DELAY_MS));
		}
	}
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * Fetches a JSON catalog, retrying transient failures. A successful response is read and parsed here, inside the
 * retry, so a body that times out or arrives cut short (catalogs are megabytes) is retried like a failed request;
 * callers get it buffered.
 */
async function fetchModelCatalog(url: string): Promise<Response> {
	for (let attempt = 1; attempt <= MODEL_FETCH_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(MODEL_FETCH_ATTEMPT_TIMEOUT_MS) });
			if (response.ok) {
				const body = await response.text();
				try {
					JSON.parse(body);
				} catch (error) {
					if (attempt === MODEL_FETCH_ATTEMPTS) throw error;
					console.warn(
						`Model fetch from ${url} returned incomplete JSON; retrying (attempt ${attempt + 1}/${MODEL_FETCH_ATTEMPTS})`,
					);
					await new Promise((resolve) => setTimeout(resolve, MODEL_FETCH_RETRY_DELAY_MS));
					continue;
				}
				return new Response(body, { status: response.status, statusText: response.statusText });
			}
			if (!isRetryableHttpStatus(response.status) || attempt === MODEL_FETCH_ATTEMPTS) return response;
			console.warn(
				`Model fetch from ${url} returned ${response.status}; retrying (attempt ${attempt + 1}/${MODEL_FETCH_ATTEMPTS})`,
			);
		} catch (error) {
			if (!isTransientNetworkError(error) || attempt === MODEL_FETCH_ATTEMPTS) throw error;
			console.warn(
				`Model fetch from ${url} failed transiently; retrying (attempt ${attempt + 1}/${MODEL_FETCH_ATTEMPTS})`,
			);
		}

		await new Promise((resolve) => setTimeout(resolve, MODEL_FETCH_RETRY_DELAY_MS));
	}

	throw new Error("Unreachable model fetch retry state");
}

interface NvidiaNimModelListItem {
	id: string;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	type?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: AiGatewayPricing;
}


async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetchModelCatalog(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	const response = await fetchModelCatalog(`https://openrouter.ai/api/v1/models${query}`);
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	return data.data ?? [];
}

async function fetchOpenRouterModels(): Promise<OpenRouterCatalog> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const [listed, imageListed, decisionListed] = await Promise.all([
			fetchOpenRouterList(""),
			fetchOpenRouterList("?output_modalities=image"),
			fetchOpenRouterList("?output_modalities=decisions"),
		]);
		const catalog = buildOpenRouterCatalog(listed, imageListed, decisionListed);
		console.log(
			`Fetched ${catalog.chat.length} tool-capable, ${catalog.images.length} image, and ${catalog.classifiers.length} classifier models from OpenRouter`,
		);
		if (generatorOptions.strict && catalog.images.length === 0) {
			throw new Error("OpenRouter API returned no usable image models");
		}
		return catalog;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], images: [], classifiers: [] };
	}
}



async function fetchAiGatewayModels(): Promise<{ chat: Model<any>[]; classifiers: ClassifierModel<"typesafe-system-one">[] }> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetchModelCatalog(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];
		const classifiers: ClassifierModel<"typesafe-system-one">[] = [];

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			if (model.type === "evaluation") {
				classifiers.push({
					type: "classifier",
					id: model.id,
					name: model.name || model.id,
					api: "typesafe-system-one",
					provider: "vercel-ai-gateway",
					baseUrl: AI_GATEWAY_TYPESAFE_BASE_URL,
					input: ["text"],
					cost: getAiGatewayCost(model.pricing),
					contextWindow: model.context_window || 4096,
				});
				continue;
			}
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const cost = getAiGatewayCost(model.pricing);

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				compat: { allowEmptySignature: true },
				cost,
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable and ${classifiers.length} classifier models from Vercel AI Gateway`);
		return { chat: models, classifiers };
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], classifiers: [] };
	}
}


async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetchModelCatalog("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();
		const models = buildModelsDevChatModels(data, { strict: generatorOptions.strict, nvidiaNimModelIds });
		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// Atomic sends TypeSafe's Danger-Zone beta headers on every direct Jev request. They raise the
// context to 262K tokens and turn on image input; models.dev records the defaults without them.
// https://docs.typesafe.ai/models.md and https://docs.typesafe.ai/images.md
const TYPESAFE_CLASSIFIER_IDS = ["jev-latest", "jev-1.14.0"];
const TYPESAFE_DANGER_ZONE_OVERRIDES = {
	input: ["text", "image"],
	contextWindow: 262000,
	headers: { "TypeSafe-Danger-Zone-Long-Context": "true", "TypeSafe-Danger-Zone-Images": "true" },
	compat: { imageInput: "assets", sendImageOptInHeader: true },
} satisfies Pick<ClassifierModel<"typesafe-system-one">, "input" | "contextWindow" | "headers" | "compat">;

async function loadModelsDevClassifierModels(): Promise<ClassifierModel<"typesafe-system-one">[]> {
	try {
		console.log("Fetching classifier models from models.dev API...");
		const response = await fetchModelCatalog("https://models.dev/models.json?type=decision");
		if (!response.ok) throw new Error(`models.dev classifier API returned ${response.status}`);
		const data = (await response.json()) as Record<string, ModelsDevMetadata>;
		return TYPESAFE_CLASSIFIER_IDS.map((id): ClassifierModel<"typesafe-system-one"> => {
			const metadata = data[`typesafe/${id}`];
			if (!metadata || metadata.type !== "decision") {
				throw new Error(`models.dev did not return decision model typesafe/${id}`);
			}
			return {
				type: "classifier",
				id,
				name: metadata.name,
				api: "typesafe-system-one",
				provider: "typesafe",
				baseUrl: "https://api.typesafe.ai/v1/",
				// The canonical models.dev entry has no direct-provider pricing and System One reports no token usage.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...TYPESAFE_DANGER_ZONE_OVERRIDES,
			};
		});
	} catch (error) {
		console.error("Failed to load models.dev classifier data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// OpenCode Zen serves Jev through its TypeSafe-compatible System One endpoint.
const OPENCODE_CLASSIFIER_MODELS: ClassifierModel<"typesafe-system-one">[] = [
	{
		type: "classifier",
		id: "jev-1.13",
		name: "Jev 1.13",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/systemone/v1",
		input: ["text"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
	{
		type: "classifier",
		id: "jev-1.13-free",
		name: "Jev 1.13 Free",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/systemone/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

// Workers AI has no unauthenticated catalog, so its System One models are listed here from
// Cloudflare's model pages.
const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS: ClassifierModel<"cloudflare-workers-ai-system-one">[] = [
	// Cloudflare-hosted Clef decision models. They take up to four PNG, JPEG, or WebP images as data URLs.
	// Clef Omni also takes audio and video, which classifier contexts do not carry.
	// Pricing and context: https://developers.cloudflare.com/workers-ai/models/clef/,
	// https://developers.cloudflare.com/workers-ai/models/clef-flash/,
	// and https://developers.cloudflare.com/workers-ai/models/clef-omni/
	{
		type: "classifier",
		id: "@cf/cloudflare/clef",
		name: "Clef",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0.24, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		compat: { imageInput: "images" },
	},
	{
		type: "classifier",
		id: "@cf/cloudflare/clef-flash",
		name: "Clef Flash",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0.038, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 24576,
		compat: { imageInput: "images" },
	},
	{
		type: "classifier",
		id: "@cf/cloudflare/clef-omni",
		name: "Clef Omni",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64000,
		compat: { imageInput: "images" },
	},
	// TypeSafe's Jev models take PNG and JPEG images as System One assets.
	// https://developers.cloudflare.com/ai/models/typesafe/jev/ (jev-latest)
	// and https://developers.cloudflare.com/ai/models/typesafe/jev-1.14.0/
	{
		type: "classifier",
		id: "typesafe/jev",
		name: "Jev",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		compat: { imageInput: "assets" },
	},
	{
		type: "classifier",
		id: "typesafe/jev-1.14.0",
		name: "Jev 1.14",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		compat: { imageInput: "assets" },
	},
];

const OPENAI_CLASSIFIER_MODELS: ClassifierModel<"openai-decisions">[] = [
	{
		type: "classifier",
		id: "gpt-6-luna",
		name: "GPT-6 Luna Decisions",
		api: "openai-decisions",
		provider: "openai-decisions",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 922000,
	},
];

// OpenAI Images API models, served by the openai-images provider. Standard-tier
// prices from https://developers.openai.com/api/docs/pricing: `input` and `cacheRead`
// are the text input rates and `output` is the image output rate. ModelCost has no
// separate image input rate, so image input tokens on edits are priced as text input.
const OPENAI_IMAGES_BASE_URL = "https://api.openai.com/v1";
// `capabilities` lists the optional request features a model supports; an absent feature is rejected
// before the request. Complexity, SVG and GIF output ship with GPT Image 2.6; markup-guided edits are
// documented for GPT Image 2.5 and 2.6 (https://developers.openai.com/api/docs/guides/image-generation).
const OPENAI_IMAGE_MODELS: ImageModel<"openai-images">[] = [
	{
		id: "gpt-image-2.6-sunburst",
		name: "GPT Image 2.6 Sunburst",
		input: 5,
		cacheRead: 1.25,
		output: 30,
		capabilities: { complexity: true, markup: true, svg: true, gif: true },
	},
	{
		id: "gpt-image-2.6-flare",
		name: "GPT Image 2.6 Flare",
		input: 5,
		cacheRead: 1.25,
		output: 30,
		capabilities: { complexity: true, markup: true, svg: true, gif: true },
	},
	{
		id: "gpt-image-2.5-sunburst",
		name: "GPT Image 2.5 Sunburst",
		input: 5,
		cacheRead: 1.25,
		output: 30,
		capabilities: { markup: true },
	},
	{
		id: "gpt-image-2.5-flare",
		name: "GPT Image 2.5 Flare",
		input: 5,
		cacheRead: 1.25,
		output: 30,
		capabilities: { markup: true },
	},
	{ id: "gpt-image-2", name: "GPT Image 2", input: 5, cacheRead: 1.25, output: 30 },
	{ id: "gpt-image-1.5", name: "GPT Image 1.5", input: 5, cacheRead: 1.25, output: 32 },
	{ id: "gpt-image-1", name: "GPT Image 1", input: 5, cacheRead: 1.25, output: 40 },
	{ id: "gpt-image-1-mini", name: "GPT Image 1 Mini", input: 2, cacheRead: 0.2, output: 8 },
].map(
	({ id, name, input, cacheRead, output, capabilities }): ImageModel<"openai-images"> => ({
		type: "image",
		id,
		name,
		api: "openai-images",
		provider: "openai-images",
		baseUrl: OPENAI_IMAGES_BASE_URL,
		input: ["text", "image"],
		output: ["image"],
		...(capabilities ? { capabilities } : {}),
		cost: { input, output, cacheRead, cacheWrite: 0 },
	}),
);

async function generateModels() {
	// Fetch models from all upstream catalogs.
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras, and others
	// OpenRouter: its tool-capable routed catalog
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const modelsDevClassifierModels = await loadModelsDevClassifierModels();
	const openRouterCatalog = await fetchOpenRouterModels();
	const aiGatewayCatalog = await fetchAiGatewayModels();

	// Combine chat models (models.dev has priority where sources overlap).
	const allModels = finalizeChatModels([...modelsDevModels, ...openRouterCatalog.chat, ...aiGatewayCatalog.chat]);

	// Keep chat and image catalogs separate so one upstream ID can expose both
	// operations with different API implementations.
	type ProviderCatalog = {
		chat: Record<string, Model<Api>>;
		image: Record<string, ImageModel<ImageApi>>;
		classifier: Record<string, ClassifierModel<ClassifierApi>>;
	};
	const providers: Record<string, ProviderCatalog> = {};
	for (const model of allModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		// Only add if not already present (models.dev takes priority over OpenRouter).
		providers[model.provider].chat[model.id] ??= { ...model, type: "chat" };
	}
	for (const model of [...openRouterCatalog.images, ...OPENAI_IMAGE_MODELS]) {
		applyImageInputMetadata(model);
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].image[model.id] ??= model;
	}
	const classifierModels: ClassifierModel<ClassifierApi>[] = [
		{
			type: "classifier",
			id: "microsoft-decision-1",
			name: "Microsoft-Decision-1",
			api: "typesafe-system-one",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			input: ["text"],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			headers: { ...COPILOT_HEADERS },
		},
		...modelsDevClassifierModels,
		...openRouterCatalog.classifiers,
		...aiGatewayCatalog.classifiers,
		...OPENCODE_CLASSIFIER_MODELS,
		...CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
		...OPENAI_CLASSIFIER_MODELS,
	];
	for (const model of classifierModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].classifier[model.id] ??= model;
	}

	const sortedProviderIds = Object.keys(providers).sort();
	const jsonChatProviders: Record<string, Record<string, Model<Api>>> = {};
	const jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>> = {};
	const jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>> = {};
	const jsonAllProviders: Record<string, AnyModel[]> = {};
	for (const providerId of sortedProviderIds) {
		jsonChatProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].chat).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonImageProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].image).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonClassifierProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].classifier).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonAllProviders[providerId] = [
			...Object.values(jsonChatProviders[providerId]),
			...Object.values(jsonImageProviders[providerId]),
			...Object.values(jsonClassifierProviders[providerId]),
		];
	}

	const serializeJson = (value: unknown) => `${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	const generatedDataProviderIds = generatorOptions.dataOnly
		? readModelDataProviderIds(packageRoot)
		: sortedProviderIds;
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonAllProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// Only the ignored internal data is grouped by API for type derivation.
	const generatedDataProviders: Record<string, Record<string, Record<string, AnyModel>>> = {};
	const modelDataStructure: ModelDataStructure = {};
	for (const providerId of generatedDataProviderIds) {
		const models = jsonAllProviders[providerId];
		generatedDataProviders[providerId] = {};
		modelDataStructure[providerId] = {};
		const apiIds = Array.from(new Set(models.map((model) => model.api))).sort();
		for (const api of apiIds) {
			generatedDataProviders[providerId][api] = {};
			for (const model of models) {
				if (model.api !== api) continue;
				const identity = `${model.type}:${model.id}`;
				if (generatedDataProviders[providerId][api][identity]) {
					throw new Error(`${providerId}/${identity} has duplicate ${api} catalog entries`);
				}
				generatedDataProviders[providerId][api][identity] = model;
				modelDataStructure[providerId][identity] = api;
			}
		}
	}

	const generatedAt = new Date().toISOString();

	if (!generatorOptions.jsonOnly) {
		// The catalog is staged and validated as `check:model-data` will find it, then installed file by file: each
		// file whose bytes changed replaces its old one in one rename, so a process importing the catalog meanwhile never
		// finds the data directory missing or a file empty or half-written. Data files go in before the shards that
		// import them and shards before the aggregator; a removed provider's shard goes before its data file.
		const srcDir = join(packageRoot, "src");
		const providersDir = join(srcDir, "providers");
		const dataDir = join(providersDir, "data");
		const aggregatorPath = join(srcDir, "models.generated.ts");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		// Laid out like the package's src, so the staged catalog is validated as it will stand.
		const stagedSrcDir = join(stagingRoot, "src");
		const stagedProvidersDir = join(stagedSrcDir, "providers");
		const stagedDataDir = join(stagedProvidersDir, "data");
		const stagedAggregatorPath = join(stagedSrcDir, "models.generated.ts");
		const catalogFiles = () => [
			aggregatorPath,
			...readdirSync(providersDir)
				.filter((entry) => entry.endsWith(".models.ts"))
				.map((entry) => join(providersDir, entry)),
			...(existsSync(dataDir) ? readdirSync(dataDir).map((entry) => join(dataDir, entry)) : []),
		];
		let previousCatalog: Map<string, Buffer> | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			for (const providerId of generatedDataProviderIds) {
				const filename = `${providerId}.json`;
				const content = serializeJson(generatedDataProviders[providerId]);
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt, modelDataInputsHash(packageRoot)),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			if (generatorOptions.dataOnly) {
				// The shards and the aggregator stay as they are: the data is validated against them.
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts")) copyFileSync(join(providersDir, entry), join(stagedProvidersDir, entry));
				}
				copyFileSync(aggregatorPath, stagedAggregatorPath);
			} else {
				const generatedHeader = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

`;
				const catalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
				const imageCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_IMAGE_MODELS`;
				const classifierCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CLASSIFIER_MODELS`;
				for (const providerId of sortedProviderIds) {
					let output = generatedHeader;
					output += `import values from "./data/${providerId}.json" with { type: "json" };\n`;
					output += `import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog, type ChatModelCatalog, type ImageModelCatalog, type ClassifierModelCatalog } from "../model-catalog.ts";\n\n`;
					// Keep the JSON attribute in the public type query: declaration emit can drop
					// attributes from value imports retained only for `typeof values` (#3105).
					output += `export const ${catalogConstName(providerId)}: ChatModelCatalog<typeof import("./data/${providerId}.json", { with: { type: "json" } }), ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenChatModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${imageCatalogConstName(providerId)}: ImageModelCatalog<typeof import("./data/${providerId}.json", { with: { type: "json" } }), ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenImageModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${classifierCatalogConstName(providerId)}: ClassifierModelCatalog<typeof import("./data/${providerId}.json", { with: { type: "json" } }), ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenClassifierModelCatalog(${JSON.stringify(providerId)}, values);\n`;
					writeFileSync(join(stagedProvidersDir, `${providerId}.models.ts`), output);
				}
				if (sortedProviderIds.includes("azure")) {
					writeFileSync(join(stagedProvidersDir, "azure-openai-responses.models.ts"), `${generatedHeader}/** @deprecated Use the Azure catalogs from providers/azure.models. */
export {
	AZURE_MODELS as AZURE_OPENAI_RESPONSES_MODELS,
	AZURE_IMAGE_MODELS as AZURE_OPENAI_RESPONSES_IMAGE_MODELS,
	AZURE_CLASSIFIER_MODELS as AZURE_OPENAI_RESPONSES_CLASSIFIER_MODELS,
} from "./azure.models.ts";
`);
				}

				let output = generatedHeader;
				for (const providerId of sortedProviderIds) {
					output += `import { ${classifierCatalogConstName(providerId)}, ${imageCatalogConstName(providerId)}, ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
				}
				output += `\nexport const MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const IMAGE_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${imageCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${imageCatalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const CLASSIFIER_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${classifierCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${classifierCatalogConstName(providerId)},\n`;
				}
				output += `};\n`;
				writeFileSync(stagedAggregatorPath, output);
			}
			validateGeneratedModelData(packageRoot, stagingRoot);

			// A failure while installing puts back the catalog as it was.
			previousCatalog = new Map(catalogFiles().map((path) => [path, readFileSync(path)] as const));
			const dataFiles = moveChangedFiles(stagedDataDir, dataDir);
			if (!generatorOptions.dataOnly) {
				const shards = moveChangedFiles(stagedProvidersDir, providersDir);
				// The aggregator, the only file directly in the staged src.
				moveChangedFiles(stagedSrcDir, srcDir);
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts") && !shards.includes(entry)) removeCatalogFile(join(providersDir, entry));
				}
				console.log("Generated provider catalogs and src/models.generated.ts");
			}
			for (const entry of readdirSync(dataDir)) {
				if (!dataFiles.includes(entry)) removeCatalogFile(join(dataDir, entry));
			}
			previousCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			if (previousCatalog) {
				const restoreDir = join(stagingRoot, "restore");
				mkdirSync(restoreDir, { recursive: true });
				for (const path of catalogFiles()) if (!previousCatalog.has(path)) removeCatalogFile(path);
				for (const [path, content] of previousCatalog) {
					if (existsSync(path) && readFileSync(path).equals(content)) continue;
					const restored = join(restoreDir, basename(path));
					writeFileSync(restored, content);
					replaceFile(restored, path);
				}
			}
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	if (generatorOptions.jsonOutputDir) {
		// `models.json` and `providers/{id}.json` retain the legacy keyed chat catalog.
		// The `.all` variants are arrays so the same upstream id can appear once per type.
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonChatProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "models.all.json"), jsonAllProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonChatProviders[providerId]);
			writeJson(join(providerOutputDir, `${providerId}.all.json`), jsonAllProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter((model) => model.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(
			`  ${provider}: ${Object.keys(models.chat).length} chat models, ${Object.keys(models.image).length} image models, ${Object.keys(models.classifier).length} classifier models`,
		);
	}
}

// Run the generator
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
