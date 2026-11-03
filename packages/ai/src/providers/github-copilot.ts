import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { COPILOT_API_VERSION, COPILOT_HEADERS, copilotClientHeaders } from "../api/github-copilot-headers.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import type { OAuthCredential } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { AnyModel, Api, Model } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";
import { THINKING_LEVELS, type ThinkingLevelMap } from "./model-schema.ts";

const GITHUB_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
const GITHUB_COPILOT_MODELS_TIMEOUT_MS = 15_000;
const GITHUB_COPILOT_FAST_ID_SUFFIX = "-fast";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

type GitHubCopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Copilot advertises entitlements as string ID arrays on the OAuth credential; ignore any other shape. */
function advertisedModelIds(value: unknown): ReadonlySet<string> | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return new Set(value);
}

/** A login saved before Copilot model lists were stored, or whose list is malformed, must re-read it. */
function lacksAccountModelList(credential: OAuthCredential): boolean {
	return advertisedModelIds(credential.availableModelIds) === undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Copilot prefers the Messages API, then Responses, then Chat Completions; an entry without a list uses Chat Completions. */
function apiForEndpoints(endpoints: unknown): GitHubCopilotApi | undefined {
	if (endpoints === undefined) return "openai-completions";
	if (!Array.isArray(endpoints)) return undefined;
	if (endpoints.includes("/v1/messages")) return "anthropic-messages";
	if (endpoints.includes("/responses")) return "openai-responses";
	if (endpoints.includes("/chat/completions")) return "openai-completions";
	return undefined;
}

function thinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
	return Object.fromEntries([
		["off", efforts.includes("none") ? "none" : null],
		...THINKING_LEVELS.map((level) => [level, efforts.includes(level) ? level : null]),
	]);
}

interface AccountModelEntry {
	id: string;
	family: string | undefined;
	pickerDisabled: boolean;
	item: Record<string, unknown>;
	capabilities: Record<string, unknown> | undefined;
	supports: Record<string, unknown> | undefined;
}

function accountModelEntries(raw: unknown): AccountModelEntry[] {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) throw new Error("Invalid GitHub Copilot models response");
	const seen = new Set<string>();
	return data.flatMap((rawItem): AccountModelEntry[] => {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (!item || typeof id !== "string" || !id || seen.has(id)) return [];
		seen.add(id);
		const capabilities = asRecord(item.capabilities);
		const supports = asRecord(capabilities?.supports);
		const type = capabilities?.type;
		if (type !== undefined && type !== "chat") return [];
		if (supports?.tool_calls !== true) return [];
		if (asRecord(item.policy)?.state === "disabled") return [];
		const family = capabilities?.family;
		return [
			{
				id,
				family: typeof family === "string" ? family : undefined,
				pickerDisabled: item.model_picker_enabled === false,
				item,
				capabilities,
				supports,
			},
		];
	});
}

/**
 * The account's list does not say which models accept a 24-hour prompt cache, and some models reject
 * the request, so a discovered OpenAI-style model never asks for one. A Messages model the list marks
 * as adaptive receives the selected effort instead of a thinking budget.
 */
function discoveredCompat(
	api: GitHubCopilotApi,
	reasoning: boolean,
	supports: Record<string, unknown> | undefined,
): Model<Api>["compat"] {
	if (api === "openai-completions") {
		return {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoning,
			supportsLongCacheRetention: false,
		};
	}
	if (api === "anthropic-messages") {
		return supports?.adaptive_thinking === true ? { forceAdaptiveThinking: true } : undefined;
	}
	return { supportsLongCacheRetention: false };
}

function discoveredModel(entry: AccountModelEntry): Model<Api> | undefined {
	const api = apiForEndpoints(entry.item.supported_endpoints);
	if (!api) return undefined;
	const limits = asRecord(entry.capabilities?.limits);
	const rawEfforts = entry.supports?.reasoning_effort;
	const efforts = Array.isArray(rawEfforts) ? rawEfforts.filter((effort): effort is string => typeof effort === "string") : [];
	const reasoning = efforts.length > 0;
	const compat = discoveredCompat(api, reasoning, entry.supports);
	return {
		id: entry.id,
		name: entry.id,
		api,
		provider: "github-copilot",
		baseUrl: GITHUB_COPILOT_BASE_URL,
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
		input: entry.supports?.vision === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow:
			positiveInteger(limits?.max_context_window_tokens) ??
			positiveInteger(limits?.max_prompt_tokens) ??
			DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveInteger(limits?.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
		headers: { ...COPILOT_HEADERS },
		...(compat ? { compat } : {}),
		discovered: true,
	};
}

/**
 * Turn a GitHub Copilot `GET /models` response into the chat models the catalog lacks, in the
 * order the account lists them.
 *
 * Every model keeps the exact ID the account advertises as both its ID and its name, and is sent
 * upstream unchanged. An entry is skipped when it is not a chat model, does not support tool calls,
 * has a disabled policy, or is already in the catalog, whose curated entry always wins. An ordinary
 * entry is also skipped when the account hides it from the model picker. A fast entry is offered
 * whenever the account lists it, as Copilot's fast entitlement does, and like every other entry is
 * described by its own row. It carries fast route metadata only when its `capabilities.family`
 * names another model in the catalog, which then becomes its base. Otherwise it is an ordinary model.
 */
export function parseGitHubCopilotDiscoveredModels(raw: unknown, catalog: readonly AnyModel[]): Model<Api>[] {
	const known = new Set<string>();
	for (const model of catalog) if (isModelType(model, "chat")) known.add(model.id);
	const entries = accountModelEntries(raw).filter((entry) => !known.has(entry.id));
	const ordinary = new Set<string>();
	const models = new Map<string, Model<Api>>();
	for (const entry of entries) {
		const isFast = entry.id.endsWith(GITHUB_COPILOT_FAST_ID_SUFFIX);
		if (!isFast && entry.pickerDisabled) continue;
		const model = discoveredModel(entry);
		if (!model) continue;
		models.set(entry.id, model);
		if (!isFast) ordinary.add(entry.id);
	}
	return entries.flatMap((entry): Model<Api>[] => {
		const model = models.get(entry.id);
		if (!model) return [];
		if (ordinary.has(entry.id)) return [model];
		const baseId = entry.family !== entry.id ? entry.family : undefined;
		if (baseId === undefined || !(known.has(baseId) || ordinary.has(baseId))) return [model];
		return [{ ...model, fastRoute: { baseModelId: baseId, upstreamModelId: entry.id } }];
	});
}

async function accountModelListRequest(
	context: RefreshModelsContext,
): Promise<{ token: string; baseUrl: string } | undefined> {
	const credential = context.credential;
	if (credential?.type === "oauth") {
		const auth = await (await loadGitHubCopilotOAuth()).toAuth(credential);
		return auth.apiKey ? { token: auth.apiKey, baseUrl: auth.baseUrl ?? GITHUB_COPILOT_BASE_URL } : undefined;
	}
	if (credential?.type === "api_key" && credential.key) {
		return { token: credential.key, baseUrl: context.baseUrl ?? GITHUB_COPILOT_BASE_URL };
	}
	return undefined;
}

/**
 * Read the account's model list with the effective OAuth or API-key credential and return the chat
 * models `catalog` lacks (see {@link parseGitHubCopilotDiscoveredModels}). An OAuth login reads the
 * host its token names; an API key reads the provider's configured host, the one its requests use.
 * When the host does not let the token read the list (400, 401, 403 or 404), nothing is discovered.
 */
export async function discoverGitHubCopilotModels(
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
): Promise<Model<Api>[]> {
	const request = await accountModelListRequest(context);
	if (!request) return [];
	const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${request.token}`,
			...copilotClientHeaders(request.token),
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(GITHUB_COPILOT_MODELS_TIMEOUT_MS)]),
	});
	if ([400, 401, 403, 404].includes(response.status)) return [];
	if (!response.ok) throw new Error(`GitHub Copilot model list request failed: ${response.status}`);
	return parseGitHubCopilotDiscoveredModels(await response.json(), catalog);
}

export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: GITHUB_COPILOT_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({
				name: "GitHub Copilot",
				isSubscription: true,
				needsRefresh: lacksAccountModelList,
				load: loadGitHubCopilotOAuth,
			}),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		filterModels: (models, credential) => {
			const oauth = credential?.type === "oauth" ? credential : undefined;
			const entitledFastModelIds = advertisedModelIds(oauth?.fastModelIds);
			const availableModelIds = advertisedModelIds(oauth?.availableModelIds);
			return models.filter((model) => {
				// A discovered model comes from the account's own model list, read with this credential at the
				// last catalog refresh. The login's saved lists are read from that same list only when its token
				// is renewed, so they can predate the refresh and must not hide what it found.
				if (model.discovered === true) return true;
				// A fast ID the login lists is entitled whether or not it is a picker entry.
				if (entitledFastModelIds?.has(model.id) === true) return true;
				// Fast-ness comes from the explicit route metadata, never from the `-fast` suffix. A login that
				// lists its fast IDs offers only those.
				if (model.fastRoute !== undefined) return entitledFastModelIds === undefined;
				// A login without a stored model list (an older login) keeps the catalog so it is never left
				// with no models; `Models.refresh()` with network access re-reads the list once (see
				// `needsRefresh`), and the account list applies from then on.
				return availableModelIds?.has(model.id) ?? true;
			});
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
