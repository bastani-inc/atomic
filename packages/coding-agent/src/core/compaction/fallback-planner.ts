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
 * Identity of one planner attempt: `provider/model:<effective reasoning>`.
 *
 * The key must be derived from the *effective* level the request will carry,
 * not from the raw optional `model:level` suffix. An unsuffixed entry for the
 * session model inherits the session level, so keying it as `provider/model:`
 * would let the identical request run a second time.
 */
export function plannerAttemptKey(planner: BorrowedPlanner): string {
	return fallbackKey(planner.model, planner.budget.reasoning);
}

/**
 * Return the next configured fallback model usable for one planner request.
 *
 * Exhaustion returns `undefined` — that is the only exit. It never throws and
 * never falls back to the session model.
 *
 * `attempted` is the compaction run's own set and is **consumed**: a candidate
 * whose credentials reject or resolve to nothing is recorded before the walk
 * moves on, so a later call cannot resolve its auth a second time or reorder the
 * configured walk around it. Without that, `A(no auth), B, C` would re-inspect
 * `A` on every call and violate RFC §5.3's one ordered pass with at most one
 * auth resolution and one planner request per candidate. The set is run-local;
 * the main chat's `_fallbackAttemptedKeys` is never touched.
 */
export async function borrowFallbackPlanner(
	context: FallbackPlannerContext,
	attempted: Set<string>,
	resolveAuth: (model: Model<Api>) => Promise<PlannerAuth | undefined>,
): Promise<BorrowedPlanner | undefined> {
	for (const entry of context.fallbackModels) {
		const candidate = resolveFallbackModel(entry, context.registry, context.preferredProvider);
		if (!candidate) continue;
		// Resolve the budget first: the attempted key depends on the effective
		// reasoning level, which inheritance may supply.
		const budget = resolvePlannerRequest(candidate.model, context.sessionThinkingLevel, candidate.thinkingLevel);
		const key = fallbackKey(candidate.model, budget.reasoning);
		if (attempted.has(key)) continue;
		let auth: PlannerAuth | undefined;
		try {
			auth = await resolveAuth(candidate.model);
		} catch {
			// A candidate whose credentials cannot be resolved is simply unusable.
			auth = undefined;
		}
		if (!auth) {
			// Consumed: unavailable credentials retire this candidate for the run.
			attempted.add(key);
			continue;
		}
		return { model: candidate.model, budget, auth };
	}
	return undefined;
}
