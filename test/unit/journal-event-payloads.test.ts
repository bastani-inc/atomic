import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	journalPayloadStub,
	STORED_JSON_CHUNK_BYTES,
	storedJournalPayload,
	storedJsonChunks,
	withJournalPayloads,
	writeJournalPayloadChunks,
} from "../../packages/coding-agent/src/core/storage/run-journal.js";

const opened: SqliteDatabase[] = [];
afterEach(async () => {
	for (const database of opened.splice(0)) await database.close();
});

async function chunkTable(): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(":memory:");
	opened.push(database);
	await database.exec(
		"CREATE TABLE chunks(run_id TEXT NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(run_id, seq, idx))",
	);
	return database;
}

/** JSON text of exactly `bytes` bytes of UTF-8. */
function jsonOfBytes(bytes: number): string {
	return JSON.stringify("x".repeat(bytes - 2));
}

test("JSON up to one chunk stays in its row; one byte more is split into chunks that join back exactly (#4965)", () => {
	assert.equal(storedJsonChunks(jsonOfBytes(STORED_JSON_CHUNK_BYTES)), undefined);
	const longer = jsonOfBytes(STORED_JSON_CHUNK_BYTES + 1);
	const chunks = storedJsonChunks(longer);
	assert.deepEqual(
		chunks?.map((chunk) => chunk.byteLength),
		[STORED_JSON_CHUNK_BYTES, 1],
	);
	// JSON of exactly two chunks is two full chunks, with no empty one after them.
	assert.deepEqual(
		storedJsonChunks(jsonOfBytes(2 * STORED_JSON_CHUNK_BYTES))?.map((chunk) => chunk.byteLength),
		[STORED_JSON_CHUNK_BYTES, STORED_JSON_CHUNK_BYTES],
	);
	// Characters of two to four bytes are split between chunks and still join back.
	const text = JSON.stringify("é😀".repeat(STORED_JSON_CHUNK_BYTES / 2));
	const split = storedJsonChunks(text)!;
	assert.ok(split.length > 1);
	assert.ok(split.slice(0, -1).every((chunk) => chunk.byteLength === STORED_JSON_CHUNK_BYTES));
	assert.equal(Buffer.concat(split).toString("utf8"), text);
	// Fewer characters than a chunk holds even at three bytes each are never encoded to be measured.
	assert.equal(storedJsonChunks("é".repeat(STORED_JSON_CHUNK_BYTES / 3)), undefined);
});

test("a large payload's stub keeps its short top-level fields and its worktree snapshots, nothing long (#4965)", () => {
	const worktreeSnapshots = [{ chain: [{ patch: "p".repeat(10_000) }] }];
	const stub = JSON.parse(
		journalPayloadStub({
			kind: "tool",
			status: "failed",
			completedAt: 7,
			resumable: false,
			nothing: null,
			gone: undefined,
			edge: "e".repeat(4094),
			output: "o".repeat(4095),
			worktreeSnapshots,
		}),
	);
	assert.deepEqual(stub, {
		kind: "tool",
		status: "failed",
		completedAt: 7,
		resumable: false,
		nothing: null,
		edge: "e".repeat(4094),
		worktreeSnapshots,
	});
	for (const value of ["text", 3, null, [1, 2], undefined]) assert.equal(journalPayloadStub(value), "null");
});

test("a stub keeps at most 64 KiB of short fields besides its worktree snapshots (#4965)", () => {
	const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`f${index}`, "v".repeat(2046)]));
	const stub = JSON.parse(journalPayloadStub({ ...fields, worktreeSnapshots: [] })) as Record<string, unknown>;
	// Each field's JSON is 2048 characters: 32 of them fill 64 KiB exactly.
	assert.deepEqual(Object.keys(stub), [...Object.keys(fields).slice(0, 32), "worktreeSnapshots"]);
});

test("a payload is stored whole up to one chunk, and as its stub and chunks past it (#4965)", () => {
	const small = JSON.stringify({ kind: "tool", output: "x" });
	assert.deepEqual(storedJournalPayload(small), { payload: small, chunks: [] });
	const value = { kind: "tool", output: "x".repeat(STORED_JSON_CHUNK_BYTES) };
	const json = JSON.stringify(value);
	for (const stored of [storedJournalPayload(json), storedJournalPayload(json, value)]) {
		assert.equal(stored.payload, JSON.stringify({ kind: "tool" }));
		assert.equal(Buffer.concat(stored.chunks).toString("utf8"), json);
	}
	// The caller's parsed value is what the stub is made of.
	assert.equal(storedJournalPayload(json, { kind: "stage" }).payload, JSON.stringify({ kind: "stage" }));
});

test("chunks written for an event replace any it had and read back into its row; rows stored whole are untouched (#4965)", async () => {
	const database = await chunkTable();
	const json = JSON.stringify({ kind: "tool", output: "é".repeat(STORED_JSON_CHUNK_BYTES) });
	const { payload, chunks } = storedJournalPayload(json);
	await writeJournalPayloadChunks(database, "chunks", "run", 2, [
		new Uint8Array([1]),
		new Uint8Array([2]),
		new Uint8Array([3]),
		new Uint8Array([4]),
	]);
	await writeJournalPayloadChunks(database, "chunks", "run", 2, chunks);
	await writeJournalPayloadChunks(database, "chunks", "other", 2, []);
	const count = await database.get<{ count: number }>("SELECT count(*) AS count FROM chunks");
	assert.equal(
		Number(count?.count),
		chunks.length,
		"the earlier chunks are gone, and an event stored whole writes none",
	);

	const whole = { run_id: "run", seq: 1, payload: "{}", chunks: 0 };
	const legacy = { run_id: "run", seq: 3, payload: "[]" };
	const loaded = await withJournalPayloads(database, "chunks", [
		whole,
		{ run_id: "run", seq: 2, payload, chunks: chunks.length },
		legacy,
	]);
	assert.equal(loaded[0], whole);
	assert.deepEqual(loaded[1], { run_id: "run", seq: 2, payload: json, chunks: 0 });
	assert.equal(loaded[2], legacy);

	await database.run("DELETE FROM chunks WHERE idx = 1");
	await assert.rejects(
		withJournalPayloads(database, "chunks", [{ run_id: "run", seq: 2, payload, chunks: chunks.length }]),
		(error: unknown) => {
			assert.ok(error instanceof StorageError);
			assert.equal(error.message, `Workflow run run event 2 is missing chunk 1 of ${chunks.length}`);
			return true;
		},
	);
});
