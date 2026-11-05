/**
 * A busy writer for the waiting-stage chaos fixtures (#4309): it keeps a write transaction open almost all the time
 * on the shared database, so a SIGSTOP of this process stops a writer that holds the write lock.
 *
 *   ATOMIC_CHAOS_DB_URL=node-sqlite:<path> node --import jiti/register test/fixtures/waiting-stage-chaos-writer.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { openChaosDatabase } from "./waiting-stage-chaos-database.js";

const url = process.env.ATOMIC_CHAOS_DB_URL;
if (url === undefined) throw new Error("ATOMIC_CHAOS_DB_URL is required");
const HOLD_MS = 200;
const database = await openChaosDatabase(url, process.env.ATOMIC_CHAOS_DB_TOKEN_FILE);
await database.run("CREATE TABLE IF NOT EXISTS chaos_writer (at INTEGER NOT NULL)");
for (;;) {
	await database.transaction(async (transaction) => {
		await transaction.run("INSERT INTO chaos_writer (at) VALUES (?)", Date.now());
		await sleep(HOLD_MS);
	});
}
