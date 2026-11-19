import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { seedCatalogSeries } from "./seed-catalog-series.js";
import type { StorageBackend } from "./storage-backends.js";

/** All columns and insertion order of every session, the meta rows, and the remaining (empty) corpus tables. */
async function fingerprint(db: SqliteDatabase, tables: Readonly<Record<keyof typeof SESSION_TABLES, string>>) {
	const hash = createHash("sha256");
	const rows = await db.all(
		`SELECT ${dialectOf(db).rowOrder()} AS insertion_order, * FROM ${tables.sessions} ORDER BY id`,
	);
	const empty = [tables.entries, tables.searchTexts, tables.blobs, tables.blobChunks, tables.entryChunks];
	const metadata = await db.all(
		`SELECT m.*, ${empty.map((t, i) => `(SELECT count(*) FROM ${t}) AS n${i}`).join(", ")} FROM ${tables.meta} AS m`,
	);
	if (rows.length !== 5_001 || metadata.length !== 1 || empty.some((_, i) => Number(metadata[0]![`n${i}`]) !== 0))
		throw new Error("listing corpus changed");
	const revision = rows.find((row) => row.id === "seed")?.revision;
	if (typeof revision !== "string") throw new Error("listing corpus lost its seed revision");
	for (const row of rows) hash.update(JSON.stringify(row)).update("\n");
	hash.update(JSON.stringify(metadata));
	return { checksum: hash.digest("hex"), revision };
}

/** Shares only the seed data, never a listing store, connection, cancellation signal or cache. */
export async function openSessionListingCorpus(backend: StorageBackend) {
	const scope = await backend.openScope();
	try {
		const database = await scope.connect();
		try {
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
			try {
				await store.create(
					{ id: "seed", version: SESSION_FORMAT_VERSION, cwd: "/project", createdAt: "2026-11-18T00:00:00Z" },
					[],
				);
				await seedCatalogSeries(
					database,
					1,
					5_000,
					`INSERT INTO ${tables.sessions}(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
					SELECT 's-' || i, '/project/' || i, created_at,
					'{"id":"s-' || i || '","version":${SESSION_FORMAT_VERSION},"cwd":"/project/' || i || '","createdAt":"2026-11-18T00:00:00Z"}',
					internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision
					FROM n CROSS JOIN ${tables.sessions} AS seed WHERE seed.id = 'seed'`,
				);
			} finally {
				await store.close();
			}
			return {
				scope,
				table: tables.sessions,
				original: await fingerprint(database, tables),
				state: (db: SqliteDatabase) => fingerprint(db, tables),
			};
		} finally {
			await database.close();
		}
	} catch (error) {
		await scope.close();
		throw error;
	}
}
