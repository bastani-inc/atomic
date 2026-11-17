// An Atomic connection that takes a database's write lock in a transaction, writes one row, prints "locked" once its
// write-lock record (written in the background as it takes the lock) says so, and then stalls with the lock held:
// "stdin" waits for a line on stdin (the test stops and continues the process meanwhile), "spin:<ms>" blocks its own
// event loop for that long. It then commits and prints "committed".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const [path, mode] = process.argv.slice(2);
const database = await openNodeSqliteDatabase(path);
await database.transaction(async (tx) => {
	await tx.run("CREATE TABLE IF NOT EXISTS stalled_holder(pid INTEGER)");
	await tx.run("INSERT INTO stalled_holder VALUES (?)", process.pid);
	const holders = `${path}-holders`;
	const recordedHeld = () =>
		readdirSync(holders).some(
			(name) => name.startsWith(`${process.pid}-`) && readFileSync(join(holders, name), "utf8").startsWith("held "),
		);
	while (!recordedHeld()) await sleep(1);
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
