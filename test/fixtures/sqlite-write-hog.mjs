// A writer that takes the journal's write lock again the moment it commits, holding it `holdMs` each time, until
// `stopPath` exists. Each transaction inserts one row into `hog`, so commits can be counted from another process.
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const [path, holdMs, stopPath] = process.argv.slice(2);
const database = await openNodeSqliteDatabase(path);
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
