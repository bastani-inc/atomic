import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	isRetryableStorageError,
	StoragePayloadTooLargeError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import {
	captureWorktreeSnapshot,
	removeRestoredWorktree,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { restoreWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/restore.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/**
 * Values larger than a libSQL server takes in one row (#4954): sqld 0.24.33 refuses a value or row over 5,000,000 bytes
 * (`max_row_size`) and a response over 10 MB (`--max-response-size`). Every backend of
 * test/helpers/storage-backends.ts runs these: a SQLite file always, sqld and Postgres when their URLs are set.
 */

useTemporaryAgentDir();

/** Writing, reading back and restoring several megabytes over HTTP is the server's cost, not a slow test. */
const LARGE_VALUE_TIMEOUT_MS = 180_000;
const MiB = 1024 * 1024;

const sandboxes: GitSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) sandbox.dispose();
});

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`large values on ${name} (#4954)`, () => {
		test(
			"a 4.5 MiB untracked file is captured and restored exactly from another connection (#4954)",
			async () => {
				const scope = await backend.openScope();
				const sandbox = new GitSandbox();
				sandboxes.push(sandbox);
				try {
					const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					const { clone } = await sandbox.remoteWithClone();
					// Random bytes make a binary patch larger than the file, well over sqld's 5,000,000-byte row.
					const content = randomBytes(4.5 * MiB);
					sandbox.write(join(clone, "large.bin"), content);
					const captured = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
					assert.equal(captured.status, "captured");
					if (captured.status !== "captured") return;
					assert.deepEqual(captured.snapshot.omitted, []);
					const patch = captured.blobs.find((blob) => blob.hash === captured.snapshot.delta.patch);
					assert.ok(
						patch !== undefined && patch.data.byteLength > 5_000_000,
						"the patch is over sqld's row limit",
					);

					const elsewhere = await SqlSnapshotBlobStore.open(await scope.connect(), scope.prefix);
					assert.deepEqual(await elsewhere.getBlob(patch.hash), patch.data);
					const restored = await restoreWorktreeSnapshot(captured.snapshot, {
						blobs: elsewhere,
						storeDir: sandbox.path("store"),
					});
					try {
						assert.ok(readFileSync(join(restored, "large.bin")).equals(content), "restored byte for byte");
					} finally {
						await removeRestoredWorktree(restored, { storeDir: sandbox.path("store") });
					}
				} finally {
					await scope.close();
				}
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"a blob stored in one row before chunks is still read, and a collection removes a chunked blob whole (#4954)",
			async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					const blobs = await SqlSnapshotBlobStore.open(database, scope.prefix);
					const t = snapshotIndexTables(scope.prefix);
					// A row as builds before chunks wrote it: the bytes in `data`, no `chunks` value.
					const legacy = randomBytes(2 * MiB);
					await database.run(
						`INSERT INTO ${t.blobs} (hash, bytes, data, created_at) VALUES (?, ?, ?, 1)`,
						"legacy",
						legacy.byteLength,
						Uint8Array.from(legacy),
					);
					assert.deepEqual(await blobs.getBlob("legacy"), Uint8Array.from(legacy));

					const large = Uint8Array.from(randomBytes(3 * SNAPSHOT_BLOB_CHUNK_BYTES + 7));
					await blobs.putBlobs([{ hash: "chunked", data: large }]);
					await blobs.putBlobs([{ hash: "chunked", data: large }]);
					assert.deepEqual(await blobs.getBlob("chunked"), large);
					const chunkRows = async () =>
						Number(
							(await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${t.blobChunks}`))?.count,
						);
					assert.equal(await chunkRows(), 4, "stored once, in four chunks");
					await database.run(`UPDATE ${t.blobs} SET created_at = 1`);
					const deleted = await blobs.collectGarbage({ graceSeconds: 0 });
					assert.deepEqual([...deleted].sort(), ["chunked", "legacy"]);
					assert.equal(await chunkRows(), 0, "a collected blob leaves no chunk behind");
					assert.equal(await blobs.getBlob("chunked"), undefined);
				} finally {
					await scope.close();
				}
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"collection keeps the latest snapshot of each branch of a session and deletes the rest (#4960)",
			async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					const sessions = await SqlSessionStore.open(database, { prefix: scope.prefix });
					const blobs = sessions.snapshotBlobs;
					const t = snapshotIndexTables(scope.prefix);
					const entry = (id: string, parentId: string | null, patch: string): SessionEntry =>
						({
							type: "worktree_snapshot",
							id,
							parentId,
							timestamp: new Date(0).toISOString(),
							root: "/repo",
							snapshotId: `snapshot-${id}`,
							snapshot: { chain: [{ tree: "t", patch, bytes: 1 }], bundle: null },
						}) as unknown as SessionEntry;
					const header = { id: "s", version: 4 as const, createdAt: new Date(0).toISOString(), cwd: "/repo" };
					// e1 is superseded by e2 on its branch; e3 is a second branch from e1, so it is a leaf too.
					await sessions.create(header, [
						entry("e1", null, "old"),
						entry("e2", "e1", "new"),
						entry("e3", "e1", "branch"),
					]);
					await blobs.putBlobs(
						["old", "new", "branch", "orphan"].map((hash) => ({ hash, data: new Uint8Array([1]) })),
					);
					await database.run(`UPDATE ${t.blobs} SET created_at = 1`);
					const deleted = await blobs.collectGarbage({ graceSeconds: 0 });
					assert.deepEqual([...deleted].sort(), ["old", "orphan"]);
					assert.deepEqual([...(await blobs.listBlobHashes())].sort(), ["branch", "new"]);
				} finally {
					await scope.close();
				}
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"a run with more than 10 MB of checkpoints reads back whole and resumes on another connection (#4954)",
			async () => {
				const scope = await backend.openScope();
				const backends: JournalDurableBackend[] = [];
				try {
					const journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
					const writer = await JournalDurableBackend.open(journal);
					backends.push(writer);
					const workflowId = "large-run";
					await writer.commitWorkflowRegistration({
						workflowId,
						name: "large",
						inputs: {},
						createdAt: 1,
						status: "running",
					});
					const outputs = Array.from({ length: 12 }, (_, index) => `${index % 10}`.repeat(1_000_000));
					for (const [index, output] of outputs.entries()) {
						await writer.commitCheckpoint({
							kind: "tool",
							workflowId,
							checkpointId: `tool-${index}`,
							name: "tool",
							argsHash: `args-${index}`,
							output,
							completedAt: 2 + index,
						});
					}
					await writer.releaseWorkflow(workflowId);

					const elsewhere = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
					let events = 0;
					for await (const _ of elsewhere.read(workflowId)) events++;
					assert.ok(events >= 13, `every event is read, ${events} read`);
					let keyed = 0;
					for await (const entry of SqlRunJournal.readKeyRange(elsewhere, workflowId, "", "\uffff")) {
						if (entry.key !== undefined) keyed++;
					}
					assert.ok(keyed >= 12, `every keyed event is read through the key index, ${keyed} read`);
					const resumed = await JournalDurableBackend.open(elsewhere);
					backends.push(resumed);
					await resumed.hydrateWorkflow(workflowId);
					const checkpoints = await resumed.readCheckpoints(workflowId);
					assert.deepEqual(
						checkpoints.map((checkpoint) => (checkpoint as { output?: unknown }).output),
						outputs,
					);
				} finally {
					for (const opened of backends) await opened.close();
					await scope.close();
				}
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"a value too large for the backend is a permanent payload error, never an outage (#4954)",
			async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					const { blob } = dialectOf(database).types;
					const table = `${scope.prefix}too_big`;
					await database.exec(`CREATE TABLE ${table} (data ${blob} NOT NULL)`);
					// Over sqld's limit; SQLite and Postgres take it.
					const value = new Uint8Array(6_000_000);
					const write = database.run(`INSERT INTO ${table} VALUES (?)`, value);
					if (backend.name !== "libSQL server (sqld)") {
						await write;
						return;
					}
					await assert.rejects(write, (error: unknown) => {
						assert.ok(error instanceof StoragePayloadTooLargeError);
						assert.ok(!(error instanceof StorageUnavailableError));
						assert.deepEqual(
							[error.code, error.kind, error.limitBytes, error.actualBytes, error.retryable, error.adapter],
							["payload-too-large", "value", 5_000_000, 6_000_000, false, "libsql"],
						);
						assert.match(error.message, /6,000,000 bytes/);
						assert.match(error.message, /5,000,000 bytes/);
						assert.equal(isRetryableStorageError(error), false);
						return true;
					});
					await assert.rejects(
						database.transaction((tx) => tx.run(`INSERT INTO ${table} VALUES (?)`, value)),
						StoragePayloadTooLargeError,
					);
					for (let index = 0; index < 3; index++) {
						await database.run(`INSERT INTO ${table} VALUES (?)`, new Uint8Array(4_000_000));
					}
					await assert.rejects(database.all(`SELECT data FROM ${table}`), (error: unknown) => {
						assert.ok(error instanceof StoragePayloadTooLargeError);
						assert.deepEqual([error.kind, error.limitBytes], ["response", 10_000_000]);
						return true;
					});
				} finally {
					await scope.close();
				}
			},
			LARGE_VALUE_TIMEOUT_MS,
		);
	});
}
