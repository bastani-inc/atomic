import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import {
	ageBlobs,
	createSession,
	snapshotEntry,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`snapshot collection on ${backend.name}`, () => {
		test("a shared blob does not make one collection statement walk several long sessions (#5659)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const writer = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const gone = textBlob("shared superseded patch");
				await writer.snapshotBlobs.putBlobs([gone]);
				const ids = Array.from({ length: 11 }, (_, i) => `fork-${i}`);
				const first = snapshotEntry("/repo", "old", syntheticSnapshot("old", [gone.hash]));
				for (const id of ids) await createSession(writer, id, [first]);
				const d = dialectOf(db);
				const json = d.jsonObject([
					["type", "'worktree_snapshot'"],
					["root", "'/repo'"],
					["id", "'e' || n"],
					["parentId", "CASE WHEN n = 2 THEN ? ELSE 'e' || (n-1) END"],
					["snapshotId", "'s' || n"],
				]);
				for (const id of ids)
					await db.run(
						`WITH RECURSIVE ord(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM ord WHERE n < 2500)
					INSERT INTO ${scope.prefix}session_entries (session_id, seq, entry_id, entry_json) SELECT ?, n, 'e' || n, ${json} FROM ord`,
						id,
						first.id,
					);
				await ageBlobs(db, writer.snapshotBlobs.table, 10_000);
				const connection = await scope.connect();
				const walks: number[] = [];
				const locked: number[] = [];
				let interleave = false;
				let interruptCleanup = true;
				const measured = (executor: SqliteExecutor): SqliteExecutor => ({
					exec: executor.exec.bind(executor),
					run: (sql, ...args) => {
						if (
							interruptCleanup &&
							sql === `DELETE FROM ${scope.prefix}snapshot_index_sources WHERE source = ?` &&
							String(args[0]).startsWith("walk@")
						) {
							interruptCleanup = false;
							throw new Error("connection lost before cleanup");
						}
						return executor.run(sql, ...args);
					},
					get: executor.get.bind(executor),
					async all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
						if (sql.includes("open_anchors(")) {
							const sessions = new Set(
								ids.filter((id) =>
									params.some((param) => typeof param === "string" && param.includes(JSON.stringify(id))),
								),
							);
							walks.push(sessions.size);
						}
						return executor.all<T>(sql, ...params);
					},
				});
				const watched: SqliteDatabase = {
					...measured(connection),
					descriptor: connection.descriptor,
					dialect: connection.dialect,
					close: connection.close.bind(connection),
					async transaction(callback, options) {
						if (interleave && walks.length >= ids.length) {
							// A second connection branches at the old patch after the last group has been read. The
							// entry trigger, not a change to the session header, must invalidate the collector's read.
							interleave = false;
							await db.run(
								`INSERT INTO ${scope.prefix}session_entries (session_id,seq,entry_id,entry_json) VALUES (?,2501,'branch',?)`,
								ids[0]!,
								JSON.stringify({ type: "message", id: "branch", parentId: first.id }),
							);
						}
						const before = walks.length;
						const result = await connection.transaction((tx) => callback(measured(tx)), options);
						locked.push(walks.slice(before).reduce((sum, n) => sum + n, 0));
						return result;
					},
				};
				const reader = await SqlSessionStore.open(watched, { prefix: scope.prefix });
				assert.deepEqual((await collectSnapshotGarbage(reader.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					gone.hash,
				]);
				assert.ok(walks.length >= ids.length);
				assert.ok(Math.max(...walks) <= 1, `long sessions per statement: ${walks}`);
				assert.ok(Math.max(...locked) <= 1, `long sessions per write transaction: ${locked}`);
				// Simulate an interrupted collector whose lease has elapsed. Even with nothing left to delete,
				// the next collection must remove the extra triggers ordinary session writers would otherwise run.
				assert.equal(interruptCleanup, false);
				const guard = d.schemaObjects([`${scope.prefix}snapshot_walk_sessions`, `${scope.prefix}snapshot_walk_0i`]);
				assert.equal((await db.all(guard.sql, ...guard.params)).length, 2);
				await db.run(`UPDATE ${scope.prefix}snapshot_index_sources SET watermark = 0 WHERE source LIKE 'walk@%'`);
				assert.deepEqual((await collectSnapshotGarbage(reader.snapshotBlobs, { graceSeconds: 0 })).deleted, []);
				assert.deepEqual(await db.all(guard.sql, ...guard.params), []);
				await writer.snapshotBlobs.putBlobs([gone]);
				interleave = true;
				walks.length = 0;
				locked.length = 0;
				assert.deepEqual((await collectSnapshotGarbage(reader.snapshotBlobs, { graceSeconds: 0 })).deleted, []);
				assert.equal(interleave, false);
				assert.deepEqual(await reader.snapshotBlobs.getBlob(gone.hash), gone.data);
				assert.ok(Math.max(...locked) <= 1, `only the edited session needs another walk: ${locked}`);
				await reader.close();
				await writer.close();
			} finally {
				await scope.close();
			}
		}, 180_000);

		test("a fork through the latest snapshot does not postpone collecting a superseded blob, while a fork through the old snapshot protects it (#5665)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const writer = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const kept = textBlob("forked at the old snapshot");
				const gone = textBlob("forked at the new snapshot");
				await writer.snapshotBlobs.putBlobs([kept, gone]);
				const entries = (hash: string) => [
					snapshotEntry("/repo", "old", syntheticSnapshot("old", [hash])),
					snapshotEntry("/repo", "new"),
				];
				const left = entries(kept.hash);
				const right = entries(gone.hash);
				await createSession(writer, "left", left);
				await createSession(writer, "right", right);
				await ageBlobs(db, writer.snapshotBlobs.table, 10_000);
				const connection = await scope.connect();
				let fork = false;
				const watched: SqliteDatabase = {
					descriptor: connection.descriptor,
					dialect: connection.dialect,
					exec: connection.exec.bind(connection),
					all: connection.all.bind(connection),
					run: connection.run.bind(connection),
					get: connection.get.bind(connection),
					close: connection.close.bind(connection),
					async transaction(callback, options) {
						if (fork) {
							fork = false;
							await createSession(writer, "fork-old", left.slice(0, 1));
							await createSession(writer, "fork-new", right);
						}
						return connection.transaction(callback, options);
					},
				};
				const reader = await SqlSessionStore.open(watched, { prefix: scope.prefix });
				await reader.snapshotBlobs.completeIndex({});
				fork = true;
				const { deleted } = await collectSnapshotGarbage(reader.snapshotBlobs, { graceSeconds: 0 });
				assert.equal(fork, false);
				assert.deepEqual(deleted, [gone.hash]);
				assert.deepEqual(await reader.snapshotBlobs.listBlobHashes(), [kept.hash]);
				await reader.close();
				await writer.close();
			} finally {
				await scope.close();
			}
		}, 60_000);
	});
}
