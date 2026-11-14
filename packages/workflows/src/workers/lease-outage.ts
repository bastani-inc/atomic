import { setTimeout as delay } from "node:timers/promises";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";

/** The first bound on the wait before a request the storage refused is sent again; each later one doubles. */
const OUTAGE_RETRY_BASE_MS = 50;
/** The largest bound on that wait. */
const OUTAGE_RETRY_MAX_MS = 1_000;
/**
 * Codes, from SQLite, a database server or the network, of a request the store refused only for a while: its lock
 * was busy, it ended the request's stream or transaction, or it could not be reached. Any other such code (a value or
 * a response too large, a constraint, a corrupt file) fails again the same way, so its request is not sent again.
 */
const PASSING_CODES = /^(SQLITE_(BUSY|LOCKED)|TRANSACTION_TIMEOUT|STREAM_EXPIRED|E[A-Z]+$|UND_ERR_)/;
/** A code as SQLite, a database server or Node writes one, as opposed to Atomic's own lower-case codes. */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]+$/;

/** Whether `error` is the store refusing for a while (unreachable, or its lock busy), not a statement it cannot run. */
function refusedForAWhile(error: unknown): boolean {
	if (infrastructureFaultOf(error) !== "storage_unavailable") return false;
	for (let current = error, depth = 0; typeof current === "object" && current !== null && depth < 8; depth++) {
		const { code, cause } = current as { readonly code?: unknown; readonly cause?: unknown };
		if (typeof code === "string" && SYSTEM_CODE.test(code) && !PASSING_CODES.test(code)) return false;
		current = cause;
	}
	return true;
}

/**
 * How long a request is sent again before the attempt gives up and hands its child to another host (#4768): a lease
 * that stays live while its attempt makes no progress would hold the child forever.
 */
export const OUTAGE_HANDOFF_MS = 120_000;
/** How long a request is sent again before the process says so once, on stderr, with the store's last refusal. */
const OUTAGE_NOTICE_MS = 30_000;

/**
 * Sends `send` again while the storage refuses it (`storage_unavailable`: unreachable, or its write lock stayed busy)
 * and `leaseLeft()` says the attempt still holds its lease, waiting a random time up to a bound that doubles from
 * `OUTAGE_RETRY_BASE_MS` to `OUTAGE_RETRY_MAX_MS` between sends (#4768). Contention on a shared store slows a pooled
 * child down this way instead of ending its attempt, which would spend one of the child's retries on a fault that is
 * not its own. Any other failure, a statement the database cannot run included, or one past the lease, goes to the
 * caller.
 */
export async function retryWithinLease<T>(
	send: () => Promise<T>,
	leaseLeft: () => boolean,
	/** What `send` sends, as a notice names it. */
	what = "a request",
	/** How long to keep sending; past it the last refusal goes to the caller. */
	giveUpMs = Number.POSITIVE_INFINITY,
): Promise<T> {
	const started = performance.now();
	let noticed = false;
	for (let attempt = 0; ; attempt++) {
		try {
			return await send();
		} catch (error) {
			if (!refusedForAWhile(error) || !leaseLeft() || performance.now() - started >= giveUpMs) throw error;
			if (!noticed && performance.now() - started >= OUTAGE_NOTICE_MS) {
				noticed = true;
				process.stderr.write(
					`atomic-workflows: the shared store has refused ${what} for ${Math.round((performance.now() - started) / 1000)} s; still retrying: ${String((error as Error)?.stack ?? error)}\n`,
				);
			}
		}
		await delay(Math.random() * Math.min(OUTAGE_RETRY_MAX_MS, OUTAGE_RETRY_BASE_MS * 2 ** Math.min(attempt, 16)));
	}
}
