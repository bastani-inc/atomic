import type { FencedPathId } from "./database.js";

/** What makes a fenced write path correct without the domain's serial lock. */
export interface FencedPathAudit {
	/** The rows the path locks, in the order it locks them (the same order on every fenced path, so none deadlock). */
	readonly fences: readonly string[];
	/** The conformance test that runs the path concurrently on every backend. */
	readonly conformance: string;
}

/**
 * Every audited path that may run a `fenced` transaction. A path is added here, with its fences and its test, in the
 * change that makes it fenced; nothing else can name one.
 */
const FENCED_PATHS = {
	/** `SqlPoolQueue.claim`: one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so claimers never wait on one another. */
	"pool-claim": {
		fences: [
			"root lease row FOR KEY SHARE",
			"root run row FOR SHARE, then pool control",
			"ready work row FOR UPDATE SKIP LOCKED",
		],
		conformance: "many hosts claim, commit and complete concurrently: no double claim, no lost settle (#5102)",
	},
	/** `SqlPoolQueue.renew`, `extend` and `heartbeat`: the attempt's lease, its claim confirmation and usage report. */
	"pool-heartbeat": {
		fences: ["root lease row FOR KEY SHARE", "attempt's work row FOR UPDATE", "root usage totals row"],
		conformance: "claim, commit, heartbeat, complete and takeover run concurrently without a deadlock (#5102)",
	},
	/** `SqlPoolQueue.commit` of a checkpoint or a session: the event takes the run's next sequence under its run row. */
	"pool-commit": {
		fences: [
			"the database-wide serial lock, shared, only when the checkpoint records worktree snapshots (before every row lock)",
			"root lease row FOR KEY SHARE",
			"attempt's work row FOR UPDATE",
			"root run row FOR UPDATE (FOR SHARE without an event), then pool control and the snapshots' stored blobs",
			"root usage totals row",
		],
		conformance: "32 concurrent writers commit one event per key with a dense sequence (#5102)",
	},
	/** `SqlPoolQueue.complete`: the result and the work row's final state. */
	"pool-complete": {
		fences: [
			"root lease row FOR KEY SHARE",
			"attempt's work row FOR UPDATE",
			"root run row FOR SHARE, then pool control",
		],
		conformance: "many hosts claim, commit and complete concurrently: no double claim, no lost settle (#5102)",
	},
	/**
	 * Intercom's broker leases (`openSqlBrokerLeaseStore`): `acquire` is one upsert whose guard takes the row only while
	 * it is free, stale or the acquirer's own, `renew` and `release` one `UPDATE` guarded by holder and fencing token, and
	 * `renewMany` those updates in (kind, key) order. Each decides on its own row lock, never on an earlier read (#6560).
	 * On PostgreSQL a first acquisition takes its order from the lease order sequence, which waits for nothing; where
	 * `atomic storage migrate` has not created it yet, `acquire`'s statement first upserts the acquisition-order counter
	 * row instead, which no other path locks.
	 */
	"intercom-lease": {
		fences: [
			"acquire only, without the order sequence: the acquisition-order counter row, by the statement's own upsert",
			"each lease row, by its own guarded upsert or UPDATE, in (kind, key) order",
		],
		conformance:
			"many brokers acquire, renew and release one lease concurrently: never two holders, fencing tokens strictly increase, a stale holder's renewal fails (#6560)",
	},
	/**
	 * Intercom's wake-up hint log (`intercom_wakeups`): a hint is a row inserted once and deleted by its id or its age,
	 * and no write reads the log to decide what to write, so its writers take no lock domain: the bus's `publish`
	 * inserts a hint and notifies in one transaction that commits both, an outbox enqueue inserts one inside its own
	 * transaction, and the bus's poll and pruning delete rows in single statements (#6560).
	 */
	"intercom-wakeup-hint": {
		fences: ["none: the new hint row only, by its own INSERT"],
		conformance: "delivers each hint published at once from several connections exactly once (#6560)",
	},
	/**
	 * Intercom's outbox rows and sent-message reservations (`openSqlOutboxStore`, `openSqlSentMessageAuthority`), which
	 * left the outbox's one lock domain (#6560). A claim reads its recipient's undelivered rows `FOR UPDATE` in sequence
	 * order, then claims them; a claim's renewal, saving report, release and settlement are each one `UPDATE` guarded by
	 * message id, claimant, token and state; expiry and `releaseClaimsOf` lock their rows in sequence order in a
	 * subquery; a reservation, an acceptance and a forget are each one statement on the message's row, guarded by its
	 * digest. Each decides on the rows it locks, never on an earlier read. They exclude the database-wide transactions an
	 * older broker runs on these tables (`excludesSerial`). A send itself is a serial transaction of its recipient's domain.
	 */
	"intercom-outbox-row": {
		fences: [
			"outbox rows, FOR UPDATE in sequence order (claim, expiry, releaseClaimsOf), or one row by its own guarded UPDATE",
			"one sent-message row, by its own guarded INSERT, UPDATE or DELETE",
		],
		conformance:
			"a send to one recipient does not wait while another recipient's claim holds its rows; sends to one recipient keep their order and suppress duplicates (#6560)",
	},
	/**
	 * `SqlRateBuckets.acquire` and `cooldown`: one `UPDATE … RETURNING` (or upsert) of the scope's bucket row, which locks
	 * no pool row, so it orders after none of them (#4768).
	 */
	"rate-bucket": {
		fences: ["the scope's rate bucket row, by its own UPDATE"],
		conformance: "many hosts acquire from one rate bucket concurrently and never take more than it allows (#4768)",
	},
} as const satisfies Readonly<Record<string, FencedPathAudit>>;

export type FencedPathName = keyof typeof FENCED_PATHS;

/** The audit record of a fenced path. */
export function fencedPathAudit(name: FencedPathName): FencedPathAudit {
	return FENCED_PATHS[name];
}

/** The `FencedPathId` that lets an audited path run `{ kind: "fenced", audit }` transactions. */
export function fencedPath(name: FencedPathName): FencedPathId {
	return name as FencedPathId;
}
