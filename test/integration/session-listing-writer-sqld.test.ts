import { describe, expect, it } from "vitest";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`session listing writer: ${backend.name}`, () => {
		it("light listing returns a concurrently recreated session ID only once (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
				const writer = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				try {
					const header = {
						id: "seed",
						version: SESSION_FORMAT_VERSION,
						cwd: "/project",
						createdAt: "2026-11-18T00:00:00Z",
					} as const;
					await store.create(header, []);
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
							INSERT INTO ${table}(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
							SELECT 's-' || i, cwd, created_at,
							'{"id":"s-' || i || '","version":${SESSION_FORMAT_VERSION},"cwd":"/project","createdAt":"2026-11-18T00:00:00Z"}',
							internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision
							FROM n CROSS JOIN ${table} AS seed WHERE seed.id = 'seed'`);
					const query = { withoutSearchText: true };
					const collect = async () => {
						const ids: string[] = [];
						for await (const summary of store.list(query)) ids.push(summary.id);
						return ids;
					};
					const all = database.all.bind(database);
					let replaced = false;
					database.all = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						const rows = await all<Row>(sql, ...params);
						if (!replaced && rows.some((row) => row.id === header.id)) {
							replaced = true;
							await writer.delete(header.id);
							await writer.create({ ...header, createdAt: "2026-11-18T00:00:01Z" }, []);
						}
						return rows;
					};
					try {
						const ids = await collect();
						expect(replaced).toBe(true);
						expect(ids.filter((id) => id === header.id)).toHaveLength(1);
						expect([...ids].sort()).toEqual(
							[header.id, ...Array.from({ length: 2_000 }, (_, i) => `s-${i + 1}`)].sort(),
						);
					} finally {
						database.all = all;
					}
				} finally {
					await writer.close();
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
