import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "../storage/database.js";
import { dialectOf, type StorageDialect } from "../storage/dialect.js";
import { withShortSchemaLockWaits } from "../storage/migrations.js";
import { schemaCatalogOf } from "../storage/schema-catalog.js";

/** The snapshot blob table and the session records of the snapshot index that {@link forkInheritedBlobGuard} reads. */
export interface ForkInheritedBlobTables {
	readonly blobs: string;
	readonly sessionRecords: string;
}

/** The name of {@link forkInheritedBlobGuard} on the snapshot blob table `blobs`. */
export function forkInheritedBlobGuardName(blobs: string): string {
	return `${blobs}_fork_keep`;
}

/**
 * The statements that install, on the snapshot blob table, a trigger that keeps every blob a fork inherits (#6560): a
 * DELETE of the blob's row skips it, as long as a session record names it at a seq a fork segment covers, so that the
 * fork's history still has the snapshot. A release without shared-history forks collects blobs by the snapshots each
 * session retains, which never count the ones a fork inherits, and a process of one that an in-place update caught
 * holds that collection while its session store, from the update, makes shared forks: the database refuses that
 * collection what this build's own collection keeps (`SqlSnapshotBlobStore.sweep`), by the same condition, so that
 * collection never meets it. Once the forks that inherit a blob are deleted, or have their own copy, their segments no
 * longer name it, and the blob goes as any other. Only a DELETE of a blob runs it, and its check reads the session
 * records by hash and the segments by source, through their indexes. The chunks of a blob go with its row, by the
 * trigger that deletes them after it.
 */
export function forkInheritedBlobGuard(
	dialect: StorageDialect,
	tables: ForkInheritedBlobTables,
	forkSegments: string,
): string {
	return dialect.renderTrigger({
		name: forkInheritedBlobGuardName(tables.blobs),
		table: tables.blobs,
		timing: "BEFORE",
		event: "DELETE",
		when: `EXISTS (SELECT 1 FROM ${tables.sessionRecords} AS record JOIN ${forkSegments} AS segment ON segment.source_id = record.session_id AND record.seq BETWEEN segment.from_seq AND segment.to_seq WHERE record.hash = OLD.hash)`,
		// Skips the row and goes on with the statement: SQLite's RAISE(IGNORE), a PostgreSQL BEFORE trigger's NULL.
		statements: [dialect.name === "postgres" ? "RETURN NULL" : "SELECT RAISE(IGNORE)"],
	});
}

/**
 * Installs {@link forkInheritedBlobGuard} in the transaction `tx`, unless it is there, or the snapshot tables or the
 * fork segments table are not there yet. The switch to shared-history forks installs it with the fork tables, so no
 * fork shares a history before the database keeps what it inherits; the snapshot store installs it with its tables on
 * a new database, whose fork tables come first.
 */
export async function installForkInheritedBlobGuard(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	tables: ForkInheritedBlobTables,
	forkSegments: string,
): Promise<void> {
	const name = forkInheritedBlobGuardName(tables.blobs);
	const probe = dialect.schemaObjects([tables.blobs, tables.sessionRecords, forkSegments, name]);
	const found = new Set(
		(await tx.all<SqliteRow & { name: string }>(probe.sql, ...probe.params)).map((row) => row.name),
	);
	if (found.has(name) || ![tables.blobs, tables.sessionRecords, forkSegments].every((table) => found.has(table)))
		return;
	const guard = forkInheritedBlobGuard(dialect, tables, forkSegments);
	await withShortSchemaLockWaits(tx, dialect, () => tx.exec(guard));
}

/**
 * Installs {@link forkInheritedBlobGuard} where a session store's open finds forks sharing history, once its snapshot
 * store is open, unless the schema the open read holds it (`schemaCatalogOf`), as it does on every open after the
 * first: a database switched by a build before the guard, or whose snapshot store came from an earlier release, as in
 * a process an in-place update caught, which creates its tables without it. Housekeeping: where it cannot be
 * installed, such as for a PostgreSQL role that does not own the snapshot tables, the open goes on, and
 * `atomic storage migrate`, run as the owner, installs it.
 */
export async function ensureForkInheritedBlobGuard(
	database: SqliteDatabase,
	tables: ForkInheritedBlobTables,
	forkSegments: string,
	ledger: string,
): Promise<void> {
	if (database.readOnly === true) return;
	const dialect = dialectOf(database);
	const name = forkInheritedBlobGuardName(tables.blobs);
	const catalog = await schemaCatalogOf(database);
	if (catalog !== undefined) {
		if (catalog.hasObject(name)) return;
	} else {
		const probe = dialect.schemaObjects([name]);
		if ((await database.all(probe.sql, ...probe.params)).length > 0) return;
	}
	try {
		await database.transaction(
			async (tx) => {
				// Serialized with the other stores' schema setups under the prefix, so hosts that open together install it once.
				if (dialect.name === "postgres")
					await tx.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked", `${ledger}:schema`);
				await installForkInheritedBlobGuard(tx, dialect, tables, forkSegments);
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial", domain: ledger } },
		);
	} catch {
		// Left for a later open or `atomic storage migrate`.
	}
}
