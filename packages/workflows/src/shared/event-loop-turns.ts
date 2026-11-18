import { setImmediate } from "node:timers";

/**
 * Most time one turn of the event loop spends on a run's pending-stage transitions before they yield (#3931). The
 * transitions of a burst of sends, and the compaction of a broadcast's receipts, resolve in microtasks once their
 * reads are in memory, so without a yield one turn ran them all: up to a second on a loaded host. The journal's own
 * operations use the same budget.
 */
export const PENDING_STAGE_TURN_BUDGET_MS = 8;

/** When the current turn's budgeted work began; cleared at the next check phase. */
let turnStartedAt: number | undefined;

/** Yield to the event loop when the current turn has spent its budget; otherwise continue in this turn. */
export async function yieldIfTurnSpent(budgetMs = PENDING_STAGE_TURN_BUDGET_MS): Promise<void> {
	const now = performance.now();
	if (turnStartedAt === undefined) {
		turnStartedAt = now;
		// `node:timers`, so a test that fakes the global timers cannot hold the work behind an immediate it never runs.
		setImmediate(() => {
			turnStartedAt = undefined;
		});
		return;
	}
	if (now - turnStartedAt < budgetMs) return;
	await new Promise<void>((resolve) => setImmediate(resolve));
}
