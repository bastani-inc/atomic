import type { ExtensionContext, ScopedModel, Settings } from "@bastani/atomic";
import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { splitKnownThinkingSuffix, splitUnknownThinkingSuffix, THINKING_LEVELS } from "../../shared/model-info.js";
import { type AvailableModelInfo, resolveModelCandidate } from "./model-fallback.js";

/** Active model allowlist resolved from the parent session's `scopedModels` / `--models` / `enabledModels`. */
export interface ResolvedModelScope {
	/** Concrete models allowed by the session scope (may be empty when configured patterns matched no available model). */
	readonly scopedModels: readonly ScopedModel[];
	/** Canonical `provider/id` entries for allowed models. */
	readonly allowedFullIds: readonly string[];
}

export type ModelScopeContext = Pick<ExtensionContext, "modelRegistry"> & {
	readonly scopedModels?: readonly ScopedModel[];
};

const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
const CANONICAL_AZURE_PROVIDER = "azure";

type GlobToken =
	| { readonly kind: "star" }
	| { readonly kind: "any" }
	| { readonly kind: "literal"; readonly char: string }
	| {
			readonly kind: "class";
			readonly negated: boolean;
			readonly chars: ReadonlySet<string>;
			readonly ranges: ReadonlyArray<readonly [string, string]>;
	  };

function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`.toLowerCase();
}

function normalizeProviderReference(raw: string): string {
	const trimmed = raw.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex === -1) return trimmed;
	const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
	if (provider !== LEGACY_AZURE_PROVIDER) return trimmed;
	return `${CANONICAL_AZURE_PROVIDER}/${trimmed.slice(slashIndex + 1).trim()}`;
}

function buildScope(scopedModels: readonly ScopedModel[]): ResolvedModelScope {
	const seen = new Set<string>();
	const allowedFullIds: string[] = [];
	for (const entry of scopedModels) {
		const fullId = `${entry.model.provider}/${entry.model.id}`;
		const key = fullId.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		allowedFullIds.push(fullId);
	}
	return { scopedModels, allowedFullIds };
}

function hasGlobCharacters(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function compileGlob(pattern: string): GlobToken[] {
	const lower = pattern.toLowerCase();
	const tokens: GlobToken[] = [];
	let i = 0;
	while (i < lower.length) {
		const ch = lower[i]!;
		if (ch === "*") {
			if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
			i++;
			continue;
		}
		if (ch === "?") {
			tokens.push({ kind: "any" });
			i++;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			let negated = false;
			if (j < lower.length && (lower[j] === "!" || lower[j] === "^")) {
				negated = true;
				j++;
			}
			if (j < lower.length && lower[j] === "]") j++;
			const closeIdx = lower.indexOf("]", j);
			if (closeIdx !== -1) {
				const chars = new Set<string>();
				const ranges: Array<readonly [string, string]> = [];
				let k = i + 1 + (negated ? 1 : 0);
				while (k < closeIdx) {
					if (k + 2 < closeIdx && lower[k + 1] === "-") {
						ranges.push([lower[k]!, lower[k + 2]!]);
						k += 3;
					} else {
						chars.add(lower[k]!);
						k++;
					}
				}
				tokens.push({ kind: "class", negated, chars, ranges });
				i = closeIdx + 1;
				continue;
			}
		}
		tokens.push({ kind: "literal", char: ch });
		i++;
	}
	return tokens;
}

function tokenMatchesChar(token: GlobToken, ch: string): boolean {
	if (token.kind === "any") return true;
	if (token.kind === "literal") return token.char === ch;
	if (token.kind === "class") {
		let matched = token.chars.has(ch);
		if (!matched) {
			for (const [start, end] of token.ranges) {
				if (ch >= start && ch <= end) {
					matched = true;
					break;
				}
			}
		}
		return token.negated ? !matched : matched;
	}
	return false;
}

function globMatches(text: string, tokens: readonly GlobToken[]): boolean {
	const lower = text.toLowerCase();
	const tokenCount = tokens.length;
	let prev = new Array<boolean>(tokenCount + 1).fill(false);
	prev[0] = true;
	for (let j = 1; j <= tokenCount; j++) {
		if (tokens[j - 1]!.kind === "star") prev[j] = prev[j - 1]!;
	}
	for (let i = 0; i < lower.length; i++) {
		const ch = lower[i]!;
		const next = new Array<boolean>(tokenCount + 1).fill(false);
		for (let j = 1; j <= tokenCount; j++) {
			const token = tokens[j - 1]!;
			if (token.kind === "star") {
				next[j] = next[j - 1]! || prev[j]!;
			} else if (prev[j - 1]! && tokenMatchesChar(token, ch)) {
				next[j] = true;
			}
		}
		prev = next;
	}
	return prev[tokenCount]!;
}

function parseTrailingThinking(pattern: string): { base: string; thinkingLevel?: ThinkingLevel } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= 0) return { base: pattern };
	const rawSuffix = pattern.slice(colonIdx + 1).toLowerCase();
	const level = THINKING_LEVELS.find((candidate) => candidate === rawSuffix);
	if (!level) return { base: pattern };
	return { base: pattern.slice(0, colonIdx), thinkingLevel: level };
}

function matchExactModels(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const lower = text.trim().toLowerCase();
	if (!lower) return [];
	const raw = models.filter((model) => model.id.toLowerCase() === lower);
	const slash = lower.indexOf("/");
	if (slash === -1) return raw;
	const provider = lower.slice(0, slash).trim();
	const id = lower.slice(slash + 1).trim();
	const qualified = models.filter(
		(model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id,
	);
	if (qualified.length > 0) return qualified;
	return raw;
}

function isAlias(id: string): boolean {
	return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

function bestFuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const lower = text.trim().toLowerCase();
	if (!lower) return [];
	const slash = lower.indexOf("/");
	let pool = models;
	let query = lower;
	if (slash > 0) {
		const provider = lower.slice(0, slash).trim();
		const providerModels = models.filter((model) => model.provider.toLowerCase() === provider);
		if (providerModels.length > 0) {
			pool = providerModels;
			query = lower.slice(slash + 1).trim();
		}
	}
	if (!query) return [];
	const matches = pool.filter(
		(model) => model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query),
	);
	if (matches.length === 0) return [];
	const aliases = matches.filter((model) => isAlias(model.id));
	const ranked = [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id));
	const bestId = ranked[0]!.id;
	return ranked.filter((model) => model.id === bestId);
}

function resolveEnabledModelPatterns(patterns: readonly string[], models: readonly Model<Api>[]): ScopedModel[] {
	const scopedModels: ScopedModel[] = [];
	const seen = new Set<string>();
	const add = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined) => {
		const key = modelKey(model.provider, model.id);
		if (seen.has(key)) return;
		seen.add(key);
		scopedModels.push({ model, thinkingLevel });
	};

	for (const rawPattern of patterns) {
		const pattern = normalizeProviderReference(rawPattern);
		if (!pattern) continue;

		const exact = matchExactModels(pattern, models);
		if (exact.length > 0) {
			for (const model of exact) add(model, undefined);
			continue;
		}

		if (hasGlobCharacters(pattern)) {
			const { base, thinkingLevel } = parseTrailingThinking(pattern);
			const exactBase = matchExactModels(base, models);
			if (exactBase.length > 0) {
				for (const model of exactBase) add(model, thinkingLevel);
				continue;
			}
			const tokens = compileGlob(base);
			for (const model of models) {
				if (globMatches(`${model.provider}/${model.id}`, tokens) || globMatches(model.id, tokens)) {
					add(model, thinkingLevel);
				}
			}
			continue;
		}

		const { base, thinkingLevel } = parseTrailingThinking(pattern);
		const exactWithSuffix = matchExactModels(base, models);
		if (exactWithSuffix.length > 0) {
			for (const model of exactWithSuffix) add(model, thinkingLevel);
			continue;
		}

		const fuzzy = bestFuzzyMatches(base, models);
		if (fuzzy.length > 0) {
			for (const model of fuzzy) add(model, thinkingLevel);
			continue;
		}

		const colonIdx = pattern.lastIndexOf(":");
		if (colonIdx > 0 && thinkingLevel === undefined) {
			const stripped = pattern.slice(0, colonIdx);
			const exactStripped = matchExactModels(stripped, models);
			const fallbackMatches = exactStripped.length > 0 ? exactStripped : bestFuzzyMatches(stripped, models);
			for (const model of fallbackMatches) add(model, undefined);
		}
	}

	return scopedModels;
}

/**
 * Resolve the active model scope from the parent session.
 *
 * Uses `ctx.scopedModels` when non-empty (reflecting `--models`, `/scoped-models`, or startup `enabledModels`),
 * falling back to resolving `settings.enabledModels` against the available registry catalog when `ctx.scopedModels`
 * is empty (such as SDK sessions or patterns matching no available model).
 *
 * Returns `undefined` when neither `scopedModels` nor `enabledModels` is configured, leaving all models allowed.
 */
export function resolveSessionModelScope(
	ctx: ModelScopeContext,
	settings?: Pick<Settings, "enabledModels">,
): ResolvedModelScope | undefined {
	if (ctx.scopedModels && ctx.scopedModels.length > 0) {
		return buildScope(ctx.scopedModels);
	}
	const patterns = settings?.enabledModels;
	if (!patterns || patterns.length === 0) return undefined;
	const available = ctx.modelRegistry?.getAvailable() ?? [];
	return buildScope(resolveEnabledModelPatterns(patterns, available));
}

/** Filter a model list to the active scope, or return all models unchanged when `scope` is undefined. */
export function filterModelsByScope<T extends { readonly provider: string; readonly id: string }>(
	models: readonly T[],
	scope: ResolvedModelScope | undefined,
): T[] {
	if (scope === undefined) return [...models];
	const allowed = new Set(scope.allowedFullIds.map((entry) => entry.toLowerCase()));
	return models.filter((model) => allowed.has(modelKey(model.provider, model.id)));
}

function matchesAllowedSets(
	baseModel: string,
	allowedFullSet: ReadonlySet<string>,
	allowedIdSet: ReadonlySet<string>,
): boolean {
	const normalized = normalizeProviderReference(baseModel).toLowerCase();
	if (normalized.includes("/")) return allowedFullSet.has(normalized);
	return allowedIdSet.has(normalized);
}

/**
 * Return whether a candidate string (`provider/id[:thinking]` or bare `id[:thinking]`) is permitted by `allowedFullIds`.
 */
export function isModelCandidateAllowed(candidate: string, allowedFullIds: readonly string[]): boolean {
	const trimmed = candidate.trim();
	if (!trimmed) return false;
	const allowedFullSet = new Set(allowedFullIds.map((entry) => entry.toLowerCase()));
	const allowedIdSet = new Set(
		allowedFullIds.map((entry) => {
			const slash = entry.indexOf("/");
			return (slash > 0 ? entry.slice(slash + 1) : entry).toLowerCase();
		}),
	);
	const { baseModel } = splitKnownThinkingSuffix(trimmed);
	if (matchesAllowedSets(baseModel, allowedFullSet, allowedIdSet)) return true;
	const unknown = splitUnknownThinkingSuffix(baseModel);
	return unknown !== undefined && matchesAllowedSets(unknown.baseModel, allowedFullSet, allowedIdSet);
}

/** Check exact catalog IDs, including unauthenticated or ambiguous matches, before reporting a model as unknown. */
export function isModelCandidateInCatalog(candidate: string, catalog: readonly Model<Api>[]): boolean {
	const { baseModel } = splitKnownThinkingSuffix(candidate);
	const matches = (id: string) => {
		const raw = id.toLowerCase();
		const qualified = normalizeProviderReference(id).toLowerCase();
		return catalog.some(
			(model) => model.id.toLowerCase() === raw || modelKey(model.provider, model.id) === qualified,
		);
	};
	if (matches(candidate) || (baseModel !== candidate && matches(baseModel))) return true;
	const unknown = splitUnknownThinkingSuffix(baseModel);
	return unknown !== undefined && matches(unknown.baseModel);
}

/** Explain a scope refusal, with the smallest settings change when its base model is already allowed. */
export function modelOutsideScopeReason(model: Model<Api> | undefined, isAllowed: (fullId: string) => boolean): string {
	const reason = "model is outside the session's enabledModels scope";
	if (!model?.fastRoute) return `${reason}.`;
	const baseFullId = `${model.provider}/${model.fastRoute.baseModelId}`;
	if (!isAllowed(baseFullId)) return `${reason}.`;
	return `${reason}; its base model ${baseFullId} is in scope. Add ${JSON.stringify(`${model.provider}/${model.id}`)} to enabledModels.`;
}

/**
 * Resolve a model candidate string while preferring models in the active scope for bare model IDs.
 * Falls back to the full available catalog when no scoped model matches so disallowed models still
 * resolve to `provider/id` for clear refusal diagnostics.
 */
export function resolveScopedModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	scope: ResolvedModelScope | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (scope !== undefined && !model.includes("/") && availableModels && availableModels.length > 0) {
		const scopedAvailable = filterModelsByScope(availableModels, scope);
		const scopedResolved = resolveModelCandidate(model, scopedAvailable, preferredProvider);
		if (scopedResolved?.includes("/")) return scopedResolved;
	}
	return resolveModelCandidate(model, availableModels, preferredProvider);
}
