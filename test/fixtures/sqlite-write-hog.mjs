// A writer that takes the journal's write lock again the moment it commits, holding it `holdMs` each time, until
// `stopPath` exists. Each transaction inserts one row into `hog`, so commits can be counted from another process.
// With `clockOffsetMs`, the process's own clock (`Date`) reads that far from the system clock, as a Windows process's
// does after the system clock is set, until V8 renews its reading.
// A row's `queued` is the `victim` transaction that process `waiterPid` was waiting on in the writers' queue when the
// row committed, or null: it is read while this writer holds the lock, so the waiter can neither commit nor take its
// ticket out of the queue in between, and a commit with `queued` set is one that went ahead of a writer already queued.
import { existsSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [path, holdMs, stopPath, clockOffsetMs, waiterPid] = process.argv.slice(2);
const offsetMs = Number(clockOffsetMs);
if (offsetMs !== 0) {
	const SystemDate = Date;
	globalThis.Date = class extends SystemDate {
		constructor(...args) {
			super(...(args.length === 0 ? [SystemDate.now() + offsetMs] : args));
		}
		static now() {
			return SystemDate.now() + offsetMs;
		}
	};
}
const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const queue = `${path}-writers`;

function waiterQueued() {
	try {
		return readdirSync(queue).some((ticket) => ticket.split("-")[1] === waiterPid);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

const database = await openNodeSqliteDatabase(path);
// Durability is not under test, only who gets the lock: a hog that syncs every commit to disk only slows the disk for
// every other process on the machine.
await database.exec("PRAGMA synchronous=OFF");
let announced = false;
while (!existsSync(stopPath)) {
	await database.transaction(async (tx) => {
		await sleep(Number(holdMs));
		const queued = waiterQueued() ? (await tx.get("SELECT COUNT(*) AS count FROM victim")).count : null;
		await tx.run("INSERT INTO hog(pid, queued) VALUES (?, ?)", process.pid, queued);
	});
	if (!announced) {
		announced = true;
		process.stdout.write("writing\n");
	}
}
await database.close();
