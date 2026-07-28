/**
 * Borrow a configured fallback model for one compaction planner request.
 *
 * This is deliberately a *weaker* capability than main-chat model fallback.
 * `borrowFallbackPlanner` returns a `BorrowedPlanner` **value**: it holds no
 * session handle, so it cannot write `agent.state.model`, append a model-change
 * entry, change the session thinking level, refresh the system prompt, emit
 * `model_changed`/`model_select`, or call `agent.continue()`.
 * `_trySwitchToFallbackModel` does all of those and is not reused or modified.
 *
 * The attempted-key set is owned by the compaction run, so borrowing never
 * touches the main chat's `_fallbackAttemptedKeys`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { fallbackKey, resolveFallbackModel, type FallbackModelLookup } from "../fallback-models.js";
import type { BorrowedPlanner, PlannerAuth } from "./compaction-types.js";
import { resolvePlannerRequest } from "./range-planner.js";

/**
 * Everything candidate selection needs.
 *
 * The RFC's §5.1 signature takes only `attempted` and `resolveAuth`, which
 * cannot select a candidate on its own: it names no fallback list, no model
 * registry, no preferred provider, and no inherited reasoning level. Those
 * inputs travel in this context object rather than through hidden state.
 */
export interface FallbackPlannerContext {
	/** The session's effective `fallbackModels`, in configured order. */
	readonly fallbackModels: readonly string[];
	/** Model registry used to resolve and authenticate candidates. */
	readonly registry: FallbackModelLookup;
	/** Provider preferred when an unqualified entry is ambiguous. */
	readonly preferredProvider: string | undefined;
	/** Session level inherited when a candidate carries no `:level` suffix. */
	readonly sessionThinkingLevel: ThinkingLevel | undefined;
}

/**
 * Return the next configured fallback model usable for one planner request.
 *
 * Exhaustion returns `undefined` — that is the only exit. It never throws and
 * never falls back to the session model.
 */
export async function borrowFallbackPlanner(
	context: FallbackPlannerContext,
	attempted: ReadonlySet<string>,
	resolveAuth: (model: Model<Api>) => Promise<PlannerAuth | undefined>,
): Promise<BorrowedPlanner | undefined> {
	for (const entry of context.fallbackModels) {
		const candidate = resolveFallbackModel(entry, context.registry, context.preferredProvider);
		if (!candidate) continue;
		const key = fallbackKey(candidate.model, candidate.thinkingLevel);
		if (attempted.has(key)) continue;
		let auth: PlannerAuth | undefined;
		try {
			auth = await resolveAuth(candidate.model);
		} catch {
			// A candidate whose credentials cannot be resolved is simply unusable.
			continue;
		}
		if (!auth) continue;
		return {
			model: candidate.model,
			budget: resolvePlannerRequest(candidate.model, context.sessionThinkingLevel, candidate.thinkingLevel),
			auth,
			key,
		};
	}
	return undefined;
}
