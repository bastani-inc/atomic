import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_LEGACY_STAMP_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-legacy-maintenance-batches-"));
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

function legacyBlob(bytes: number, salt: number): { readonly data: Buffer; readonly hash: string } {
	const data = Buffer.alloc(bytes).fill(Buffer.from(Array.from({ length: 251 }, (_, index) => (index + salt) & 255)));
	return { data, hash: createHash("sha256").update(data).digest("hex") };
}

type Kind = "stamp" | "chunks" | "publish" | "other";
interface State {
	readonly legacy: number;
	readonly chunkRows: number;
	readonly chunked: number;
}

async function stateOf(database: SqliteDatabase): Promise<State> {
	const row = await database.get(`SELECT
		(SELECT count(*) FROM snapshot_blobs WHERE created_at = 0) AS legacy,
		(SELECT count(*) FROM snapshot_blob_chunks) AS chunkRows,
		(SELECT count(*) FROM snapshot_blobs WHERE chunks > 0) AS chunked`);
	return { legacy: Number(row?.legacy), chunkRows: Number(row?.chunkRows), chunked: Number(row?.chunked) };
}

function kindOf(previous: State, next: State): Kind {
	if (next.chunked > previous.chunked) return "publish";
	if (next.chunkRows > previous.chunkRows) return "chunks";
	if (next.legacy < previous.legacy) return "stamp";
	return "other";
}

function hooked(
	database: SqliteDatabase,
	hooks: { readonly before?: () => void; readonly after?: () => Promise<void> },
): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		close: database.close.bind(database),
		async transaction(callback, options) {
			hooks.before?.();
			const result = await database.transaction(callback, options);
			await hooks.after?.();
			return result;
		},
	};
}

for (const adapter of ["node-sqlite", "libsql"] as const) {
	describe(adapter, () => {
		async function legacyDatabase(sizes: readonly number[]) {
			const path = join(directory, "journal.sqlite");
			const database =
				adapter === "node-sqlite"
					? await openNodeSqliteDatabase(path)
					: await openLibsqlDatabase({ url: pathToFileURL(path).href });
			closers.push(() => database.close());
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const blobs = sizes.map((size, index) => legacyBlob(size, index));
			for (const blob of blobs)
				await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
			return { database, blobs };
		}

		test("a legacy blob stored again and swept after its first chunk batch, before the move stops, leaves no orphan chunk (#5327)", async () => {
			const { database, blobs } = await legacyDatabase([2 * SNAPSHOT_LEGACY_STAMP_BYTES + 17]);
			const blob = blobs[0]!;
			const chunkRows = async () =>
				Number((await database.get("SELECT count(*) AS rows FROM snapshot_blob_chunks"))?.rows);
			const controller = new AbortController();
			let phase = 0;
			let other: SqlSnapshotBlobStore | undefined;
			const store = await SqlSnapshotBlobStore.open(
				hooked(database, {
					after: async () => {
						if (phase === 0) return;
						const rows = await chunkRows();
						if (phase === 1 && rows > 0) {
							phase = 2;
							assert.equal(await other!.refreshBlobs([blob.hash]), true);
							await database.run("UPDATE snapshot_blobs SET created_at = 1 WHERE hash = ?", blob.hash);
							assert.deepEqual(await other!.collectGarbage({ graceSeconds: 0 }), [blob.hash]);
							phase = 3;
							return;
						}
						if (phase === 3) controller.abort(new Error("process exits"));
					},
				}),
			);
			other = await SqlSnapshotBlobStore.open(database);
			phase = 1;
			await collectSnapshotGarbage(store, { graceSeconds: 3600, signal: controller.signal }).catch(() => undefined);
			assert.equal(phase, 3, "the blob was stored again and swept during the move");
			assert.equal(
				await database.get("SELECT 1 AS present FROM snapshot_blobs WHERE hash = ?", blob.hash),
				undefined,
			);
			assert.equal(await chunkRows(), 0);
		});

		test("a collection renews its own holder's claim in every stamping, chunk and publish transaction (#5327)", async () => {
			const { database } = await legacyDatabase([SNAPSHOT_BLOB_CHUNK_BYTES, SNAPSHOT_LEGACY_STAMP_BYTES + 1]);
			let state: State | undefined;
			const seen: { kind: Kind; renewed: boolean }[] = [];
			const store = await SqlSnapshotBlobStore.open(
				hooked(database, {
					after: async () => {
						if (state === undefined) return;
						const next = await stateOf(database);
						const kind = kindOf(state, next);
						const age = Number(
							(await database.get("SELECT unixepoch() - claimed_at AS age FROM snapshot_collection"))?.age,
						);
						if (kind !== "other") seen.push({ kind, renewed: age < 5 });
						await database.run("UPDATE snapshot_collection SET claimed_at = unixepoch() - 100");
						state = next;
					},
				}),
			);
			await database.run("UPDATE snapshot_collection SET holder = 'owner', claimed_at = unixepoch() - 100");
			state = await stateOf(database);
			await store.collectGarbage({ graceSeconds: 0, holder: "owner" });
			assert.deepEqual([...new Set(seen.map((entry) => entry.kind))].sort(), ["chunks", "publish", "stamp"]);
			assert.deepEqual(
				seen.filter((entry) => !entry.renewed).map((entry) => entry.kind),
				[],
				"every stamping, chunk and publish transaction renews the claim",
			);
		});

		test("a collection returns to the event loop after every stamping, chunk and publish transaction (#5327)", async () => {
			const { database } = await legacyDatabase([
				...Array.from({ length: 17 }, () => SNAPSHOT_BLOB_CHUNK_BYTES),
				SNAPSHOT_LEGACY_STAMP_BYTES + 1,
				SNAPSHOT_LEGACY_STAMP_BYTES + 2,
			]);
			let state: State | undefined;
			let ticked = true;
			let previous: Kind = "other";
			const followed: { after: Kind; ticked: boolean }[] = [];
			const store = await SqlSnapshotBlobStore.open(
				hooked(database, {
					before: () => {
						if (state !== undefined) followed.push({ after: previous, ticked });
					},
					after: async () => {
						if (state === undefined) return;
						const next = await stateOf(database);
						previous = kindOf(state, next);
						state = next;
						ticked = false;
						setImmediate(() => {
							ticked = true;
						});
					},
				}),
			);
			state = await stateOf(database);
			await store.collectGarbage({ graceSeconds: 0 });
			followed.push({ after: previous, ticked });
			const relevant = followed.filter((entry) => entry.after !== "other");
			assert.deepEqual([...new Set(relevant.map((entry) => entry.after))].sort(), ["chunks", "publish", "stamp"]);
			assert.deepEqual(
				relevant.filter((entry) => !entry.ticked).map((entry) => entry.after),
				[],
				"the next transaction starts only after the event loop ran",
			);
		});

		test.each(["stamp", "chunks"] as const)(
			"a collection stopped after a %s transaction writes nothing more (#5327)",
			async (stopAfter) => {
				const sizes =
					stopAfter === "stamp"
						? Array.from({ length: 17 }, () => SNAPSHOT_BLOB_CHUNK_BYTES)
						: [2 * SNAPSHOT_LEGACY_STAMP_BYTES + 17];
				const { database } = await legacyDatabase(sizes);
				const controller = new AbortController();
				const stop = new Error(`stop after a ${stopAfter} transaction`);
				let state: State | undefined;
				const afterStop: Kind[] = [];
				const store = await SqlSnapshotBlobStore.open(
					hooked(database, {
						after: async () => {
							if (state === undefined) return;
							const next = await stateOf(database);
							const kind = kindOf(state, next);
							state = next;
							if (controller.signal.aborted) afterStop.push(kind);
							else if (kind === stopAfter) controller.abort(stop);
						},
					}),
				);
				state = await stateOf(database);
				await assert.rejects(
					store.collectGarbage({ graceSeconds: 0, signal: controller.signal }),
					(error) => error === stop,
				);
				assert.deepEqual(afterStop, [], "no transaction commits after the stop");
			},
		);

		test("a collection returns to the event loop after every statement of moving a legacy blob, also when another host moved it first (#5530)", async () => {
			const { database, blobs } = await legacyDatabase([
				SNAPSHOT_BLOB_CHUNK_BYTES + 1,
				SNAPSHOT_BLOB_CHUNK_BYTES + 2,
				SNAPSHOT_BLOB_CHUNK_BYTES + 3,
			]);
			const other = await SqlSnapshotBlobStore.open(database);
			let armed = false;
			let transactions = 0;
			// Turns of the event loop between this collection's steps; a connection may also take turns inside a transaction,
			// while it waits for the write lock, and those are not counted.
			let turns: number | undefined;
			// Once this collection has read the bytes of the first blob it moves, another host's collection moves all three:
			// this one's first chunk transaction finds its blob moved, and its reads of the other two find nothing to move.
			const read = (async (sql, ...params) => {
				const row = await database.get(sql, ...params);
				if (armed && turns === undefined && row?.data instanceof Uint8Array) {
					await other.collectGarbage({ graceSeconds: 3600 });
					turns = 0;
					const tick = () => {
						if (!armed) return;
						if (transactions === 0) turns!++;
						setImmediate(tick);
					};
					setImmediate(tick);
				}
				return row;
			}) as SqliteDatabase["get"];
			const counted = hooked(database, {
				before: () => {
					transactions++;
				},
				after: async () => {
					transactions--;
				},
			});
			const store = await SqlSnapshotBlobStore.open({ ...counted, get: read });
			armed = true;
			await store.collectGarbage({ graceSeconds: 3600 });
			armed = false;

			assert.ok(turns !== undefined, "the other host moved the blobs during this collection");
			// From the other host's collection on, each of these ends with a turn: the read of the first blob's bytes, its
			// chunk transaction, which finds it moved, and the reads of the other two, which find nothing to move.
			const statements = blobs.length + 1;
			assert.ok(
				turns >= statements,
				`the event loop ran ${turns} times between the steps of the collection over its last ${statements} statements, which met blobs another host had moved`,
			);
			for (const blob of blobs) assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			assert.equal((await stateOf(database)).chunked, blobs.length);
		});

		test.each(["deleted", "stamped"] as const)(
			"a collection moving one legacy blob to chunks after a later one on the same page was %s finishes (#5327)",
			async (change) => {
				const { database, blobs } = await legacyDatabase([
					SNAPSHOT_LEGACY_STAMP_BYTES + 1,
					SNAPSHOT_LEGACY_STAMP_BYTES + 2,
				]);
				const other = await SqlSnapshotBlobStore.open(database);
				let armed = false;
				let later: string | undefined;
				const store = await SqlSnapshotBlobStore.open(
					hooked(database, {
						after: async () => {
							if (!armed || later !== undefined) return;
							const moving = await database.get("SELECT hash FROM snapshot_blob_chunks LIMIT 1");
							if (moving === undefined) return;
							later = blobs.map((blob) => blob.hash).find((hash) => hash !== moving.hash)!;
							if (change === "deleted") {
								await database.run("DELETE FROM snapshot_blobs WHERE hash = ?", later);
								return;
							}
							assert.equal(await other.refreshBlobs([later]), true);
							await other.collectGarbage({ graceSeconds: 3600 });
						},
					}),
				);
				armed = true;
				await store.collectGarbage({ graceSeconds: 3600 });
				assert.ok(later !== undefined, "the later blob changed during the first one's move");
				for (const blob of blobs) {
					if (change === "deleted" && blob.hash === later) {
						assert.equal(await store.getBlob(blob.hash), undefined);
					} else {
						assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
					}
				}
			},
		);
	});
}
