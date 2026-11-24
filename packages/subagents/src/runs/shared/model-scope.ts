import type { ExtensionContext, ScopedModel, Settings } from "@bastani/atomic";
import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { splitKnownThinkingSuffix, splitUnknownThinkingSuffix } from "../../shared/model-info.js";
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

function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`.toLowerCase();
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

/**
 * Resolve the active model scope from the parent session.
 *
 * Uses `ctx.scopedModels` when non-empty (reflecting `--models`, `/scoped-models`, or startup `enabledModels`),
 * falling back to resolving `settings.enabledModels` against the available registry catalog when `ctx.scopedModels`
 * is empty (such as SDK sessions or patterns matching no available model).
 *
 * Returns `undefined` when neither `scopedModels` nor `enabledModels` is configured, leaving all models allowed.
 */
function hasGlobCharacters(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function globMatches(text: string, pattern: string): boolean {
	const t = text.toLowerCase();
	const p = pattern.toLowerCase();
	let ti = 0;
	let pi = 0;
	let starIdx = -1;
	let matchIdx = 0;
	while (ti < t.length) {
		if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
			ti++;
			pi++;
		} else if (pi < p.length && p[pi] === "*") {
			starIdx = pi;
			matchIdx = ti;
			pi++;
		} else if (starIdx !== -1) {
			pi = starIdx + 1;
			matchIdx++;
			ti = matchIdx;
		} else {
			return false;
		}
	}
	while (pi < p.length && p[pi] === "*") pi++;
	return pi === p.length;
}

function matchExactModel(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const normalized = text.trim().toLowerCase();
	if (!normalized) return [];
	if (normalized.includes("/")) {
		return models.filter((model) => modelKey(model.provider, model.id) === normalized);
	}
	return models.filter((model) => model.id.toLowerCase() === normalized);
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
		const trimmed = rawPattern.trim();
		if (!trimmed) continue;
		const exactNoSuffix = matchExactModel(trimmed, models);
		if (exactNoSuffix.length > 0) {
			for (const model of exactNoSuffix) add(model, undefined);
			continue;
		}

		const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(trimmed);
		const thinkingLevel = thinkingSuffix ? (thinkingSuffix.slice(1) as ThinkingLevel) : undefined;
		const exactWithSuffix = matchExactModel(baseModel, models);
		if (exactWithSuffix.length > 0) {
			for (const model of exactWithSuffix) add(model, thinkingLevel);
			continue;
		}

		if (hasGlobCharacters(baseModel)) {
			for (const model of models) {
				if (globMatches(`${model.provider}/${model.id}`, baseModel) || globMatches(model.id, baseModel)) {
					add(model, thinkingLevel);
				}
			}
			continue;
		}

		const needle = baseModel.toLowerCase();
		for (const model of models) {
			if (modelKey(model.provider, model.id).includes(needle) || model.id.toLowerCase().includes(needle)) {
				add(model, thinkingLevel);
			}
		}
	}

	return scopedModels;
}

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
	const normalized = baseModel.toLowerCase();
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
