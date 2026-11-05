/**
 * A process that opens a session store, or a run journal, through the storage provider on an adapter whose database
 * keeps the process alive until it is closed, starts an automatic snapshot collection the way a closing session or a
 * finishing workflow run does, and closes it, as `closeAgentSession` and a run's completion do. It then has nothing
 * else to do (#4355).
 *
 *   <runtime> snapshot-collection-dispose.ts <database> session|journal
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageProvider } from "../../packages/coding-agent/src/core/storage/provider.js";
import type { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { scheduleSnapshotCollection } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

const [path, domain] = process.argv.slice(2);
if (path === undefined || (domain !== "session" && domain !== "journal")) {
	throw new Error("usage: snapshot-collection-dispose.ts <database> session|journal");
}
const adapter = join(dirname(fileURLToPath(import.meta.url)), "snapshot-collection-adapter.ts");
const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
const selection = { kind: "adapter", module: adapter, options: { path } } as const;
const context = { agentDir: dirname(path), domain: domain === "session" ? "sessions" : "journal" } as const;
const store =
	domain === "session"
		? ((await provider.openSessionStore(selection, context)) as SqlSessionStore)
		: ((await provider.openRunJournal(selection, context)) as SqlRunJournal);
const outcome = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
	onFailure: (error) => process.stdout.write(`failure ${error.code}\n`),
});
if ((await Promise.race([outcome, Promise.resolve(undefined)]))?.status === "skipped") {
	throw new Error("the collection was skipped, so this process proves nothing about it");
}
await store.close();
process.stdout.write("closed\n");
