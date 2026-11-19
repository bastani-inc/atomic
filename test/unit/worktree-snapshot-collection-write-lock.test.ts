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
			let last = performance.now();
			const tick = () => {
				const now = performance.now();
				longestTurnMs = Math.max(longestTurnMs, now - last);
				last = now;
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
				longestTurnMs < MAIN_THREAD_LAG_LIMIT_MS,
				`the event loop stopped for ${Math.round(longestTurnMs)} ms while the other connection wrote`,
			);
		} finally {
			await other.close();
			await shared.close();
		}
	},
	60_000,
);
