import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { ForkSourceIncompleteError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { setForkCopyRefusalNote } from "../../packages/coding-agent/src/core/storage/session/fork-detach.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	bytesOf,
	header,
	SERVER_TIMEOUT_MS,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A fork that shares a session's rows gets its own copy of an entry's chunk rows 0 to `chunks - 1` when it is detached,
 * and only when every one of them is there, as a fork's copy does (#6560): a copy that would be corrupt is refused, the
 * fork keeps reading the source, and the source can still be deleted, its rows kept for the fork. Runs on every backend.
 */

/** Stored in two chunks, at seq 1. */
const big = user("e1", null, `big ${"x".repeat(SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2)}`, 1);
/** Stored whole, at seq 2. */
const small = user("e2", "e1", "small", 2);

interface Corruption {
	readonly name: string;
	/** Changes the source's chunk rows through `database`, around the store. */
	corrupt(database: SqliteDatabase, entryChunks: string, source: string): Promise<void>;
	/** The fork's chunk rows after its detach, as `seq:idx`, or undefined where the detach must be refused. */
	readonly copied: readonly string[] | undefined;
}

const corruptions: readonly Corruption[] = [
	{
		name: "a chunk row past the entry's count is left behind",
		async corrupt(database, entryChunks, source) {
			await database.run(`INSERT INTO ${entryChunks} VALUES (?, 1, 7, ?)`, source, bytesOf(10, 1));
		},
		copied: ["1:0", "1:1"],
	},
	{
		name: "a chunk row within the entry's count is missing and one past it is left behind",
		async corrupt(database, entryChunks, source) {
			await database.run(`DELETE FROM ${entryChunks} WHERE session_id = ? AND seq = 1 AND idx = 1`, source);
			await database.run(`INSERT INTO ${entryChunks} VALUES (?, 1, 7, ?)`, source, bytesOf(10, 1));
		},
		copied: undefined,
	},
	{
		name: "an entry stored whole has chunk rows an older version left behind",
		async corrupt(database, entryChunks, source) {
			await database.run(`INSERT INTO ${entryChunks} VALUES (?, 2, 0, ?)`, source, bytesOf(10, 2));
			await database.run(`INSERT INTO ${entryChunks} VALUES (?, 2, 3, ?)`, source, bytesOf(10, 3));
		},
		copied: ["1:0", "1:1"],
	},
];

async function count(database: SqliteDatabase, sql: string, ...params: string[]): Promise<number> {
	return Number((await database.get<{ n: number }>(sql, ...params))?.n ?? 0);
}

async function chunkKeys(database: SqliteDatabase, entryChunks: string, session: string): Promise<string[]> {
	const rows = await database.all(
		`SELECT seq, idx FROM ${entryChunks} WHERE session_id = ? ORDER BY seq, idx`,
		session,
	);
	return rows.map((row) => `${Number(row.seq)}:${Number(row.idx)}`);
}

/** What a whole read of `id` gives, or the error it fails with. */
async function readOutcome(store: SqlSessionStore, id: string): Promise<string> {
	return store.load(id).then(
		(snapshot) => JSON.stringify(snapshot.entries),
		(error: Error) => `${error.name}: ${error.message}`,
	);
}

const notes: Readonly<Record<string, string | number>>[] = [];
afterEach(() => {
	notes.length = 0;
	setForkCopyRefusalNote(() => {});
});

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(
		`detaching a fork from corrupted chunk rows on ${name} (#6560)`,
		() => {
			for (const corruption of corruptions)
				test(
					corruption.name,
					() =>
						withBackendScope(backend, async (scope) => {
							setForkCopyRefusalNote((fields) => notes.push(fields));
							const prefix = `${scope.prefix}s_`;
							const database = await scope.connect();
							const store = await SqlSessionStore.open(database, { prefix });
							const { entries, entryChunks } = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);
							const { forkSegments } = sessionForkTables(prefix);
							const { epoch } = await store.create(header("src"), [big, small]);
							assert.ok(epoch);
							const created = await store.createFork(
								header("child", "src"),
								completeSessionForkStream("src", epoch, 2),
								{ store, sessionId: "src", epoch, hashes: [], receipts: new Map() },
							);
							assert.equal(created?.lastSeq, 2);
							assert.ok(
								(await count(
									database,
									`SELECT count(*) AS n FROM ${forkSegments} WHERE session_id = ?`,
									"child",
								)) > 0,
								"the child shares the source's rows",
							);
							await corruption.corrupt(database, entryChunks, "src");
							const before = await readOutcome(store, "child");

							if (corruption.copied !== undefined) {
								assert.deepEqual(await store.detachForks("src"), { detached: ["child"], reparented: [] });
								assert.deepEqual(await chunkKeys(database, entryChunks, "child"), corruption.copied);
								assert.deepEqual((await store.load("child")).entries, [big, small]);
								assert.deepEqual(notes, []);
								return;
							}

							// The copy would lack chunk 1 of entry 1: the detach is refused, writes nothing, and is noted once.
							await assert.rejects(store.detachForks("src"), (error: Error) => {
								assert.ok(error instanceof ForkSourceIncompleteError, String(error));
								assert.equal(error.sessionId, "child");
								assert.equal(error.sourceSeq, 1);
								return true;
							});
							assert.deepEqual(notes, [
								{ operation: "detach", sessionId: "child", sourceId: "src", sourceSeq: 1 },
							]);
							assert.deepEqual(await chunkKeys(database, entryChunks, "child"), []);
							assert.equal(
								await count(database, `SELECT count(*) AS n FROM ${entries} WHERE session_id = ?`, "child"),
								0,
							);
							assert.equal(await readOutcome(store, "child"), before, "the child reads as it did");
							// A replace of the source, which would take the rows the child reads, is refused the same way.
							const head = await store.readEntrySizes("src", 1, 0);
							await assert.rejects(
								store.replace("src", header("src"), [small], { expectSeq: head.lastSeq }),
								ForkSourceIncompleteError,
							);
							assert.equal(notes.at(-1)?.operation, "replace");
							assert.equal(await readOutcome(store, "child"), before);
							// Deleting the source still succeeds: its rows stay under a tombstone, for the child.
							await store.delete("src");
							assert.equal(await store.readHeader("src"), undefined);
							assert.equal(
								await count(database, `SELECT count(*) AS n FROM ${entries} WHERE session_id = ?`, "src"),
								2,
							);
							assert.equal(await readOutcome(store, "child"), before);
							// A session created under the deleted one's ID would need the child detached: it is refused too.
							await assert.rejects(store.create(header("src"), [small]), ForkSourceIncompleteError);
							assert.equal(notes.at(-1)?.operation, "create");
							assert.equal(await readOutcome(store, "child"), before);
							assert.equal(notes.length, 3, "each refused write is noted once");
						}),
					SERVER_TIMEOUT_MS,
				);
		},
	);
}
