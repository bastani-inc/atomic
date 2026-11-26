import {
	dialectOf,
	type SqliteDatabase,
	type SqliteRow,
	type SqliteValue,
	type StorageDialect,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import { isMissingPrivilege } from "./sql-add-column.js";
import { brokerSchemaCurrent, ensureBrokerSchema, openCatalogOf } from "./sql-schema.js";

/** The most rows one retention statement deletes, as River's job cleaner and Oban's pruner bound theirs. */
export const RETENTION_DELETE_BATCH = 1_000;
/** The most batches one prune of a table deletes; older rows left over wait for the next maintenance. */
const RETENTION_DELETE_BATCHES = 100;

/**
 * The database clock in milliseconds, read once for the whole statement. A retention filter compares a column to it,
 * `column < ${storeNow} - ?`, so the column's index answers the filter: PostgreSQL's clock (`clock_timestamp()`) is
 * volatile, and a comparison with a volatile expression is never an index condition, while a subquery's value is.
 */
export function storeNow(database: SqliteDatabase): string {
	return `(SELECT ${dialectOf(database).nowMs})`;
}

/** The rows of `table` that one retention prune deletes. */
export interface RetentionDelete {
	readonly table: string;
	/** A column that names each row on its own, such as the primary key. */
	readonly key: string;
	/** The rows to delete: `where`, with `params`, in which `orderBy` is the column an index orders them by. */
	readonly where: string;
	readonly params: readonly SqliteValue[];
	readonly orderBy: string;
}

/**
 * Deletes the rows `request` names, at most `RETENTION_DELETE_BATCH` per statement, until a batch finds fewer, as River's
 * `JobDeleteBefore` and Oban's `prune_jobs` do: each statement reads its rows from the index `orderBy` is the column of
 * and holds their locks only while it runs, so a large backlog never becomes one long statement. Resolves to the number
 * of rows deleted.
 */
export async function deleteInBatches(database: SqliteDatabase, request: RetentionDelete): Promise<number> {
	const { table, key, where, params, orderBy } = request;
	const batch = `SELECT ${key} FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ?`;
	// PostgreSQL: the keys as one array, so the delete finds each row by its key's index; `IN (SELECT …)` can join the
	// whole table instead.
	const sql =
		dialectOf(database).name === "postgres"
			? `DELETE FROM ${table} WHERE ${key} = ANY(ARRAY(${batch}))`
			: `DELETE FROM ${table} WHERE ${key} IN (${batch})`;
	let deleted = 0;
	for (let round = 0; round < RETENTION_DELETE_BATCHES; round++) {
		const { changes } = await database.run(sql, ...params, RETENTION_DELETE_BATCH);
		deleted += changes;
		if (changes < RETENTION_DELETE_BATCH) break;
	}
	return deleted;
}

/** The rows still to deliver: every query of a recipient's undelivered rows names them with this text exactly. */
export const UNDELIVERED = "state IN ('queued', 'claimed')";
/** The settled outbox rows, which retention deletes. */
export const SETTLED = "state IN ('delivered', 'failed')";
/**
 * The outbox's fillfactor on PostgreSQL: each page keeps room for new versions of its rows, so a claim's renewal or a
 * save report, which changes no indexed column, stays on its page as a HOT update.
 */
const OUTBOX_FILLFACTOR = 85;

/**
 * The indexes that keep the broker state's maintenance and sweeps off full scans, created once per database at the end
 * of a broker's open, when every table and column they need is there, as one schema step: `intercom-outbox-indexes`,
 * revision 2, so an older broker, which recorded revision 1 of it, creates nothing of its own again. On a new database
 * it is the one schema transaction the outbox's indexes always took.
 * - `<outbox>_undelivered`, `(target_identity, sequence)` over the undelivered rows only, with `frame_bytes` alongside:
 *   every claim, scan and send reads a recipient's undelivered rows in sequence order and sums their sizes from it. It
 *   holds no settled row, so it stays the size of what is still to deliver. SQLite has no `INCLUDE`: there `frame_bytes`
 *   is its last column.
 * - `<outbox>_settled`, `settled_at` over the settled rows, which retention deletes oldest first.
 * - `<released asks>_expires`, by which retention finds the expired released asks.
 * - `<known sessions>_lost` and `<pending asks>_ended`, partial: every broker's backup poll sweeps for the recipients
 *   and asks a stopped broker left, and reads only those, rather than every known session and pending ask.
 * The outbox's earlier indexes, `<outbox>_target` and `<outbox>_target_bytes`, keyed by `(target_identity, state, …)`,
 * are dropped: every claim and settlement changed a key of both. On PostgreSQL the outbox's fillfactor is set too.
 * A role that does not own the tables (a runtime role with only DML privileges) leaves all of it to `atomic storage
 * migrate`, run as the owner role, without trying; every query works without them.
 */
export async function ensureRetentionIndexes(database: SqliteDatabase, prefix: string | undefined): Promise<void> {
	const dialect = dialectOf(database);
	const named = validateStoragePrefix(prefix, dialect.name);
	const outbox = `${named}intercom_outbox`;
	const released = `${named}intercom_released_asks`;
	const known = `${named}intercom_known_sessions`;
	const pending = `${named}intercom_pending_asks`;
	const postgres = dialect.name === "postgres";
	if (await brokerSchemaCurrent(database, prefix, "outbox-indexes", 2)) return;
	const catalog = await openCatalogOf(database);
	// PostgreSQL: a table this open created is this role's; otherwise the role must own the outbox to change it.
	if (postgres && (catalog === undefined || catalog.hasTable(outbox))) {
		// A host whose storage API predates identifier hashing names every table as given.
		const name = (dialect as Partial<StorageDialect>).identifier?.(outbox) ?? outbox;
		const found = await database.get<SqliteRow & { owned: boolean | number }>(
			`SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned FROM pg_catalog.pg_class c
			WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ?`,
			name,
		);
		if (found === undefined || !(found.owned === true || Number(found.owned) === 1)) return;
	}
	const retired = [`${outbox}_target`, `${outbox}_target_bytes`];
	const undelivered = postgres
		? "(target_identity, sequence) INCLUDE (frame_bytes)"
		: "(target_identity, sequence, frame_bytes)";
	const created = [
		`CREATE INDEX IF NOT EXISTS ${outbox}_undelivered ON ${outbox}${undelivered} WHERE ${UNDELIVERED}`,
		`CREATE INDEX IF NOT EXISTS ${outbox}_settled ON ${outbox}(settled_at) WHERE ${SETTLED}`,
		`CREATE INDEX IF NOT EXISTS ${released}_expires ON ${released}(expires_at)`,
		`CREATE INDEX IF NOT EXISTS ${known}_lost ON ${known}(lost_at) WHERE lost_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS ${pending}_ended ON ${pending}(ended_at) WHERE ended_at IS NOT NULL AND replied IS NULL`,
	];
	const drops = retired.map((index) => `DROP INDEX IF EXISTS ${index}`);
	// SQLite, which records no step, runs only the creations in it, so an open whose catalog finds every index takes no
	// write transaction; the retired indexes are dropped apart.
	const script = postgres
		? [...created, ...drops, `ALTER TABLE ${outbox} SET (fillfactor = ${OUTBOX_FILLFACTOR})`]
		: created;
	try {
		await ensureBrokerSchema(database, prefix, "outbox-indexes", (tx) => tx.exec(script.join(";\n")), 2);
	} catch (error) {
		if (isMissingPrivilege(error)) return;
		throw error;
	}
	if (postgres) return;
	// An older broker's open recreates them where it records no step.
	const present =
		catalog?.sqliteObjectType === undefined
			? (await database.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)", ...retired))
					.length > 0
			: retired.some((index) => catalog.sqliteObjectType?.(index) === "index");
	if (present) await database.transaction((tx) => tx.exec(drops.join(";\n")));
}
