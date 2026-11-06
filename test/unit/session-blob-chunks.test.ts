import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "vitest";
import type { SqliteDatabase, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { isSessionBlobError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createToolOutputRouter } from "../../packages/coding-agent/src/core/tools/tool-output-protocol.js";
import { countingDatabase } from "../helpers/counting-database.js";
import { rowLimitedDatabase, ServerLimitError } from "../helpers/row-limited-database.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const MiB = 1024 * 1024;
const header = { id: "session", version: 4 as const, createdAt: new Date(0).toISOString(), cwd: "/project" };

function bytesOf(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index++) bytes[index] = (index * 131 + (index >>> 8)) & 0xff;
	return bytes;
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

async function rowsOf(database: SqliteDatabase, table: string): Promise<number> {
	return Number((await database.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
}

const chunkSizes = (params: readonly SqliteValue[]) =>
	params.flatMap((param) => (param instanceof Uint8Array ? [param.byteLength] : []));

describe("a blob larger than a libSQL server's row limit (#4379)", () => {
	for (const size of [6_000_000, 64 * MiB]) {
		test(`of ${size} bytes is stored and read back through a database that refuses values over 5 MB (#4379)`, async () => {
			await withNodeSqliteDatabase(async ({ database }) => {
				const limited = rowLimitedDatabase(database);
				const store = await SqlSessionStore.open(limited.wrapped);
				await store.create(header, []);
				const bytes = bytesOf(size);

				const blob = await store.putBlob("session", bytes);
				const read = await store.getBlob("session", blob.hash);

				assert.deepEqual(blob, { hash: sha256(bytes), bytes: size });
				assert.ok(read !== undefined && Buffer.from(read).equals(Buffer.from(bytes)));
				assert.deepEqual(limited.refused, []);
			});
		});
	}

	test("the same blob in one row is what such a database refuses (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database);

			await assert.rejects(
				limited.wrapped.run("SELECT ?", new Uint8Array(5_000_001)),
				(error) => error instanceof ServerLimitError,
			);
			await assert.doesNotReject(limited.wrapped.run("SELECT ?", new Uint8Array(5_000_000)));
		});
	});

	test("every statement a store runs binds and returns at most one chunk, with no transaction around the chunks (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const counted = countingDatabase(
				rowLimitedDatabase(database, {
					maxValueBytes: SESSION_BLOB_CHUNK_BYTES,
					maxResponseBytes: SESSION_BLOB_CHUNK_BYTES,
				}).wrapped,
			);
			const store = await SqlSessionStore.open(counted.wrapped);
			await store.create(header, []);
			const bytes = bytesOf(2.5 * MiB);
			const chunks = 3;
			counted.statements.length = 0;
			counted.counts.transactions = 0;

			await store.putBlob("session", bytes);

			assert.equal(counted.statements.length, chunks + 2, "a header read, a statement per chunk, the header");
			assert.equal(counted.counts.transactions, 0);
			assert.deepEqual(
				counted.statements.flatMap(({ params }) => chunkSizes(params)),
				[MiB, MiB, 0.5 * MiB],
			);
			counted.statements.length = 0;

			await store.putBlob("session", bytes);

			assert.equal(counted.statements.length, 1, "the bytes a session holds are not sent again");
			assert.deepEqual(chunkSizes(counted.statements[0]!.params), []);
			counted.statements.length = 0;

			const read = await store.getBlob("session", sha256(bytes));

			assert.equal(read?.byteLength, bytes.byteLength);
			assert.deepEqual(
				counted.statements.map(({ sql, rows }) => [/blob_chunks/.test(sql) ? "chunk" : "header", rows]),
				[
					["header", 1],
					["chunk", 1],
					["chunk", 1],
					["chunk", 1],
				],
			);
		});
	});
});

describe("a blob that is only partly there (#4379)", () => {
	test("a header whose chunk was lost is blob-incomplete, through the store and through tool-output:// (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.create(header, []);
			const bytes = bytesOf(2 * MiB + 5);
			const blob = await store.putBlob("session", bytes);
			await database.run("DELETE FROM session_blob_chunks WHERE idx = 1");
			const router = createToolOutputRouter({ sessionId: () => "session", sessionStore: () => store });

			for (const read of [
				() => store.getBlob("session", blob.hash),
				() => Promise.resolve(router.read?.(`tool-output://${blob.hash}`)),
			]) {
				await assert.rejects(read(), (error) => {
					assert.ok(isSessionBlobError(error));
					assert.equal(error.code, "blob-incomplete");
					assert.equal(error.sessionId, "session");
					assert.equal(error.hash, blob.hash);
					assert.equal(error.bytes, bytes.byteLength);
					assert.equal("retryable" in error, false, "no blob error is retryable");
					return true;
				});
			}
		});
	});

	test("a chunk longer than the blob's recorded size is blob-incomplete, not a failure of the copy into memory (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.create(header, []);
			const blob = await store.putBlob("session", bytesOf(2 * MiB));
			await database.run("UPDATE session_blob_chunks SET data = zeroblob(?) WHERE idx = 0", MiB + 7);

			await assert.rejects(store.getBlob("session", blob.hash), (error) => {
				assert.ok(isSessionBlobError(error));
				assert.equal(error.code, "blob-incomplete");
				return true;
			});
		});
	});

	test("a session deleted while its blob is read holds nothing, which is no failure (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const owner = await SqlSessionStore.open(database);
			await owner.create(header, []);
			const blob = await owner.putBlob("session", bytesOf(2 * MiB));
			let deleted = false;
			const racing = Object.assign(Object.create(database) as SqliteDatabase, {
				get: async (sql: string, ...params: SqliteValue[]) => {
					if (!deleted && sql.includes("blob_chunks")) {
						deleted = true;
						await owner.delete("session");
					}
					return database.get(sql, ...params);
				},
			});
			const reader = await SqlSessionStore.open(racing);

			assert.equal(await reader.getBlob("session", blob.hash), undefined);
			assert.equal(deleted, true);
		});
	});

	test("a writer that stops between chunks leaves nothing readable, and storing the bytes again completes it (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const owner = await SqlSessionStore.open(database);
			await owner.create(header, []);
			const bytes = bytesOf(2.5 * MiB);
			let chunkWrites = 0;
			const dying = Object.assign(Object.create(database) as SqliteDatabase, {
				run: async (sql: string, ...params: SqliteValue[]) => {
					if (sql.includes("INTO session_blob_chunks") && ++chunkWrites === 2) throw new Error("killed");
					return database.run(sql, ...params);
				},
			});
			const writer = await SqlSessionStore.open(dying);

			await assert.rejects(writer.putBlob("session", bytes), /killed/);

			assert.equal(await rowsOf(database, "session_blobs"), 0);
			assert.equal(await rowsOf(database, "session_blob_chunks"), 1);
			assert.equal(await owner.getBlob("session", sha256(bytes)), undefined);
			await owner.putBlob("session", bytes);
			assert.ok(Buffer.from((await owner.getBlob("session", sha256(bytes)))!).equals(Buffer.from(bytes)));
			assert.equal(await rowsOf(database, "session_blob_chunks"), 3);
			await owner.delete("session");
			assert.deepEqual(
				[await rowsOf(database, "session_blobs"), await rowsOf(database, "session_blob_chunks")],
				[0, 0],
				"deleting the session removes every row of its blobs",
			);
		});
	});

	test("a session deleted while its blob is written rejects the write and leaves no row (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const owner = await SqlSessionStore.open(database);
			await owner.create(header, []);
			let chunkWrites = 0;
			const racing = Object.assign(Object.create(database) as SqliteDatabase, {
				run: async (sql: string, ...params: SqliteValue[]) => {
					if (sql.includes("INTO session_blob_chunks") && ++chunkWrites === 2) await owner.delete("session");
					return database.run(sql, ...params);
				},
			});
			const writer = await SqlSessionStore.open(racing);

			await assert.rejects(writer.putBlob("session", bytesOf(2.5 * MiB)), (error) => {
				assert.ok(error instanceof SessionNotFoundError);
				assert.equal(error.sessionId, "session");
				return true;
			});

			assert.deepEqual(
				[await rowsOf(database, "session_blobs"), await rowsOf(database, "session_blob_chunks")],
				[0, 0],
			);
		});
	});
});
