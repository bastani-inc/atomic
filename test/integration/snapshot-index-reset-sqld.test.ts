import assert from "node:assert/strict";
import { test } from "vitest";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	test.skipIf(backend.skipReason !== undefined)(
		`${backend.name}: a large reference index can be reset and collected; only local SQLite keeps a retired generation (#5553)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const p = scope.prefix;
				const t = snapshotIndexTables(p);
				const d = dialectOf(db);
				await SqlSessionStore.open(db, { prefix: p });
				await db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 25000)
				INSERT INTO ${t.sessionLinks}(session_id,seq,entry_id,children,broken) SELECT 'stale',i,'e'||i,0,0 FROM n`);
				await db.exec(d.dropTrigger(`${p}session_entries_snapshot_refs`, `${p}session_entries`));
				const store = await SqlSnapshotBlobStore.open(db, p);
				assert.equal(await db.get(`SELECT 1 FROM ${t.sessionLinks} LIMIT 1`), undefined);
				if (d.name === "sqlite") {
					const retired = await db.get<{ name: string }>(
						"SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB ?",
						`${t.sessionLinks}_old_*`,
					);
					if (backend.name === "SQLite file") {
						assert.ok(retired);
						assert.equal(Number((await db.get(`SELECT count(*) AS n FROM ${retired.name}`))?.n), 25000);
					} else assert.equal(retired, undefined, "a server with no free-space reading uses its original reset");
				}
				await store.completeIndex();
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 0 }), []);
			} finally {
				await scope.close();
			}
		},
		60_000,
	);
}
