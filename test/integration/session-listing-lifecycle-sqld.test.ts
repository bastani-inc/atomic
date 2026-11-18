import { describe, expect, it } from "vitest";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionListQuery,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";

const variants: readonly { name: string; query: SessionListQuery; cached?: boolean }[] = [
	{ name: "normal", query: {} },
	{ name: "cached", query: {}, cached: true },
	{ name: "light", query: { withoutSearchText: true } },
	{ name: "project", query: { cwd: "/project" } },
	{ name: "light project", query: { cwd: "/project", withoutSearchText: true } },
];

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`session listing lifetime: ${backend.name}`, () => {
		for (const variant of variants) {
			for (const stop of ["abort", "close"] as const) {
				it(`${variant.name} listing starts no further read after ${stop} at a page boundary (#5537)`, async () => {
					const scope = await backend.openScope();
					try {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, {
							prefix: scope.prefix,
							cwdMatcher: () => (cwd) => cwd?.startsWith("/project") ?? false,
						});
						let closed = false;
						try {
							await store.create(
								{
									id: "seed",
									version: SESSION_FORMAT_VERSION,
									cwd: "/project",
									createdAt: "2026-11-18T00:00:00Z",
								},
								[],
							);
							const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
							await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
								INSERT INTO ${table}(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
								SELECT 's-' || i, '/project/' || i, created_at,
								'{"id":"s-' || i || '","version":${SESSION_FORMAT_VERSION},"cwd":"/project/' || i || '","createdAt":"2026-11-18T00:00:00Z"}',
								internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision
								FROM n CROSS JOIN ${table} AS seed WHERE seed.id = 'seed'`);
							const collect = async (query: SessionListQuery) => {
								let count = 0;
								for await (const _summary of store.list(query)) count++;
								return count;
							};
							if (variant.cached) {
								expect(await collect(variant.query)).toBe(5_001);
								await database.run(`UPDATE ${table} SET revision = 'changed' WHERE id = 'seed'`);
							}
							const controller = new AbortController();
							const reason = new Error("listing cancelled");
							const all = database.all.bind(database);
							let stopped = false;
							let readsAfterStop = 0;
							database.all = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
								if (stopped) readsAfterStop++;
								const rows = await all<Row>(sql, ...params);
								if (!stopped && rows.some((row) => typeof row.cwd === "string")) {
									stopped = true;
									if (stop === "abort") controller.abort(reason);
									else {
										closed = true;
										await store.close();
									}
								}
								return rows;
							};
							try {
								const listing = collect({ ...variant.query, signal: controller.signal });
								if (stop === "abort") await expect(listing).rejects.toBe(reason);
								else await expect(listing).rejects.toBeInstanceOf(StoreClosedError);
								expect(stopped).toBe(true);
								expect(readsAfterStop).toBe(0);
							} finally {
								database.all = all;
							}
						} finally {
							if (!closed) await store.close();
						}
					} finally {
						await scope.close();
					}
				});
			}
		}
	});
}
