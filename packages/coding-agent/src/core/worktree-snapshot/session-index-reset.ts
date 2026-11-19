import type { SqliteExecutor, SqliteRow } from "../storage/database.js";
import { SESSION_INDEX_RETIRED_PREFIX, type SnapshotIndexTables } from "./blob-store.ts";

/** Old index rows a single cleanup transaction can release. */
export const SESSION_RESET_BATCH = 1_000;
const RESERVE = 64 * 1024 * 1024;
const GENERATION = /^[0-9a-f]{32}$/;
const TYPES = ["sessionLinks", "sessionRefs", "sessionRecords"] as const;
type Family = (typeof TYPES)[number];

interface Retired {
	readonly source: string;
	readonly family: Family;
	readonly token: string;
}

/** No identifier read from a database is used as SQL until it has this closed grammar. */
function retiredSessionIndex(source: string): Retired | undefined {
	if (!source.startsWith(SESSION_INDEX_RETIRED_PREFIX)) return;
	const [family, token, extra] = source.slice(SESSION_INDEX_RETIRED_PREFIX.length).split(":");
	if (extra !== undefined || !token || !GENERATION.test(token)) return;
	for (const kind of TYPES) if (family === kind) return { source, family: kind, token };
}

function indexes(table: string, family: Family): readonly (readonly [string, string])[] {
	switch (family) {
		case "sessionLinks":
			return [
				[`${table}_entry`, "(session_id, entry_id)"],
				[`${table}_leaves`, "(session_id, anchor_seq) WHERE children = 0 AND anchor_seq IS NOT NULL"],
				[`${table}_broken`, "(session_id) WHERE broken = 1"],
			];
		case "sessionRecords":
			return [[`${table}_hash`, "(hash)"]];
		case "sessionRefs":
			return [];
	}
}

const retiredTable = (t: SnapshotIndexTables, r: Retired) => `${t[r.family]}_old_${r.token}`;
const receiptColumn = (r: Retired) => `retired_${r.token}`;

/** The table we actually retired, not an application table created under its old name after it was dropped. */
async function owns(tx: SqliteExecutor, t: SnapshotIndexTables, r: Retired): Promise<boolean> {
	return (
		(await tx.get(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`, retiredTable(t, r), receiptColumn(r))) !==
		undefined
	);
}

interface Schema extends SqliteRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

/** Only the old table and the indexes we are replacing may follow its rename. SQLite itself resolves dependencies,
 * including quoted views, foreign keys and triggers on other tables. An unrelated broken view can also prevent a
 * rename: the trial is rolled back and the original DELETE remains available in the same transaction. */
async function detach(tx: SqliteExecutor, t: SnapshotIndexTables, family: Family, token: string): Promise<boolean> {
	const table = t[family];
	const source = `${SESSION_INDEX_RETIRED_PREFIX}${family}:${token}`;
	const receipt: Retired = { source, family, token };
	const old = retiredTable(t, receipt);
	const defs = indexes(table, family);
	// Outgoing foreign keys do not follow a rename in another object's SQL. Retaining those rows would keep
	// the application's parent alive after the reset, or prevent its deletion.
	if (await tx.get("SELECT 1 FROM pragma_foreign_key_list(?) LIMIT 1", table)) return false;
	const schema = await tx.all<Schema>("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name = ?", table);
	const create = schema.find((row) => row.type === "table")?.sql;
	if (!create) return false;
	const known = new Set([old]);
	for (const row of schema) {
		if (row.type === "table" || (row.type === "index" && row.sql === null)) continue;
		if (
			row.type !== "index" ||
			!defs.some(
				([name, expression]) =>
					(row.name === name ||
						(row.name.startsWith(`${name}_`) && GENERATION.test(row.name.slice(name.length + 1)))) &&
					(row.sql === `CREATE INDEX ${row.name} ON ${table} ${expression}` ||
						row.sql === `CREATE INDEX ${row.name} ON "${table}" ${expression}`),
			)
		)
			return false;
		known.add(row.name);
	}
	try {
		await tx.exec(`ALTER TABLE ${table} RENAME TO ${old}`);
	} catch {
		// SQLite recompiles the schema when renaming. Even an unrelated invalid view can prevent it. The caller
		// rolls the trial back; if the transaction itself failed, the rollback propagates that failure.
		return false;
	}
	const moved = await tx.all<Schema>(
		"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE instr(lower(sql), ?) > 0",
		old.toLowerCase(),
	);
	if (
		moved.some((object) => !known.has(object.name)) ||
		(await tx.get("SELECT 1 FROM sqlite_temp_schema WHERE instr(lower(sql), ?) > 0 LIMIT 1", old.toLowerCase()))
	)
		return false;
	// RENAME changes only the schema. ADD COLUMN would revalidate every row of a STRICT table, freezing the
	// opener even if the added column is nullable. Leave the primary key intact for bounded cleanup.
	const unused = { sessionLinks: "entry_id", sessionRefs: "root", sessionRecords: "snapshot_id" }[family];
	await tx.exec(`ALTER TABLE ${old} RENAME COLUMN ${unused} TO ${receiptColumn(receipt)}`);
	await tx.exec(create);
	for (const [name, expression] of defs) {
		const occupied = await tx.get("SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE", name);
		await tx.exec(`CREATE INDEX ${occupied ? `${name}_${token}` : name} ON ${table} ${expression}`);
	}
	await tx.run(`INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, 0, 0)`, source);
	return true;
}

/** Publish main's empty active tables in the same transaction as its normal triggers and progress. Unmodified peers
 * always see the same generations and backfill progress as before; no older release knows or writes retired tables. */
export async function detachSessionIndex(
	tx: SqliteExecutor,
	t: SnapshotIndexTables,
	triggers: readonly string[],
	available: number,
): Promise<boolean> {
	if (!Number.isFinite(available) || available < RESERVE) return false;
	const hasMore = `${TYPES.map((family) => `SELECT 1 FROM ${t[family]}`).join(" UNION ALL ")} LIMIT 1 OFFSET ?`;
	if (!(await tx.get(hasMore, SESSION_RESET_BATCH))) return false;
	// Use a constant-time upper bound rather than counting index pages on Atomic's thread. The live index can reuse
	// free database pages; SQLite's WAL may also temporarily hold a second copy, as during the chunk-layout move.
	const size = await tx.get<{ used: number; free: number; growth: number }>(
		`SELECT (page_count-freelist_count)*page_size AS used, freelist_count*page_size AS free, (max_page_count-page_count)*page_size AS growth FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size(), pragma_max_page_count()`,
	);
	if (!size) return false;
	const bytes = Number(size.used);
	const growth = Math.max(0, bytes - Number(size.free));
	if (growth > Number(size.growth) || available < growth + bytes + RESERVE) return false;
	// Names from released sources must keep resolving through the active tables, not follow a retired generation.
	const temporary = [...triggers, ...TYPES.map((family) => t[family])];
	if (
		await tx.get(
			`SELECT 1 FROM sqlite_temp_schema WHERE name COLLATE NOCASE IN (${temporary.map(() => "?").join(",")}) LIMIT 1`,
			...temporary,
		)
	)
		return false;
	const token = crypto.randomUUID().replaceAll("-", "");
	await tx.exec("SAVEPOINT atomic_snapshot_detach");
	let ok = false;
	try {
		for (const name of triggers) await tx.exec(`DROP TRIGGER IF EXISTS ${name}`);
		for (const family of TYPES) if (!(await detach(tx, t, family, token))) return false;
		ok = true;
		return true;
	} catch (error) {
		// A schema that SQLite cannot rewrite is still a valid store for the old reset. Do not mask I/O failures.
		if (error instanceof Error && /error in (?:view|trigger|table)|already exists/i.test(error.message)) return false;
		throw error;
	} finally {
		if (!ok) await tx.exec("ROLLBACK TO atomic_snapshot_detach");
		await tx.exec("RELEASE atomic_snapshot_detach");
	}
}

/** Recheck the receipt under the writer lock: another collector can finish (or the user can replace the table)
 * at any yield. Committed removals are the restart cursor, including after a lost commit reply. */
export async function drainRetiredSessionIndex(
	tx: SqliteExecutor,
	t: SnapshotIndexTables,
	source: string,
): Promise<boolean> {
	const r = retiredSessionIndex(source);
	if (!r) return true;
	const row = await tx.get(`SELECT 1 FROM ${t.sources} WHERE source = ? AND backfilled_through = 0`, r.source);
	if (!row) return true;
	const table = retiredTable(t, r);
	if (await owns(tx, t, r)) {
		const key =
			r.family === "sessionLinks"
				? "rowid"
				: r.family === "sessionRefs"
					? "session_id, seq"
					: "session_id, seq, hash";
		const { changes } = await tx.run(
			`DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT ?)`,
			SESSION_RESET_BATCH,
		);
		if (changes === SESSION_RESET_BATCH) return false;
		const original = indexes(t[r.family], r.family).map(([name]) => name);
		if (
			original.length &&
			(await tx.get(
				`SELECT 1 FROM sqlite_schema WHERE tbl_name = ? AND name IN (${original.map(() => "?").join(",")})`,
				table,
				...original,
			))
		) {
			// SQLite cannot rename an index. Keep its now-empty roots so a released initializer's CREATE INDEX IF NOT
			// EXISTS does not rebuild a duplicate on a large live table. Only one shell per original name can remain.
			await tx.run(`UPDATE ${t.sources} SET backfilled_through = 1 WHERE source = ?`, r.source);
			return true;
		}
		await tx.exec(`DROP TABLE ${table}`);
	}
	await tx.run(`DELETE FROM ${t.sources} WHERE source = ?`, r.source);
	return true;
}
