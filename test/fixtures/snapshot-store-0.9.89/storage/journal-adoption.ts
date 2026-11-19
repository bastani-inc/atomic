// Not vendored as a whole: see ../README.md. 0.9.89's blob store imports this module only to upgrade a run journal at
// schema version 1 when it writes a chunked blob. These are that release's upgrade and the table definitions it applies,
// byte for byte from 0.9.89's `storage/journal-adoption.ts`; the rest of that module needs most of 0.9.89's storage layer.
import type { SqliteExecutor } from "../../../../packages/coding-agent/src/core/storage/database.js";
import { type StorageDialect, sqliteDialect } from "./dialect.js";
import { renderStorageIdentifiers } from "./prefix.js";
import { RUN_JOURNAL_SCHEMA_VERSION, RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED } from "./run-journal.js";

/** The tables of a SQL run journal, before the storage prefix and the `wf_` domain prefix. */
export const RUN_JOURNAL_TABLE_NAMES = {
	meta: "meta",
	runs: "runs",
	events: "events",
	leases: "leases",
	eventChunks: "event_chunks",
	leaseBuilds: "lease_builds",
} as const;

/** A SQL run journal's table names under `prefix`. */
export function runJournalTables(prefix = ""): Readonly<Record<keyof typeof RUN_JOURNAL_TABLE_NAMES, string>> {
	return renderStorageIdentifiers("journal", RUN_JOURNAL_TABLE_NAMES, prefix);
}

/**
 * `CREATE TABLE IF NOT EXISTS` statements for a SQL run journal's runs, events, leases and event chunks tables, in
 * `dialect`. The runs and events tables carry the dialect's row order column, which the journal's change token and the
 * snapshot reference index read, and event keys compare by their UTF-8 bytes, as the journal's key range reads expect.
 * An event's `chunks` is how many rows of the event chunks table hold its payload, 0 when its row holds it (#4965).
 */
export function runJournalTableDefinitions(prefix = "", dialect: StorageDialect = sqliteDialect): string {
	const t = runJournalTables(prefix);
	const { int, blob } = dialect.types;
	return `
		CREATE TABLE IF NOT EXISTS ${t.runs}(
			run_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
			created_at ${int} NOT NULL, status TEXT NOT NULL, header_json TEXT NOT NULL${dialect.rowOrderColumn}
		);
		CREATE TABLE IF NOT EXISTS ${t.events}(
			run_id TEXT NOT NULL,
			seq ${int} NOT NULL, epoch ${int} NOT NULL, key TEXT${dialect.byteOrderCollation},
			type TEXT NOT NULL, payload TEXT NOT NULL, at ${int} NOT NULL${dialect.rowOrderColumn},
			chunks ${int} NOT NULL DEFAULT 0,
			PRIMARY KEY(run_id, seq), UNIQUE(run_id, key)
		);
		CREATE TABLE IF NOT EXISTS ${t.leases}(
			run_id TEXT PRIMARY KEY,
			holder_id TEXT, epoch ${int} NOT NULL, renewed_at ${int} NOT NULL
		);
		CREATE TABLE IF NOT EXISTS ${t.leaseBuilds}(
			run_id TEXT PRIMARY KEY, holder_id TEXT NOT NULL, epoch ${int} NOT NULL, schema_version ${int} NOT NULL
		);
		CREATE TABLE IF NOT EXISTS ${t.eventChunks}(
			run_id TEXT NOT NULL, seq ${int} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL,
			PRIMARY KEY(run_id, seq, idx)
		)${dialect.tableOptions};
	`;
}

/**
 * Upgrades a run journal of schema version 1 to version 2 inside the caller's transaction (#4965): the events table's
 * `chunks` column, 0 for every event written before it, the event chunks table, and the meta row at version 2. A
 * build that knows only version 1 then refuses the journal instead of reading a large payload's stub. Idempotent.
 */
export async function upgradeRunJournalSchema(
	tx: SqliteExecutor,
	prefix = "",
	dialect: StorageDialect = sqliteDialect,
): Promise<void> {
	const t = runJournalTables(prefix);
	await tx.exec(runJournalTableDefinitions(prefix, dialect));
	const probe = dialect.columnExists(t.events, "chunks");
	if ((await tx.get(probe.sql, ...probe.params)) === undefined)
		await tx.exec(`ALTER TABLE ${t.events} ADD COLUMN chunks ${dialect.types.int} NOT NULL DEFAULT 0`);
	await tx.run(
		`UPDATE ${t.meta} SET schema_version = ? WHERE schema_version = ?`,
		RUN_JOURNAL_SCHEMA_VERSION,
		RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED,
	);
}

