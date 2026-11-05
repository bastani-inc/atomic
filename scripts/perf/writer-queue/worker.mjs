// One writer process of the writers'-queue benchmark (#4316). It loads the node-sqlite adapter from the directory it is
// given (the current source or a baseline revision copied out of git), opens the shared database, prints "ready",
// and on a "go <startEpochMs> <endEpochMs>" line runs `lanes` concurrent transaction loops until `endEpochMs`. Each
// transaction inserts one row and keeps the lock for `busyMs` of CPU work; a lane then thinks for `thinkMs`.
//
// What it measures comes from the connection itself, the same way for every adapter version: every successful
// `BEGIN IMMEDIATE` starts a hold and the COMMIT or ROLLBACK after it ends it. Each transaction's lock wait is the time
// from its `transaction()` call to its callback starting. All times are wall-clock epoch milliseconds
// (`performance.timeOrigin + performance.now()`), so the orchestrator can merge processes.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const [storageDirectory, path, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const now = () => performance.timeOrigin + performance.now();

const holds = [];
const commits = [];
let heldSince;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
	exec.call(this, sql);
	if (sql === "BEGIN IMMEDIATE") heldSince = now();
	else if ((sql === "COMMIT" || sql === "ROLLBACK") && heldSince !== undefined) {
		const end = now();
		holds.push([heldSince, end]);
		if (sql === "COMMIT") commits.push(end);
		heldSince = undefined;
	}
};

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(join(storageDirectory, "node-sqlite.ts"));
const database = await openNodeSqliteDatabase(
	path,
	spec.groupCommitHoldMs === undefined ? {} : { groupCommitHoldMs: spec.groupCommitHoldMs },
);
process.stdout.write("ready\n");
const go = await new Promise((resolve) => {
	let text = "";
	process.stdin.on("data", (chunk) => {
		text += chunk;
		if (text.includes("\n")) resolve(text.trim());
	});
});
const [, startAt, endAt] = go.split(" ").map(Number);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - now())));

const transactions = [];
let failures = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function lane(laneIndex) {
	let seq = 0;
	while (now() < endAt) {
		const called = now();
		let started;
		try {
			await database.transaction(async (tx) => {
				started = now();
				await tx.run("INSERT INTO bench(writer, lane, seq) VALUES (?, ?, ?)", spec.label, laneIndex, seq);
				const until = performance.now() + spec.busyMs;
				while (performance.now() < until) {
					// CPU work while holding the lock.
				}
			});
			transactions.push([called, started, now()]);
			seq += 1;
		} catch {
			failures += 1;
		}
		if (spec.thinkMs > 0) await sleep(spec.thinkMs * (0.5 + Math.random()));
	}
}
await Promise.all(Array.from({ length: spec.lanes }, (_, index) => lane(index)));
process.stdout.write(`${JSON.stringify({ label: spec.label, holds, commits, transactions, failures })}\n`);
await database.close();
