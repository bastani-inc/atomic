// Another process that keeps a SQLite file's write lock almost all the time and still commits: each turn it writes
// one row in a `BEGIN IMMEDIATE` transaction, keeps the lock for `holdMs` and commits, then starts the next turn at
// once. It prints "committing" once it first holds the lock, stops starting turns after `durationMs`, and prints how
// many turns it committed.
import { DatabaseSync } from "node:sqlite";

const [path, holdMs, durationMs] = process.argv.slice(2);
const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS commits(n INTEGER NOT NULL)");
// Blocks the thread, so the lock is free only between one turn's COMMIT and the next turn's BEGIN.
const pause = new Int32Array(new SharedArrayBuffer(4));
let committed = 0;
let deadline;
do {
	database.exec("BEGIN IMMEDIATE");
	database.prepare("INSERT INTO commits VALUES (?)").run(committed);
	if (deadline === undefined) {
		process.stdout.write("committing\n");
		deadline = Date.now() + Number(durationMs);
	}
	Atomics.wait(pause, 0, 0, Number(holdMs));
	database.exec("COMMIT");
	committed++;
} while (Date.now() < deadline);
database.close();
process.stdout.write(`committed ${committed}\n`);
