import type { SessionStore, SqliteDatabase } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";

/**
 * The sessions of stages that ran on local workers (#3996).
 *
 * Workers commit their stage sessions into the journal's `<runs>_pool_` session tables,
 * not the host's session store. This opens those tables over the journal's own connection,
 * so a finished pooled stage's transcript can be read and reopened for post-mortem chat,
 * in the same process and after a restart. Undefined when no pool ever ran on the journal.
 * The caller owns the returned store.
 */
export async function poolSessionStore(backend: DurableWorkflowBackend): Promise<SessionStore | undefined> {
	const journal = (backend as { readonly journal?: Parameters<typeof sqlPoolStorage>[0] }).journal;
	return journal === undefined ? undefined : openPoolSessionStore(journal);
}

async function openPoolSessionStore(journal: Parameters<typeof sqlPoolStorage>[0]): Promise<SessionStore | undefined> {
	const storage = sqlPoolStorage(journal);
	if (storage === undefined) return undefined;
	const prefix = `${storage.tables.runs}_pool_`;
	const owners = await storage.transaction((tx) =>
		tx.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", `${prefix}session_owners`),
	);
	if (owners === undefined) return undefined;
	const database: SqliteDatabase = {
		descriptor: { adapter: "pool-journal", location: prefix },
		exec: (sql) => storage.transaction((tx) => tx.exec(sql)),
		run: (sql, ...params) => storage.transaction((tx) => tx.run(sql, ...params)),
		get: (sql, ...params) => storage.transaction((tx) => tx.get(sql, ...params)),
		all: (sql, ...params) => storage.transaction((tx) => tx.all(sql, ...params)),
		transaction: (body) => storage.transaction(body),
		close: async () => {},
	};
	const { StorageProvider } = await import("@bastani/atomic/storage");
	return new StorageProvider().openSessionStore(
		{ kind: "database", database, prefix },
		{ agentDir: "", domain: "sessions" },
	);
}
