import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
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
		test("an empty collection preserves an application's table named like the session watch", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const table = `${scope.prefix}snapshot_walk_sessions`;
				await db.exec(
					`CREATE TABLE ${table} (session_id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('application')`,
				);
				assert.deepEqual((await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 })).deleted, []);
				assert.equal((await db.get(`SELECT session_id FROM ${table}`))?.session_id, "application");
			} finally {
				await scope.close();
			}
		});

		test("a shared superseded patch needs only its delete transaction on an initialized store (#5665)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const writer = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const patch = textBlob("shared superseded patch");
				await writer.snapshotBlobs.putBlobs([patch]);
				const first = snapshotEntry("/repo", "old", syntheticSnapshot("old", [patch.hash]));
				const tips = Array.from({ length: 48 }, (_, index) =>
					snapshotEntry("/repo", `tip-${index}`, undefined, first.id),
				);
				for (const id of ["original", "fork"]) await createSession(writer, id, [first, ...tips]);
				await ageBlobs(db, writer.snapshotBlobs.table, 10_000);
				const connection = await scope.connect();
				let writes = 0;
				const counted: SqliteDatabase = {
					descriptor: connection.descriptor,
					dialect: connection.dialect,
					exec: connection.exec.bind(connection),
					all: connection.all.bind(connection),
					run: connection.run.bind(connection),
					get: connection.get.bind(connection),
					close: connection.close.bind(connection),
					transaction(callback, options) {
						if (!options?.readOnly) writes++;
						return connection.transaction(callback, options);
					},
				};
				const reader = await SqlSessionStore.open(counted, { prefix: scope.prefix });
				await reader.snapshotBlobs.completeIndex({});
				writes = 0;
				assert.deepEqual((await collectSnapshotGarbage(reader.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					patch.hash,
				]);
				assert.equal(writes, 1);
				await reader.close();
				await writer.close();
			} finally {
				await scope.close();
			}
		});

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
