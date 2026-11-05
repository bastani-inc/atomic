import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

export interface SqlSnapshotJournal {
	readonly database: SqliteDatabase;
	readonly journal: SqlRunJournal;
	/** Closes the journal and then its database. */
	close(): Promise<void>;
}

export interface SqlSnapshotJournalBackend extends SqlSnapshotJournal {
	readonly backend: JournalDurableBackend;
}

/**
 * A run journal on a SQLite file. Worktree snapshot blobs need a journal with a blob table, which the in-memory journal
 * deliberately does not have, so every test that records snapshots runs on one of these.
 */
export async function openSqlSnapshotJournal(
	path: string,
	options: { prefix?: string } = {},
): Promise<SqlSnapshotJournal> {
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database, options);
	return {
		database,
		journal,
		async close() {
			await journal.close();
			await database.close();
		},
	};
}

/** {@link openSqlSnapshotJournal} with a durable backend over it; closing the backend closes the journal. */
export async function openSqlSnapshotJournalBackend(
	path: string,
	options: { readonly runs?: readonly string[] } = {},
): Promise<SqlSnapshotJournalBackend> {
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { runs: options.runs ?? [] });
	return {
		database,
		journal,
		backend,
		async close() {
			await backend.close();
			await database.close();
		},
	};
}
