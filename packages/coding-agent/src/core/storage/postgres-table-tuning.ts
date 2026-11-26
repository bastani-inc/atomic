import type { SqliteDatabase, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";
import { storageMigrationTable, validateStoragePrefix } from "./prefix.js";

/** A table `atomic storage migrate` tunes on PostgreSQL, named without the storage prefix. */
interface TableTuning {
	readonly table: string;
	/** Columns of large text, JSON or bytes whose new values PostgreSQL compresses with lz4, where the server has it. */
	readonly lz4?: readonly string[];
	/** Autovacuum storage parameters, set only where the table has no value of its own for them. */
	readonly autovacuum?: Readonly<Record<string, number>>;
}

/**
 * Small tables whose rows change constantly: autovacuum cleans them after a fixed number of dead rows, instead of after
 * a fifth of the table, which on a table that keeps every session's row ever written is thousands of dead rows that
 * reads and index scans step over.
 */
const BUSY = (threshold: number) => ({
	autovacuum_vacuum_scale_factor: 0,
	autovacuum_vacuum_threshold: threshold,
	autovacuum_analyze_scale_factor: 0,
	autovacuum_analyze_threshold: threshold,
});

/**
 * Every table `atomic storage migrate` tunes. lz4 compresses large values about as well as PostgreSQL's default, pglz,
 * in about half the time, and decompresses them faster, so saves and reads of large entries, blobs and Intercom
 * frames spend less time compressing. The search tables are tuned by the search index's own setup.
 */
const TUNINGS: readonly TableTuning[] = [
	{ table: "session_sessions", autovacuum: BUSY(500) },
	{ table: "intercom_leases", autovacuum: BUSY(500) },
	{ table: "snapshot_session_links", autovacuum: BUSY(1000) },
	{ table: "session_entries", lz4: ["entry_json"] },
	{ table: "session_entry_chunks", lz4: ["data"] },
	{ table: "session_blob_chunks", lz4: ["data"] },
	{ table: "session_chat_v1", lz4: ["data"] },
	{ table: "snapshot_blobs", lz4: ["data"] },
	{ table: "snapshot_blob_chunks", lz4: ["data"] },
	{ table: "intercom_outbox", lz4: ["frame_json"] },
];

/** How long a change waits for its table's lock before it gives up, leaving that table for the next migrate. */
const TUNING_LOCK_WAIT_MS = 2_000;

export interface PostgresTableTuningResult {
	/** The tables changed, prefixed. */
	readonly tuned: readonly string[];
	/** The tables left unchanged because another process held them longer than the lock wait, prefixed. */
	readonly busy: readonly string[];
	/** Whether the server compresses with lz4: false where it was built without it. */
	readonly lz4: boolean;
}

/**
 * Applies {@link TUNINGS} to the tables under `prefix` on PostgreSQL, for `atomic storage migrate`, as their owner. Each
 * table's missing settings change in one `ALTER TABLE` of its own, a catalog change that rewrites nothing: lz4 applies
 * to values written from then on, and values already stored stay readable as they are. A setting the table already has,
 * such as one an administrator chose, is kept. Tables this role does not own, and those that do not exist, are skipped.
 * Nothing runs on other databases, or where every table is tuned already.
 */
export async function tunePostgresStorageTables(
	database: SqliteDatabase,
	prefix: string | undefined,
): Promise<PostgresTableTuningResult> {
	const dialect = dialectOf(database);
	if (dialect.name !== "postgres") return { tuned: [], busy: [], lz4: false };
	const validated = validateStoragePrefix(prefix, "postgres");
	const named = TUNINGS.map((tuning) => ({ ...tuning, table: `${validated}${tuning.table}` }));
	const support = await database.get<SqliteRow & { lz4: boolean | number }>(
		`SELECT coalesce('lz4' = ANY(enumvals), false) AS lz4 FROM pg_catalog.pg_settings WHERE name = 'default_toast_compression'`,
	);
	const lz4 = support?.lz4 === true || Number(support?.lz4) === 1;
	const rows = await database.all<
		SqliteRow & { name: string; owned: boolean | number; options: string | null; lz4_columns: string | null }
	>(
		`SELECT c.relname AS name, pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned,
			array_to_string(c.reloptions, ',') AS options,
			(SELECT string_agg(a.attname, ',') FROM pg_catalog.pg_attribute a
				WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attcompression = 'l') AS lz4_columns
		FROM pg_catalog.pg_class c
		WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
			AND c.relname = ANY(ARRAY(SELECT value FROM ${dialect.jsonValues("?")}))`,
		JSON.stringify(named.map((tuning) => dialect.identifier(tuning.table))),
	);
	const found = new Map(rows.map((row) => [row.name, row]));
	const tuned: string[] = [];
	const busy: string[] = [];
	for (const tuning of named) {
		const row = found.get(dialect.identifier(tuning.table));
		if (row === undefined || !(row.owned === true || Number(row.owned) === 1)) continue;
		const present = new Set((row.options ?? "").split(",").map((option) => option.split("=")[0]));
		const settings = Object.entries(tuning.autovacuum ?? {}).filter(([name]) => !present.has(name));
		const compressed = new Set((row.lz4_columns ?? "").split(","));
		const columns = lz4 ? (tuning.lz4 ?? []).filter((column) => !compressed.has(column)) : [];
		const changes = [
			...(settings.length === 0
				? []
				: [`SET (${settings.map(([name, value]) => `${name} = ${value}`).join(", ")})`]),
			...columns.map((column) => `ALTER COLUMN ${column} SET COMPRESSION lz4`),
		];
		if (changes.length === 0) continue;
		try {
			await database.transaction(
				async (tx) => {
					await tx.exec(`SET LOCAL lock_timeout = ${TUNING_LOCK_WAIT_MS}`);
					await tx.exec(`ALTER TABLE ${tuning.table} ${changes.join(", ")}`);
				},
				{ concurrency: { kind: "serial", domain: storageMigrationTable(prefix) } },
			);
			tuned.push(tuning.table);
		} catch (error) {
			if (!isLockTimeout(error)) throw error;
			busy.push(tuning.table);
		}
	}
	return { tuned, busy, lz4 };
}

/** Whether `error`, or an error it wraps, is a lock wait that ran out: PostgreSQL's 55P03 or the facade's lock conflict. */
function isLockTimeout(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const code = (current as { code?: unknown }).code;
		if (code === "55P03" || code === "lock-conflict") return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}
