import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import {
	forkBoth,
	type LinkRow,
	linksOf,
	openWorlds,
	putBlobs,
	randomForkKind,
	seeded,
	segmentCount,
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

async function allLinks(database: SqliteDatabase, prefix: string, sessions: readonly string[]): Promise<Links> {
	const links: Links = new Map();
	for (const id of sessions) links.set(id, await linksOf(database, prefix, id));
	return links;
}

/** Rebuilds the snapshot index of the session entries under `prefix` from nothing, as after an upgrade. */
async function rebuild(worlds: Worlds, prefix: string): Promise<void> {
	const { sources } = snapshotIndexTables(prefix);
	await worlds.database.run(
		`UPDATE ${sources} SET watermark = -1, backfilled_through = -1 WHERE source = 'session-entries'`,
	);
	const store = prefix === worlds.copyPrefix ? worlds.copy : worlds.shared;
	await store.snapshotBlobs.completeIndex();
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
	});
}
