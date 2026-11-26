import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { copySessionBlobs } from "../../packages/coding-agent/src/core/session-tool-output.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	BIG_BLOB_BYTES,
	bytesOf,
	header,
	mainClone,
	SERVER_TIMEOUT_MS,
	seedSource,
	sha256,
	stagingTable,
	stored,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * Two session stores opened separately on one database with one prefix hold their sessions in the same tables (#6560):
 * a clone from one into the other is the same-store copy, made in the destination's own transaction, not the staged
 * copy between stores whose tables differ. Runs on every backend of the storage matrix.
 */

/** Whether the staging table of `prefix` exists: the first staged clone into that prefix creates it. */
async function stagingExists(database: SqliteDatabase, prefix: string): Promise<boolean> {
	const probe = dialectOf(database).tableExists(stagingTable(prefix));
	return (await database.get(probe.sql, ...probe.params)) !== undefined;
}

/**
 * `id`'s stored rows. A clone in one store leaves a resume index whose branches its first resume rebuilds, where the
 * staged clone rebuilds it once published: that mark aside, the rows are main's.
 */
async function storedRows(database: SqliteDatabase, prefix: string, id: string) {
	const rows = await stored(database, prefix, id);
	const resume = (rows.session.summary_state as { resume?: Record<string, unknown> }).resume;
	if (resume !== undefined) delete resume.needsBranchRebuild;
	return rows;
}

/** What `forkTo` does for a whole-session clone: `createFork` with the complete feed, then the blobs it left. */
async function clone(source: SqlSessionStore, sourceId: string, dest: SqlSessionStore, child: SessionRecordHeader) {
	const head = await source.readEntrySizes(sourceId, 1, 0);
	const created = await dest.createFork(child, completeSessionForkStream(sourceId, head.epoch, head.lastSeq), {
		store: source,
		sessionId: sourceId,
		epoch: head.epoch,
		hashes: [],
		receipts: new Map(),
	});
	assert.ok(created, "the destination takes the clone");
	const missing: string[] = [];
	if (created.remainingBlobs?.length)
		await copySessionBlobs(source, sourceId, dest, child.id, created.remainingBlobs, {
			onMissingBlob: (error) => missing.push(String(error.message)),
		});
	return { created, missing };
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`forks between handles of one database on ${name} (#6560)`, () => {
		test(
			"stores opened separately on one database and prefix fork from each other without staging, and each child is complete",
			() =>
				withBackendScope(backend, async (scope) => {
					const prefix = `${scope.prefix}s_`;
					const firstDb = await scope.connect();
					const secondDb = await scope.connect();
					const first = await SqlSessionStore.open(firstDb, { prefix });
					const second = await SqlSessionStore.open(secondDb, { prefix });
					const { missing } = await seedSource(first, "src", "identity");
					await seedSource(second, "other", "reverse");
					const mainPrefix = `${scope.prefix}m_`;
					const mainDb = await scope.connect();
					const main = await SqlSessionStore.open(mainDb, { prefix: mainPrefix });

					const forward = await clone(first, "src", second, header("child", "src"));
					const backward = await clone(second, "other", first, header("child2", "other"));
					await mainClone(first, "src", main, header("child", "src"));
					await mainClone(second, "other", main, header("child2", "other"));

					assert.equal(await stagingExists(firstDb, prefix), false, "nothing was staged");
					assert.deepEqual(forward.created.remainingBlobs, [missing], "only the blob the source lacks is left");
					assert.equal(forward.created.lastSeq, 13);
					assert.equal(backward.created.lastSeq, 13);
					assert.deepEqual(
						await storedRows(firstDb, prefix, "child"),
						await storedRows(mainDb, mainPrefix, "child"),
					);
					assert.deepEqual(
						await storedRows(firstDb, prefix, "child2"),
						await storedRows(mainDb, mainPrefix, "child2"),
					);
					assert.deepEqual(await second.load("child"), await main.load("child"));
					assert.deepEqual(await first.load("child2"), await main.load("child2"));
					assert.deepEqual(
						await second.getBlob("child", sha256(bytesOf(BIG_BLOB_BYTES, 7))),
						bytesOf(BIG_BLOB_BYTES, 7),
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a store on the same database with another prefix keeps its own tables, and a clone into it is staged",
			() =>
				withBackendScope(backend, async (scope) => {
					const sourcePrefix = `${scope.prefix}s_`;
					const destPrefix = `${scope.prefix}d_`;
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: sourcePrefix });
					await seedSource(source, "src", "prefixes");
					const destDb = await scope.connect();
					const dest = await SqlSessionStore.open(destDb, { prefix: destPrefix });

					const { created } = await clone(source, "src", dest, header("child", "src"));
					assert.equal(created.lastSeq, 13);
					assert.equal(await stagingExists(destDb, destPrefix), true, "the clone went through the staging table");
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
