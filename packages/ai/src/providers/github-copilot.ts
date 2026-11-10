import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import {
	COPILOT_API_VERSION,
	COPILOT_HEADERS,
	copilotClientHeaders,
	preserveCopilotIntegrationHeader,
} from "../api/github-copilot-headers.js";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.js";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import type { OAuthCredential } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { AnyModel, Api, Model, ProviderClassifier } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.js";
import { isModelType } from "../utils/model-operations.ts";
import { GITHUB_COPILOT_CLASSIFIER_MODELS, GITHUB_COPILOT_MODELS } from "./github-copilot.models.js";
import {
	GITHUB_COPILOT_INDIVIDUAL_BASE_URL as GITHUB_COPILOT_BASE_URL,
	parseGitHubCopilotAccountModelLists,
} from "./github-copilot-account.ts";
import type { GitHubCopilotApi } from "./github-copilot-capabilities.ts";
import { THINKING_LEVELS, type ThinkingLevelMap } from "./model-schema.ts";

const GITHUB_COPILOT_MODELS_TIMEOUT_MS = 15_000;
const GITHUB_COPILOT_FAST_ID_SUFFIX = "-fast";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
/** Atomic's default cap on a resized image's base64 payload, which an account's own image limit may lower. */
const DEFAULT_MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

/** Copilot advertises entitlements as string ID arrays on the stored credential; ignore any other shape. */
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
 * the request, so a discovered OpenAI-style model never asks for one. Its tool schemas are strict only
 * when the entry lists `structured_outputs`. A Messages model the list marks as adaptive receives the
 * selected effort instead of a thinking budget.
 */
function discoveredCompat(
	api: GitHubCopilotApi,
	reasoning: boolean,
	supports: Record<string, unknown> | undefined,
): Model<Api>["compat"] {
	const supportsStrictMode = supports?.structured_outputs === true;
	if (api === "openai-completions") {
		return {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoning,
			supportsLongCacheRetention: false,
			supportsStrictMode,
		};
	}
	if (api === "anthropic-messages") {
		return supports?.adaptive_thinking === true ? { forceAdaptiveThinking: true } : undefined;
	}
	return { supportsLongCacheRetention: false, supportsStrictMode };
}

/** Image limits from the entry's `limits.vision`: images per request, and a resize cap from the per-image byte limit. */
function discoveredImageLimits(limits: Record<string, unknown> | undefined): Model<Api>["inputLimits"] {
	const vision = asRecord(limits?.vision);
	const maxPerRequest = positiveInteger(vision?.max_prompt_images);
	const maxImageBytes = positiveInteger(vision?.max_prompt_image_size);
	if (maxPerRequest === undefined && maxImageBytes === undefined) return undefined;
	const base64Bytes = maxImageBytes === undefined ? undefined : Math.ceil(maxImageBytes / 3) * 4;
	return {
		images: {
			...(maxPerRequest === undefined ? {} : { maxPerRequest }),
			...(base64Bytes === undefined
				? {}
				: { resize: { maxBytes: Math.min(base64Bytes, DEFAULT_MAX_IMAGE_BASE64_BYTES) } }),
		},
	};
}

/** The display name the account's entry advertises, or its ID when the entry has no usable one. */
function discoveredName(entry: AccountModelEntry): string {
	const name = entry.item.name;
	return typeof name === "string" && name.trim() ? name.trim() : entry.id;
}

function discoveredModel(entry: AccountModelEntry): Model<Api> | undefined {
	const api = apiForEndpoints(entry.item.supported_endpoints);
	if (!api) return undefined;
	const limits = asRecord(entry.capabilities?.limits);
	const rawEfforts = entry.supports?.reasoning_effort;
	const efforts = Array.isArray(rawEfforts)
		? rawEfforts.filter((effort): effort is string => typeof effort === "string")
		: [];
	const reasoning = efforts.length > 0;
	const compat = discoveredCompat(api, reasoning, entry.supports);
	const vision = entry.supports?.vision === true;
	const inputLimits = vision ? discoveredImageLimits(limits) : undefined;
	return {
		id: entry.id,
		name: discoveredName(entry),
		api,
		provider: "github-copilot",
		baseUrl: GITHUB_COPILOT_BASE_URL,
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
		input: vision ? ["text", "image"] : ["text"],
		...(inputLimits ? { inputLimits } : {}),
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
 * Every model keeps the exact ID the account advertises, which is sent upstream unchanged, and takes
 * the entry's display name as its name, or its ID when the entry has none. An entry is skipped when it
 * is not a chat model, does not support tool calls, has a disabled policy, or is already in the
 * catalog, whose curated entry always wins. An ordinary entry is also skipped when the account hides
 * it from the model picker. A fast entry is offered
 * whenever the account lists it, as Copilot's fast entitlement does, and like every other entry is
 * described by its own row. It carries fast route metadata only when its `capabilities.family`
 * names another model in the catalog, which then becomes its base. Otherwise it is an ordinary model.
 */
export function parseGitHubCopilotDiscoveredModels(raw: unknown, catalog: readonly AnyModel[]): Model<Api>[] {
	const known = new Set<string>();
	for (const model of catalog) known.add(model.id);
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

/** Whether a credential's saved list names exactly these IDs. */
function savesSameIds(saved: unknown, ids: readonly string[]): boolean {
	const savedIds = advertisedModelIds(saved);
	return savedIds !== undefined && savedIds.size === new Set(ids).size && ids.every((id) => savedIds.has(id));
}

/**
 * Save to the OAuth login or API key that read an account's list the model lists it keeps, parsed from
 * that response. A login otherwise renews them only with its token, so a refresh with a still-valid token
 * could discover a model the login's older lists hide; a key has no other way to learn them.
 *
 * A key whose list names no usable model keeps what it saved before: hiding every model on a list that
 * may not be the account's real one would leave nothing to select.
 */
async function saveAccountModelLists(context: RefreshModelsContext, raw: unknown, baseUrl: string): Promise<void> {
	if (!context.updateCredential) return;
	const { availableModelIds, fastModelIds } = parseGitHubCopilotAccountModelLists(raw, baseUrl);
	if (context.credential?.type === "api_key" && availableModelIds.length === 0) return;
	await context.updateCredential((current) =>
		savesSameIds(current.availableModelIds, availableModelIds) && savesSameIds(current.fastModelIds, fastModelIds)
			? undefined
			: { ...current, availableModelIds, fastModelIds },
	);
}

/** The account's `GET /models` response and the host that answered it, or undefined when the host refuses the token. */
async function readAccountModelList(
	context: RefreshModelsContext,
): Promise<{ raw: unknown; baseUrl: string } | undefined> {
	const request = await accountModelListRequest(context);
	if (!request) return undefined;
	const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${request.token}`,
			...copilotClientHeaders(request.token),
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(GITHUB_COPILOT_MODELS_TIMEOUT_MS)]),
	});
	if ([400, 401, 403, 404].includes(response.status)) return undefined;
	if (!response.ok) throw new Error(`GitHub Copilot model list request failed: ${response.status}`);
	return { raw: await response.json(), baseUrl: request.baseUrl };
}

/**
 * Read the account's model list with the effective OAuth or API-key credential and return the chat
 * models `catalog` lacks (see {@link parseGitHubCopilotDiscoveredModels}). An OAuth login reads the
 * host its token names; an API key reads the provider's configured host, the one its requests use.
 *
 * Returns undefined when the list cannot be read: without a usable credential, or when the host
 * refuses the token (400, 401, 403 or 404). That is not an empty list, so a caller keeps the models it
 * found before. Other failures throw.
 *
 * The model lists that decide what the login or stored API key is offered are renewed from the same
 * response through `context.updateCredential`, so what a refresh discovers is offered at once. Nothing
 * is saved when the list cannot be read, so a credential that never had lists hides no model.
 */
export async function discoverGitHubCopilotModels(
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
): Promise<Model<Api>[] | undefined> {
	const list = await readAccountModelList(context);
	if (!list) return undefined;
	const models = parseGitHubCopilotDiscoveredModels(list.raw, catalog);
	await saveAccountModelLists(context, list.raw, list.baseUrl);
	return models;
}

/**
 * Renew only the model lists of a stored API key, which a provider alias of GitHub Copilot uses to
 * filter by its own account. The alias has no catalog of its own to publish, so this reads and saves
 * the lists and returns nothing. An alias's OAuth login keeps the lists it saved when it signed in or
 * renewed its token.
 */
export async function refreshGitHubCopilotAccountModelLists(context: RefreshModelsContext): Promise<void> {
	if (!context.allowNetwork || context.credential?.type !== "api_key") return;
	const list = await readAccountModelList(context);
	if (list) await saveAccountModelLists(context, list.raw, list.baseUrl);
}

/** Copilot's account endpoint has no version prefix, but System One requires it. */
function copilotSystemOne(classifier: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) => {
			const defaults = copilotClientHeaders(options?.apiKey ?? "");
			const integration = { "Copilot-Integration-Id": defaults["Copilot-Integration-Id"]! };
			const headers = providerHeadersToRecord(defaults, model.headers, options?.headers);
			return classifier.classify(
				{
					...model,
					baseUrl: `${model.baseUrl.replace(/\/+$/u, "")}/v1`,
				},
				context,
				{
					...options,
					headers: providerHeadersToRecord(headers, preserveCopilotIntegrationHeader(headers, integration)),
				},
			);
		},
	};
}

export function githubCopilotProvider(): Provider<GitHubCopilotApi> {
	return createProvider<GitHubCopilotApi>({
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
		models: [...Object.values(GITHUB_COPILOT_MODELS), ...Object.values(GITHUB_COPILOT_CLASSIFIER_MODELS)],
		filterModels: (models, credential) => {
			const entitledFastModelIds = advertisedModelIds(credential?.fastModelIds);
			const availableModelIds = advertisedModelIds(credential?.availableModelIds);
			return models.filter((model) => {
				// Picker entitlements list chat models, not classifiers.
				if (isModelType(model, "classifier")) return true;
				// The saved lists of the login or API key decide for every model, discovered ones included:
				// discovered models are cached per provider, not per credential. A refresh that reads the
				// account's list renews the lists of the same credential (see `discoverGitHubCopilotModels`), so
				// they never predate what it found.
				// A fast ID the credential lists is entitled whether or not it is a picker entry.
				if (entitledFastModelIds?.has(model.id) === true) return true;
				// Fast-ness comes from the explicit route metadata, never from the `-fast` suffix. A credential
				// that lists its fast IDs offers only those; without such a list, the account's own model list
				// already decided which fast models exist.
				if (model.fastRoute !== undefined) return entitledFastModelIds === undefined;
				// A credential without a saved model list (an older login, or a key whose list was never read,
				// is refused or comes from the environment) keeps the catalog so it is never left with no models;
				// `Models.refresh()` with network access reads the list (see `needsRefresh` and
				// `discoverGitHubCopilotModels`), and the account list applies from then on.
				return availableModelIds?.has(model.id) ?? true;
			});
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
		classifiers: { "typesafe-system-one": copilotSystemOne(typesafeSystemOneApi()) },
	});
}
