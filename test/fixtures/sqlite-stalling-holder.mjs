// An Atomic connection that takes a database's write lock in a transaction, writes one row, prints "locked" once its
// write-lock record (written in the background as it takes the lock) says so, and then stalls with the lock held:
// "stdin" waits for a line on stdin (the test stops and continues the process meanwhile), "spin:<ms>" blocks its own
// event loop for that long. It then commits and prints "committed". A third argument "slow-record:<ms>" makes every
// write to its write-lock record take that long, and prints "locked" without waiting for the record.
import fs, { readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [path, mode, record] = process.argv.slice(2);
const slowRecordMs = record?.startsWith("slow-record:") ? Number(record.slice("slow-record:".length)) : undefined;
if (slowRecordMs !== undefined) {
	const write = fs.write;
	fs.write = (...args) => setTimeout(() => write(...args), slowRecordMs);
	syncBuiltinESMExports();
}

const jiti = createJiti(import.meta.url, { fsCache: false });
if (slowRecordMs !== undefined) {
	// Route holder-record writes through the main-thread `fs.write` path delayed above so the caller can stop this
	// process after taking the lock and before its "held" record lands.
	const { ThreadConnection } = await jiti.import(
		fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite-thread.ts", import.meta.url)),
	);
	Object.defineProperty(ThreadConnection.prototype, "inTransaction", { get: () => undefined, configurable: true });
}
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const database = await openNodeSqliteDatabase(path);
await database.transaction(async (tx) => {
	await tx.run("CREATE TABLE IF NOT EXISTS stalled_holder(pid INTEGER)");
	await tx.run("INSERT INTO stalled_holder VALUES (?)", process.pid);
	const holders = `${path}-holders`;
	const recordedHeld = () =>
		readdirSync(holders).some(
			(name) => name.startsWith(`${process.pid}-`) && readFileSync(join(holders, name), "utf8").startsWith("held "),
		);
	while (slowRecordMs === undefined && !recordedHeld()) await sleep(1);
	process.stdout.write("locked\n");
	if (mode === "stdin") await new Promise((resolve) => process.stdin.once("data", resolve));
	else {
		const until = Date.now() + Number(mode.slice("spin:".length));
		while (Date.now() < until) {
			// The event loop is starved for the whole stall.
		}
	}
});
process.stdout.write("committed\n");
await database.close();
