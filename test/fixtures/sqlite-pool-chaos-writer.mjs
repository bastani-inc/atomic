// Another process writing a pool journal with raw node:sqlite, for the pool read chaos tests (#4314).
//   hold <path> <sql>: begin a write transaction, run `sql`, print "locked", and commit on a line from stdin.
//   fence <path> <workId> <stopPath>: until `stopPath` exists, commit transactions that each advance the attempt's
//     generation and the pool's control revision together; print "writing" after the first, the commit count at the end.
//   fill <path> <workId> <bytes>: one transaction that fences the attempt and writes `bytes` more; print its outcome.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [mode, path, ...rest] = process.argv.slice(2);
const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout=10000");
const fence = (workId) => {
	database.prepare("UPDATE wf_runs_work SET generation = generation + 1 WHERE id = ?").run(workId);
	database.prepare("UPDATE wf_runs_pool_control SET revision = revision + 1").run();
};

if (mode === "hold") {
	database.exec("BEGIN IMMEDIATE");
	database.exec(rest[0]);
	process.stdout.write("locked\n");
	await new Promise((resolve) => process.stdin.once("data", resolve));
	database.exec("COMMIT");
	process.stdout.write("committed\n");
} else if (mode === "fence") {
	const [workId, stopPath] = rest;
	let commits = 0;
	while (!existsSync(stopPath)) {
		database.exec("BEGIN IMMEDIATE");
		fence(workId);
		database.exec("COMMIT");
		commits += 1;
		if (commits === 1) process.stdout.write("writing\n");
	}
	process.stdout.write(`${commits}\n`);
} else if (mode === "fill") {
	const [workId, bytes] = rest;
	let outcome;
	try {
		database.exec("BEGIN IMMEDIATE");
		fence(workId);
		database.exec("CREATE TABLE chaos_fill(data BLOB)");
		database.prepare("INSERT INTO chaos_fill VALUES (?)").run(new Uint8Array(Number(bytes)));
		database.exec("COMMIT");
		outcome = { committed: true };
	} catch (error) {
		outcome = { committed: false, errcode: error.errcode, message: error.message };
		if (database.isTransaction) database.exec("ROLLBACK");
	}
	process.stdout.write(`${JSON.stringify(outcome)}\n`);
} else {
	throw new Error(`Unknown chaos writer mode: ${mode}`);
}
database.close();
