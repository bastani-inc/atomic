// A run-journal storage adapter that is not a SqlRunJournal as far as the pool can tell: it hands out an object with
// only the public RunJournal members, each delegating to a SQLite file at `options.path`. Every process that opens it
// reaches the same file, which stands in for a remote database (libSQL, Turso) that all of a pool's processes share.
//
// `options.faults` names a JSON file `{ "failAppends": n }`: the next n `append` calls throw, as an outage would.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { openSqlRunJournal } from "@bastani/atomic/workflows";

const DELEGATED = [
	"createRun",
	"getRun",
	"listRuns",
	"acquire",
	"takeover",
	"takeoverExpired",
	"leaseState",
	"renew",
	"release",
	"readKey",
	"deleteOwnedRun",
	"deleteRun",
];

function fault(file) {
	if (file === undefined) return false;
	let remaining;
	try {
		remaining = JSON.parse(readFileSync(String(file), "utf8")).failAppends;
	} catch {
		return false;
	}
	if (!(remaining > 0)) return false;
	writeFileSync(String(file), JSON.stringify({ failAppends: remaining - 1 }));
	return true;
}

export default {
	atomicStorageAdapter: 1,
	async openRunJournal(options) {
		const inner = await openSqlRunJournal(String(options.path));
		const journal = {
			descriptor: { adapter: "delegating-test", location: String(options.path) },
			async append(lease, event, appendOptions) {
				if (event.type === "CheckpointRecorded" && fault(options.faults)) throw new Error("journal unavailable");
				const outcome = await inner.append(lease, event, appendOptions);
				if (options.log !== undefined)
					appendFileSync(
						String(options.log),
						`${JSON.stringify({ pid: process.pid, type: event.type, key: appendOptions?.key ?? null, status: outcome.status })}\n`,
					);
				return outcome;
			},
			async *read(runId, fromSeq) {
				yield* inner.read(runId, fromSeq);
			},
			close: () => inner.close(),
		};
		for (const name of DELEGATED) journal[name] = (...args) => inner[name](...args);
		return journal;
	},
};
