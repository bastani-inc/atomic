#!/usr/bin/env bun
/**
 * One pool process of a heavy root for the journal store benchmark: it opens the journal that holds its root's runs,
 * either the root's shard of a journal store or one single journal file, creates a run of its own beside the root,
 * waits until every process of the benchmark is ready, and appends checkpoints back to back, timing each append from
 * the call to its commit. That time is the wait for the database's write lock plus one commit. The wait for the lock
 * alone is read from the database handle's own writer-queue statistics once the appends are done, so the report
 * separates it from the commit (and its fsync) that follows, and the database files whose write lock it took are listed.
 *
 *   bun run scripts/perf/journal-store/writer.ts <store|file> <path> <root> <worker> <appends> <payloadBytes> <ready> <peers>
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWriterQueueStats, type SqliteDatabase } from "@bastani/atomic/storage";
import { sqlPoolStorage } from "../../../packages/workflows/src/durable/journal/internal.js";
import { openSelectedRunJournal } from "../../../packages/workflows/src/durable/journal/resolution.js";
import { isShardedRunJournal } from "../../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../../packages/workflows/src/durable/journal/types.js";

const [mode, path, root, worker, appendsText, payloadText, ready, peersText] = process.argv.slice(2);
if (!mode || !path || !root || !worker || !appendsText || !payloadText || !ready || !peersText)
	throw new Error("usage: writer.ts <store|file> <path> <root> <worker> <appends> <payloadBytes> <ready> <peers>");
const appends = Number(appendsText);
const payload = "x".repeat(Number(payloadText));

let owner: RunJournal | undefined;
let journal: RunJournal;
if (mode === "store") {
	owner = await openSelectedRunJournal({ kind: "sharded", dir: path }, dirname(path));
	if (!isShardedRunJournal(owner)) throw new Error("not a journal store");
	journal = await owner.journalFor(root);
} else journal = await openSqlRunJournal(path);

const runId = `${root}/worker-${worker}`;
await journal.createRun({ runId, name: "bench", cwd: "/bench", createdAt: Date.now(), status: "running" });
const held = await journal.acquire(runId, runId);
if (held.status !== "acquired") throw new Error("lease not acquired");
mkdirSync(ready, { recursive: true });
writeFileSync(join(ready, runId.replaceAll("/", "_")), "");
while (readdirSync(ready).length < Number(peersText)) await Bun.sleep(5);

const waits: number[] = [];
const started = performance.now();
for (let index = 0; index < appends; index++) {
	const before = performance.now();
	await journal.append(held.lease, { type: "CheckpointRecorded", payload: { kind: "tool", index, payload } });
	waits.push(performance.now() - before);
}
const elapsedMs = performance.now() - started;
const queue = await sqlPoolStorage(journal)!.read(async (database) => getWriterQueueStats(database as SqliteDatabase));
// The database files of the store this process took the write lock on, read from the records each connection keeps
// next to a database while it holds that database's lock; a store writer holds its root's shard and no other.
const holders =
	mode === "store"
		? readdirSync(path)
				.filter((name) => name.endsWith("-holders"))
				.filter((name) => readdirSync(join(path, name)).some((record) => record.startsWith(`${process.pid}-`)))
				.map((name) => name.slice(0, -"-holders".length))
		: [];
await journal.release(held.lease);
if (owner === undefined) await journal.close();
else await owner.close();
const lockWait = { p50: queue.p50WaitMs, p95: queue.p95WaitMs };
process.stdout.write(`${JSON.stringify({ root, worker, pid: process.pid, waits, elapsedMs, lockWait, holders })}\n`);
