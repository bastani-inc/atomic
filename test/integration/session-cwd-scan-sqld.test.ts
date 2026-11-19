import { describe, expect, it } from "vitest";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { seedCatalogSeries } from "../helpers/seed-catalog-series.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`project directory scan: ${backend.name}`, () => {
		it("reads repeated directory spellings once, not once per session (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, {
					prefix: scope.prefix,
					cwdMatcher: () => (cwd) => cwd === "/absent",
				});
				try {
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
					const distinct = db.descriptor.adapter === "node-sqlite" ? 256 : 16_384;
					await store.create(
						{ id: "s0", version: SESSION_FORMAT_VERSION, cwd: "/p0", createdAt: "2026-11-18T00:00:00Z" },
						[],
					);
					await seedCatalogSeries(
						db,
						1,
						50_000,
						`INSERT INTO ${table}(id,cwd,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision) SELECT 's'||i,'/p'||(i%${distinct}),created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision FROM n CROSS JOIN ${table} seed WHERE seed.id='s0'`,
					);
					const replies: number[] = [];
					const restore = observeSqlReads(db, {
						after(rows, sql) {
							if (sql.includes(table) && /SELECT DISTINCT cwd FROM|SELECT id, cwd FROM/.test(sql))
								replies.push(rows.length);
						},
					});
					try {
						expect(await Array.fromAsync(store.list({ cwd: "/absent" }))).toEqual([]);
						expect(replies).toEqual([distinct]);
					} finally {
						restore();
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("scans distinct directory spellings at most once while resolving a missing project (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, {
					prefix: scope.prefix,
					cwdMatcher: () => (cwd) => cwd === "/missing",
				});
				try {
					await store.create(
						{
							id: "seed",
							version: SESSION_FORMAT_VERSION,
							cwd: "/project/seed",
							createdAt: "2026-11-18T00:00:00Z",
						},
						[],
					);
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
					await seedCatalogSeries(
						database,
						1,
						10_240,
						`INSERT INTO ${table}(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
						SELECT 's-' || i, '/project/' || i, created_at,
						'{"id":"s-' || i || '","version":${SESSION_FORMAT_VERSION},"cwd":"/project/' || i || '","createdAt":"2026-11-18T00:00:00Z"}',
						internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision
						FROM n CROSS JOIN ${table} AS seed WHERE seed.id = 'seed'`,
					);
					const all = database.all.bind(database);
					let fullScans = 0;
					let directoryReads = 0;
					let yielded = false;
					let turn: NodeJS.Immediate | undefined;
					const directoryQuery = (sql: string) =>
						sql.includes(table) && /catalog_chars|catalog_complete|SELECT DISTINCT cwd FROM/.test(sql);
					const restore = observeSqlReads(database, {
						before: async (sql, params) => {
							if (directoryQuery(sql)) {
								if (directoryReads > 0) expect(yielded, "directory pages yield before another read").toBe(true);
								directoryReads++;
								const postgres = dialectOf(database).name === "postgres";
								const plan = await all(`${postgres ? "EXPLAIN" : "EXPLAIN QUERY PLAN"} ${sql}`, ...params);
								fullScans += plan.filter((row) => {
									const text = String(postgres ? row["QUERY PLAN"] : row.detail);
									return (
										text.includes(table) &&
										(postgres ? text.includes("Seq Scan") : text.includes("SCAN ") && !text.includes("USING"))
									);
								}).length;
							}
						},
						after: (_rows, sql) => {
							if (directoryQuery(sql) && directoryReads === 1)
								turn = setImmediate(() => {
									yielded = true;
								});
						},
					});
					try {
						const listed = [];
						for await (const session of store.list({ cwd: "/missing" })) listed.push(session);
						expect(listed).toEqual([]);
						expect(directoryReads).toBeGreaterThan(0);
						expect(fullScans).toBeLessThanOrEqual(1);
						if (database.descriptor.adapter !== "node-sqlite") expect(directoryReads).toBe(1);
					} finally {
						if (turn !== undefined) clearImmediate(turn);
						restore();
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
