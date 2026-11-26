import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { ForkArchiveSource, SessionForkSeed } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	bytesOf,
	header,
	SERVER_TIMEOUT_MS,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A fork copies an entry's chunk rows 0 to `chunks - 1` and requires every one of them, whatever other chunk rows the
 * source keeps at that seq, as the copy one chunk at a time before #6560 did. A randomized test of corrupted sources
 * found the set-based copy taking every chunk row of a seq and checking only their number. Runs on every backend.
 *
 * A store copies forks while an older Atomic has a session open on it, so the stores here hold such a session's
 * marker; a store that shares fork history copies no chunk row at a fork, and its detach is covered by
 * storage-lazy-fork-detach-chunks.test.ts.
 */

/** Stored in two chunks, at seq 1. */
const big = user("e1", null, `big ${"x".repeat(SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2)}`, 1);
/** Stored whole, at seq 2. */
const small = user("e2", "e1", "small", 2);

interface Corruption {
	readonly name: string;
	/** Changes the source's chunk rows through `database`, around the store. */
	corrupt(database: SqliteDatabase, entryChunks: string, source: string): Promise<void>;
	/** The child's chunk rows, as `seq:idx`, or undefined where the fork must be refused. */
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

/** The ways a fork copies the source's stored rows. */
const forks: readonly {
	readonly name: string;
	/** Whether the child is written into another prefix, through the staged copy. */
	readonly staged: boolean;
	seed(source: string, epoch: string): SessionForkSeed;
	receipts(source: string, epoch: string): ForkArchiveSource["receipts"];
}[] = [
	{
		name: "a clone of the whole session in its store",
		staged: false,
		seed: (source, epoch) => completeSessionForkStream(source, epoch, 2),
		receipts: () => new Map(),
	},
	{
		name: "a fork of archived receipts in their store",
		staged: false,
		seed: () => [big, small],
		receipts: (source, epoch) =>
			new Map([
				["e1", { kind: "oversized", sessionId: source, epoch, seq: 1, bytes: 0 }],
				["e2", { kind: "oversized", sessionId: source, epoch, seq: 2, bytes: 0 }],
			]),
	},
	{
		name: "a clone of the whole session staged into another store",
		staged: true,
		seed: (source, epoch) => completeSessionForkStream(source, epoch, 2),
		receipts: () => new Map(),
	},
];

async function chunkKeys(database: SqliteDatabase, entryChunks: string, session: string): Promise<string[]> {
	const rows = await database.all(
		`SELECT seq, idx FROM ${entryChunks} WHERE session_id = ? ORDER BY seq, idx`,
		session,
	);
	return rows.map((row) => `${Number(row.seq)}:${Number(row.idx)}`);
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`fork copies of corrupted chunk rows on ${name} (#6560)`, () => {
		for (const fork of forks)
			for (const corruption of corruptions)
				test(
					`${fork.name}: ${corruption.name}`,
					() =>
						withBackendScope(backend, async (scope) => {
							const prefix = `${scope.prefix}s_`;
							const database = await scope.connect();
							await holdOlderBuildMarker(database, prefix);
							const source = await SqlSessionStore.open(database, { prefix });
							const destPrefix = fork.staged ? `${scope.prefix}d_` : prefix;
							const destDatabase = fork.staged ? await scope.connect() : database;
							if (fork.staged) await holdOlderBuildMarker(destDatabase, destPrefix);
							const dest = fork.staged
								? await SqlSessionStore.open(destDatabase, { prefix: destPrefix })
								: source;
							const { entryChunks } = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);
							const destChunks = renderStorageIdentifiers("sessions", SESSION_TABLES, destPrefix).entryChunks;
							const { epoch } = await source.create(header("src"), [big, small]);
							assert.ok(epoch);
							assert.deepEqual(await chunkKeys(database, entryChunks, "src"), ["1:0", "1:1"]);
							await corruption.corrupt(database, entryChunks, "src");

							const created = dest.createFork(header("child", "src"), fork.seed("src", epoch), {
								store: source,
								sessionId: "src",
								epoch,
								hashes: [],
								receipts: fork.receipts("src", epoch),
							});
							if (corruption.copied === undefined) {
								await assert.rejects(created, (error: Error) => {
									assert.ok(error instanceof StorageUnavailableError, String(error));
									assert.match(String(error.cause), /Missing (final )?chunk of session entry 1/);
									return true;
								});
								assert.equal(await dest.readHeader("child"), undefined, "no child is published");
								assert.deepEqual(await chunkKeys(destDatabase, destChunks, "child"), []);
								return;
							}
							assert.equal((await created)?.lastSeq, 2);
							assert.deepEqual(await chunkKeys(destDatabase, destChunks, "child"), corruption.copied);
							assert.deepEqual((await dest.load("child")).entries, [big, small]);
						}),
					SERVER_TIMEOUT_MS,
				);
	});
}
