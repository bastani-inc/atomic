/**
 * A process that starts an automatic snapshot blob collection the way a closing session or a finishing workflow run
 * does, then has nothing else to do (#4355).
 *
 *   <runtime> snapshot-collection-exit.ts schedule <database>   starts it and returns
 *   <runtime> snapshot-collection-exit.ts await <database>      starts it and waits for runningSnapshotCollection
 *
 * The connection waits up to ten minutes for a write lock another process holds, so a collection that waited for the
 * lock would keep this process alive far longer than any test waits.
 */
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import {
	runningSnapshotCollection,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.js";

const PATIENT_LOCK_WAIT_MS = 600_000;

const [mode, path] = process.argv.slice(2);
if ((mode !== "schedule" && mode !== "await") || path === undefined) {
	throw new Error("usage: snapshot-collection-exit.ts schedule|await <database>");
}
const database = await openNodeSqliteDatabase(path, { lockWaitMs: PATIENT_LOCK_WAIT_MS });
const store = await SqlSnapshotBlobStore.open(database);
void scheduleSnapshotCollection(store, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
	onFailure: (error) => process.stdout.write(`failure ${error.code}\n`),
});
process.stdout.write("scheduled\n");
if (mode === "await") {
	const outcome = await runningSnapshotCollection(store);
	process.stdout.write(`outcome ${outcome?.status ?? "none"}\n`);
}
