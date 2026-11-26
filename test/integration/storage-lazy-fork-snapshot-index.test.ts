import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	snapshotBlobHashes,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { legacyForkLinksTriggerName } from "../../packages/coding-agent/src/core/worktree-snapshot/fork-snapshot-index.js";
import {
	forkBoth,
	type LinkRow,
	linksOf,
	openWorlds,
	putBlobs,
	randomEntries,
	randomHistory,
	seeded,
	segmentCount,
	storedSeqs,
	type Worlds,
	writeBoth,
} from "../helpers/lazy-fork-worlds.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { messageEntry, snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";
import { libsqlFileBackend, type StorageBackend, storageBackends } from "../helpers/storage-backends.js";
import { header, user } from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * The snapshot reference index of forks that share their parent's history (#6560). Such a fork stores none of the
 * entries it inherits, so the index has no link for them under its id. An entry the fork stores must still be linked
 * as in a copy of the session: anchored to the nearest snapshot on its branch, never marked broken. The session store
 * writes those links itself, in the transaction that writes the entries; a plain session's writes link nothing more.
 * And collection must keep every snapshot a fork inherits, though no reference of the fork names it.
 *
 * Each history is written through the store twice on one database, under two prefixes: once with forks that copy,
 * once with forks that share. The copy is the expected result.
 */

const SERVER_TIMEOUT_MS = 240_000;

/**
 * The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md): a
 * released build whose reference index installs the session-entries triggers under their released names.
 */
interface ReleasedBlobStore {
	completeIndex(): Promise<void>;
}
const released = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase, prefix?: string): Promise<ReleasedBlobStore> } };
/** Histories per backend: a local file runs more of them than a server, where each statement is a round trip. */
const SEEDS: Record<string, number> = {
	"SQLite file": 16,
	"libSQL file": 8,
	"libSQL server (sqld)": 4,
	Postgres: 6,
};

async function withScope(backend: StorageBackend, body: (database: SqliteDatabase, prefix: string) => Promise<void>) {
	const scope = await backend.openScope();
	try {
		await body(await scope.connect(), scope.prefix);
	} finally {
		await scope.close();
	}
}

/** The view seq one past the last a fork inherits: the rows it stores past it are the entries appended to it. */
async function forkEnd(database: SqliteDatabase, prefix: string, id: string): Promise<number> {
	const row = await database.get(
		`SELECT max(base_seq + to_seq - from_seq + 1) AS last FROM ${prefix}session_fork_segments WHERE session_id = ?`,
		id,
	);
	return Number(row?.last ?? 0);
}

/** What a link says of its entry's place in the tree, as a copy has it. */
const linked = (row: LinkRow | undefined) =>
	row && { entry: row.entry, parent: row.parent, anchor: row.anchor, broken: row.broken };

/**
 * Asserts that the links of every row `id` stores in the shared world are the copy's: never broken, and, for a row
 * past `childrenFrom`, the same count of children. Resolves with the shared world's links.
 */
async function assertLinkedAsCopy(worlds: Worlds, id: string, childrenFrom: number, where: string) {
	const { database } = worlds;
	const stored = await storedSeqs(database, worlds.sharedPrefix, id);
	const expected = await linksOf(database, worlds.copyPrefix, id);
	const actual = await linksOf(database, worlds.sharedPrefix, id);
	assert.deepEqual([...actual.keys()], [...stored], `${where}: a link for every row it stores, and only those`);
	for (const seq of stored) {
		const want = expected.get(seq);
		const got = actual.get(seq);
		assert.deepEqual(linked(got), linked(want), `${where} seq ${seq}`);
		assert.equal(got?.broken, 0, `${where} seq ${seq}: not broken`);
		if (seq > childrenFrom) assert.equal(got?.children, want?.children, `${where} seq ${seq}: children`);
	}
	return actual;
}

/** Copies every row each fork of the shared world reads into it, through the store, until no fork has a segment. */
async function detachAll(worlds: Worlds, sessions: readonly string[], pageRows: number | undefined) {
	for (let round = 0; (await segmentCount(worlds.database, worlds.sharedPrefix)) > 0; round++) {
		assert.ok(round < sessions.length + 2, "every fork detaches");
		for (const id of sessions) await worlds.shared.detachForks(id, pageRows === undefined ? {} : { pageRows });
	}
}

for (const backend of [...storageBackends, libsqlFileBackend]) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(
		`the snapshot index of shared-history forks on ${name} (#6560)`,
		() => {
			test(
				"an entry a fork stores is linked as in a copy, through chains of forks three deep, never broken, and a rebuild of the index links it the same",
				() =>
					withScope(backend, async (database, prefix) => {
						for (let seed = 1; seed <= (SEEDS[backend.name] ?? 4); seed++) {
							const worlds = await openWorlds(database, `${prefix}${seed}`);
							const forks = await randomHistory(worlds, seed);
							assert.ok((await segmentCount(database, worlds.sharedPrefix)) > 0, `seed ${seed}: forks share`);
							const before = new Map<string, Map<number, LinkRow>>();
							for (const id of forks) {
								// A row the fork appended has only children it stores; a row it stored when it was made may have
								// inherited children, which its count leaves out.
								const end = await forkEnd(database, worlds.sharedPrefix, id);
								before.set(id, await assertLinkedAsCopy(worlds, id, end, `seed ${seed}, ${id}`));
							}

							// The index's rebuild links every row the way the store did.
							const { sources } = snapshotIndexTables(worlds.sharedPrefix);
							await database.run(
								`UPDATE ${sources} SET watermark = -1, backfilled_through = -1 WHERE source = 'session-entries'`,
							);
							await worlds.shared.snapshotBlobs.completeIndex();
							for (const id of forks)
								assert.deepEqual(
									await linksOf(database, worlds.sharedPrefix, id),
									before.get(id),
									`seed ${seed}, ${id}: rebuilt`,
								);
							for (const store of [worlds.copy, worlds.shared]) await store.close();
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a fork that copies the rows it read is linked as its copy, children included, a page at a time or at once",
				() =>
					withScope(backend, async (database, prefix) => {
						for (let seed = 1; seed <= Math.ceil((SEEDS[backend.name] ?? 4) / 2); seed++) {
							const worlds = await openWorlds(database, `${prefix}${seed}`);
							const forks = await randomHistory(worlds, 500 + seed);
							const root = `root-${500 + seed}`;
							await detachAll(worlds, [root, ...forks], seed % 2 === 0 ? 3 : undefined);
							for (const id of [root, ...forks]) {
								const length = worlds.views.get(id)!.length;
								assert.equal(
									(await storedSeqs(database, worlds.sharedPrefix, id)).size,
									length,
									`seed ${seed}, ${id}: stores its whole view`,
								);
								await assertLinkedAsCopy(worlds, id, 0, `seed ${seed}, ${id} detached`);
							}
							// Entries appended after it are linked as in the copy too.
							const random = seeded(seed);
							for (const id of forks)
								await writeBoth(worlds, id, randomEntries(random, worlds.views.get(id)!, 2, worlds.blobs, id));
							for (const id of forks) await assertLinkedAsCopy(worlds, id, 0, `seed ${seed}, ${id} later`);
							for (const store of [worlds.copy, worlds.shared]) await store.close();
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"collection keeps the snapshot a fork inherits after its parent moves on, as a copy keeps it",
				() =>
					withScope(backend, async (database, prefix) => {
						const worlds = await openWorlds(database, prefix);
						const first = textBlob("first checkout");
						const second = textBlob("second checkout");
						worlds.blobs.push(first, second);
						const s1 = snapshotEntry("/repo", "s1", syntheticSnapshot("s1", [first.hash]), null);
						const m1 = messageEntry("after s1", s1.id);
						await writeBoth(worlds, "parent", [s1, m1]);
						await forkBoth(worlds, "parent", "child", { cut: 2 });
						assert.equal(await storedSeqs(database, worlds.sharedPrefix, "child").then((s) => s.size), 0);
						await writeBoth(worlds, "child", [messageEntry("in the fork", m1.id)]);
						// The parent's next snapshot of the same checkout: the parent alone keeps only that one.
						await writeBoth(worlds, "parent", [
							snapshotEntry("/repo", "s2", syntheticSnapshot("s2", [second.hash]), m1.id),
						]);
						for (const store of [worlds.copy, worlds.shared])
							await store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
						const kept = async (store: SqlSessionStore) =>
							[...(await store.snapshotBlobs.listBlobHashes())].sort();
						const both = [first.hash, second.hash].sort();
						assert.deepEqual(await kept(worlds.copy), both, "the copy keeps both");
						assert.deepEqual(await kept(worlds.shared), both, "the shared fork keeps its inherited snapshot");
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"collection with live forks never removes a blob an inherited snapshot references, and keeps all a copy keeps",
				() =>
					withScope(backend, async (database, prefix) => {
						for (let seed = 1; seed <= Math.ceil((SEEDS[backend.name] ?? 4) / 2); seed++) {
							const worlds = await openWorlds(database, `${prefix}${seed}`);
							const forks = await randomHistory(worlds, 1000 + seed);
							await putBlobs(worlds);
							for (const store of [worlds.copy, worlds.shared])
								await store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
							const copyKept = new Set(await worlds.copy.snapshotBlobs.listBlobHashes());
							const sharedKept = new Set(await worlds.shared.snapshotBlobs.listBlobHashes());
							for (const hash of copyKept)
								assert.ok(sharedKept.has(hash), `seed ${seed}: ${hash} kept as in the copy`);
							for (const id of forks) {
								const stored = await storedSeqs(database, worlds.sharedPrefix, id);
								for (const [index, entry] of worlds.views.get(id)!.entries()) {
									if (stored.has(index + 1) || entry.type !== "worktree_snapshot" || !entry.snapshot) continue;
									for (const hash of snapshotBlobHashes(entry.snapshot))
										assert.ok(sharedKept.has(hash), `seed ${seed}: ${id} inherits ${hash} at ${index + 1}`);
								}
							}
							for (const store of [worlds.copy, worlds.shared]) await store.close();
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"after a released build installs its own triggers again, the store still links a fork's entries as a copy",
				() =>
					withScope(backend, async (database, prefix) => {
						const worlds = await openWorlds(database, prefix);
						const random = seeded(7);
						const append = (id: string, count: number) =>
							writeBoth(worlds, id, randomEntries(random, worlds.views.get(id) ?? [], count, worlds.blobs, id));
						await append("parent", 12);
						await forkBoth(worlds, "parent", "child", { cut: 9 });
						await append("child", 3);
						const entries = `${worlds.sharedPrefix}session_entries`;
						const triggers = async () => {
							const objects = dialectOf(database).schemaObjects([
								legacyForkLinksTriggerName(entries),
								`${entries}_snapshot_links`,
							]);
							return new Set(
								(await database.all(objects.sql, ...objects.params)).map((row) => String(row.name)),
							);
						};
						assert.deepEqual([...(await triggers())], [`${entries}_snapshot_links`], "no fork links trigger");

						// A released build finds one of its triggers missing and installs all of them again, under their names.
						await database.exec(dialectOf(database).dropTrigger(`${entries}_snapshot_links`, entries));
						const store = await released.SqlSnapshotBlobStore.open(database, worlds.sharedPrefix);
						await store.completeIndex();
						assert.ok(
							(await triggers()).has(`${entries}_snapshot_links`),
							"the released build installed it again",
						);

						// Entries written below inherited ones after it, once this build opens the store again, are linked as in a
						// copy. The released build indexed the entries before them its way, which this build trusts: a fork's entry
						// below an inherited one is broken there, as is any entry below it, which keeps every snapshot the fork
						// records.
						await worlds.shared.close();
						const reopened = await SqlSessionStore.open(database, { prefix: worlds.sharedPrefix });
						await reopened.snapshotBlobs.completeIndex();
						const view = worlds.views.get("child")!;
						const before = view.length;
						const blob = textBlob("below an inherited entry");
						worlds.blobs.push(blob);
						const added = [
							snapshotEntry("/repo", "below", syntheticSnapshot("below", [blob.hash]), view[2]!.id),
							messageEntry("below an inherited entry", view[4]!.id),
						];
						await putBlobs(worlds);
						for (const writer of [worlds.copy, reopened])
							await writer.append("child", added, { expectSeq: before });
						const expected = await linksOf(database, worlds.copyPrefix, "child");
						const actual = await linksOf(database, worlds.sharedPrefix, "child");
						for (const seq of [before + 1, before + 2])
							assert.deepEqual(
								{ ...linked(actual.get(seq)), children: actual.get(seq)?.children },
								{ ...linked(expected.get(seq)), children: expected.get(seq)?.children },
								`seq ${seq}`,
							);
						for (const seq of [before + 1, before + 2]) assert.equal(actual.get(seq)?.broken, 0, `seq ${seq}`);
						await reopened.close();
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a store that switches at its open links the entries its forks append from the first fork on, with no trigger for it",
				() =>
					withScope(backend, async (database, prefix) => {
						// A store an older build left at schema 2, with a session in it; then that build stops.
						const at = `${prefix}s_`;
						const older = await holdOlderBuildMarker(database, at);
						const before = await SqlSessionStore.open(database, { prefix: at });
						await before.create(header("parent"), [
							user("e1", null, "one", 1),
							user("e2", "e1", "two", 2),
							user("e3", "e2", "three", 3),
						]);
						await before.close();
						await older.release();

						// This open switches it, and the store links the entries of shared forks from then on.
						const store = await SqlSessionStore.open(database, { prefix: at });
						const objects = dialectOf(database).schemaObjects([
							legacyForkLinksTriggerName(`${at}session_entries`),
						]);
						assert.equal((await database.all(objects.sql, ...objects.params)).length, 0, "no fork links trigger");
						await store.snapshotBlobs.completeIndex();
						const head = await store.readEntrySizes("parent", 1, 0);
						const created = await store.createFork(
							header("child", "parent"),
							completeSessionForkStream("parent", head.epoch, head.lastSeq),
							{ store, sessionId: "parent", epoch: head.epoch, hashes: [], receipts: new Map() },
						);
						assert.equal(created?.lastSeq, 3);
						assert.ok((await segmentCount(database, at, "child")) > 0, "the fork shares its parent's rows");
						await store.append("child", [user("e4", "e3", "four", 4)], { expectSeq: 3 });
						assert.deepEqual(
							[...(await linksOf(database, at, "child")).values()].map((row) => [
								row.seq,
								row.entry,
								row.parent,
								row.broken,
							]),
							[[4, "e4", "e3", 0]],
							"the appended entry is linked below the entry it inherits, as in a copy",
						);
						await store.close();
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
