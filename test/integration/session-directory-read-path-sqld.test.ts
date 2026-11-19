import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { seedCatalogSeries } from "../helpers/seed-catalog-series.js";
import { storageBackends } from "../helpers/storage-backends.js";

const header = (id: string, cwd: string) =>
	({
		id,
		cwd,
		version: SESSION_FORMAT_VERSION,
		createdAt: "2026-01-01T00:00:00Z",
	}) as const;
function seed(table: string, cwd: string) {
	return `INSERT INTO ${table}(id,cwd,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision)
		SELECT 's-'||i,${cwd},created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision FROM n CROSS JOIN ${table} seed WHERE seed.id='needle-good'`;
}
for (const backend of storageBackends)
	it.skipIf(backend.skipReason)(
		`${backend.name}: a scoped lookup with 501 matching directories reads no unrelated history (#5537)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, {
					prefix: scope.prefix,
					cwdMatcher: () => (cwd) => cwd?.startsWith("/alias/") ?? false,
				});
				try {
					await store.create(header("needle-good", "/alias/0"), []);
					await seedCatalogSeries(
						db,
						1,
						500,
						seed(renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions, "'/alias/'||i"),
					);
					await store.create(
						header("needle-other", "/other"),
						Array.from({ length: 3 }, (_, i) => ({
							type: "message",
							id: `m${i}`,
							parentId: i ? `m${i - 1}` : null,
							timestamp: "2026-01-01T00:00:00Z",
							message: { role: "user", content: "x".repeat(62_000), timestamp: 1 },
						})),
					);
					let unrelated = 0;
					const restore = observeSqlReads(db, {
						after(rows) {
							for (const row of rows)
								if (row.id === "needle-other") unrelated += String(row.search_texts_json).length;
						},
					});
					try {
						expect(
							(await Array.fromAsync(store.list({ cwd: "/project", idPrefix: "needle-" }))).map((r) => r.id),
						).toEqual(["needle-good"]);
						expect(unrelated).toBe(0);
					} finally {
						restore();
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		},
	);

const postgres = storageBackends.find((backend) => backend.name === "Postgres")!;
it.skipIf(postgres.skipReason)(
	"a sparse PostgreSQL lookup accepts 50,000 matching directory aliases (#5537)",
	async () => {
		const scope = await postgres.openScope();
		try {
			const db = await scope.connect();
			const store = await SqlSessionStore.open(db, {
				prefix: scope.prefix,
				cwdMatcher: () => (cwd) => cwd?.startsWith("/alias/") ?? false,
			});
			try {
				await store.create(header("needle-good", "/alias/0"), []);
				await seedCatalogSeries(
					db,
					1,
					49_999,
					seed(renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions, "'/alias/'||i"),
				);
				expect(
					(await Array.fromAsync(store.list({ cwd: "/project", idPrefix: "needle-" }))).map((r) => r.id),
				).toEqual(["needle-good"]);
			} finally {
				await store.close();
			}
		} finally {
			await scope.close();
		}
	},
);

it.each(["native", "libSQL"])(
	"%s memory: a same-store write commits between useful directory replies (#5537)",
	async (mode) => {
		const db =
			mode === "native"
				? await openNodeSqliteDatabase(":memory:")
				: await openLibsqlDatabase({ url: "file::memory:" });
		try {
			const store = await SqlSessionStore.open(db);
			try {
				await store.create(header("needle-good", "/p"), []);
				await seedCatalogSeries(
					db,
					1,
					6_000,
					seed(renderStorageIdentifiers("sessions", SESSION_TABLES).sessions, "cwd"),
				);
				let reads = 0,
					committed = 0;
				let write: Promise<void> | undefined;
				const restore = observeSqlReads(db, {
					after(rows) {
						if (!rows.length || !("ord" in rows[0]! && "cwd" in rows[0]!)) return;
						reads++;
						if (!write && Number(rows[0]!.ord) === (mode === "native" ? 257 : 2001))
							write = store.create(header("new", "/p"), []).then(() => {
								committed = reads;
							});
					},
				});
				try {
					expect(await Array.fromAsync(store.list({ cwd: "/absent", withoutSearchText: true }))).toEqual([]);
					await write;
					expect(committed).toBe(2);
					expect(reads).toBeGreaterThan(committed);
				} finally {
					restore();
				}
			} finally {
				await store.close();
			}
		} finally {
			await db.close();
		}
	},
);
