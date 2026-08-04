/**
 * Borrow a configured fallback model for one compaction planner request.
 *
 * This is deliberately a *weaker* capability than main-chat model fallback. The
 * borrowing door returns a `BorrowedPlanner` **value**: it holds no session
 * handle, so it cannot write `agent.state.model`, append a model-change entry,
 * change the session thinking level, refresh the system prompt, emit
 * `model_changed`/`model_select`, or call `agent.continue()`.
 * `_trySwitchToFallbackModel` does all of those and is not reused or modified.
 *
 * The attempted-key set belongs to the compaction run and is read-only here, so
 * borrowing never touches the main chat's `_fallbackAttemptedKeys`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type FallbackModelLookup, fallbackKey, resolveFallbackModel } from "../fallback-models.ts";
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
 * Run-local traversal state for one compaction's fallback walk.
 *
 * Kept out of the borrower's arguments and out of module scope: concurrent
 * compactions each own one of these, so nothing is shared.
 */
interface FallbackPlannerWalk {
	/** Next configured list position to inspect. Only ever advances. */
	nextIndex: number;
	/** Effective `provider/model:level` identities already inspected this run. */
	consumed: Set<string>;
}

/** The exact two-argument borrowing door, bound to one run's configuration. */
export type BorrowFallbackPlanner = (
	attempted: ReadonlySet<string>,
	resolveAuth: (model: Model<Api>) => Promise<PlannerAuth | undefined>,
) => Promise<BorrowedPlanner | undefined>;

/**
 * Build the borrowing door for one compaction run.
 *
 * The RFC's top-level two-argument signature names no fallback list, registry,
 * preferred provider, inherited reasoning level, or traversal cursor, so a
 * stateless exported function cannot select a candidate without hidden shared
 * state — unsafe under concurrent compactions. Binding the configuration and the
 * run-local cursor in a closure keeps the returned door exactly two arguments
 * while `attempted` stays a `ReadonlySet` the borrower never writes.
 *
 * The walk is one monotonic pass. Each list position is inspected at most once,
 * whether it fails to resolve, has no usable credentials, duplicates an earlier
 * identity, or yields a planner. Without the cursor, an entry that could not
 * resolve earlier could be returned after a later candidate once the registry
 * changed, producing a B→A order the configured list never asked for.
 */
export function createFallbackPlannerBorrower(context: FallbackPlannerContext): BorrowFallbackPlanner {
	const walk: FallbackPlannerWalk = { nextIndex: 0, consumed: new Set<string>() };
	return async (attempted, resolveAuth) => {
		while (walk.nextIndex < context.fallbackModels.length) {
			const entry = context.fallbackModels[walk.nextIndex];
			// Advance before any work: this list position is spent either way.
			walk.nextIndex += 1;

			const candidate = resolveFallbackModel(entry, context.registry, context.preferredProvider);
			if (!candidate) continue;
			// Resolve the budget first: the identity depends on the effective
			// reasoning level, which inheritance may supply.
			const budget = resolvePlannerRequest(candidate.model, context.sessionThinkingLevel, candidate.thinkingLevel);
			const key = fallbackKey(candidate.model, budget.reasoning);
			if (attempted.has(key) || walk.consumed.has(key)) continue;
			walk.consumed.add(key);

			let auth: PlannerAuth | undefined;
			try {
				auth = await resolveAuth(candidate.model);
			} catch {
				// A candidate whose credentials cannot be resolved is simply unusable.
				auth = undefined;
			}
			if (!auth) continue;
			return { model: candidate.model, budget, auth };
		}
		return undefined;
	};
}
