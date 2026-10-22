import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)));
const { SqlRunJournal } = await jiti.import(fileURLToPath(new URL("../../packages/workflows/src/durable/journal/sql-run-journal.ts", import.meta.url)));
const { openSqlPoolQueue } = await jiti.import(fileURLToPath(new URL("../../packages/workflows/src/durable/journal/sql-pool-queue.ts", import.meta.url)));
const [path, leaseJson, worker] = process.argv.slice(2);
const database = await openNodeSqliteDatabase(path);
const journal = await SqlRunJournal.open(database);
try {
	const pool = await openSqlPoolQueue(journal);
	process.stdout.write("ready\n");
	await new Promise((resolve) => process.stdin.once("data", resolve));
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (sql) {
		if (sql === "BEGIN IMMEDIATE") process.stdout.write("claiming\n");
		return exec.call(this, sql);
	};
	const claim = await pool.claim(JSON.parse(leaseJson), worker, [{ definition: "fixture/child", digest: "sha256:child" }], 60_000);
	process.stdout.write(`${JSON.stringify(claim ?? null)}\n`);
} finally {
	await journal.close();
	await database.close();
}
