// A writer that takes the journal's write lock again the moment it commits, holding it `holdMs` each time, until
// `stopPath` exists. Each transaction inserts one row into `hog`, so commits can be counted from another process.
// With `clockOffsetMs`, the process's own clock (`Date`) reads that far from the system clock, as a Windows process's
// does after the system clock is set, until V8 renews its reading.
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [path, holdMs, stopPath, clockOffsetMs = "0"] = process.argv.slice(2);
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
const database = await openNodeSqliteDatabase(path);
// Durability is not under test, only who gets the lock: a hog that syncs every commit to disk only slows the disk for
// every other process on the machine.
await database.exec("PRAGMA synchronous=OFF");
let announced = false;
while (!existsSync(stopPath)) {
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO hog(pid) VALUES (?)", process.pid);
		await sleep(Number(holdMs));
	});
	if (!announced) {
		announced = true;
		process.stdout.write("writing\n");
	}
}
await database.close();
