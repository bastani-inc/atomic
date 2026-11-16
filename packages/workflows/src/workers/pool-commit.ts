import type { PoolMutation } from "../durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../durable/types.js";

/**
 * A pooled worker's write: sent to its coordinator, then folded into the worker's read-only root view.
 * #3983: a session append journals no root event, so it resolves once the coordinator has committed it. Folding the
 * root journal after every append (assistant messages, Intercom inbox saves) made each save wait on a catch-up of
 * every other child's events, which outlasted the broker's receipt wait under journal contention.
 */
export function poolWorkerCommit(input: {
	readonly send: (mutation: PoolMutation) => Promise<PoolCommitReceipt>;
	readonly catchUp: () => Promise<void>;
	/** Notes a checkpoint the worker's host accepted and has not shipped yet, which the root's journal lacks (#4768). */
	readonly noteLocal: (checkpoint: DurableCheckpoint) => void;
}): (mutation: PoolMutation) => Promise<PoolCommitReceipt> {
	return async (mutation) => {
		const receipt = await input.send(mutation);
		if (mutation.kind === "session-append") return receipt;
		if (receipt.local === true) input.noteLocal(mutation.checkpoint);
		else await input.catchUp();
		return receipt;
	};
}
