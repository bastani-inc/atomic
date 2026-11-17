import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)));
const { ThreadConnection } = await jiti.import(fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite-thread.ts", import.meta.url)));
const { SqlRunJournal } = await jiti.import(fileURLToPath(new URL("../../packages/workflows/src/durable/journal/sql-run-journal.ts", import.meta.url)));
const { openSqlPoolQueue } = await jiti.import(fileURLToPath(new URL("../../packages/workflows/src/durable/journal/sql-pool-queue.ts", import.meta.url)));
const [path, leaseJson, worker] = process.argv.slice(2);
const database = await openNodeSqliteDatabase(path);
const journal = await SqlRunJournal.open(database);
try {
	const pool = await openSqlPoolQueue(journal);
	process.stdout.write("ready\n");
	await new Promise((resolve) => process.stdin.once("data", resolve));
	// Report once this process is contending for the write lock: its first `BEGIN IMMEDIATE`, or, when another
	// writer is already waiting, the ticket it takes in the writers' queue next to the journal (#3978).
	const request = ThreadConnection.prototype.request;
	let claiming = false;
	const report = () => {
		if (claiming) return;
		claiming = true;
		process.stdout.write("claiming\n");
	};
	ThreadConnection.prototype.request = function (next) {
		if (next.kind === "begin") report();
		return request.call(this, next);
	};
	const queued = setInterval(() => {
		try {
			if (readdirSync(`${path}-writers`).some((name) => name.split("-")[1] === String(process.pid))) report();
		} catch {
			// No writer has queued yet.
		}
	}, 5);
	const claim = await pool
		.claim(JSON.parse(leaseJson), worker, [{ definition: "fixture/child", digest: "sha256:child" }], 60_000)
		.finally(() => clearInterval(queued));
	process.stdout.write(`${JSON.stringify(claim ?? null)}\n`);
} finally {
	await journal.close();
	await database.close();
}
