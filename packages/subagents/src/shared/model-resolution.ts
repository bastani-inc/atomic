/**
 * Resolution of a selected model candidate id to a concrete registry model.
 *
 * `buildModelCandidates` yields `provider/model[:thinking]` strings. Those
 * strings alone never reach the child session: `createAgentSession` takes a
 * `Model<Api>` object, and when no model is supplied it restores the model
 * persisted in the session file. For a fork-context child that file is a copy
 * of the parent's, so the parent's model silently won. Resolving the selected
 * candidate to a real model here is what lets the configured model be handed
 * to the child session instead.
 *
 * The lookup semantics deliberately mirror the SDK's own fallback-entry
 * resolution (`resolveFallbackModel`), so the primary candidate and the
 * fallback candidates handed to the same session agree on what a candidate
 * string means.
 */

import { resolveFallbackModel } from "@bastani/atomic";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { splitUnknownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "./model-info.js";

/** Registry surface needed to resolve a candidate; satisfied by `ctx.modelRegistry`. */
export interface CandidateModelLookup {
	/** Full catalog, including models without configured auth. */
	getAll?(): readonly Model<Api>[];
	getAvailable(): Model<Api>[];
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/** A candidate string resolved to a concrete model and its requested thinking level. */
export interface ResolvedCandidateModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	/**
	 * The word of a `provider/model:word` candidate that names no thinking level, as in `openai/gpt-5.5:extreme`,
	 * when the candidate resolved only without it. The model then runs at its default level, as at any effort it lacks.
	 */
	unknownEffort?: string;
}

/**
 * Resolve one `provider/model[:thinking]` candidate id against the registry.
 * Returns `undefined` when the candidate names no usable model, which leaves
 * the caller on its previous behavior rather than failing the run, except for
 * a candidate ending in a `:word` that names no thinking level: a launch of one
 * fails rather than run another model.
 */
export interface CandidateModelResolver {
	(candidateId: string): ResolvedCandidateModel | undefined;
	/** Present when the host exposes the full catalog; for refusal diagnostics only. */
	getCatalog?: () => readonly Model<Api>[];
}

/** Resolve a name exactly as a settings `fallbackModels` entry or `--model` is resolved (#5046). */
function findCandidateModel(
	name: string,
	lookup: CandidateModelLookup,
	preferredProvider: string | undefined,
): ResolvedCandidateModel | undefined {
	const models = lookup.getAvailable().filter((model) => lookup.hasConfiguredAuth(model));
	const resolved = resolveFallbackModel(
		name,
		{ getModels: () => models, hasConfiguredAuth: () => true },
		preferredProvider,
	);
	if (!resolved) return undefined;
	const thinkingLevel = THINKING_LEVELS.find((level) => level === resolved.thinkingLevel);
	return thinkingLevel === undefined ? { model: resolved.model } : { model: resolved.model, thinkingLevel };
}

export function resolveCandidateModel(
	candidateId: string,
	lookup: CandidateModelLookup,
	preferredProvider?: string,
): ResolvedCandidateModel | undefined {
	const trimmed = candidateId.trim();
	if (!trimmed) return undefined;
	const resolved = findCandidateModel(trimmed, lookup, preferredProvider);
	if (resolved) return resolved;
	// A model id may end in `:word` itself, so the word is an effort no level names only when the whole id is no model.
	const unknown = splitUnknownThinkingSuffix(trimmed);
	if (!unknown) return undefined;
	const base = findCandidateModel(unknown.baseModel, lookup, preferredProvider);
	return base && base.thinkingLevel === undefined ? { model: base.model, unknownEffort: unknown.effort } : undefined;
}

/** Bind a registry and the parent's provider into a reusable candidate resolver. */
export function createCandidateModelResolver(
	lookup: CandidateModelLookup,
	preferredProvider?: string,
): CandidateModelResolver {
	const resolve: CandidateModelResolver = (candidateId) =>
		resolveCandidateModel(candidateId, lookup, preferredProvider);
	if (typeof lookup.getAll === "function") resolve.getCatalog = lookup.getAll.bind(lookup);
	return resolve;
}
