import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_READ_FETCH,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";

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
					// These text-only messages contain no snapshot references. Avoid per-row reference invalidation during
					// fixture creation, and restore every trigger before exercising the listing.
					const postgres = dialectOf(database).name === "postgres";
					if (postgres) await database.exec(`ALTER TABLE ${tables.entries} DISABLE TRIGGER USER`);
					try {
						await database.run(
							`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
							INSERT INTO ${tables.entries}(session_id, seq, entry_id, entry_json, chunks)
							SELECT 'big', i, 'm-' || i, '{"type":"message","id":"m-' || i || '","parentId":null,"timestamp":"${AT}","message":{"role":"user","content":"m-' || i || '","timestamp":${Date.parse(AT)}}}', 0 FROM n`,
							MESSAGES,
						);
					} finally {
						if (postgres) await database.exec(`ALTER TABLE ${tables.entries} ENABLE TRIGGER USER`);
					}
					await database.run(
						`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
						INSERT INTO ${tables.searchTexts}(session_id, seq, text_json) SELECT 'big', i, '"m-' || i || '"' FROM n`,
						MESSAGES,
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
					const all = database.all.bind(database);
					let closed = false;
					let stopped = false;
					let readsAfterStop = 0;
					database.all = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						if (stopped) readsAfterStop++;
						const rows = await all<Row>(sql, ...params);
						const metadata = rows.some((row) => "seq" in row && "size" in row);
						if (metadata) expect(rows.length).toBeLessThanOrEqual(SESSION_READ_FETCH.max);
						const text = rows.some((row) => typeof row.text_json === "string");
						if (!stopped && stop !== undefined && (stop.phase === "metadata" ? metadata : text)) {
							stopped = true;
							if (stop.action === "abort") controller.abort(reason);
							else {
								closed = true;
								await store.close();
							}
						}
						return rows;
					};
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
						database.all = all;
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
