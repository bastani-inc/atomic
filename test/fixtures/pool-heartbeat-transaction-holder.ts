/**
 * Opens a worker heartbeat's journal transaction and holds it open with its usage already written, for a test to stop
 * or kill this process mid-transaction (#4313). Prints `in-transaction` once the lease renewal and the usage report are
 * written but not committed. Run with Bun: `bun pool-heartbeat-transaction-holder.ts '<json>'`.
 */
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type PoolUsageReport } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";

interface HolderArguments {
	readonly path: string;
	readonly lease: Lease;
	readonly attempt: PoolWork;
	readonly leaseMs: number;
	readonly reports: readonly PoolUsageReport[];
}

const { path, lease, attempt, leaseMs, reports } = JSON.parse(process.argv[2]!) as HolderArguments;
const journal = await SqlRunJournal.open(await openNodeSqliteDatabase(path));
const queue = await openSqlPoolQueue(journal);
const usage = await openSqlPoolUsage(journal);
const record = usage.recording(lease, attempt, reports);
await queue.heartbeat(lease, attempt, leaseMs, async (tx) => {
	const recorded = await record(tx);
	process.stdout.write("in-transaction\n");
	// A timer keeps the process alive; nothing settles the transaction until the test stops or kills it.
	await new Promise<never>(() => setInterval(() => process.stdout.write(""), 60_000));
	return recorded;
});
