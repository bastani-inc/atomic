// One process of the dead-head probe (#4316), loading the node-sqlite adapter from the directory it is given.
// "hold": takes the write lock in a transaction, prints "locked", commits when a line arrives on stdin, and prints
// "committed <epoch ms>" right after the commit. "write": prints "ready", runs one transaction when a line arrives,
// and prints "started <epoch ms>" when its callback starts, that is, the moment it holds the lock.
import { join } from "node:path";
import { createJiti } from "jiti";

const [storageDirectory, path, role] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(join(storageDirectory, "node-sqlite.ts"));
const database = await openNodeSqliteDatabase(path);
const line = () => new Promise((resolve) => process.stdin.once("data", resolve));

if (role === "hold") {
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO probe(role) VALUES ('holder')");
		process.stdout.write("locked\n");
		await line();
	});
	process.stdout.write(`committed ${Date.now()}\n`);
} else {
	process.stdout.write("ready\n");
	await line();
	await database.transaction(async (tx) => {
		process.stdout.write(`started ${Date.now()}\n`);
		await tx.run("INSERT INTO probe(role) VALUES ('writer')");
	});
}
await database.close();
