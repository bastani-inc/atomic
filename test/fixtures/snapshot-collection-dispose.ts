/** Open a real session store on a database that holds the process alive until close, start collection, then dispose it. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "@bastani/atomic";
import { StorageProvider } from "../../packages/coding-agent/src/core/storage/provider.js";
import type { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { scheduleSnapshotCollection } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.js";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("Expected database path");
const adapter = join(dirname(fileURLToPath(import.meta.url)), "snapshot-collection-adapter.ts");
const provider = new StorageProvider();
const selection = { kind: "adapter", module: adapter, options: { path } } as const;
const store = await provider.openSessionStore(selection, {agentDir: dirname(path), domain:"sessions"}) as SqlSessionStore;
const outcome = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
	onFailure: (error) => process.stdout.write(`failure ${error.code}\n`),
});
if ((await Promise.race([outcome, Promise.resolve(undefined)]))?.status === "skipped") {
	throw new Error("the collection was skipped, so this process proves nothing about it");
}
await store.close();
process.stdout.write("closed\n");
