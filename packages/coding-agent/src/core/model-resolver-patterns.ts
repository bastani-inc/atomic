import type { Api, Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isValidThinkingLevel } from "../cli/args.ts";
import { normalizeModelReference } from "./azure-provider-compat.js";
import { defaultModelPerProvider } from "./model-resolver-defaults.ts";

/*
 * Model reference resolution. Candidates are collected before a provider is chosen, so catalog order
 * never decides the provider and an ambiguous match is reported instead of falling through to a
 * weaker one.
 */

export interface ModelReferenceRequest {
	/** Bare model id or `provider/id`, optionally followed by `:<thinking>`. */
	text: string;
	/** Only consider models from this provider. */
	provider?: string;
	/**
	 * A trailing `:<suffix>` is only considered when the full text matches no model, since ids such as
	 * OpenRouter's `qwen/qwen3-coder:exacto` contain colons.
	 * - `none`: the suffix stays part of the id
	 * - `strict`: a valid thinking level is parsed; any other suffix stays part of the id
	 * - `lenient`: like `strict`, but an invalid suffix is dropped with a warning
	 */
	thinkingSuffix: "none" | "strict" | "lenient";
	/** Match id and name substrings when no exact match exists. */
	fuzzy: boolean;
}

export type ModelReferenceResult =
	| { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel; warning?: string }
	| {
			status: "ambiguous";
			candidates: Model<Api>[];
			usableCount: number;
			thinkingLevel?: ThinkingLevel;
			warning?: string;
	  }
	| {
			status: "not-found";
			/** Set when a provider is explicit or named by a `provider/` prefix, for building a custom model id. */
			target?: ModelReferenceTarget;
	  };

export interface ModelReferenceTarget {
	provider: string;
	providerModels: [Model<Api>, ...Model<Api>[]];
	/** Text after the provider prefix as typed, including any `:<suffix>`. */
	modelText: string;
	/** `modelText` without a valid thinking suffix (unless `thinkingSuffix` is `none`). */
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

type ResolvedOrAmbiguous = Exclude<ModelReferenceResult, { status: "not-found" }>;

function splitThinkingSuffix(text: string): { base: string; thinkingLevel: ThinkingLevel } | undefined {
	const colonIndex = text.lastIndexOf(":");
	const suffix = text.substring(colonIndex + 1);
	if (colonIndex <= 0 || !isValidThinkingLevel(suffix)) return undefined;
	return { base: text.substring(0, colonIndex), thinkingLevel: suffix };
}

function splitProviderPrefix(
	text: string,
	models: readonly Model<Api>[],
): { provider: string; modelText: string } | undefined {
	const slashIndex = text.indexOf("/");
	if (slashIndex === -1) return undefined;
	const prefix = text.substring(0, slashIndex).trim().toLowerCase();
	const modelText = text.substring(slashIndex + 1).trim();
	if (!prefix || !modelText) return undefined;
	const provider = models.find((model) => model.provider.toLowerCase() === prefix)?.provider;
	return provider ? { provider, modelText } : undefined;
}

/** Duplicate entries from one provider must not look like several providers. */
function uniqueByReference(models: readonly Model<Api>[]): Model<Api>[] {
	const seen = new Set<string>();
	return models.filter((model) => {
		const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * `usable` only breaks ties between providers, so a unique match resolves even without credentials
 * (`--api-key` first-time setup).
 */
export function resolveModelReference(
	request: ModelReferenceRequest,
	models: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	const text = normalizeModelReference(request.text.trim());
	if (!text) return { status: "not-found" };
	const constraint = request.provider?.toLowerCase();
	const pool = constraint ? models.filter((model) => model.provider.toLowerCase() === constraint) : models;
	const result = resolveText(text, request, pool, usable);
	if (result.status !== "not-found") return result;

	const split = splitProviderPrefix(text, pool);
	const anchor = constraint ? pool[0] : pool.find((model) => model.provider === split?.provider);
	if (!anchor) return result;
	const modelText = split?.modelText ?? text;
	const suffix = request.thinkingSuffix === "none" ? undefined : splitThinkingSuffix(modelText);
	return {
		status: "not-found",
		target: {
			provider: anchor.provider,
			providerModels: [anchor, ...pool.filter((model) => model.provider === anchor.provider && model !== anchor)],
			modelText,
			modelId: suffix?.base ?? modelText,
			thinkingLevel: suffix?.thinkingLevel,
		},
	};
}

/** Exact `provider/id` or bare id lookup without thinking suffixes or fuzzy matching. */
export function findExactModelReferenceMatch(
	modelReference: string,
	models: readonly Model<Api>[],
): Model<Api> | undefined {
	const result = resolveModelReference(
		{ text: modelReference, thinkingSuffix: "none", fuzzy: false },
		models,
		() => true,
	);
	return result.status === "resolved" ? result.model : undefined;
}

function resolveText(
	text: string,
	request: ModelReferenceRequest,
	pool: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	const reference = selectReference(text, pool, request.fuzzy, usable);
	if (reference) return reference;

	if (request.fuzzy) {
		const fuzzy = selectFuzzy(fuzzyMatches(text, pool), usable);
		if (fuzzy) return fuzzy;
	}

	if (request.thinkingSuffix === "none") return { status: "not-found" };
	const thinking = splitThinkingSuffix(text);
	if (thinking) {
		const inner = resolveText(thinking.base, request, pool, usable);
		if (inner.status === "not-found") return inner;
		// An inner warning means an invalid inner suffix, which discards the thinking level
		return { ...inner, thinkingLevel: inner.warning ? undefined : thinking.thinkingLevel };
	}
	// Keep an invalid suffix as part of the id and fail, rather than resolve a different model
	if (request.thinkingSuffix === "strict") return { status: "not-found" };
	const colonIndex = text.lastIndexOf(":");
	if (colonIndex <= 0) return { status: "not-found" };

	const suffix = text.substring(colonIndex + 1);
	const inner = resolveText(text.substring(0, colonIndex), request, pool, usable);
	if (inner.status === "not-found") return inner;
	return {
		...inner,
		thinkingLevel: undefined,
		warning: `Invalid thinking level "${suffix}" in pattern "${text}". Using default instead.`,
	};
}

/**
 * `provider/rest` is only a hint: the whole text may also be a model id on another provider, such as
 * gateway id `zai/glm-5` or commandcode id `xiaomi/mimo-v2.5-pro`. The named provider wins when usable,
 * since that is what the syntax usually means; otherwise a sole usable raw match wins, since the named
 * provider could not serve the request. An unusable named match is still preferred over unusable raw
 * matches, so `--api-key` can set up the named provider.
 */
function selectReference(
	text: string,
	pool: readonly Model<Api>[],
	fuzzy: boolean,
	usable: (provider: string) => boolean,
): ResolvedOrAmbiguous | undefined {
	const lowerText = text.toLowerCase();
	const raw = uniqueByReference(pool.filter((model) => model.id.toLowerCase() === lowerText));
	const split = splitProviderPrefix(text, pool);
	let named: Model<Api> | undefined;
	if (split) {
		const providerModels = pool.filter((model) => model.provider === split.provider);
		const lowerModelText = split.modelText.toLowerCase();
		// The provider's own literal id (OpenRouter's `openrouter/free`) beats its fuzzy matches
		named =
			providerModels.find((model) => model.id.toLowerCase() === lowerModelText) ??
			raw.find((model) => model.provider === split.provider) ??
			(fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels)) : undefined);
	}

	const others = raw.filter((model) => model !== named);
	const candidates = named ? [named, ...others] : others;
	if (candidates.length === 0) return undefined;
	if (new Set(candidates.map((model) => model.provider)).size === 1) {
		return { status: "resolved", model: candidates[0] };
	}
	if (named && usable(named.provider)) return { status: "resolved", model: named };
	const usableOthers = others.filter((model) => usable(model.provider));
	if (usableOthers.length === 1) return { status: "resolved", model: usableOthers[0] };
	if (usableOthers.length === 0 && named) return { status: "resolved", model: named };
	return { status: "ambiguous", candidates, usableCount: usableOthers.length };
}

function fuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const lowerText = text.toLowerCase();
	return models.filter(
		(model) => model.id.toLowerCase().includes(lowerText) || model.name?.toLowerCase().includes(lowerText),
	);
}

function selectFuzzy(matches: Model<Api>[], usable: (provider: string) => boolean): ResolvedOrAmbiguous | undefined {
	if (matches.length === 0) return undefined;
	const multipleProviders = new Set(matches.map((model) => model.provider)).size > 1;
	const usableMatches = multipleProviders ? matches.filter((model) => usable(model.provider)) : [];
	const pool = usableMatches.length > 0 ? usableMatches : matches;
	const best = bestFuzzyMatch(pool);
	if (!best) return undefined;
	// The same id on several providers would otherwise be decided by catalog order
	const tied = uniqueByReference(pool.filter((model) => model.id === best.id));
	if (new Set(tied.map((model) => model.provider)).size === 1) return { status: "resolved", model: best };
	return {
		status: "ambiguous",
		candidates: tied,
		usableCount: usableMatches.length > 0 ? tied.length : 0,
	};
}

/** Prefer aliases (`claude-sonnet-4-5`) over dated versions (`claude-sonnet-4-5-20250929`), then the latest. */
function bestFuzzyMatch(matches: readonly Model<Api>[]): Model<Api> | undefined {
	const aliases = matches.filter((model) => isAlias(model.id));
	return [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function isAlias(id: string): boolean {
	return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

export function buildFallbackModel(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];
	const fallbackContextWindow = baseModel.contextWindow;

	return {
		...baseModel,
		id: modelId,
		name: modelId,
		contextWindow: fallbackContextWindow,
	};
}
