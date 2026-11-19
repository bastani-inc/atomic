import type { SessionStore, SqliteDatabase } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { poolSessionPrefix, type SqlPoolStorage, sqlPoolStorage } from "../durable/journal/internal.js";
import { existingRootRunJournal } from "../durable/journal/sharded-run-journal.js";
import { poolJournalOf } from "./pool-journal.js";
import type { WorkflowExecutionResources } from "./public-options.js";

/**
 * The sessions of stages that ran on local workers (#3996).
 *
 * Workers commit their stage sessions into the journal's pool session tables (`poolSessionPrefix`),
 * not the host's session store. This opens those tables over the journal's own connection,
 * so a finished pooled stage's transcript can be read and reopened for post-mortem chat,
 * in the same process and after a restart. Undefined when no pool ever ran on the journal.
 * In the journal store those tables are in the shard of `rootRunId`. A root whose pool runs in the journal itself, as a
 * root with shared placement does, keeps them there, whatever other pools ran on this machine (#4310). The root's
 * recorded `resources` say so when the caller has its run; a fork's run, whose pool has not run yet, is placed only by
 * them (#4357). Without them, the pool's own record in the journal does.
 * The caller owns the returned store.
 */
export async function poolSessionStore(
	backend: DurableWorkflowBackend,
	rootRunId: string,
	resources?: WorkflowExecutionResources,
): Promise<SessionStore | undefined> {
	const journal = (backend as { readonly journal?: Parameters<typeof sqlPoolStorage>[0] }).journal;
	if (journal === undefined) return undefined;
	const rootJournal = await existingRootRunJournal(journal, rootRunId);
	// A journal in another database keeps its pool's sessions in the machine's coordination database, except for a root
	// whose pool runs in the journal itself, which every host opens.
	const inJournal = resources?.workers?.placement === "shared" || (await poolRunsIn(rootJournal, rootRunId));
	return openPoolSessionStore(inJournal ? rootJournal : await poolJournalOf(rootJournal));
}

/** Whether `rootRunId`'s pool keeps its tables in `journal` itself, read without the write lock. */
async function poolRunsIn(journal: Parameters<typeof sqlPoolStorage>[0], rootRunId: string): Promise<boolean> {
	const storage = sqlPoolStorage(journal);
	if (storage === undefined) return false;
	const pool = `${storage.tables.runs}_pool`;
	const exists = storage.dialect.tableExists(pool);
	return storage.read(
		async (executor) =>
			(await executor.get(exists.sql, ...exists.params)) !== undefined &&
			(await executor.get(`SELECT 1 FROM ${pool} WHERE root = ?`, rootRunId)) !== undefined,
	);
}

async function openPoolSessionStore(journal: Parameters<typeof sqlPoolStorage>[0]): Promise<SessionStore | undefined> {
	const storage = sqlPoolStorage(journal);
	if (storage === undefined) return undefined;
	const prefix = poolSessionPrefix(storage);
	const exists = storage.dialect.tableExists(`${prefix}session_owners`);
	const owners = await storage.read((executor) => executor.get(exists.sql, ...exists.params));
	if (owners === undefined) return undefined;
	return openPoolSessions(storage);
}

/**
 * The pooled-stage session store over a journal's own connection, for a pool whose tables live in that journal: the
 * local SQLite journal it shares, or a shared journal every host opens (#4310). The caller owns the returned store.
 * A read outside the store's transactions is a read of the journal (`SqlPoolStorage.read`), which never takes the
 * write lock: a store's open probes its schema with a dozen such reads, and every pooled child opens one in a fresh
 * worker, so as write transactions they queued every other host's writes behind them on a shared server.
 */
export async function openPoolSessions(storage: SqlPoolStorage): Promise<SessionStore> {
	const prefix = poolSessionPrefix(storage);
	const database: SqliteDatabase = {
		descriptor: { adapter: "pool-journal", location: prefix },
		dialect: storage.dialect,
		exec: (sql) => storage.transaction((tx) => tx.exec(sql)),
		run: (sql, ...params) => storage.transaction((tx) => tx.run(sql, ...params)),
		get: (sql, ...params) => storage.read((executor) => executor.get(sql, ...params)),
		all: (sql, ...params) => storage.read((executor) => executor.all(sql, ...params)),
		transaction: (body) => storage.transaction(body),
		close: async () => {},
	};
	// Over a local libSQL journal every write waits for another process's lock on the calling thread: the sessions store
	// then saves no reader-only chat records, as on that database itself (#5682).
	if (storage.locksOnThread)
		Object.defineProperty(database, Symbol.for("atomic.storage.locks-on-thread.v1"), { value: true });
	const { StorageProvider } = await import("@bastani/atomic/storage");
	return new StorageProvider().openSessionStore(
		{ kind: "database", database, prefix },
		{ agentDir: "", domain: "sessions" },
	);
}
