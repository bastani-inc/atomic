/**
 * A collection must never give the event loop a turn while it holds the database's write lock: another connection of
 * the same process that writes in such a turn waits for the lock synchronously (SQLite's busy timeout), so the event
 * loop stops and the collection's transaction cannot finish until that wait gives up (#5530).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SNAPSHOT_COLLECTION_SESSION_REFS } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { MAIN_THREAD_LAG_LIMIT_MS } from "../helpers/event-loop-lag.js";
import {
	ageBlobs,
	createSession,
	openSharedSnapshotDatabase,
	snapshotEntry,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

/**
 * The most CPU time this thread may spend between two turns of the event loop while a collection runs. Measured as
 * this thread's CPU, not wall time: a loaded runner keeps the thread waiting for a core longer than this (CI: 328 ms;
 * under a 300 ms burst of other work, 371 ms, of which 323 ms waiting to run and 48 ms running), and what the
 * collection controls is how long it runs before the next turn. Waiting for the write lock on this thread would use no
 * CPU, but here it never ends while the collection holds the lock: the other connection's write fails once its busy
 * timeout passes, which the check of failed writes catches.
 */
const TURN_CPU_LIMIT_MS = MAIN_THREAD_LAG_LIMIT_MS;

/** A full garbage collection, whatever flags the runtime started with. */
function exposedGc(): () => void {
	if (globalThis.gc) return globalThis.gc;
	setFlagsFromString("--expose-gc");
	try {
		return runInNewContext("gc") as () => void;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}
const gc = exposedGc();

/**
 * Frees what the setup left for the garbage collector and lets the finalizers of what it freed run, so the measured
 * turns are the collection's own. The setup writes thousands of entries through connections that prepare each
 * statement anew, as libSQL's file connections do: each insert's prepared statement holds a program with every
 * trigger of the entries table compiled in, and the finalizers that free them run on this thread in turns of the
 * event loop. Left pending, they ran in the collection's first turn and made it the busiest by far (#6560).
 */
async function settleSetupGarbage(): Promise<void> {
	gc();
	for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-write-lock-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

test.each(["node-sqlite", "libsql"] as const)(
	"on %s, another connection of the same process writes at every turn of a collection's delete batches without stopping the event loop (#5530)",
	async (adapter) => {
		const path = join(directory, "store.sqlite");
		const open = async (): Promise<SqliteDatabase> =>
			adapter === "node-sqlite"
				? await openNodeSqliteDatabase(path)
				: await openLibsqlDatabase({ url: pathToFileURL(path).href });
		const shared = await openSharedSnapshotDatabase(path, { database: await open() });
		const other = await open();
		try {
			// Sessions whose first snapshot records a blob their latest one does not: each delete batch reads them again.
			const dropped = Array.from({ length: 6 }, (_, index) => textBlob(`dropped by session ${index}`));
			await shared.journal.snapshotBlobs.putBlobs(dropped);
			for (const [index, blob] of dropped.entries()) {
				const root = `/repo/${index}`;
				await createSession(shared.sessions, `session-${index}`, [
					snapshotEntry(root, `first-${index}`, syntheticSnapshot(`first-${index}`, [blob.hash], { root })),
					snapshotEntry(root, `latest-${index}`),
				]);
			}
			// A blob the first snapshot of two sessions records, as a fork copies it, whose snapshot entries are more
			// together than one statement walks: its delete batch checks both sessions again.
			const forked = textBlob("dropped by a session and its fork");
			await shared.journal.snapshotBlobs.putBlobs([forked]);
			const entries = SNAPSHOT_COLLECTION_SESSION_REFS / 2 + 1;
			for (const name of ["parent", "fork"]) {
				const root = `/repo/${name}`;
				await createSession(shared.sessions, name, [
					snapshotEntry(root, `${name}-first`, syntheticSnapshot(`${name}-first`, [forked.hash], { root })),
					...Array.from({ length: entries - 1 }, (_, index) => snapshotEntry(root, `${name}-${index}`)),
				]);
			}
			dropped.push(forked);
			await ageBlobs(shared.database, "snapshot_blobs", 10_000);
			await other.exec("CREATE TABLE other_writes (at INTEGER NOT NULL)");
			await settleSetupGarbage();

			// The other connection writes once in every turn of the event loop while the collection runs, as another
			// store of this process (one that keeps its own connection) may at any time.
			let collecting = true;
			const failures: unknown[] = [];
			let writes = 0;
			const write = () => {
				if (!collecting) return;
				other
					.run("INSERT INTO other_writes (at) VALUES (?)", Date.now())
					.then(
						() => writes++,
						(error: unknown) => failures.push(error),
					)
					.finally(() => setImmediate(write));
			};
			let longestTurnMs = 0;
			let busiestTurnCpuMs = 0;
			let last = performance.now();
			let lastCpu = process.threadCpuUsage();
			const tick = () => {
				const now = performance.now();
				const cpu = process.threadCpuUsage();
				longestTurnMs = Math.max(longestTurnMs, now - last);
				busiestTurnCpuMs = Math.max(
					busiestTurnCpuMs,
					(cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000,
				);
				last = now;
				lastCpu = cpu;
				if (collecting) setTimeout(tick, 1);
			};
			setTimeout(tick, 1);
			setImmediate(write);
			const { deleted } = await collectSnapshotGarbage(shared.journal.snapshotBlobs, { graceSeconds: 0 });
			collecting = false;

			assert.deepEqual([...deleted].sort(), dropped.map((blob) => blob.hash).sort());
			assert.deepEqual(failures, [], "writes of the other connection that failed");
			assert.ok(writes > 0);
			assert.ok(
				busiestTurnCpuMs < TURN_CPU_LIMIT_MS,
				`the event loop ran ${Math.round(busiestTurnCpuMs)} ms of CPU without a turn while the other connection wrote (longest wait ${Math.round(longestTurnMs)} ms)`,
			);
		} finally {
			await other.close();
			await shared.close();
		}
	},
	60_000,
);
