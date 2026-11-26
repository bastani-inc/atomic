import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { FORK_DETACH_PAGE_ROWS } from "../../packages/coding-agent/src/core/storage/session/fork-detach.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	sessionEntryLinks,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import {
	entriesIndexComplete,
	forkLinksCheck,
} from "../../packages/coding-agent/src/core/worktree-snapshot/fork-snapshot-index.js";
import {
	forkBoth,
	type LinkRow,
	linksOf,
	openWorlds,
	putBlobs,
	randomForkKind,
	seeded,
	segmentCount,
	sessionHeader,
	type Worlds,
	writeBoth,
} from "../helpers/lazy-fork-worlds.js";
import { messageEntry, snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";
import { type StorageBackend, storageBackends } from "../helpers/storage-backends.js";

/**
 * The snapshot index links each entry a session stores to its parent, its nearest snapshot and its count of children
 * (#6560). A save links an entry as it writes it; a rebuild of the index links every stored row again, in the order the
 * rows are stored. Both must end with the same links, also where a session has entries that share an ID, entries whose
 * parent comes after them, and forks whose inherited rows were copied in below the entries they appended.
 *
 * Each history is written twice on one database, under two prefixes: once with forks that copy, once with forks that
 * share their parent's history. The links of every session in both are read after the saves, the index is rebuilt,
 * and they are read again.
 */

const SERVER_TIMEOUT_MS = 300_000;
const SEEDS: Record<string, number> = { "SQLite file": 24, Postgres: 8 };

/**
 * Builds entries with the oddities older builds and imports can leave in a session: an entry with the ID of an earlier
 * one, and an entry whose parent is written after it, or never. Every ID gets a rank, and every parent ranks below its
 * child, so no chain of parents loops, whichever entry of a repeated ID a reader follows.
 */
class AnomalousEntries {
	private readonly ranks = new Map<string, number>();
	/** IDs an entry named as its parent before any entry had them, with the rank such an entry must stay below. */
	private readonly promised: { id: string; rank: number }[] = [];
	private next = 0;

	constructor(
		private readonly random: () => number,
		private readonly blobs: ReturnType<typeof textBlob>[],
	) {}

	/** Registers the entries of a view the generator did not make, such as a fork's. */
	know(view: readonly SessionEntry[]): void {
		for (const entry of view) if (!this.ranks.has(entry.id)) this.ranks.set(entry.id, this.next++);
	}

	/** A parent for an entry of rank `below`, from `view`: mostly the last entry, else any, else none. */
	private parentFor(view: readonly SessionEntry[], below: number): string | null {
		const candidates = view.filter((entry) => (this.ranks.get(entry.id) ?? Number.POSITIVE_INFINITY) < below);
		if (candidates.length === 0 || this.random() < 0.05) return null;
		return this.random() < 0.6
			? candidates.at(-1)!.id
			: candidates[Math.floor(this.random() * candidates.length)]!.id;
	}

	private body(tag: string, id: string, parentId: string | null): SessionEntry {
		if (this.random() < 0.35) {
			const blob = textBlob(`${tag}-${this.blobs.length}-${this.random()}`);
			this.blobs.push(blob);
			const root = this.random() < 0.5 ? "/repo" : "/other";
			const snapshotId = `snap-${this.blobs.length}-${Math.floor(this.random() * 1e9)}`;
			const entry = snapshotEntry(root, snapshotId, syntheticSnapshot(snapshotId, [blob.hash], { root }), parentId);
			return { ...entry, id } as SessionEntry;
		}
		return { ...messageEntry(`${tag} ${this.random()}`, parentId), id } as SessionEntry;
	}

	/** `count` entries after `view`. */
	entries(view: readonly SessionEntry[], count: number, tag: string): SessionEntry[] {
		const added: SessionEntry[] = [];
		for (let index = 0; index < count; index++) {
			const all = [...view, ...added];
			const pick = this.random();
			if (pick < 0.12 && all.length > 0) {
				// An ID an earlier entry has.
				const original = all[Math.floor(this.random() * all.length)]!;
				const rank = this.ranks.get(original.id)!;
				added.push(this.body(tag, original.id, this.parentFor(all, rank)));
			} else if (pick < 0.2 && this.promised.length > 0) {
				// The entry an earlier one named as its parent before it existed.
				const [promise] = this.promised.splice(Math.floor(this.random() * this.promised.length), 1);
				this.ranks.set(promise!.id, promise!.rank);
				added.push(this.body(tag, promise!.id, this.parentFor(all, promise!.rank)));
			} else if (pick < 0.3) {
				// An entry whose parent is written after it, or never.
				const rank = this.next++;
				const id = `${tag}-e${rank}`;
				const parent = `${tag}-later${rank}`;
				this.ranks.set(id, rank);
				this.promised.push({ id: parent, rank: rank - 0.5 });
				added.push(this.body(tag, id, parent));
			} else {
				const rank = this.next++;
				const id = `${tag}-e${rank}`;
				this.ranks.set(id, rank);
				added.push(this.body(tag, id, this.parentFor(all, rank)));
			}
		}
		return added;
	}
}

/** Every session of the history, in the order they were made. */
async function anomalousHistory(worlds: Worlds, seed: number): Promise<string[]> {
	const random = seeded(seed);
	const generator = new AnomalousEntries(random, worlds.blobs);
	const append = (id: string, count: number) =>
		writeBoth(worlds, id, generator.entries(worlds.views.get(id) ?? [], count, id));
	const root = `root-${seed}`;
	await append(root, 10 + Math.floor(random() * 16));
	const sessions = [root];
	const fork = async (parent: string, id: string) => {
		await forkBoth(worlds, parent, id, randomForkKind(random, worlds.views.get(parent)!));
		generator.know(worlds.views.get(id)!);
		sessions.push(id);
		await append(id, 2 + Math.floor(random() * 6));
		await append(parent, Math.floor(random() * 3));
	};
	let parent = root;
	for (let depth = 1; depth <= 3; depth++) {
		await fork(parent, `fork-${seed}-${depth}`);
		parent = `fork-${seed}-${depth}`;
	}
	await fork(root, `sibling-${seed}`);
	await fork(`fork-${seed}-1`, `nephew-${seed}`);
	return sessions;
}

type Links = Map<string, Map<number, LinkRow>>;

interface RefRow {
	readonly seq: number;
	readonly root: string;
	readonly snapshotId: string;
	readonly prevSeq: number | null;
}

async function refsOf(database: SqliteDatabase, prefix: string, id: string): Promise<RefRow[]> {
	const rows = await database.all<SqliteRow>(
		`SELECT seq, root, snapshot_id, prev_seq FROM ${snapshotIndexTables(prefix).sessionRefs} WHERE session_id = ? ORDER BY seq`,
		id,
	);
	return rows.map((row) => ({
		seq: Number(row.seq),
		root: String(row.root),
		snapshotId: String(row.snapshot_id),
		prevSeq: row.prev_seq === null ? null : Number(row.prev_seq),
	}));
}

async function allLinks(database: SqliteDatabase, prefix: string, sessions: readonly string[]): Promise<Links> {
	const links: Links = new Map();
	for (const id of sessions) links.set(id, await linksOf(database, prefix, id));
	return links;
}

/** Rebuilds the snapshot index of the session entries under `prefix` from nothing, as after an upgrade. */
async function rebuildStore(database: SqliteDatabase, prefix: string, store: SqlSessionStore): Promise<void> {
	const { sources } = snapshotIndexTables(prefix);
	await database.run(`UPDATE ${sources} SET watermark = -1, backfilled_through = -1 WHERE source = 'session-entries'`);
	await store.snapshotBlobs.completeIndex();
}

async function rebuild(worlds: Worlds, prefix: string): Promise<void> {
	const store = prefix === worlds.copyPrefix ? worlds.copy : worlds.shared;
	await rebuildStore(worlds.database, prefix, store);
}

function assertSameLinks(actual: Links, expected: Links, where: string): void {
	for (const [id, links] of expected)
		assert.deepEqual(
			[...(actual.get(id) ?? new Map()).values()],
			[...links.values()],
			`${where}: ${id} is linked by the rebuild as its saves linked it`,
		);
}

async function withScope(backend: StorageBackend, body: (database: SqliteDatabase, prefix: string) => Promise<void>) {
	const scope = await backend.openScope();
	try {
		await body(await scope.connect(), scope.prefix);
	} finally {
		await scope.close();
	}
}

/** Whether the history under `prefix` has an entry whose ID another entry of its session also has. */
async function hasDuplicates(database: SqliteDatabase, prefix: string): Promise<boolean> {
	const row = await database.get<SqliteRow>(
		`SELECT count(*) AS n FROM (SELECT session_id, entry_id FROM ${prefix}session_entries GROUP BY session_id, entry_id HAVING count(*) > 1) AS d`,
	);
	return Number(row?.n) > 0;
}

for (const backend of storageBackends.filter((backend) => backend.name in SEEDS)) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`the snapshot index's links on ${name} (#6560)`, () => {
		test(
			"a rebuild links every row as the saves did, with repeated entry IDs and parents written after their children",
			() =>
				withScope(backend, async (database, prefix) => {
					let duplicates = 0;
					for (let seed = 1; seed <= SEEDS[backend.name]!; seed++) {
						const worlds = await openWorlds(database, `${prefix}${seed}`);
						const sessions = await anomalousHistory(worlds, seed);
						assert.ok((await segmentCount(database, worlds.sharedPrefix)) > 0, `seed ${seed}: forks share`);
						if (await hasDuplicates(database, worlds.sharedPrefix)) duplicates++;
						for (const prefix of [worlds.copyPrefix, worlds.sharedPrefix]) {
							const saved = await allLinks(database, prefix, sessions);
							await rebuild(worlds, prefix);
							assertSameLinks(await allLinks(database, prefix, sessions), saved, `seed ${seed}, ${prefix}`);
						}
						for (const store of [worlds.copy, worlds.shared]) await store.close();
					}
					assert.ok(duplicates > 0, "some histories repeat an entry ID in a session");
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"after forks copy the rows they read, below the entries they appended, a rebuild links every row as the saves did",
			() =>
				withScope(backend, async (database, prefix) => {
					for (let seed = 1; seed <= Math.ceil(SEEDS[backend.name]! / 2); seed++) {
						const worlds = await openWorlds(database, `${prefix}${seed}`);
						const random = seeded(700 + seed);
						const sessions = await anomalousHistory(worlds, 700 + seed);
						// Detach some sessions' forks, a page of a few rows at a time or at once, and append after.
						for (const id of sessions)
							if (random() < 0.5) await worlds.shared.detachForks(id, random() < 0.5 ? { pageRows: 3 } : {});
						const generator = new AnomalousEntries(random, worlds.blobs);
						for (const id of sessions) generator.know(worlds.views.get(id)!);
						for (const id of sessions)
							await writeBoth(worlds, id, generator.entries(worlds.views.get(id)!, 2, `${id}-after`));
						await putBlobs(worlds);
						const saved = await allLinks(database, worlds.sharedPrefix, sessions);
						await rebuild(worlds, worlds.sharedPrefix);
						assertSameLinks(
							await allLinks(database, worlds.sharedPrefix, sessions),
							saved,
							`seed ${seed} detached`,
						);
						for (const store of [worlds.copy, worlds.shared]) await store.close();
					}
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"irregular caller-held forks, self-parents, and multi-segment histories match a rebuild after paged detach (#6705)",
			() =>
				withScope(backend, async (database, prefix) => {
					const store = await SqlSessionStore.open(database, { prefix });
					try {
						const blobs = [textBlob("b1"), textBlob("b2"), textBlob("b3"), textBlob("b4")];
						await store.snapshotBlobs.putBlobs(blobs);
						const snap = (id: string, parentId: string | null, blobIndex: number): SessionEntry =>
							({
								...snapshotEntry(
									"/repo",
									`snap-${id}`,
									syntheticSnapshot(`snap-${id}`, [blobs[blobIndex]!.hash], { root: "/repo" }),
									parentId,
								),
								id,
							}) as SessionEntry;
						const msg = (id: string, parentId: string | null): SessionEntry =>
							({ ...messageEntry(`msg-${id}`, parentId), id }) as SessionEntry;

						// Source A: normal chain with snapshots, plus a self-parenting snapshot and an entry later given a non-text parentId.
						const p1Entries: SessionEntry[] = [
							msg("a1", null),
							snap("a2", "a1", 0),
							msg("a3", "a2"),
							snap("self-snap", "self-snap", 1),
							msg("a5", "a3"),
							msg("bad-parent-type", null),
							snap("a7", "a5", 2),
						];
						await store.create(sessionHeader("p1"), p1Entries);
						// Simulate a legacy/imported row whose JSON parentId is a non-text value (integer 42), then rebuild so p1's
						// own links mark it broken as a fresh indexing of that row does.
						await database.run(
							`UPDATE ${prefix}session_entries SET entry_json = ? WHERE session_id = ? AND seq = 6`,
							JSON.stringify({ ...p1Entries[5]!, parentId: 42 }),
							"p1",
						);
						await rebuildStore(database, prefix, store);
						const p1Loaded = (await store.load("p1")).entries;

						// Source B: second source with an entry sharing ID "a3" to test multi-segment duplicate detection.
						const p2Entries: SessionEntry[] = [snap("b1", null, 3), msg("a3", "b1"), msg("b3", "a3")];
						await store.create(sessionHeader("p2"), p2Entries);

						const forkEntries = async (parentId: string, childId: string, entries: readonly SessionEntry[]) => {
							const head = await store.readEntrySizes(parentId, 1, 0);
							const created = await store.createFork(sessionHeader(childId), entries, {
								store,
								sessionId: parentId,
								epoch: head.epoch,
								hashes: [],
								receipts: new Map(),
							});
							assert.ok(created, `created shared fork ${childId}`);
						};

						// 1. Caller-held fork that skips parent "a2" so shared row "a3" loses its parent.
						await forkEntries("p1", "f-skip", [p1Entries[0]!, p1Entries[2]!, p1Entries[4]!, p1Entries[6]!]);
						// 2. Caller-held fork that edits seq 1 to name a parent ("a5") materialized in a later page.
						await forkEntries("p1", "f-forward-parent", [
							msg("a1", "a5"),
							p1Entries[1]!,
							p1Entries[2]!,
							p1Entries[4]!,
							p1Entries[6]!,
						]);
						// 3. Caller-held fork that changes entry types (snapshot -> message, message -> snapshot) and parentId.
						await forkEntries("p1", "f-type-change", [
							p1Entries[0]!,
							msg("a2", "a1"),
							snap("a3", "a2", 0),
							p1Entries[4]!,
							msg("edited-parent", "a1"),
							p1Entries[6]!,
						]);
						// 4. Full fork of p1 (contains self-parenting snapshot + non-text parentId at seq 6) + appended child of self-snap.
						{
							const head = await store.readEntrySizes("p1", 1, 0);
							const created = await store.createFork(
								sessionHeader("f-self"),
								completeSessionForkStream("p1", head.epoch, head.lastSeq),
								{ store, sessionId: "p1", epoch: head.epoch, hashes: [], receipts: new Map() },
							);
							assert.equal(created?.lastSeq, p1Loaded.length);
							await store.append("f-self", [msg("f-self-own", "self-snap")], { expectSeq: p1Loaded.length });
						}
						// 5. Multi-segment fork combining p2 and p1 (duplicate "a3" across two sources) via two-level fork.
						await forkEntries("p2", "f-mid", [
							p2Entries[0]!,
							p2Entries[1]!,
							p1Entries[0]!,
							p1Entries[1]!,
							p1Entries[2]!,
						]);
						await forkEntries("p1", "f-multi", [
							p2Entries[0]!,
							p2Entries[1]!,
							p1Entries[0]!,
							p1Entries[1]!,
							p1Entries[2]!,
							p1Entries[4]!,
							p1Entries[6]!,
						]);
						await store.append("f-multi", [msg("multi-own", "a3")], { expectSeq: 7 });

						// Detach p1 a 2-row page at a time (cross-page parent checks + remaining segments on intermediate pages).
						await store.detachForks("p1", { pageRows: 2 });
						// Self-parenting snapshot must have 1 child (f-self-own), never 2 (must not count itself).
						const selfLinks = await linksOf(database, prefix, "f-self");
						assert.equal(selfLinks.get(4)?.children, 1, "self-parenting snapshot counts only later child");

						const sessions = [
							"p1",
							"p2",
							"f-skip",
							"f-forward-parent",
							"f-type-change",
							"f-self",
							"f-mid",
							"f-multi",
						];
						const linksAfterP1 = await allLinks(database, prefix, sessions);
						const refsAfterP1 = new Map(
							await Promise.all(sessions.map(async (id) => [id, await refsOf(database, prefix, id)] as const)),
						);
						await rebuildStore(database, prefix, store);
						assertSameLinks(await allLinks(database, prefix, sessions), linksAfterP1, "after p1 paged detach");
						for (const id of sessions)
							assert.deepEqual(
								await refsOf(database, prefix, id),
								refsAfterP1.get(id),
								`after p1 paged detach: ${id} refs`,
							);

						// Detach f-self's reparented children as well (with reparent: false) so every irregular fork copies its own rows
						// in 2-row pages down to 0 remaining segments, then verify rebuild equivalence and verdict equivalence.
						await store.detachForks("f-self", { pageRows: 2, reparent: false });
						const linksAfterFself = await allLinks(database, prefix, sessions);
						const refsAfterFself = new Map(
							await Promise.all(sessions.map(async (id) => [id, await refsOf(database, prefix, id)] as const)),
						);
						await rebuildStore(database, prefix, store);
						assertSameLinks(
							await allLinks(database, prefix, sessions),
							linksAfterFself,
							"after f-self paged detach",
						);
						for (const id of sessions)
							assert.deepEqual(
								await refsOf(database, prefix, id),
								refsAfterFself.get(id),
								`after f-self paged detach: ${id} refs`,
							);

						// Verify differential verdict equivalence between hasSegments: true and hasSegments: false when 0 segments remain.
						const t = snapshotIndexTables(prefix);
						const forkTables = sessionForkTables(prefix);
						const complete = entriesIndexComplete(t.sources);
						const checkTables = { links: t.sessionLinks, segments: forkTables.forkSegments, refs: t.sessionRefs };
						const checkWithSegs = forkLinksCheck(checkTables, complete, { hasSegments: true });
						const checkNoSegsMat = forkLinksCheck(checkTables, complete, {
							hasSegments: false,
							materialize: true,
						});
						const checkNoSegsInline = forkLinksCheck(checkTables, complete, {
							hasSegments: false,
							materialize: false,
						});
						for (const id of ["f-skip", "f-forward-parent", "f-type-change", "f-self"]) {
							assert.equal(await segmentCount(database, prefix, id), 0, `${id} has no remaining segments`);
							for (const fromSeq of [1, 2, 4]) {
								const vWith = await database.get<SqliteRow>(checkWithSegs, id, id, fromSeq, id, fromSeq);
								const vNoMat = await database.get<SqliteRow>(checkNoSegsMat, id, fromSeq, id, fromSeq);
								const vNoInline = await database.get<SqliteRow>(
									checkNoSegsInline,
									id,
									fromSeq,
									id,
									fromSeq,
									id,
									fromSeq,
								);
								assert.deepEqual(vNoMat, vWith, `${id} fromSeq=${fromSeq}: materialized verdicts match`);
								assert.deepEqual(vNoInline, vWith, `${id} fromSeq=${fromSeq}: streamed verdicts match`);
							}
						}

						// Verify 4-argument settle (omitting hasSegments, as an older caller does) and 6-parameter materialized SQL.
						const entryLinks = sessionEntryLinks(prefix, dialectOf(database), forkTables.forkSegments);
						await database.transaction(async (tx) => {
							await entryLinks.settle(tx, "f-self", 1, []);
						});
						assert.deepEqual(await linksOf(database, prefix, "f-self"), linksAfterFself.get("f-self"));

						// Detach p2 as well and verify rebuild equivalence again.
						await store.detachForks("p2", { pageRows: 1 });
						const linksAfterP2 = await allLinks(database, prefix, sessions);
						await rebuildStore(database, prefix, store);
						assertSameLinks(await allLinks(database, prefix, sessions), linksAfterP2, "after p2 paged detach");
					} finally {
						await store.close();
					}
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a 20,000-row fork detached with default 2,000-row pages matches expected links and refs across all 10 pages (#6705)",
			() =>
				withScope(backend, async (database, prefix) => {
					const store = await SqlSessionStore.open(database, { prefix });
					try {
						const total = 20_000;
						const blob = textBlob("large-fork-snap");
						await store.snapshotBlobs.putBlobs([blob]);
						const parentEntries: SessionEntry[] = [];
						for (let seq = 1; seq <= total; seq++) {
							const id = `p-${seq}`;
							const parentId = seq === 1 ? null : `p-${seq - 1}`;
							if (seq % 2_500 === 0) {
								parentEntries.push({
									...snapshotEntry(
										"/repo",
										`snap-${seq}`,
										syntheticSnapshot(`snap-${seq}`, [blob.hash], { root: "/repo" }),
										parentId,
									),
									id,
								} as SessionEntry);
							} else {
								parentEntries.push({
									type: "message",
									id,
									parentId,
									timestamp: "2026-11-26T00:00:00.000Z",
									message: { role: "user", content: `m${seq}`, timestamp: seq },
								} as SessionEntry);
							}
						}
						await store.create(sessionHeader("p-20k"), parentEntries);
						const head = await store.readEntrySizes("p-20k", 1, 0);
						for (const child of ["f1-20k", "f2-20k"]) {
							const created = await store.createFork(
								sessionHeader(child),
								completeSessionForkStream("p-20k", head.epoch, head.lastSeq),
								{ store, sessionId: "p-20k", epoch: head.epoch, hashes: [], receipts: new Map() },
							);
							assert.equal(created?.lastSeq, total);
							await store.append(
								child,
								[
									{
										...snapshotEntry(
											"/repo",
											`snap-${child}`,
											syntheticSnapshot(`snap-${child}`, [blob.hash], { root: "/repo" }),
											`p-${total}`,
										),
										id: `${child}-own`,
									} as SessionEntry,
								],
								{ expectSeq: total },
							);
						}

						// Detach with default FORK_DETACH_PAGE_ROWS (2,000 rows -> 10 pages).
						assert.equal(FORK_DETACH_PAGE_ROWS, 2_000);
						const report = await store.detachForks("p-20k");
						assert.deepEqual([...report.detached, ...report.reparented].sort(), ["f1-20k", "f2-20k"]);
						const detachedId = report.detached[0]!;
						assert.equal(await segmentCount(database, prefix, detachedId), 0);

						// Verify every single one of the 20,001 link rows and every snapshot ref matches the exact chain spec!
						const links = await linksOf(database, prefix, detachedId);
						assert.equal(links.size, total + 1);
						let lastAnchor: number | null = null;
						for (let seq = 1; seq <= total; seq++) {
							if (seq % 2_500 === 0) lastAnchor = seq;
							const row = links.get(seq);
							assert.ok(row, `missing link at seq ${seq}`);
							assert.equal(row.entry, `p-${seq}`);
							assert.equal(row.parent, seq === 1 ? null : `p-${seq - 1}`);
							assert.equal(row.anchor, lastAnchor, `anchor at seq ${seq}`);
							assert.equal(row.children, 1, `children at seq ${seq}`);
							assert.equal(row.broken, 0, `broken at seq ${seq}`);
						}
						const ownRow = links.get(total + 1);
						assert.deepEqual(ownRow, {
							seq: total + 1,
							entry: `${detachedId}-own`,
							parent: `p-${total}`,
							anchor: total + 1,
							children: 0,
							broken: 0,
						});
						const refs = await refsOf(database, prefix, detachedId);
						assert.equal(refs.length, total / 2_500 + 1);
						for (let i = 0; i < total / 2_500; i++) {
							const seq = (i + 1) * 2_500;
							assert.equal(refs[i]!.seq, seq);
							assert.equal(refs[i]!.prevSeq, i === 0 ? null : i * 2_500);
						}
						assert.equal(refs.at(-1)!.seq, total + 1);
						assert.equal(refs.at(-1)!.prevSeq, total);
					} finally {
						await store.close();
					}
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
