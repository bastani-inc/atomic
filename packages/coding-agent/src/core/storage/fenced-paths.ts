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
		fences: ["root lease row FOR SHARE", "root run row FOR SHARE", "ready work row FOR UPDATE SKIP LOCKED"],
		conformance: "many hosts claim, commit and complete concurrently: no double claim, no lost settle (#5102)",
	},
	/** `SqlPoolQueue.renew`, `extend` and `heartbeat`: the attempt's lease, its claim confirmation and usage report. */
	"pool-heartbeat": {
		fences: ["root lease row FOR SHARE", "attempt's work row FOR UPDATE", "root usage totals row"],
		conformance: "claim, commit, heartbeat, complete and takeover run concurrently without a deadlock (#5102)",
	},
	/** `SqlPoolQueue.commit` of a checkpoint or a session: the event takes the run's next sequence under its run row. */
	"pool-commit": {
		fences: [
			"root lease row FOR SHARE",
			"attempt's work row FOR UPDATE",
			"root run row FOR UPDATE (FOR SHARE without an event)",
			"root usage totals row",
		],
		conformance: "32 concurrent writers commit one event per key with a dense sequence (#5102)",
	},
	/** `SqlPoolQueue.complete`: the result and the work row's final state. */
	"pool-complete": {
		fences: ["root lease row FOR SHARE", "attempt's work row FOR UPDATE", "root run row FOR SHARE"],
		conformance: "many hosts claim, commit and complete concurrently: no double claim, no lost settle (#5102)",
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
