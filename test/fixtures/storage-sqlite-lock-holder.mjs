// Holds the write lock of a SQLite file still in the rollback journal, as another process does while it writes a file
// nothing has switched to the write-ahead log yet: it writes one row in a `BEGIN IMMEDIATE` transaction, prints
// "locked", and commits once its stdin ends, or after `holdMs` when that is given.
import { DatabaseSync } from "node:sqlite";

const [path, holdMs] = process.argv.slice(2);
const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS held(n INTEGER NOT NULL)");
database.exec("BEGIN IMMEDIATE; INSERT INTO held VALUES (1)");
process.stdout.write("locked\n");
if (holdMs === undefined) {
	process.stdin.resume();
	await new Promise((resolve) => process.stdin.once("end", resolve));
	process.stdin.pause();
} else {
	await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
}
database.exec("COMMIT");
database.close();
