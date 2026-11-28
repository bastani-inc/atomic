import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "../database.js";
import { dialectOf, postgresJsonb, type StorageDialect } from "../dialect.js";
import * as migrations from "../migrations.js";
import { renderStorageIdentifiers, storageMigrationTable, validateStoragePrefix } from "../prefix.js";
import { type StorageSchemaCatalog, schemaCatalogOf } from "../schema-catalog.js";
import { queueSqliteSchemaSetup } from "../sqlite-open-batch.js";

/** Legacy inline column name retained for compatibility with earlier builds. */
export const CAPTURE_HEADING = "snapshot_capture_heading";

const CAPTURE_HEADING_TABLES = { captureHeadings: "capture_headings" } as const;
const BACKFILL_KEY_BATCH = 500;
const MIGRATE_REF_BATCH = 2_000;
const MIGRATE_ENTRY_BATCH = 4_000;

export function captureHeadingIndex(entries: string): string {
	return `${entries}_capture_heading`;
}

export function captureHeadingTable(prefix?: string): string {
	return renderStorageIdentifiers("sessions", CAPTURE_HEADING_TABLES, prefix).captureHeadings;
}

export interface CaptureHeadingKey {
	readonly owner: string;
	readonly seq: number;
}

const {
	ensureStorageSchemaOnce,
	withShortSchemaLockWaits,
}: Partial<Pick<typeof migrations, "ensureStorageSchemaOnce" | "withShortSchemaLockWaits">> = migrations;

const captureSchema = (prefix: string | undefined) => ({
	ledger: storageMigrationTable(prefix),
	domain: "session-capture-headings",
	revision: 2,
});

function captureTriggers(entries: string) {
	return {
		insert: `${entries}_capture_ins`,
		update: `${entries}_capture_upd`,
		delete: `${entries}_capture_del`,
	} as const;
}

function captureHeadingsReady(catalog: StorageSchemaCatalog | undefined, entries: string, table: string): boolean {
	if (catalog === undefined) return false;
	const triggers = captureTriggers(entries);
	return (
		catalog.hasTable(table) &&
		catalog.hasObject(triggers.insert) &&
		catalog.hasObject(triggers.update) &&
		catalog.hasObject(triggers.delete)
	);
}

/** Only the fields resume compares; never copies the potentially large snapshot body. */
export function captureHeadingProjection(dialect: StorageDialect, body: string, chunks: string): string {
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
		FROM (SELECT ${pg ? postgresJsonb(body) : sqliteHeadingBody(body)} AS p${pg ? " OFFSET 0" : " LIMIT -1 OFFSET 0"}) parsed)`;
}

function sqliteHeadingBody(body: string): string {
	return `CASE WHEN json_valid(${body}) THEN ${body} ELSE '{}' END`;
}

/** Generated Atomic messages with an exact first key and a known non-snapshot type need no JSON decoding. */
export function couldBeCaptureHeading(body: string): string {
	return ["message", "custom", "custom_message", "compaction"]
		.map((type) => {
			const prefix = `{"type":"${type}"`;
			return `substr(${body},1,${prefix.length}) <> '${prefix}'`;
		})
		.join(" AND ");
}

function createTableSql(dialect: StorageDialect, table: string): string {
	const { int, text } = dialect.types;
	return `CREATE TABLE IF NOT EXISTS ${table} (
			session_id ${text} NOT NULL, seq ${int} NOT NULL, chunks ${int} NOT NULL, heading ${text},
			PRIMARY KEY (session_id, seq)
		)${dialect.withoutRowidTableOptions}`;
}

function sqliteTriggers(dialect: StorageDialect, entries: string, table: string): string[] {
	const triggers = captureTriggers(entries);
	const project = captureHeadingProjection(dialect, "NEW.entry_json", "NEW.chunks");
	const candidate = couldBeCaptureHeading("NEW.entry_json");
	return [
		`CREATE TRIGGER IF NOT EXISTS ${triggers.insert} AFTER INSERT ON ${entries} WHEN ${candidate} BEGIN
				INSERT INTO ${table} (session_id, seq, chunks, heading)
				SELECT NEW.session_id, NEW.seq, NEW.chunks, h FROM (SELECT ${project} AS h) WHERE h IS NOT NULL
				ON CONFLICT(session_id, seq) DO UPDATE SET chunks=excluded.chunks, heading=excluded.heading; END`,
		`CREATE TRIGGER IF NOT EXISTS ${triggers.update} AFTER UPDATE OF session_id, seq, entry_json, chunks ON ${entries} BEGIN
				DELETE FROM ${table} WHERE (session_id=OLD.session_id AND seq=OLD.seq) OR (session_id=NEW.session_id AND seq=NEW.seq);
				INSERT INTO ${table} (session_id, seq, chunks, heading)
				SELECT NEW.session_id, NEW.seq, NEW.chunks, h FROM (SELECT CASE WHEN ${candidate} THEN ${project} END AS h) WHERE h IS NOT NULL
				ON CONFLICT(session_id, seq) DO UPDATE SET chunks=excluded.chunks, heading=excluded.heading; END`,
		`CREATE TRIGGER IF NOT EXISTS ${triggers.delete} AFTER DELETE ON ${entries} BEGIN
				DELETE FROM ${table} WHERE session_id=OLD.session_id AND seq=OLD.seq; END`,
	];
}

function postgresTriggers(dialect: StorageDialect, entries: string, table: string): string {
	const triggers = captureTriggers(entries);
	const project = captureHeadingProjection(dialect, "NEW.entry_json", "NEW.chunks");
	const candidate = couldBeCaptureHeading("NEW.entry_json");
	return `CREATE OR REPLACE FUNCTION ${triggers.insert}_fn() RETURNS trigger LANGUAGE plpgsql AS $capture$
		DECLARE h TEXT;
		BEGIN
			h := ${project};
			IF h IS NOT NULL THEN
				INSERT INTO ${table} (session_id, seq, chunks, heading) VALUES (NEW.session_id, NEW.seq, NEW.chunks, h)
				ON CONFLICT (session_id, seq) DO UPDATE SET chunks=excluded.chunks, heading=excluded.heading;
			END IF;
			RETURN NULL;
		END $capture$;
		CREATE OR REPLACE TRIGGER ${triggers.insert}
			AFTER INSERT ON ${entries} FOR EACH ROW WHEN (${candidate})
			EXECUTE FUNCTION ${triggers.insert}_fn();
		CREATE OR REPLACE FUNCTION ${triggers.update}_fn() RETURNS trigger LANGUAGE plpgsql AS $capture$
		DECLARE h TEXT;
		BEGIN
			DELETE FROM ${table} WHERE (session_id=OLD.session_id AND seq=OLD.seq) OR (session_id=NEW.session_id AND seq=NEW.seq);
			IF ${candidate} THEN
				h := ${project};
				IF h IS NOT NULL THEN
					INSERT INTO ${table} (session_id, seq, chunks, heading) VALUES (NEW.session_id, NEW.seq, NEW.chunks, h)
					ON CONFLICT (session_id, seq) DO UPDATE SET chunks=excluded.chunks, heading=excluded.heading;
				END IF;
			END IF;
			RETURN NULL;
		END $capture$;
		CREATE OR REPLACE TRIGGER ${triggers.update}
			AFTER UPDATE OF session_id, seq, entry_json, chunks ON ${entries} FOR EACH ROW
			EXECUTE FUNCTION ${triggers.update}_fn();
		CREATE OR REPLACE FUNCTION ${triggers.delete}_fn() RETURNS trigger LANGUAGE plpgsql AS $capture$
		BEGIN
			DELETE FROM ${table} h USING old_rows o WHERE h.session_id=o.session_id AND h.seq=o.seq;
			RETURN NULL;
		END $capture$;
		CREATE OR REPLACE TRIGGER ${triggers.delete}
			AFTER DELETE ON ${entries} REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
			EXECUTE FUNCTION ${triggers.delete}_fn()`;
}

async function prepareCaptureTableAndTriggers(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	entries: string,
	table: string,
): Promise<void> {
	await tx.exec(createTableSql(dialect, table));
	if (dialect.name === "postgres") await tx.exec(postgresTriggers(dialect, entries, table));
	else for (const statement of sqliteTriggers(dialect, entries, table)) await tx.exec(statement);
}

/** Empty PostgreSQL tables install the capture headings sidecar and triggers in the initial sessions transaction. */
export async function createPostgresCaptureHeadings(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	entries: string,
	prefix?: string,
): Promise<void> {
	const { ledger, domain, revision } = captureSchema(prefix);
	const table = captureHeadingTable(prefix);
	await tx.exec(`${createTableSql(dialect, table)};
		${postgresTriggers(dialect, entries, table)};`);
	await tx.run(
		`INSERT INTO ${ledger} (domain,version,applied_at) VALUES (?,?,${dialect.nowMs}) ON CONFLICT DO NOTHING`,
		`schema:${domain}`,
		revision,
	);
}

async function postgresEntriesOwned(database: SqliteDatabase, entries: string): Promise<boolean> {
	const row = await database.get<SqliteRow & { owned: boolean | number }>(
		`SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned
		FROM pg_catalog.pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=?`,
		dialectOf(database).identifier(entries),
	);
	return row !== undefined && (row.owned === true || Number(row.owned) === 1);
}

async function postgresObjectsPresent(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	entries: string,
	table: string,
): Promise<boolean> {
	const triggers = captureTriggers(entries);
	const probe = dialect.schemaObjects([table, triggers.insert, triggers.update, triggers.delete]);
	return (await executor.all(probe.sql, ...probe.params)).length === 4;
}

/**
 * Installs only the O(1) capture-heading table and triggers on open, never altering or scanning `session_entries`.
 * Pre-existing rows are populated lazily per session on first read, or in bounded batches by `atomic storage migrate`.
 */
export async function ensureCaptureHeadings(
	database: SqliteDatabase,
	entries: string,
	prefix?: string,
): Promise<boolean> {
	const schema = captureSchema(prefix);
	const dialect = dialectOf(database);
	const table = captureHeadingTable(prefix);
	const catalog = await schemaCatalogOf(database, schema.ledger);
	if (captureHeadingsReady(catalog, entries, table)) return true;
	if (
		dialect.name === "postgres" &&
		catalog === undefined &&
		(await postgresObjectsPresent(database, dialect, entries, table))
	)
		return true;
	if (database.readOnly === true) return false;
	if (dialect.name === "sqlite") {
		const setup = (tx: SqliteExecutor) => prepareCaptureTableAndTriggers(tx, dialect, entries, table);
		if (
			!queueSqliteSchemaSetup(database, schema.ledger, {
				done: (fresh) => captureHeadingsReady(fresh, entries, table),
				run(ctx) {
					if (captureHeadingsReady(ctx.catalog, entries, table)) return;
					if (!ctx.tableExisted(table)) {
						ctx.enqueue(createTableSql(dialect, table));
						ctx.noteTableCreated(table);
					}
					for (const statement of sqliteTriggers(dialect, entries, table)) ctx.enqueue(statement);
				},
			})
		)
			await database.transaction(setup, { retryTransientFailures: true });
		return true;
	}
	if (!(await postgresEntriesOwned(database, entries))) return false;
	try {
		await database.transaction(
			async (tx) => {
				if (await postgresObjectsPresent(tx, dialect, entries, table)) return;
				const run = () => prepareCaptureTableAndTriggers(tx, dialect, entries, table);
				if (withShortSchemaLockWaits !== undefined) await withShortSchemaLockWaits(tx, dialect, run);
				else await run();
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial", domain: schema.ledger } },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Lazily populates capture headings for a bounded list of `(owner, seq)` keys missed during a read.
 * Re-reads fresh rows inside the write transaction (`FOR SHARE OF e SKIP LOCKED` on PostgreSQL) so concurrent deletes
 * or updates can never leave stale or resurrected rows.
 */
export async function backfillCaptureHeadingKeys(
	database: SqliteDatabase,
	entries: string,
	table: string,
	keys: readonly CaptureHeadingKey[],
): Promise<void> {
	if (keys.length === 0 || database.readOnly === true) return;
	const unique = new Map<string, CaptureHeadingKey>();
	for (const key of keys) unique.set(`${key.owner}\0${key.seq}`, key);
	const sorted = [...unique.values()].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.seq - b.seq));
	const dialect = dialectOf(database);
	const pg = dialect.name === "postgres";
	const candidate = couldBeCaptureHeading("e.entry_json");
	const project = captureHeadingProjection(dialect, "e.entry_json", "e.chunks");
	const requested = pg
		? "SELECT owner, seq FROM jsonb_to_recordset((?)::jsonb) AS r(owner TEXT, seq BIGINT)"
		: `SELECT ${dialect.jsonText("value", "owner")} AS owner, CAST(${dialect.jsonText("value", "seq")} AS INTEGER) AS seq FROM ${dialect.jsonValues("?")}`;
	const sql = pg
		? `WITH keys AS (${requested}),
			locked AS MATERIALIZED (
				SELECT e.session_id, e.seq, e.chunks,
					CASE WHEN ${candidate} THEN ${project} END AS heading
				FROM keys k
				JOIN ${entries} e ON e.session_id = k.owner AND e.seq = k.seq
				ORDER BY e.session_id, e.seq
				FOR SHARE OF e SKIP LOCKED
			)
			INSERT INTO ${table} (session_id, seq, chunks, heading)
			SELECT session_id, seq, CASE WHEN heading IS NOT NULL THEN chunks ELSE 0 END, heading
			FROM locked
			ON CONFLICT (session_id, seq) DO NOTHING`
		: `WITH keys AS (${requested}),
			projected AS (
				SELECT e.session_id, e.seq, e.chunks,
					CASE WHEN ${candidate} THEN ${project} END AS heading
				FROM keys k
				JOIN ${entries} e ON e.session_id = k.owner AND e.seq = k.seq
				WHERE json_valid(e.entry_json)
			)
			INSERT INTO ${table} (session_id, seq, chunks, heading)
			SELECT session_id, seq, CASE WHEN heading IS NOT NULL THEN chunks ELSE 0 END, heading
			FROM projected WHERE true
			ON CONFLICT (session_id, seq) DO NOTHING`;
	for (let start = 0; start < sorted.length; start += BACKFILL_KEY_BATCH) {
		const batch = sorted.slice(start, start + BACKFILL_KEY_BATCH);
		await database.transaction((tx) => tx.run(sql, JSON.stringify(batch)), { retryTransientFailures: true });
	}
}

async function hasCompleteSnapshotRefs(
	database: SqliteDatabase,
	dialect: StorageDialect,
	entries: string,
	prefix: string | undefined,
): Promise<string | undefined> {
	const validated = validateStoragePrefix(prefix);
	const sessionRefs = `${validated}snapshot_session_refs`;
	const sources = `${validated}snapshot_index_sources`;
	const probe = dialect.schemaObjects([sessionRefs, sources, `${entries}_snapshot_refs`]);
	if ((await database.all(probe.sql, ...probe.params)).length !== 3) return undefined;
	const complete = await database.get<SqliteRow & { ready: number | boolean }>(
		`SELECT 1 AS ready FROM ${sources}
		WHERE source = 'session-entries' AND watermark >= 0 AND backfilled_through >= watermark
			AND NOT EXISTS (SELECT 1 FROM ${sources} WHERE source = 'session-entries@rebuild')`,
	);
	return complete === undefined ? undefined : sessionRefs;
}

async function backfillSingleRowLocked(
	database: SqliteDatabase,
	dialect: StorageDialect,
	entries: string,
	table: string,
	owner: string,
	seq: number,
): Promise<void> {
	const candidate = couldBeCaptureHeading("e.entry_json");
	const project = captureHeadingProjection(dialect, "e.entry_json", "e.chunks");
	await database.transaction(
		(tx) =>
			tx.run(
				`WITH locked AS MATERIALIZED (
					SELECT e.session_id, e.seq, e.chunks,
						CASE WHEN ${candidate} THEN ${project} END AS heading
					FROM ${entries} e
					WHERE e.session_id = ? AND e.seq = ?
					FOR SHARE OF e
				)
				INSERT INTO ${table} (session_id, seq, chunks, heading)
				SELECT session_id, seq, chunks, heading
				FROM locked
				WHERE heading IS NOT NULL
				ON CONFLICT (session_id, seq) DO NOTHING`,
				owner,
				seq,
			),
		{ retryTransientFailures: true },
	);
}

/**
 * Explicit migration (`atomic storage migrate`): installs the O(1) sidecar table and triggers, then backfills
 * pre-existing snapshots in bounded, crash-resumable batches without altering or scanning indexes on `session_entries`.
 * Uses `snapshot_session_refs` when its index is complete so large databases skip non-snapshot entries altogether.
 */
export async function migrateCaptureHeadings(
	database: SqliteDatabase,
	entries: string,
	prefix?: string,
): Promise<boolean> {
	if (database.readOnly === true) return false;
	const dialect = dialectOf(database);
	const pg = dialect.name === "postgres";
	const table = captureHeadingTable(prefix);
	const schema = captureSchema(prefix);
	if (pg) {
		if (ensureStorageSchemaOnce === undefined) return false;
		if (!(await postgresEntriesOwned(database, entries))) return false;
		const ledgerProbe = dialect.tableExists(schema.ledger);
		if (await database.get(ledgerProbe.sql, ...ledgerProbe.params)) {
			const recorded = await database.get(
				`SELECT 1 AS ready FROM ${schema.ledger} WHERE domain=? AND version>=?`,
				`schema:${schema.domain}`,
				schema.revision,
			);
			if (recorded && (await postgresObjectsPresent(database, dialect, entries, table))) return false;
		}
		await database.transaction(
			async (tx) => {
				if (await postgresObjectsPresent(tx, dialect, entries, table)) return;
				const run = () => prepareCaptureTableAndTriggers(tx, dialect, entries, table);
				if (withShortSchemaLockWaits !== undefined) await withShortSchemaLockWaits(tx, dialect, run);
				else await run();
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial", domain: schema.ledger } },
		);
	} else {
		const entriesProbe = dialect.tableExists(entries);
		if ((await database.get(entriesProbe.sql, ...entriesProbe.params)) === undefined) return false;
		const triggers = captureTriggers(entries);
		const probe = dialect.schemaObjects([table, triggers.insert, triggers.update, triggers.delete]);
		const existed = (await database.all(probe.sql, ...probe.params)).length === 4;
		if (!existed) {
			await database.transaction((tx) => prepareCaptureTableAndTriggers(tx, dialect, entries, table), {
				retryTransientFailures: true,
			});
		}
		const refsTable = await hasCompleteSnapshotRefs(database, dialect, entries, prefix);
		const inserted = await runBatchedMigrate(database, dialect, entries, table, refsTable);
		return !existed || inserted > 0;
	}
	const refsTable = await hasCompleteSnapshotRefs(database, dialect, entries, prefix);
	await runBatchedMigrate(database, dialect, entries, table, refsTable);
	await ensureStorageSchemaOnce!(database, schema, async () => {});
	return true;
}

async function runBatchedMigrate(
	database: SqliteDatabase,
	dialect: StorageDialect,
	entries: string,
	table: string,
	refsTable: string | undefined,
): Promise<number> {
	const pg = dialect.name === "postgres";
	const candidate = couldBeCaptureHeading("e.entry_json");
	const project = captureHeadingProjection(dialect, "e.entry_json", "e.chunks");
	const source = refsTable ?? entries;
	const batchSize = refsTable !== undefined ? MIGRATE_REF_BATCH : MIGRATE_ENTRY_BATCH;
	let cursor: { sessionId: string; seq: number } | undefined;
	let totalInserted = 0;
	const skipped: CaptureHeadingKey[] = [];
	for (;;) {
		const page = await database.all<SqliteRow & { session_id: string; seq: number | bigint }>(
			cursor === undefined
				? `SELECT session_id, seq FROM ${source} ORDER BY session_id, seq LIMIT ?`
				: `SELECT session_id, seq FROM ${source} WHERE (session_id, seq) > (?, ?) ORDER BY session_id, seq LIMIT ?`,
			...(cursor === undefined ? [batchSize] : [cursor.sessionId, cursor.seq, batchSize]),
		);
		if (page.length === 0) break;
		const last = page.at(-1)!;
		const first = page[0]!;
		const rangeParams = [String(first.session_id), Number(first.seq), String(last.session_id), Number(last.seq)];
		if (pg) {
			const keysJson = JSON.stringify(page.map((row) => ({ owner: String(row.session_id), seq: Number(row.seq) })));
			const batchRows = await database.transaction(
				(tx) =>
					tx.all<SqliteRow & { kind: number; session_id: string; seq: number | bigint }>(
						`WITH batch AS (
							SELECT owner, seq FROM jsonb_to_recordset((?)::jsonb) AS r(owner TEXT, seq BIGINT)
						),
						missing AS MATERIALIZED (
							SELECT b.owner, b.seq FROM batch b
							WHERE NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.session_id = b.owner AND h.seq = b.seq)
						),
						locked AS MATERIALIZED (
							SELECT e.session_id, e.seq, e.chunks,
								CASE WHEN ${candidate} THEN ${project} END AS heading
							FROM missing m
							JOIN ${entries} e ON e.session_id = m.owner AND e.seq = m.seq
							ORDER BY e.session_id, e.seq
							FOR SHARE OF e SKIP LOCKED
						),
						ins AS (
							INSERT INTO ${table} (session_id, seq, chunks, heading)
							SELECT session_id, seq, chunks, heading FROM locked WHERE heading IS NOT NULL
							ON CONFLICT (session_id, seq) DO NOTHING
							RETURNING session_id, seq
						)
						SELECT 0 AS kind, session_id, seq FROM ins
						UNION ALL
						SELECT 1 AS kind, e.session_id, e.seq
						FROM missing m
						JOIN ${entries} e ON e.session_id = m.owner AND e.seq = m.seq
						WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l.session_id = m.owner AND l.seq = m.seq)
							AND ${candidate}`,
						keysJson,
					),
				{ retryTransientFailures: true },
			);
			for (const row of batchRows) {
				if (Number(row.kind) === 0) totalInserted += 1;
				else skipped.push({ owner: String(row.session_id), seq: Number(row.seq) });
			}
		} else {
			const res = await database.transaction(
				(tx) =>
					tx.run(
						refsTable !== undefined
							? `INSERT INTO ${table} (session_id, seq, chunks, heading)
								SELECT session_id, seq, chunks, heading FROM (
									SELECT e.session_id, e.seq, e.chunks, ${project} AS heading
									FROM ${refsTable} r
									JOIN ${entries} e ON e.session_id = r.session_id AND e.seq = r.seq
									WHERE (r.session_id, r.seq) >= (?, ?) AND (r.session_id, r.seq) <= (?, ?)
										AND NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.session_id = e.session_id AND h.seq = e.seq)
										AND json_valid(e.entry_json) AND ${candidate}
								) WHERE heading IS NOT NULL
								ON CONFLICT (session_id, seq) DO NOTHING`
							: `INSERT INTO ${table} (session_id, seq, chunks, heading)
								SELECT session_id, seq, chunks, heading FROM (
									SELECT e.session_id, e.seq, e.chunks, ${project} AS heading
									FROM ${entries} e
									WHERE (e.session_id, e.seq) >= (?, ?) AND (e.session_id, e.seq) <= (?, ?)
										AND NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.session_id = e.session_id AND h.seq = e.seq)
										AND json_valid(e.entry_json) AND ${candidate}
								) WHERE heading IS NOT NULL
								ON CONFLICT (session_id, seq) DO NOTHING`,
						...rangeParams,
					),
				{ retryTransientFailures: true },
			);
			totalInserted += res.changes;
		}
		cursor = { sessionId: String(last.session_id), seq: Number(last.seq) };
		if (page.length < batchSize) break;
	}
	if (pg && skipped.length > 0) {
		for (const key of skipped) {
			await backfillSingleRowLocked(database, dialect, entries, table, key.owner, key.seq);
		}
	}
	return totalInserted;
}
