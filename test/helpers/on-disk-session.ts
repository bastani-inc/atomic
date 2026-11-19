import { join } from "node:path";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/** Each call to open gets a separate handle to the same sessions, including a separate SQLite connection. */
export async function withDiskSessions(
	backend: "sqlite" | "jsonl",
	run: (
		open: () => Promise<{ store: SqlSessionStore | JsonlSessionStore; close: () => Promise<void> }>,
	) => Promise<void>,
): Promise<void> {
	const directory = makeTempDirectory("atomic-session-reopen-");
	const handles = new Set<() => Promise<void>>();
	try {
		await run(async () => {
			const database =
				backend === "sqlite" ? await openNodeSqliteDatabase(join(directory, "sessions.sqlite")) : undefined;
			const store = database
				? await SqlSessionStore.open(database)
				: await JsonlSessionStore.open(directory, { exactDirectory: true });
			const close = async () => {
				await store.close();
				await database?.close();
				handles.delete(close);
			};
			handles.add(close);
			return { store, close };
		});
	} finally {
		for (const close of handles) await close();
		removeTempDirectory(directory);
	}
}
