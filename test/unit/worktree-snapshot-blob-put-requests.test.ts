import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteTransactionOptions,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Blobs of one test: a header row's `created_at` set by a test, the stamp of an unknown age and an old one. */
const UNKNOWN_AGE = 0;
const OLD_AGE = 1;

function blob(text: string): SnapshotBlob {
	const data = new TextEncoder().encode(text);
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

/** A blob of `bytes` bytes, stored as chunk rows once it is larger than one chunk. */
function sizedBlob(seed: number, bytes: number): SnapshotBlob {
	const data = new Uint8Array(bytes);
	for (let index = 0; index < bytes; index++) data[index] = (index * 31 + seed) % 251;
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

async function openStore(database: SqliteDatabase = undefined as never) {
	return SqlSnapshotBlobStore.open(database);
}

async function openDatabase(name: string): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("atomic-blob-put-requests-");
	const database = await openNodeSqliteDatabase(join(directory, name));
	cleanups.push(async () => {
		await database.close();
		removeTempDirectory(directory);
	});
	return database;
}

/**
 * A database whose transactions run every statement as a call of its own, as a put ran them before: their callbacks
 * get a decorator of the transaction, which offers no way to send statements together, and no leading statements.
 */
function oneCallAtATime(database: SqliteDatabase): SqliteDatabase {
	const decorate = (tx: SqliteExecutor): SqliteExecutor =>
		new Proxy(tx, {
			get(target, key) {
				if (key === "run") return (sql: string, ...params: readonly SqliteValue[]) => target.run(sql, ...params);
				return Reflect.get(target, key);
			},
		});
	return new Proxy(database, {
		get(target, key) {
			if (key === "transaction")
				return <T>(body: (tx: SqliteExecutor) => Promise<T>, options?: SqliteTransactionOptions) => {
					const { leading: _leading, leadingOnly: _leadingOnly, ...rest } = options ?? {};
					return target.transaction((tx) => body(decorate(tx)), rest);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Counts the waits for a connection's thread (requests sent while none was in flight) and the write locks taken. */
function countRequests() {
	let inFlight = 0;
	let waits = 0;
	let locks = 0;
	const interception = interceptConnectionRequests((request, send) => {
		if (request.kind === "begin") locks += 1;
		if (inFlight === 0) waits += 1;
		inFlight += 1;
		return send(request).finally(() => {
			inFlight -= 1;
		});
	});
	cleanups.push(() => interception.restore());
	return {
		take() {
			const counted = { waits, locks };
			waits = 0;
			locks = 0;
			return counted;
		},
	};
}

type BlobRow = SqliteRow & { hash: string; bytes: number; data: Uint8Array; chunks: number; created_at: number };
type ChunkRow = SqliteRow & { hash: string; idx: number; data: Uint8Array };

/** Every row of the blob and chunk tables, with a `created_at` the put stamped (not one a test set) as "now". */
async function rows(database: SqliteDatabase, store: SqlSnapshotBlobStore) {
	const blobs = await database.all<BlobRow>(
		`SELECT hash, bytes, data, chunks, created_at FROM ${store.table} ORDER BY hash`,
	);
	const chunks = await database.all<ChunkRow>("SELECT hash, idx, data FROM snapshot_blob_chunks ORDER BY hash, idx");
	return {
		blobs: blobs.map((row) => ({
			hash: row.hash,
			bytes: Number(row.bytes),
			data: Buffer.from(row.data).toString("hex"),
			chunks: Number(row.chunks),
			created_at: row.created_at === UNKNOWN_AGE || row.created_at === OLD_AGE ? Number(row.created_at) : "now",
		})),
		chunks: chunks.map((row) => ({
			hash: row.hash,
			idx: Number(row.idx),
			data: Buffer.from(row.data).toString("hex"),
		})),
	};
}

test("a put of eight small blobs waits for the SQLite connection's thread once, and takes the write lock once (#6708)", async () => {
	const database = await openDatabase("store.sqlite");
	const store = await openStore(database);
	const blobs = Array.from({ length: 8 }, (_, index) => blob(`file ${index}`));
	const requests = countRequests();
	await store.putBlobs(blobs);
	// Before: BEGIN IMMEDIATE, each blob's row, COMMIT, each its own wait (10).
	assert.deepEqual(requests.take(), { waits: 1, locks: 1 });
	assert.deepEqual((await store.listBlobHashes()).toSorted(), blobs.map((each) => each.hash).toSorted());
});

test("leading fast-path boundaries at 0, 1, 255, 256 statements and the 1 MiB chunk limit (#6708)", async () => {
	const database = await openDatabase("boundaries.sqlite");
	const store = await openStore(database);
	const requests = countRequests();

	await store.putBlobs([]);
	assert.deepEqual(requests.take(), { waits: 0, locks: 0 }, "empty put sends nothing");

	await store.putBlobs([blob("")]);
	assert.deepEqual(requests.take(), { waits: 1, locks: 1 }, "single empty blob uses leadingOnly");

	const exactChunk = sizedBlob(1, SNAPSHOT_BLOB_CHUNK_BYTES);
	await store.putBlobs([exactChunk]);
	assert.deepEqual(requests.take(), { waits: 1, locks: 1 }, "single 1 MiB blob uses leadingOnly");

	const half = SNAPSHOT_BLOB_CHUNK_BYTES / 2;
	await store.putBlobs([sizedBlob(2, half), sizedBlob(3, half)]);
	assert.deepEqual(requests.take(), { waits: 1, locks: 1 }, "two blobs totaling 1 MiB use leadingOnly");

	await store.putBlobs([sizedBlob(4, half + 1), sizedBlob(5, half + 1)]);
	assert.deepEqual(requests.take(), { waits: 2, locks: 1 }, "non-chunked payload over 1 MiB falls back to finisher");

	const chunked = sizedBlob(6, SNAPSHOT_BLOB_CHUNK_BYTES + 1);
	await store.putBlobs([chunked]);
	assert.deepEqual(requests.take(), { waits: 2, locks: 1 }, "chunked blob over 1 MiB falls back to finisher");

	const batch255 = Array.from({ length: 255 }, (_, index) => blob(`b255-${index}`));
	await store.putBlobs(batch255);
	assert.deepEqual(requests.take(), { waits: 1, locks: 1 }, "255 small blobs fit with COMMIT in one request");

	const batch256 = Array.from({ length: 256 }, (_, index) => blob(`b256-${index}`));
	await store.putBlobs(batch256);
	assert.deepEqual(requests.take(), { waits: 258, locks: 1 }, "256 statements fall back past leading and finisher");

	assert.deepEqual(await store.getBlob(exactChunk.hash), exactChunk.data);
	assert.deepEqual(await store.getBlob(chunked.hash), chunked.data);
	assert.equal((await store.listBlobHashes()).length, 1 + 1 + 2 + 2 + 1 + 255 + 256);
});

test("puts write the rows, and settle, as running each statement in turn did: single, batched, duplicate, chunked, many, invalid, concurrent (#6708)", async () => {
	const database = await openDatabase("together.sqlite");
	const reference = await openDatabase("one-at-a-time.sqlite");
	const store = await openStore(database);
	const inTurn = await openStore(oneCallAtATime(reference));
	const both = [
		{ database, store },
		{ database: reference, store: inTurn },
	] as const;
	const age = (hash: string, createdAt: number) =>
		Promise.all(
			both.map(({ database, store }) =>
				database.run(`UPDATE ${store.table} SET created_at = ? WHERE hash = ?`, createdAt, hash),
			),
		);
	const put = async (blobs: readonly SnapshotBlob[], expectRejected = false) => {
		const settled = await Promise.allSettled(both.map(({ store }) => store.putBlobs(blobs)));
		assert.deepEqual(settled[0], settled[1], "the put settles as before");
		assert.equal(settled[0]?.status, expectRejected ? "rejected" : "fulfilled");
		const [together, oneAtATime] = await Promise.all(both.map(({ database, store }) => rows(database, store)));
		assert.deepEqual(together, oneAtATime, "the put leaves the rows it left before");
		return together;
	};

	const single = blob("single");
	const [first, second, third] = [blob("first"), blob("second"), blob("")];
	const chunked = sizedBlob(7, SNAPSHOT_BLOB_CHUNK_BYTES * 2 + 5);
	const large = sizedBlob(3, SNAPSHOT_BLOB_CHUNK_BYTES);
	assert.equal((await put([single])).blobs.length, 1);
	// Duplicates within one put, an empty blob, one of exactly a chunk's size, and one stored as chunks.
	const batched = await put([second, first, chunked, second, third, large, chunked]);
	assert.equal(batched.blobs.length, 6);
	assert.deepEqual(
		batched.blobs.find((row) => row.hash === chunked.hash),
		{ hash: chunked.hash, bytes: chunked.data.byteLength, data: "", chunks: 3, created_at: "now" },
	);
	assert.equal(batched.chunks.length, 3);

	// Stored again: an old row restarts its age, an unknown age stays unknown, and chunks are not written again.
	await age(single.hash, OLD_AGE);
	await age(first.hash, UNKNOWN_AGE);
	await age(chunked.hash, OLD_AGE);
	const again = await put([single, first, chunked, blob("new")]);
	assert.equal(again.blobs.find((row) => row.hash === single.hash)?.created_at, "now");
	assert.equal(again.blobs.find((row) => row.hash === first.hash)?.created_at, UNKNOWN_AGE);
	assert.equal(again.blobs.find((row) => row.hash === chunked.hash)?.created_at, "now");
	assert.equal(again.chunks.length, 3);

	// A put with an invalid text parameter fails and rolls back earlier rows in the same put.
	const invalid = await put([blob("rolled-back-before-nul"), { hash: "z\0invalid", data: new Uint8Array([1]) }], true);
	assert.equal(invalid.blobs.length, 7);

	// Concurrent small puts (group commit on SQLite) write the same rows as sequential puts.
	const groupA = [blob("group-a-1"), blob("group-a-2")];
	const groupB = [blob("group-b-1"), blob("group-b-2")];
	await Promise.all([store.putBlobs(groupA), store.putBlobs(groupB)]);
	await inTurn.putBlobs(groupA);
	await inTurn.putBlobs(groupB);
	assert.deepEqual(await rows(database, store), await rows(reference, inTurn));

	// More blobs than one request to a connection's thread carries.
	const many = await put(Array.from({ length: 300 }, (_, index) => blob(`many ${index}`)));
	assert.equal(many.blobs.length, 311);
	assert.deepEqual(await store.getBlob(chunked.hash), chunked.data);
});
