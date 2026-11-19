import { expect, it } from "vitest";

import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";

import { observeSqlReads } from "../helpers/observe-sql-reads.js";

it("can cancel the first paced session directory read in private read-only memory (#5537)", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	try {
		const store = await SqlSessionStore.open(db, {
			prefix: "pace_",
			cwdMatcher: () => (cwd) => cwd === "/absent",
		});

		try {
			const table = renderStorageIdentifiers("sessions", SESSION_TABLES, "pace_").sessions;
			await store.create(
				{ id: "s0", version: SESSION_FORMAT_VERSION, cwd: "/p0", createdAt: "2026-11-18T00:00:00Z" },
				[],
			);
			await db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000) INSERT INTO ${table}(id,cwd,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision) SELECT 's'||i,'/p'||i,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision FROM n CROSS JOIN ${table} seed WHERE seed.id='s0'`,
			);
			// No temporary write is needed to reach the first cancellation boundary, even in a private database.
			await db.exec("PRAGMA query_only=ON");
			const stop = new AbortController();
			const reason = new Error("cancel");
			let first = 0;
			const restore = observeSqlReads(db, {
				after(rows) {
					if (!first && rows.some((r) => typeof r.cwd === "string")) {
						first = rows.length;
						stop.abort(reason);
					}
				},
			});
			try {
				const read = Array.fromAsync(store.list({ cwd: "/absent", withoutSearchText: true, signal: stop.signal }));
				await expect(read).rejects.toBe(reason);
				expect(first).toBe(256);
			} finally {
				restore();
				await db.exec("PRAGMA query_only=OFF");
			}
		} finally {
			await store.close();
		}
	} finally {
		await db.close();
	}
});
