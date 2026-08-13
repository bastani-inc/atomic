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

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { splitKnownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "./model-info.ts";

/** Registry surface needed to resolve a candidate; satisfied by `ctx.modelRegistry`. */
export interface CandidateModelLookup {
	getAvailable(): Model<Api>[];
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/** A candidate string resolved to a concrete model and its requested thinking level. */
export interface ResolvedCandidateModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve one `provider/model[:thinking]` candidate id against the registry.
 * Returns `undefined` when the candidate names no usable model, which leaves
 * the caller on its previous behavior rather than failing the run.
 */
export type CandidateModelResolver = (candidateId: string) => ResolvedCandidateModel | undefined;

function thinkingLevelFromSuffix(suffix: string): ThinkingLevel | undefined {
	if (!suffix) return undefined;
	const level = suffix.slice(1);
	return THINKING_LEVELS.find((known) => known === level);
}

export function resolveCandidateModel(
	candidateId: string,
	lookup: CandidateModelLookup,
	preferredProvider?: string,
): ResolvedCandidateModel | undefined {
	const trimmed = candidateId.trim();
	if (!trimmed) return undefined;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(trimmed);
	const thinkingLevel = thinkingLevelFromSuffix(thinkingSuffix);
	const slash = baseModel.indexOf("/");
	if (slash < 0) {
		const available = lookup.getAvailable().filter((entry) => entry.id === baseModel);
		const model =
			available.find((entry) => entry.provider === preferredProvider) ??
			(available.length === 1 ? available[0] : undefined);
		if (!model) return undefined;
		return thinkingLevel === undefined ? { model } : { model, thinkingLevel };
	}
	const provider = baseModel.slice(0, slash);
	const modelId = baseModel.slice(slash + 1);
	const model = lookup.find(provider, modelId);
	if (!model || !lookup.hasConfiguredAuth(model)) return undefined;
	return thinkingLevel === undefined ? { model } : { model, thinkingLevel };
}

/** Bind a registry and the parent's provider into a reusable candidate resolver. */
export function createCandidateModelResolver(
	lookup: CandidateModelLookup,
	preferredProvider?: string,
): CandidateModelResolver {
	return (candidateId: string) => resolveCandidateModel(candidateId, lookup, preferredProvider);
}
