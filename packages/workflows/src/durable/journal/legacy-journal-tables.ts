import {
	renderStorageIdentifiers,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
} from "@bastani/atomic/storage";
import { JOURNAL_COLUMNS as c, JOURNAL_SCHEMA_VERSION, JOURNAL_TABLES } from "./types.js";

const LEGACY_JOURNAL_MIGRATION = "unprefixed-journal-tables";
const CURRENT_TABLES = renderStorageIdentifiers("journal", { ...JOURNAL_TABLES, migrations: "migrations" });

const LEGACY_COLUMNS: Readonly<Record<keyof typeof JOURNAL_TABLES, readonly string[]>> = {
	meta: [c.schemaVersion],
	runs: [c.runId, c.name, c.cwd, c.createdAt, c.status, c.headerJson],
	events: [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at],
	leases: [c.runId, c.holderId, c.epoch, c.renewedAt],
};

async function hasLegacyTable(tx: SqliteExecutor, table: keyof typeof JOURNAL_TABLES): Promise<boolean> {
	const columns = await tx.all<SqliteRow & { name: string }>(
		"SELECT name FROM pragma_table_info(?)",
		JOURNAL_TABLES[table],
	);
	const names = new Set(columns.map((column) => column.name));
	return columns.length === LEGACY_COLUMNS[table].length && LEGACY_COLUMNS[table].every((name) => names.has(name));
}

/**
 * Copy runs from the unprefixed journal tables into the `wf_` tables.
 *
 * #3682 renamed the journal tables `meta`/`runs`/`events`/`leases` to
 * `wf_meta`/`wf_runs`/`wf_events`/`wf_leases` without reading or migrating the
 * old ones, so `/workflow resume` lost every run recorded before 0.9.38-alpha.6.
 * The schema version and columns are unchanged, so rows copy verbatim.
 *
 * Runs once per database: completion is recorded in `wf_migrations`, so a run
 * deleted afterward stays deleted. Runs already in `wf_runs` are skipped. The
 * legacy tables are left in place so older builds keep working. Copied leases are
 * released, since no process from an older build can hold one on the new tables.
 */
export async function migrateLegacyJournalTables(database: SqliteDatabase): Promise<void> {
	const t = CURRENT_TABLES;
	try {
		await database.transaction(async (tx) => {
			for (const table of ["meta", "runs", "events"] as const) {
				if (!(await hasLegacyTable(tx, table))) return;
			}
			await tx.exec(
				`CREATE TABLE IF NOT EXISTS ${t.migrations}(name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)`,
			);
			if (await tx.get(`SELECT name FROM ${t.migrations} WHERE name = ?`, LEGACY_JOURNAL_MIGRATION)) return;
			const versions = await tx.all<SqliteRow & { [c.schemaVersion]: number }>(
				`SELECT ${c.schemaVersion} FROM ${JOURNAL_TABLES.meta}`,
			);
			if (versions.length !== 1 || Number(versions[0]![c.schemaVersion]) !== JOURNAL_SCHEMA_VERSION) return;

			const missing = `SELECT ${c.runId} FROM ${JOURNAL_TABLES.runs} WHERE ${c.runId} NOT IN (SELECT ${c.runId} FROM ${t.runs})`;
			const eventColumns = LEGACY_COLUMNS.events.join(", ");
			await tx.run(
				`INSERT OR IGNORE INTO ${t.events}(${eventColumns}) SELECT ${eventColumns} FROM ${JOURNAL_TABLES.events} WHERE ${c.runId} IN (${missing})`,
			);
			if (await hasLegacyTable(tx, "leases")) {
				await tx.run(
					`INSERT OR IGNORE INTO ${t.leases}(${c.runId}, ${c.holderId}, ${c.epoch}, ${c.renewedAt}) SELECT ${c.runId}, NULL, ${c.epoch}, ${c.renewedAt} FROM ${JOURNAL_TABLES.leases} WHERE ${c.runId} IN (${missing})`,
				);
			}
			const runColumns = LEGACY_COLUMNS.runs.join(", ");
			await tx.run(
				`INSERT INTO ${t.runs}(${runColumns}) SELECT ${runColumns} FROM ${JOURNAL_TABLES.runs} WHERE ${c.runId} IN (${missing})`,
			);
			await tx.run(`INSERT INTO ${t.migrations} VALUES (?, ?)`, LEGACY_JOURNAL_MIGRATION, Date.now());
		});
	} catch {
		// A legacy journal that cannot be read must not block opening the current one.
	}
}
