import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "../database.js";
import { dialectOf, postgresJsonb, type StorageDialect } from "../dialect.js";
import { ensureStorageSchemaOnce, storageSchemaCurrent } from "../migrations.js";
import { storageMigrationTable } from "../prefix.js";
import { type StorageSchemaCatalog, schemaCatalogOf } from "../schema-catalog.js";
import { queueSqliteSchemaSetup } from "../sqlite-open-batch.js";

export const CAPTURE_HEADING = "snapshot_capture_heading";
const OPEN_BUILD_BYTES = 16 * 1024 * 1024;

export function captureHeadingIndex(dialect: StorageDialect, entries: string): string {
	return dialect.identifier(`${entries}_capture_heading`);
}

const captureSchema = (prefix: string | undefined) => ({
	ledger: storageMigrationTable(prefix),
	domain: "session-capture-headings",
	revision: 1,
});

/** Only the fields the resume compares; do not copy the potentially large snapshot body. */
function heading(dialect: StorageDialect, body: string, chunks: string): string {
	const pg = dialect.name === "postgres";
	const entry = (key: string) => (pg ? `p->>'${key}'` : dialect.jsonText("p", key));
	const type = (key: string) => (pg ? `jsonb_typeof(p->'${key}')` : dialect.jsonType("p", key));
	const value = dialect.jsonObject([
		["root", entry("root")],
		["snapshotId", entry("snapshotId")],
		["timestamp", entry("timestamp")],
		["restore", entry("restore")],
		[
			"capture",
			`CASE WHEN ${type("captureMs")} IS NOT NULL AND ${type("restore")} IS NULL AND ${type("unrestored")} IS NULL THEN 1 ELSE 0 END`,
		],
		["chunks", chunks],
	]);
	return `(SELECT CASE WHEN ${entry("type")}='worktree_snapshot' THEN CAST(${value} AS TEXT) END
		FROM (SELECT ${pg ? postgresJsonb(body) : body} AS p${pg ? " OFFSET 0" : " LIMIT -1 OFFSET 0"}) parsed)`;
}

/** Generated Atomic messages with an exact first key and a known non-snapshot type need no JSON decoding. */
function couldBeCapture(body: string): string {
	return ["message", "custom", "custom_message", "compaction"]
		.map((type) => {
			const prefix = `{"type":"${type}"`;
			return `substr(${body},1,${prefix.length}) <> '${prefix}'`;
		})
		.join(" AND ");
}

async function prepareHeadings(tx: SqliteExecutor, dialect: StorageDialect, entries: string): Promise<void> {
	const exists = dialect.columnExists(entries, CAPTURE_HEADING);
	if (!(await tx.get(exists.sql, ...exists.params)))
		await tx.exec(`ALTER TABLE ${entries} ADD COLUMN ${CAPTURE_HEADING} TEXT`);
	const trigger = (suffix: string) => dialect.identifier(`${entries}_capture_${suffix}`);
	const project = heading(dialect, "NEW.entry_json", "NEW.chunks");
	const candidate = couldBeCapture("NEW.entry_json");
	if (dialect.name === "postgres") {
		const fn = trigger("head_fn");
		await tx.exec(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $capture$
			BEGIN NEW.${CAPTURE_HEADING} := CASE WHEN ${candidate} THEN ${project} END; RETURN NEW; END $capture$;
			CREATE OR REPLACE TRIGGER ${trigger("head")}
				BEFORE INSERT OR UPDATE OF entry_json,chunks ON ${entries} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
	} else {
		for (const [event, suffix, when] of [
			["INSERT", "insert", candidate],
			["UPDATE OF entry_json,chunks", "update", `(${candidate}) OR OLD.${CAPTURE_HEADING} IS NOT NULL`],
		] as const) {
			await tx.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger(suffix)} AFTER ${event} ON ${entries} WHEN ${when} BEGIN
				UPDATE ${entries} SET ${CAPTURE_HEADING}=CASE WHEN ${candidate} THEN ${project} END
				WHERE session_id=NEW.session_id AND seq=NEW.seq; END`);
		}
	}
}

async function backfill(tx: SqliteExecutor, dialect: StorageDialect, entries: string): Promise<void> {
	// Snapshots are normally the only old rows that match the second condition. The first-key fast path leaves other
	// entries alone; an older or externally inserted entry not written in Atomic's key order is checked as JSON.
	const body = "entry_json";
	const kind = dialect.jsonText(body, "type");
	await tx.exec(`UPDATE ${entries} SET ${CAPTURE_HEADING}=${heading(dialect, body, "chunks")}
		WHERE ${CAPTURE_HEADING} IS NULL AND CASE WHEN ${couldBeCapture(body)} THEN ${kind}='worktree_snapshot' ELSE false END`);
}

function createIndex(dialect: StorageDialect, entries: string, concurrently = false): string {
	return `CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}IF NOT EXISTS ${captureHeadingIndex(dialect, entries)}
		ON ${entries} (session_id,seq) WHERE ${CAPTURE_HEADING} IS NOT NULL`;
}

async function postgresState(database: SqliteDatabase, entries: string) {
	const found = await database.get<
		SqliteRow & { owned: boolean | number; bytes: number; valid: boolean | number | null; building: boolean | number }
	>(
		`SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned,
			pg_catalog.pg_total_relation_size(c.oid) AS bytes,
			(SELECT x.indisvalid FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
				WHERE x.indrelid=c.oid AND i.relname=?) AS valid,
			EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index p WHERE p.relid=c.oid) AS building
		FROM pg_catalog.pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=?`,
		captureHeadingIndex(dialectOf(database), entries),
		entries,
	);
	if (found === undefined) return undefined;
	const truth = (value: boolean | number) => value === true || Number(value) === 1;
	return {
		owned: truth(found.owned),
		bytes: Number(found.bytes),
		building: truth(found.building),
		valid: found.valid === null ? null : truth(found.valid),
	};
}

/** New stores and SQLite build on open. A large PostgreSQL store or a runtime role keeps the slow compatible read. */
export async function ensureCaptureHeadings(
	database: SqliteDatabase,
	entries: string,
	prefix?: string,
): Promise<boolean> {
	const schema = captureSchema(prefix);
	const dialect = dialectOf(database);
	const sqliteReady = (catalog: StorageSchemaCatalog | undefined) =>
		catalog?.hasColumn(entries, CAPTURE_HEADING) === true &&
		catalog.hasObject(captureHeadingIndex(dialect, entries)) &&
		catalog.hasObject(`${entries}_capture_insert`) &&
		catalog.hasObject(`${entries}_capture_update`);
	// SQLite publishes the projection, its backfill, and its index together. The open's existing catalog suffices;
	// reading schema stamps separately would add a connection-thread wait to every resume of a current store.
	const ready =
		dialect.name === "sqlite"
			? sqliteReady(await schemaCatalogOf(database, schema.ledger))
			: await storageSchemaCurrent(database, schema);
	if (ready) return true;
	if (database.readOnly === true) return false;
	if (dialect.name === "postgres") {
		const found = await postgresState(database, entries);
		if (!found?.owned || Number(found.bytes) > OPEN_BUILD_BYTES || found.valid === false || found.building)
			return false;
	}
	const setup = async (tx: SqliteExecutor) => {
		await prepareHeadings(tx, dialect, entries);
		await backfill(tx, dialect, entries);
		await tx.exec(createIndex(dialect, entries));
	};
	// Share the SQLite open's transaction and its final schema version stamp with the other session tables.
	if (
		!queueSqliteSchemaSetup(database, schema.ledger, {
			stamp: schema,
			done: (catalog) => sqliteReady(catalog),
			async run(ctx) {
				await ctx.flushWrites();
				await setup(ctx.tx);
			},
		})
	)
		await ensureStorageSchemaOnce(database, schema, setup);
	return true;
}

/** Explicit PostgreSQL migration: put the trigger in place before backfill, then build the index without blocking writes. */
export async function migrateCaptureHeadings(
	database: SqliteDatabase,
	entries: string,
	prefix?: string,
): Promise<boolean> {
	const dialect = dialectOf(database);
	if (dialect.name !== "postgres") return false;
	let found = await postgresState(database, entries);
	if (!found?.owned) return false;
	const schema = captureSchema(prefix);
	const ledger = dialect.tableExists(schema.ledger);
	if (await database.get(ledger.sql, ...ledger.params)) {
		const recorded = await database.get(
			`SELECT 1 AS ready FROM ${schema.ledger} WHERE domain=? AND version>=?`,
			`schema:${schema.domain}`,
			schema.revision,
		);
		if (recorded && found.valid === true) return false;
	}
	await ensureStorageSchemaOnce(database, { ...schema, domain: `${schema.domain}-trigger` }, (tx) =>
		prepareHeadings(tx, dialect, entries),
	);
	await backfill(database, dialect, entries);
	// The adapter opens each statement below outside a transaction. Never record the step for an unfinished index.
	for (;;) {
		found = await postgresState(database, entries);
		if (!found?.owned) return false;
		if (found.valid === true) break;
		if (found.building) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			continue;
		}
		if (found.valid === false)
			await database.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${captureHeadingIndex(dialect, entries)}`);
		await database.exec(createIndex(dialect, entries, true));
	}
	await ensureStorageSchemaOnce(database, schema, async () => {});
	return true;
}
