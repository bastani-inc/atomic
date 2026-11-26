import assert from "node:assert/strict";
import { createLabelEntry } from "../../packages/coding-agent/src/core/session-manager-entries.ts";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	completeSessionForkStream,
	humanForkStream,
} from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import { holdOlderBuildMarker } from "./older-build-marker.js";
import { messageEntry, snapshotEntry, syntheticSnapshot, textBlob } from "./snapshot-reference-index.js";

/**
 * Two worlds of the same session histories on one database, under two prefixes (#6560), both written through the
 * session store: in one every fork copies the rows it keeps, as forks always have; in the other, where shared-history
 * forks are on, a fork stores only the rows it changes and the entries appended to it, and fork segments name the rest
 * in the sessions that store them.
 */

/** A deterministic random source, so a failing history can be replayed by its seed. */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The ancestors of `entry` in `view`, itself included, in view order. */
export function pathTo(view: readonly SessionEntry[], entry: SessionEntry): SessionEntry[] {
	const byId = new Map(view.map((item) => [item.id, item]));
	const path: SessionEntry[] = [];
	for (
		let at: SessionEntry | undefined = entry;
		at !== undefined;
		at = at.parentId ? byId.get(at.parentId) : undefined
	)
		path.push(at);
	const order = new Map(view.map((item, index) => [item.id, index]));
	return path.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function sessionHeader(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-01T00:00:00.000Z", cwd: "/project" };
}

/** The two stores of one history, each session's view, and every snapshot blob its entries name. */
export interface Worlds {
	readonly database: SqliteDatabase;
	readonly copy: SqlSessionStore;
	readonly shared: SqlSessionStore;
	readonly copyPrefix: string;
	readonly sharedPrefix: string;
	readonly views: Map<string, SessionEntry[]>;
	readonly blobs: SnapshotBlob[];
}

/**
 * Opens both worlds under `prefix`: the copying store stays at schema 2 while an older build's session runs on its
 * prefix, as a store does until such a build stops; the other shares its forks' history from its first open.
 */
export async function openWorlds(database: SqliteDatabase, prefix: string): Promise<Worlds> {
	const copyPrefix = `${prefix}c_`;
	const sharedPrefix = `${prefix}l_`;
	await holdOlderBuildMarker(database, copyPrefix);
	return {
		database,
		copy: await SqlSessionStore.open(database, { prefix: copyPrefix }),
		shared: await SqlSessionStore.open(database, { prefix: sharedPrefix }),
		copyPrefix,
		sharedPrefix,
		views: new Map(),
		blobs: [],
	};
}

/**
 * `count` random entries after `view`: snapshots of one of two checkouts, each with a blob of its own, messages, and
 * now and then a label, which a branch fork drops, editing the entry after it to follow the one before.
 */
export function randomEntries(
	random: () => number,
	view: readonly SessionEntry[],
	count: number,
	blobs: SnapshotBlob[],
	tag: string,
): SessionEntry[] {
	const added: SessionEntry[] = [];
	for (let index = 0; index < count; index++) {
		const all = [...view, ...added];
		const parent = all.length === 0 ? null : random() < 0.6 ? all.at(-1)! : all[Math.floor(random() * all.length)]!;
		if (parent !== null && random() < 0.1) {
			const target = all[Math.floor(random() * all.length)]!;
			added.push(createLabelEntry(target.id, `${tag}-label`, new Set(all.map((entry) => entry.id)), parent.id));
			continue;
		}
		if (random() < 0.35) {
			const blob = textBlob(`${tag}-${blobs.length}-${random()}`);
			blobs.push(blob);
			const root = random() < 0.5 ? "/repo" : "/other";
			const id = `snap-${blobs.length}-${Math.floor(random() * 1e9)}`;
			added.push(snapshotEntry(root, id, syntheticSnapshot(id, [blob.hash], { root }), parent?.id ?? null));
		} else added.push(messageEntry(tag, parent?.id ?? null));
	}
	return added;
}

/** Stores `entries` in both worlds: a new session `id`, or appended to it. Their blobs are stored first. */
export async function writeBoth(worlds: Worlds, id: string, entries: readonly SessionEntry[]): Promise<void> {
	await putBlobs(worlds);
	const view = worlds.views.get(id);
	for (const store of [worlds.copy, worlds.shared]) {
		if (view === undefined) await store.create(sessionHeader(id), entries);
		else if (entries.length > 0) await store.append(id, entries, { expectSeq: view.length });
	}
	worlds.views.set(id, [...(view ?? []), ...entries]);
}

/** Every blob of the worlds' history, stored in both. */
export async function putBlobs(worlds: Worlds): Promise<void> {
	for (const store of [worlds.copy, worlds.shared]) await store.snapshotBlobs.putBlobs(worlds.blobs);
}

/** How a fork keeps its parent's entries: see {@link forkBoth}. */
export type ForkKind =
	| { readonly cut: number }
	| { readonly leaf: SessionEntry; readonly leafSeq: number }
	| { readonly entries: readonly SessionEntry[] };

/**
 * Forks `parent` into `id` in both worlds: its whole history through `cut`; with `leaf`, the branch to that entry,
 * without its labels, each entry after one edited to follow the entry before it; or, with `entries`, the entries a caller holds, which a store with shared history shares where they are the
 * ones it wrote and stores itself where they are not, as when they were edited.
 */
export async function forkBoth(worlds: Worlds, parent: string, id: string, kind: ForkKind): Promise<void> {
	const lengths: number[] = [];
	for (const store of [worlds.copy, worlds.shared]) {
		const head = await store.readEntrySizes(parent, 1, 0);
		const source = { store, sessionId: parent, epoch: head.epoch, hashes: [], receipts: new Map() };
		if ("entries" in kind) {
			// Entries that need nothing of the source are created as they are where they share nothing.
			const created =
				(await store.createFork(sessionHeader(id), kind.entries, source)) ??
				(await store.create(sessionHeader(id), kind.entries));
			lengths.push(created.lastSeq);
			continue;
		}
		const stream =
			"cut" in kind
				? completeSessionForkStream(parent, head.epoch, kind.cut)
				: humanForkStream(parent, head.epoch, head.lastSeq, kind.leafSeq, kind.leaf.id, new Map(), new Map());
		const created = await store.createFork(sessionHeader(id), stream, source);
		assert.ok(created, `the store forks ${parent} into ${id}`);
		lengths.push(created.lastSeq);
	}
	assert.equal(lengths[0], lengths[1], `${id}: both forks keep as many entries`);
	const entries = (await worlds.copy.load(id)).entries;
	assert.deepEqual((await worlds.shared.load(id)).entries, entries, `${id}: both forks read the same`);
	worlds.views.set(id, [...entries]);
}

/** A random way to fork a session whose view is `view`. */
export function randomForkKind(random: () => number, view: readonly SessionEntry[]): ForkKind {
	const at = Math.floor(random() * view.length);
	const pick = random();
	if (pick < 0.35) return { cut: at + 1 };
	if (pick < 0.7) return { leaf: view[at]!, leafSeq: at + 1 };
	// The entries through `at`, a message now and then edited, as a caller may hold them.
	return {
		entries: view
			.slice(0, at + 1)
			.map((entry) =>
				entry.type === "message" && random() < 0.25
					? ({ ...entry, message: { ...entry.message, content: `edited ${entry.id}` } } as SessionEntry)
					: entry,
			),
	};
}

/**
 * A random history in both worlds: a root session, a chain of three forks, each of the one before, and a fork of the
 * root beside them. A fork keeps a prefix of its parent's view, the branch to one of its entries, or entries a caller
 * holds, some edited, and has entries appended; parents go on appending after they are forked. Resolves with the forks'
 * ids, parents first.
 */
export async function randomHistory(worlds: Worlds, seed: number): Promise<string[]> {
	const random = seeded(seed);
	const append = (id: string, count: number) =>
		writeBoth(worlds, id, randomEntries(random, worlds.views.get(id) ?? [], count, worlds.blobs, id));
	const root = `root-${seed}`;
	await append(root, 12 + Math.floor(random() * 20));
	const forks: string[] = [];
	const fork = async (parent: string, id: string) => {
		await forkBoth(worlds, parent, id, randomForkKind(random, worlds.views.get(parent)!));
		await append(id, 2 + Math.floor(random() * 6));
		// The parent goes on after the fork.
		await append(parent, Math.floor(random() * 3));
		forks.push(id);
	};
	let parent = root;
	for (let depth = 1; depth <= 3; depth++) {
		await fork(parent, `fork-${seed}-${depth}`);
		parent = `fork-${seed}-${depth}`;
	}
	await fork(root, `sibling-${seed}`);
	return forks;
}

export interface LinkRow {
	readonly seq: number;
	readonly entry: string;
	readonly parent: string | null;
	readonly anchor: number | null;
	readonly children: number;
	readonly broken: number;
}

/** The snapshot index's links of session `id` under `prefix`, by seq. */
export async function linksOf(database: SqliteDatabase, prefix: string, id: string): Promise<Map<number, LinkRow>> {
	const rows = await database.all<SqliteRow>(
		`SELECT seq, entry_id, parent_id, anchor_seq, children, broken FROM ${snapshotIndexTables(prefix).sessionLinks} WHERE session_id = ? ORDER BY seq`,
		id,
	);
	return new Map(
		rows.map((row) => [
			Number(row.seq),
			{
				seq: Number(row.seq),
				entry: String(row.entry_id),
				parent: row.parent_id === null ? null : String(row.parent_id),
				anchor: row.anchor_seq === null ? null : Number(row.anchor_seq),
				children: Number(row.children),
				broken: Number(row.broken),
			},
		]),
	);
}

/** The seqs of the rows session `id` stores itself under `prefix`. */
export async function storedSeqs(database: SqliteDatabase, prefix: string, id: string): Promise<Set<number>> {
	const rows = await database.all<SqliteRow>(
		`SELECT seq FROM ${prefix}session_entries WHERE session_id = ? ORDER BY seq`,
		id,
	);
	return new Set(rows.map((row) => Number(row.seq)));
}

/** How many fork segments the sessions under `prefix` have. */
export async function segmentCount(database: SqliteDatabase, prefix: string, id?: string): Promise<number> {
	const segments = sessionForkTables(prefix).forkSegments;
	const row = await database.get<SqliteRow>(
		`SELECT count(*) AS n FROM ${segments}${id === undefined ? "" : " WHERE session_id = ?"}`,
		...(id === undefined ? [] : [id]),
	);
	return Number(row?.n);
}
