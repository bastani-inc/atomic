import { join } from "node:path";
import { expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

it.each(["native query-only", "libSQL query-only", "exclusive file"])(
	"lists on the caller's %s connection (#5537)",
	async (mode) => {
		const dir = makeTempDirectory("catalog-modes-");
		const db =
			mode === "libSQL query-only"
				? await openLibsqlDatabase({ url: "file::memory:" })
				: await openNodeSqliteDatabase(mode === "exclusive file" ? join(dir, "journal.db") : ":memory:");
		try {
			const journal = await SqlRunJournal.open(db, { prefix: "mode_" });
			try {
				const count = mode === "libSQL query-only" ? 4096 : 128;
				if (mode === "exclusive file") await db.get("PRAGMA locking_mode=EXCLUSIVE");
				await db.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?) INSERT INTO ${runJournalTables("mode_").runs}(run_id,name,cwd,created_at,status,header_json) SELECT 'm-'||i,'r','/p',1,'completed','{"runId":"m-'||i||'","name":"r","cwd":"/p","createdAt":1,"status":"completed"}' FROM n`,
					count,
				);
				if (mode !== "exclusive file") await db.exec("PRAGMA query_only=ON");
				try {
					expect((await journal.listRuns()).map((r) => r.runId)).toEqual(
						Array.from({ length: count }, (_, i) => `m-${i + 1}`).sort(),
					);
				} finally {
					if (mode !== "exclusive file") await db.exec("PRAGMA query_only=OFF");
				}
			} finally {
				await journal.close();
			}
		} finally {
			await db.close();
			removeTempDirectory(dir);
		}
	},
);

it.each(["directory", "versions"])(
	"can cancel the first paced %s read in private read-only memory (#5537)",
	async (view) => {
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			const store = await SqlSessionStore.open(db, {
				prefix: "pace_",
				cwdMatcher: () => (cwd) => cwd === "/absent",
			});
			const journal = await SqlRunJournal.open(db, { prefix: "pace_" });
			try {
				if (view === "directory") {
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, "pace_").sessions;
					await store.create(
						{ id: "s0", version: SESSION_FORMAT_VERSION, cwd: "/p0", createdAt: "2026-11-18T00:00:00Z" },
						[],
					);
					await db.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000) INSERT INTO ${table}(id,cwd,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision) SELECT 's'||i,'/p'||i,created_at,header_json,internal,last_seq,modified_at,message_count,first_message,name,has_name,summary,summarized_through_id,summary_state,revision FROM n CROSS JOIN ${table} seed WHERE seed.id='s0'`,
					);
				} else
					await db.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50001) INSERT INTO ${runJournalTables("pace_").runs}(run_id,name,cwd,created_at,status,header_json) SELECT 'm-'||i,'r','/p',1,'completed','{"runId":"m-'||i||'"}' FROM n`,
					);
				// No temporary write is needed to reach the first cancellation boundary, even in a private database.
				await db.exec("PRAGMA query_only=ON");
				const stop = new AbortController();
				const reason = new Error("cancel");
				let first = 0;
				const restore = observeSqlReads(db, {
					after(rows) {
						if (!first && rows.some((r) => typeof (view === "directory" ? r.cwd : r.run_id) === "string")) {
							first = rows.length;
							stop.abort(reason);
						}
					},
				});
				try {
					const read =
						view === "versions"
							? journal.runVersions(stop.signal)
							: Array.fromAsync(store.list({ cwd: "/absent", withoutSearchText: true, signal: stop.signal }));
					await expect(read).rejects.toBe(reason);
					expect(first).toBe(view === "directory" ? 256 : 128);
				} finally {
					restore();
					await db.exec("PRAGMA query_only=OFF");
				}
			} finally {
				await journal.close();
				await store.close();
			}
		} finally {
			await db.close();
		}
	},
);
