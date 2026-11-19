import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_READ_FETCH,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { seedCatalogSeries } from "../helpers/seed-catalog-series.js";
import { storageBackends } from "../helpers/storage-backends.js";

// Only the fixture's three AFTER INSERT snapshot-index triggers are suspended. PostgreSQL can toggle them;
// SQLite needs their original definitions to restore them. Both changes are atomic and leave other triggers alone.
async function seedTextOnlyEntries(database: SqliteDatabase, table: string, seed: () => Promise<void>): Promise<void> {
	const names = ["snapshot_links", "snapshot_pending", "snapshot_refs"].map((suffix) => `${table}_${suffix}`);
	const postgres = dialectOf(database).name === "postgres";
	const find = `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name IN (?, ?, ?) ORDER BY name`;
	const definitions = await database.transaction(async (tx) => {
		if (postgres) {
			for (const name of names) await tx.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
			return [];
		}
		const rows = await tx.all<SqliteRow & { name: string; sql: string }>(find, table, ...names);
		expect(rows.map((row) => row.name)).toEqual(names);
		for (const name of names) await tx.exec(`DROP TRIGGER ${name}`);
		return rows;
	});
	try {
		await seed();
	} finally {
		await database.transaction(async (tx) => {
			if (postgres) {
				for (const name of names) await tx.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`);
			} else {
				for (const { sql } of definitions) await tx.exec(sql);
				expect(await tx.all(find, table, ...names)).toEqual(definitions);
			}
		});
	}
}

const MESSAGES = 700_000;
const AT = "2026-11-18T00:00:00Z";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`search-text metadata: ${backend.name}`, () => {
		it("pages long-session metadata and stops both metadata and text reads on abort or close (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const seed = await SqlSessionStore.open(database, { prefix: scope.prefix });
				try {
					const entry: SessionEntry = {
						type: "message",
						id: "m-1",
						parentId: null,
						timestamp: AT,
						message: { role: "user", content: "m-1", timestamp: Date.parse(AT) },
					};
					await seed.create({ id: "big", version: SESSION_FORMAT_VERSION, cwd: "/project", createdAt: AT }, [
						entry,
					]);
					const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
					await seedTextOnlyEntries(database, tables.entries, () =>
						seedCatalogSeries(
							database,
							2,
							MESSAGES,
							`INSERT INTO ${tables.entries}(session_id, seq, entry_id, entry_json, chunks)
							SELECT 'big', i, 'm-' || i, '{"type":"message","id":"m-' || i || '","parentId":null,"timestamp":"${AT}","message":{"role":"user","content":"m-' || i || '","timestamp":${Date.parse(AT)}}}', 0 FROM n`,
						),
					);
					await seedCatalogSeries(
						database,
						2,
						MESSAGES,
						`INSERT INTO ${tables.searchTexts}(session_id, seq, text_json) SELECT 'big', i, '"m-' || i || '"' FROM n`,
					);
					await database.run(
						`UPDATE ${tables.sessions} SET last_seq = ?, message_count = ?, revision = 'bulk' WHERE id = 'big'`,
						MESSAGES,
						MESSAGES,
					);
				} finally {
					await seed.close();
				}

				const read = async (stop?: { phase: "metadata" | "text"; action: "abort" | "close" }) => {
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					const controller = new AbortController();
					const reason = new Error("search-text listing cancelled");
					let closed = false;
					let stopped = false;
					let readsAfterStop = 0;
					const restore = observeSqlReads(database, {
						before: () => {
							if (stopped) readsAfterStop++;
						},
						after: async (rows) => {
							const metadata = rows.some((row) => row.seq != null && "size" in row);
							if (metadata && rows.length > SESSION_READ_FETCH.max)
								throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
							const text = rows.some((row) => typeof row.text_json === "string");
							if (!stopped && stop !== undefined && (stop.phase === "metadata" ? metadata : text)) {
								stopped = true;
								if (stop.action === "abort") controller.abort(reason);
								else {
									closed = true;
									await store.close();
								}
							}
						},
					});
					try {
						const listing = (async () => {
							const rows = [];
							for await (const summary of store.list({ signal: controller.signal })) rows.push(summary);
							return rows;
						})();
						if (stop === undefined) {
							const rows = await listing;
							expect(rows).toHaveLength(1);
							expect(rows[0]!.messageCount).toBe(MESSAGES);
							expect(rows[0]!.searchText.split(" ")).toEqual(
								Array.from({ length: MESSAGES }, (_, i) => `m-${i + 1}`),
							);
						} else {
							if (stop.action === "abort") await expect(listing).rejects.toBe(reason);
							else await expect(listing).rejects.toBeInstanceOf(StoreClosedError);
							expect(stopped).toBe(true);
							expect(readsAfterStop).toBe(0);
						}
					} finally {
						restore();
						if (!closed) await store.close();
					}
				};

				await read();
				for (const phase of ["metadata", "text"] as const)
					for (const action of ["abort", "close"] as const) await read({ phase, action });
			} finally {
				await scope.close();
			}
		}, 60_000);
	});
}
