import {
	renderStorageIdentifiers,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
} from "@bastani/atomic/storage";
import { JOURNAL_COLUMNS as c, JOURNAL_SCHEMA_VERSION, JOURNAL_TABLES } from "./types.js";

const CURRENT = renderStorageIdentifiers("journal", {
	...JOURNAL_TABLES,
	legacyDeleted: "legacy_deleted",
	migrations: "migrations",
});
/** Recorded by the earlier version that copied every legacy run at once; those runs are already in `wf_*`. */
const COPIED_ALL_MARKER = "unprefixed-journal-tables";

const LEGACY_COLUMNS: Readonly<Record<keyof typeof JOURNAL_TABLES, readonly string[]>> = {
	meta: [c.schemaVersion],
	runs: [c.runId, c.name, c.cwd, c.createdAt, c.status, c.headerJson],
	events: [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at],
	leases: [c.runId, c.holderId, c.epoch, c.renewedAt],
};

/** Legacy runs that have not been converted into `wf_runs` or deleted since. */
const PENDING_LEGACY_RUNS = `SELECT ${c.runId}, ${c.headerJson}, ${c.status} FROM ${JOURNAL_TABLES.runs}
	WHERE ${c.runId} NOT IN (SELECT ${c.runId} FROM ${CURRENT.runs})
	AND ${c.runId} NOT IN (SELECT ${c.runId} FROM ${CURRENT.legacyDeleted})`;

type LegacyRunRow = SqliteRow & { [c.runId]: string; [c.headerJson]: string; [c.status]: string };
type LegacyEventRow = SqliteRow & {
	[c.runId]: string;
	[c.seq]: number;
	[c.epoch]: number;
	[c.key]: string | null;
	[c.type]: string;
	[c.payload]: string;
	[c.at]: number;
};

export type RunVersionRow = SqliteRow & { [c.runId]: string; [c.seq]: number; [c.at]: number };

/** `seq` and `at` of the latest event of `${runs}.run_id`, through the `(run_id, seq)` primary key. */
export function latestEventColumns(events: string, runs: string): string {
	const latest = (column: string) =>
		`COALESCE((SELECT ${column} FROM ${events} AS latest WHERE latest.${c.runId} = ${runs}.${c.runId} ORDER BY latest.${c.seq} DESC LIMIT 1), 0) AS ${column}`;
	return `${latest(c.seq)}, ${latest(c.at)}`;
}
async function hasLegacyTable(tx: SqliteExecutor, table: keyof typeof JOURNAL_TABLES): Promise<boolean> {
	const columns = await tx.all<SqliteRow & { name: string }>(
		"SELECT name FROM pragma_table_info(?)",
		JOURNAL_TABLES[table],
	);
	const names = new Set(columns.map((column) => column.name));
	return columns.length === LEGACY_COLUMNS[table].length && LEGACY_COLUMNS[table].every((name) => names.has(name));
}

/**
 * Runs recorded before #3682, kept in the unprefixed `meta`/`runs`/`events`/`leases` tables.
 *
 * #3682 renamed the journal tables to `wf_*` without reading the old ones, so
 * `/workflow resume` lost every run recorded before 0.9.38-alpha.6. Those runs are
 * listed from the old tables as they are, and a run is converted into `wf_*` only
 * when it is resumed (its lease is claimed), following pi's migrate-on-load pattern.
 * Until then its events are read from the old tables as they are. The schema version and
 * columns are unchanged, so its rows copy verbatim. The old tables are never
 * modified; deleting a legacy run records its ID so it is not listed again.
 */
export class LegacyJournalRuns {
	/** Present only for the unprefixed journal in a database that still has version-1 legacy tables. */
	static async open(database: SqliteDatabase): Promise<LegacyJournalRuns | undefined> {
		try {
			return await database.transaction(async (tx) => {
				for (const table of ["meta", "runs", "events"] as const) {
					if (!(await hasLegacyTable(tx, table))) return undefined;
				}
				const versions = await tx.all<SqliteRow & { [c.schemaVersion]: number }>(
					`SELECT ${c.schemaVersion} FROM ${JOURNAL_TABLES.meta}`,
				);
				if (versions.length !== 1 || Number(versions[0]![c.schemaVersion]) !== JOURNAL_SCHEMA_VERSION)
					return undefined;
				const copiedAll =
					(await tx.get(
						`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
						CURRENT.migrations,
					)) !== undefined &&
					(await tx.get(`SELECT name FROM ${CURRENT.migrations} WHERE name = ?`, COPIED_ALL_MARKER)) !== undefined;
				if (copiedAll) return undefined;
				await tx.exec(
					`CREATE TABLE IF NOT EXISTS ${CURRENT.legacyDeleted}(${c.runId} TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`,
				);
				return new LegacyJournalRuns();
			});
		} catch {
			return undefined;
		}
	}

	async pending(executor: SqliteExecutor, filter?: { cwd?: string }): Promise<LegacyRunRow[]> {
		return executor.all<LegacyRunRow>(
			`${PENDING_LEGACY_RUNS}${filter?.cwd === undefined ? "" : ` AND ${c.cwd} = ?`}`,
			...(filter?.cwd === undefined ? [] : [filter.cwd]),
		);
	}

	async find(executor: SqliteExecutor, runId: string): Promise<LegacyRunRow | undefined> {
		return executor.get<LegacyRunRow>(`${PENDING_LEGACY_RUNS} AND ${c.runId} = ?`, runId);
	}

	/** Latest event of each pending legacy run; the legacy tables are never modified. */
	async versions(executor: SqliteExecutor): Promise<RunVersionRow[]> {
		return executor.all<RunVersionRow>(
			`SELECT pending.${c.runId}, ${latestEventColumns(JOURNAL_TABLES.events, "pending")} FROM (${PENDING_LEGACY_RUNS}) AS pending`,
		);
	}

	/** Events of an unconverted legacy run, read in place. */
	async events(executor: SqliteExecutor, runId: string, fromSeq: number, limit: number): Promise<LegacyEventRow[]> {
		return executor.all<LegacyEventRow>(
			`SELECT ${LEGACY_COLUMNS.events.join(", ")} FROM ${JOURNAL_TABLES.events} WHERE ${c.runId} = ? AND ${c.seq} >= ? ORDER BY ${c.seq} LIMIT ?`,
			runId,
			fromSeq,
			limit,
		);
	}

	async eventByKey(executor: SqliteExecutor, runId: string, key: string): Promise<LegacyEventRow | undefined> {
		return executor.get<LegacyEventRow>(
			`SELECT ${LEGACY_COLUMNS.events.join(", ")} FROM ${JOURNAL_TABLES.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
			runId,
			key,
		);
	}

	/** Convert one legacy run into `wf_*` inside the caller's transaction; returns whether it did. */
	async convert(tx: SqliteExecutor, runId: string): Promise<boolean> {
		if ((await this.find(tx, runId)) === undefined) return false;
		const eventColumns = LEGACY_COLUMNS.events.join(", ");
		await tx.run(
			`INSERT OR IGNORE INTO ${CURRENT.events}(${eventColumns}) SELECT ${eventColumns} FROM ${JOURNAL_TABLES.events} WHERE ${c.runId} = ?`,
			runId,
		);
		if (await hasLegacyTable(tx, "leases")) {
			await tx.run(
				`INSERT OR IGNORE INTO ${CURRENT.leases}(${c.runId}, ${c.holderId}, ${c.epoch}, ${c.renewedAt}) SELECT ${c.runId}, NULL, ${c.epoch}, ${c.renewedAt} FROM ${JOURNAL_TABLES.leases} WHERE ${c.runId} = ?`,
				runId,
			);
		}
		const runColumns = LEGACY_COLUMNS.runs.join(", ");
		await tx.run(
			`INSERT INTO ${CURRENT.runs}(${runColumns}) SELECT ${runColumns} FROM ${JOURNAL_TABLES.runs} WHERE ${c.runId} = ?`,
			runId,
		);
		return true;
	}

	async markDeleted(tx: SqliteExecutor, runId: string): Promise<void> {
		if ((await tx.get(`SELECT ${c.runId} FROM ${JOURNAL_TABLES.runs} WHERE ${c.runId} = ?`, runId)) === undefined)
			return;
		await tx.run(`INSERT OR IGNORE INTO ${CURRENT.legacyDeleted} VALUES (?, ?)`, runId, Date.now());
	}
}
