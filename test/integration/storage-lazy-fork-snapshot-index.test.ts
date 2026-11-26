import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { snapshotBlobHashes } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { forkLinksTriggerName } from "../../packages/coding-agent/src/core/worktree-snapshot/fork-snapshot-index.js";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import {
	appendEntries,
	forkOf,
	type HistorySession,
	linksAt,
	openWorld,
	pathTo,
	seeded,
	type World,
	writeAppend,
	writeFork,
} from "../helpers/lazy-fork-worlds.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { messageEntry, snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";
import { type StorageBackend, storageBackends } from "../helpers/storage-backends.js";
import { header, user } from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * The snapshot reference index of forks that share their parent's history (#6560). Such a fork stores none of the
 * entries it inherits, so the index has no link for them under its id. An entry the fork appends below an inherited
 * one must still be linked as in a copy of the session: anchored to the nearest snapshot on its branch, never marked
 * broken. And collection must keep every snapshot a fork inherits, though no reference of the fork names it.
 *
 * Each history is written twice on one database, under two prefixes: once with forks that copy, once with forks that
 * share. The copy is the expected result.
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
/** Histories per backend: a local file runs more of them than a server, where each row is a round trip. */
const SEEDS: Record<string, number> = { "SQLite file": 24, "libSQL server (sqld)": 6, Postgres: 8 };

async function withScope(backend: StorageBackend, body: (database: SqliteDatabase, prefix: string) => Promise<void>) {
	const scope = await backend.openScope();
	try {
		await body(await scope.connect(), scope.prefix);
	} finally {
		await scope.close();
	}
}

interface Worlds {
	readonly copy: World;
	readonly shared: World;
	/** Every session of the history, parents first. */
	readonly sessions: HistorySession[];
	/** The sessions that are forks. */
	readonly forks: HistorySession[];
	readonly blobs: SnapshotBlob[];
}

/**
 * A random history: a root session, a chain of three forks, each of the one before, and a fork of the root beside
 * them. A fork keeps a prefix of its parent's view or the branch to one of its entries, stores some kept rows itself, as
 * a fork stores rows it edits, and has entries appended; parents go on appending after they are forked.
 */
async function randomHistory(database: SqliteDatabase, prefix: string, seed: number): Promise<Worlds> {
	const random = seeded(seed);
	const copy = await openWorld(database, `${prefix}c_`, false);
	const shared = await openWorld(database, `${prefix}l_`, true);
	const both = [copy, shared];
	const blobs: SnapshotBlob[] = [];
	const root: HistorySession = { id: `root-${seed}`, view: [], segments: [], own: new Set() };
	await writeAppend(database, both, root.id, appendEntries(random, root, 12 + Math.floor(random() * 20), blobs));
	const sessions = [root];
	const forks: HistorySession[] = [];
	const fork = async (parent: HistorySession, id: string) => {
		const view = parent.view;
		const kept =
			random() < 0.5
				? view.slice(0, 1 + Math.floor(random() * view.length))
				: pathTo(view, view[Math.floor(random() * view.length)]!);
		const { child, ownRows } = forkOf(random, parent, id, kept, 0.15);
		await writeFork(database, copy, shared, child, ownRows);
		await writeAppend(database, both, child.id, appendEntries(random, child, 2 + Math.floor(random() * 6), blobs));
		// The parent goes on after the fork.
		await writeAppend(database, both, parent.id, appendEntries(random, parent, Math.floor(random() * 3), blobs));
		sessions.push(child);
		forks.push(child);
		return child;
	};
	let parent = root;
	for (let depth = 1; depth <= 3; depth++) parent = await fork(parent, `fork-${seed}-${depth}`);
	await fork(root, `sibling-${seed}`);
	return { copy, shared, sessions, forks, blobs };
}

/** The view seqs at which a fork stores a row it appended, past every row it inherits or stored when it was made. */
function appendedSeqs(session: HistorySession): Set<number> {
	const forkEnd = Math.max(
		0,
		...session.segments.map((segment) => segment.baseSeq + segment.toSeq - segment.fromSeq + 1),
	);
	return new Set([...session.own].filter((seq) => seq > forkEnd));
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(
		`the snapshot index of shared-history forks on ${name} (#6560)`,
		() => {
			test(
				"an entry a fork stores is linked as in a copy: its anchor, through chains of forks three deep, and never broken",
				() =>
					withScope(backend, async (database, prefix) => {
						for (let seed = 1; seed <= (SEEDS[backend.name] ?? 4); seed++) {
							const { copy, shared, forks } = await randomHistory(database, `${prefix}${seed}`, seed);
							for (const session of forks) {
								const seqs = [...session.own];
								const expected = await linksAt(database, copy, session.id, seqs);
								const actual = await linksAt(database, shared, session.id, seqs);
								const appended = appendedSeqs(session);
								for (const seq of seqs) {
									const want = expected.get(seq)!;
									const got = actual.get(seq);
									const where = `seed ${seed}, ${session.id} seq ${seq}`;
									assert.ok(got, `${where}: indexed`);
									assert.deepEqual(
										{
											entry: got.entry_id,
											parent: got.parent_id,
											anchor: got.anchor_seq,
											broken: got.broken,
										},
										{
											entry: want.entry_id,
											parent: want.parent_id,
											anchor: want.anchor_seq,
											broken: want.broken,
										},
										where,
									);
									assert.equal(got.broken, 0, `${where}: not broken`);
									// A row the fork appended has only children it stores; a row it stored when it was made may have
									// inherited children, which its count leaves out.
									if (appended.has(seq)) assert.equal(got.children, want.children, `${where}: children`);
								}
							}
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"collection keeps the snapshot a fork inherits after its parent moves on, as a copy keeps it",
				() =>
					withScope(backend, async (database, prefix) => {
						const copy = await openWorld(database, `${prefix}c_`, false);
						const shared = await openWorld(database, `${prefix}l_`, true);
						const both = [copy, shared];
						const first = textBlob("first checkout");
						const second = textBlob("second checkout");
						const s1 = snapshotEntry("/repo", "s1", syntheticSnapshot("s1", [first.hash]), null);
						const m1 = messageEntry("after s1", s1.id);
						await writeAppend(database, both, "parent", [
							{ seq: 1, entry: s1 },
							{ seq: 2, entry: m1 },
						]);
						const parent: HistorySession = { id: "parent", view: [s1, m1], segments: [], own: new Set([1, 2]) };
						const { child, ownRows } = forkOf(() => 1, parent, "child", parent.view, 0);
						await writeFork(database, copy, shared, child, ownRows);
						await writeAppend(database, both, "child", [{ seq: 3, entry: messageEntry("in the fork", m1.id) }]);
						// The parent's next snapshot of the same checkout: the parent alone keeps only that one.
						const s2 = snapshotEntry("/repo", "s2", syntheticSnapshot("s2", [second.hash]), m1.id);
						await writeAppend(database, both, "parent", [{ seq: 3, entry: s2 }]);
						for (const world of both) {
							await world.store.snapshotBlobs.putBlobs([first, second]);
							await world.store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
						}
						const kept = async (world: World) => new Set(await world.store.snapshotBlobs.listBlobHashes());
						assert.deepEqual(
							[...(await kept(copy))].sort(),
							[first.hash, second.hash].sort(),
							"the copy keeps both",
						);
						assert.deepEqual(
							[...(await kept(shared))].sort(),
							[first.hash, second.hash].sort(),
							"the shared fork keeps its inherited snapshot",
						);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"collection with live forks never removes a blob an inherited snapshot references, and keeps all a copy keeps",
				() =>
					withScope(backend, async (database, prefix) => {
						for (let seed = 1; seed <= Math.ceil((SEEDS[backend.name] ?? 4) / 2); seed++) {
							const { copy, shared, forks, blobs } = await randomHistory(
								database,
								`${prefix}${seed}`,
								1000 + seed,
							);
							for (const world of [copy, shared]) {
								await world.store.snapshotBlobs.putBlobs(blobs);
								await world.store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
							}
							const copyKept = new Set(await copy.store.snapshotBlobs.listBlobHashes());
							const sharedKept = new Set(await shared.store.snapshotBlobs.listBlobHashes());
							for (const hash of copyKept)
								assert.ok(sharedKept.has(hash), `seed ${seed}: ${hash} kept as in the copy`);
							for (const session of forks)
								session.view.forEach((entry: SessionEntry, index) => {
									if (session.own.has(index + 1) || entry.type !== "worktree_snapshot" || !entry.snapshot)
										return;
									for (const hash of snapshotBlobHashes(entry.snapshot))
										assert.ok(
											sharedKept.has(hash),
											`seed ${seed}: ${session.id} inherits ${hash} at ${index + 1}`,
										);
								});
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a released build that installs its own triggers again leaves the fork links trigger in place",
				() =>
					withScope(backend, async (database, prefix) => {
						const copy = await openWorld(database, `${prefix}c_`, false);
						const shared = await openWorld(database, `${prefix}l_`, true);
						const both = [copy, shared];
						const blobs: SnapshotBlob[] = [];
						const random = seeded(7);
						const parent: HistorySession = { id: "parent", view: [], segments: [], own: new Set() };
						await writeAppend(database, both, parent.id, appendEntries(random, parent, 12, blobs));
						const { child, ownRows } = forkOf(random, parent, "child", parent.view.slice(0, 9), 0);
						await writeFork(database, copy, shared, child, ownRows);
						await writeAppend(database, both, child.id, appendEntries(random, child, 3, blobs));
						const forkLinks = forkLinksTriggerName(shared.entries);
						const triggers = async () => {
							const objects = dialectOf(database).schemaObjects([forkLinks, `${shared.entries}_snapshot_links`]);
							return new Set(
								(await database.all(objects.sql, ...objects.params)).map((row) => String(row.name)),
							);
						};
						assert.ok((await triggers()).has(forkLinks), "turning shared history on installs the trigger");

						// A released build finds one of its triggers missing and installs all of them again, under their names.
						await database.exec(
							dialectOf(database).dropTrigger(`${shared.entries}_snapshot_links`, shared.entries),
						);
						const store = await released.SqlSnapshotBlobStore.open(database, shared.prefix);
						await store.completeIndex();
						const present = await triggers();
						assert.ok(
							present.has(`${shared.entries}_snapshot_links`),
							"the released build installed its trigger again",
						);
						assert.ok(present.has(forkLinks), "the fork links trigger is still there");

						// Entries written after it, here once this build opens the store again, are linked as in a copy. The released
						// build indexed the entries before them its way: a fork's entry below an inherited one is broken there, which
						// keeps every snapshot the fork records.
						const reopened = await SqlSessionStore.open(database, { prefix: shared.prefix });
						await reopened.snapshotBlobs.completeIndex();
						const before = child.view.length;
						await writeAppend(database, both, child.id, appendEntries(random, child, 1, blobs));
						// Below an inherited entry, not the last one the fork stores.
						const below = messageEntry("below an inherited entry", child.view[4]!.id);
						child.view.push(below);
						child.own.add(child.view.length);
						await writeAppend(database, both, child.id, [{ seq: child.view.length, entry: below }]);
						const seqs = [...child.own].filter((seq) => seq > before);
						assert.equal(seqs.length, 2);
						const expected = await linksAt(database, copy, child.id, seqs);
						const actual = await linksAt(database, shared, child.id, seqs);
						for (const seq of seqs) {
							const want = expected.get(seq)!;
							const got = actual.get(seq)!;
							assert.deepEqual(
								{ anchor: got.anchor_seq, broken: got.broken, children: got.children },
								{ anchor: want.anchor_seq, broken: want.broken, children: want.children },
								`seq ${seq}`,
							);
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a store that switches at its open links the entries its forks append from the first fork on",
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

						// This open switches it, and the snapshot index the same process opens next links shared forks.
						const store = await SqlSessionStore.open(database, { prefix: at });
						const trigger = forkLinksTriggerName(`${at}session_entries`);
						const objects = dialectOf(database).schemaObjects([trigger]);
						assert.equal(
							(await database.all(objects.sql, ...objects.params)).length,
							1,
							"the switch installs the fork links trigger with the fork tables",
						);
						await store.snapshotBlobs.completeIndex();
						const head = await store.readEntrySizes("parent", 1, 0);
						const created = await store.createFork(
							header("child", "parent"),
							completeSessionForkStream("parent", head.epoch, head.lastSeq),
							{ store, sessionId: "parent", epoch: head.epoch, hashes: [], receipts: new Map() },
						);
						assert.equal(created?.lastSeq, 3);
						const segments = await database.get(
							`SELECT count(*) AS n FROM ${sessionForkTables(at).forkSegments} WHERE session_id = ?`,
							"child",
						);
						assert.ok(Number(segments?.n) > 0, "the fork shares its parent's rows");
						await store.append("child", [user("e4", "e3", "four", 4)], { expectSeq: 3 });

						const links = await database.all(
							`SELECT seq, entry_id, parent_id, broken FROM ${at}snapshot_session_links WHERE session_id = ? ORDER BY seq`,
							"child",
						);
						assert.deepEqual(
							links.map((row) => [Number(row.seq), row.entry_id, row.parent_id, Number(row.broken)]),
							[[4, "e4", "e3", 0]],
							"the appended entry is linked below the entry it inherits, as in a copy",
						);
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
