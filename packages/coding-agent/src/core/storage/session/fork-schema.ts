import type { SqliteExecutor } from "../database.js";
import type { StorageDialect } from "../dialect.js";
import { renderStorageIdentifiers } from "../prefix.js";

/**
 * The tables of forks that share their parent's history instead of copying it (#6560): `<prefix>session_fork_segments`,
 * which maps a fork's inherited seqs onto the rows its sources store, and `<prefix>session_fork_lineage`, one row per
 * such fork; `<prefix>session_fork_tombstones`, one row per deleted session whose rows forks still read, which those
 * forks and the sweep that removes the rows lock; and `<prefix>session_fork_detach`, the progress of a fork copying
 * the rows it read from a source into its own. They exist only in a store whose sessions schema was raised to version 3
 * by the switch a store's open or `atomic storage migrate` makes once no older build runs a session there, in the same
 * transaction; a store that was not switched keeps only the tables every older build reads.
 */
export const SESSION_FORK_TABLES = Object.freeze({
	forkSegments: "fork_segments",
	forkLineage: "fork_lineage",
	forkTombstones: "fork_tombstones",
	forkDetach: "fork_detach",
});

export type SessionForkTables = Readonly<Record<keyof typeof SESSION_FORK_TABLES, string>>;

/** The fork tables under `prefix`. */
export function sessionForkTables(prefix?: string): SessionForkTables {
	return renderStorageIdentifiers("sessions", SESSION_FORK_TABLES, prefix);
}

/**
 * The statements that create the fork tables, idempotently: in the transaction that raises the sessions schema to the
 * version that turns shared-history forks on, or in the one that creates a new database's sessions schema at that
 * version. `generation` is a token that changes with every change to a fork's segments and never repeats for an id, so
 * a reader's cached segments are keyed by it.
 */
export function sharedHistoryTablesScript(dialect: StorageDialect, tables: SessionForkTables): string {
	const { int, text } = dialect.types;
	return `
		CREATE TABLE IF NOT EXISTS ${tables.forkSegments} (
			session_id ${text} NOT NULL, idx ${int} NOT NULL, source_id ${text} NOT NULL,
			from_seq ${int} NOT NULL, to_seq ${int} NOT NULL, base_seq ${int} NOT NULL,
			PRIMARY KEY(session_id, idx)
		)${dialect.tableOptions};
		CREATE INDEX IF NOT EXISTS ${tables.forkSegments}_source ON ${tables.forkSegments} (source_id);
		CREATE TABLE IF NOT EXISTS ${tables.forkLineage} (
			session_id ${text} NOT NULL PRIMARY KEY, parent_id ${text}, cut_seq ${int}, generation ${text} NOT NULL
		)${dialect.tableOptions};
		CREATE TABLE IF NOT EXISTS ${tables.forkTombstones} (
			session_id ${text} NOT NULL PRIMARY KEY, deleted_at ${text} NOT NULL
		)${dialect.tableOptions};
		CREATE TABLE IF NOT EXISTS ${tables.forkDetach} (
			parent_id ${text} NOT NULL, child_id ${text} NOT NULL, reparent ${int} NOT NULL,
			original_segments ${text} NOT NULL, parent_epoch ${text}, child_epoch ${text},
			PRIMARY KEY(parent_id, child_id)
		)${dialect.tableOptions};
	`;
}

/** Creates the fork tables in `tx`: see {@link sharedHistoryTablesScript}. */
export async function createSharedHistoryTables(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	tables: SessionForkTables,
): Promise<void> {
	await tx.exec(sharedHistoryTablesScript(dialect, tables));
}
