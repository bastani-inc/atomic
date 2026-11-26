import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	assertForkSegments,
	type ForkSegment,
	forkRunSegments,
} from "../../packages/coding-agent/src/core/storage/session/fork-segments.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import { holdOlderBuildMarker } from "./older-build-marker.js";
import { messageEntry, snapshotEntry, syntheticSnapshot, textBlob } from "./snapshot-reference-index.js";

/**
 * Two worlds of the same session histories on one database, under two prefixes (#6560): in one every fork copies the
 * rows it keeps, as forks always have; in the other, where shared-history forks are on, a fork stores only the rows it
 * changes and the entries appended to it, and fork segments name the rest in the sessions that store them. Rows are
 * written to the entries table directly, in seq order as a fork or an append writes them, so the snapshot index's
 * triggers index them; nothing here reads a session through the store.
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

/** A session of a written history: its view, in seq order, and, in the shared world, its segments and the seqs it stores. */
export interface HistorySession {
	readonly id: string;
	readonly view: SessionEntry[];
	readonly segments: ForkSegment[];
	/** The seqs of the view the session stores itself in the shared world. */
	readonly own: Set<number>;
}

/** One world's tables and store. */
export interface World {
	readonly prefix: string;
	readonly store: SqlSessionStore;
	readonly entries: string;
	readonly links: string;
	readonly segments: string;
	readonly shared: boolean;
}

export async function openWorld(database: SqliteDatabase, prefix: string, shared: boolean): Promise<World> {
	// A store shares its forks' history from its first open; the copying world stays at schema 2 while an older build's
	// session runs on its prefix, as a store does until such a build stops.
	if (!shared) await holdOlderBuildMarker(database, prefix);
	const store = await SqlSessionStore.open(database, { prefix });
	return {
		prefix,
		store,
		entries: `${prefix}session_entries`,
		links: snapshotIndexTables(prefix).sessionLinks,
		segments: sessionForkTables(prefix).forkSegments,
		shared,
	};
}

/** Writes `rows` of `sessionId` at their seqs, one statement each, in seq order, in one transaction. */
export async function writeRows(
	database: SqliteDatabase,
	world: World,
	sessionId: string,
	rows: readonly { readonly seq: number; readonly entry: SessionEntry }[],
): Promise<void> {
	if (rows.length === 0) return;
	await database.transaction(async (tx) => {
		for (const { seq, entry } of rows)
			await tx.run(
				`INSERT INTO ${world.entries} (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)`,
				sessionId,
				seq,
				entry.id,
				JSON.stringify(entry),
			);
	});
}

export async function writeSegments(
	database: SqliteDatabase,
	world: World,
	sessionId: string,
	segments: readonly ForkSegment[],
): Promise<void> {
	for (const [index, segment] of segments.entries())
		await database.run(
			`INSERT INTO ${world.segments} (session_id, idx, source_id, from_seq, to_seq, base_seq) VALUES (?, ?, ?, ?, ?, ?)`,
			sessionId,
			index,
			segment.sourceId,
			segment.fromSeq,
			segment.toSeq,
			segment.baseSeq,
		);
}

export interface LinkRow extends SqliteRow {
	seq: number;
	entry_id: string;
	parent_id: string | null;
	anchor_seq: number | null;
	children: number;
	broken: number;
}

/** The index's links of `sessionId` at `seqs`, by seq. */
export async function linksAt(
	database: SqliteDatabase,
	world: World,
	sessionId: string,
	seqs: readonly number[],
): Promise<Map<number, LinkRow>> {
	const rows = await database.all<LinkRow>(
		`SELECT seq, entry_id, parent_id, anchor_seq, children, broken FROM ${world.links} WHERE session_id = ? ORDER BY seq`,
		sessionId,
	);
	const wanted = new Set(seqs);
	return new Map(
		rows
			.filter((row) => wanted.has(Number(row.seq)))
			.map((row) => [
				Number(row.seq),
				{
					...row,
					seq: Number(row.seq),
					anchor_seq: row.anchor_seq === null ? null : Number(row.anchor_seq),
					children: Number(row.children),
					broken: Number(row.broken),
				},
			]),
	);
}

/** A random entry following `parent`: a snapshot of one of two checkouts, with blobs of its own, or a message. */
export function randomEntry(
	random: () => number,
	parent: SessionEntry | undefined,
	blobs: SnapshotBlob[],
	tag: string,
): SessionEntry {
	const parentId = parent?.id ?? null;
	if (random() < 0.35) {
		const blob = textBlob(`${tag}-${blobs.length}-${random()}`);
		blobs.push(blob);
		const root = random() < 0.5 ? "/repo" : "/other";
		const id = `snap-${blobs.length}-${Math.floor(random() * 1e9)}`;
		return snapshotEntry(root, id, syntheticSnapshot(id, [blob.hash], { root }), parentId);
	}
	return messageEntry(`${tag}`, parentId);
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

/** Appends `count` random entries to `session`, each under its last entry or a random one, in both worlds. */
export function appendEntries(
	random: () => number,
	session: HistorySession,
	count: number,
	blobs: SnapshotBlob[],
): { readonly seq: number; readonly entry: SessionEntry }[] {
	const rows: { seq: number; entry: SessionEntry }[] = [];
	for (let index = 0; index < count; index++) {
		const view = session.view;
		const parent =
			view.length === 0 ? undefined : random() < 0.6 ? view.at(-1)! : view[Math.floor(random() * view.length)]!;
		const entry = randomEntry(random, parent, blobs, session.id);
		view.push(entry);
		session.own.add(view.length);
		rows.push({ seq: view.length, entry });
	}
	return rows;
}

/**
 * A fork of `parent` that keeps `kept`, entries of its view in view order: the shared world's segments for the rows
 * it inherits and the rows it stores itself, each kept row stored by the fork with probability `ownShare`, as a fork
 * stores a row it edits. The copy world stores every row.
 */
export function forkOf(
	random: () => number,
	parent: HistorySession,
	id: string,
	kept: readonly SessionEntry[],
	ownShare: number,
): { readonly child: HistorySession; readonly ownRows: { seq: number; entry: SessionEntry }[] } {
	const parentSeq = new Map(parent.view.map((entry, index) => [entry.id, index + 1]));
	const segments: ForkSegment[] = [];
	const own = new Set<number>();
	const ownRows: { seq: number; entry: SessionEntry }[] = [];
	let run: { fromSeq: number; toSeq: number; baseSeq: number } | undefined;
	const flush = () => {
		if (run !== undefined) segments.push(...forkRunSegments(parent.id, parent.segments, parent.view.length, run));
		run = undefined;
	};
	kept.forEach((entry, index) => {
		const seq = index + 1;
		const from = parentSeq.get(entry.id)!;
		if (random() < ownShare) {
			flush();
			own.add(seq);
			ownRows.push({ seq, entry });
			return;
		}
		if (run !== undefined && run.toSeq + 1 === from && run.baseSeq + (run.toSeq - run.fromSeq + 1) === seq - 1)
			run.toSeq = from;
		else {
			flush();
			run = { fromSeq: from, toSeq: from, baseSeq: seq - 1 };
		}
	});
	flush();
	assertForkSegments(id, segments, kept.length);
	return { child: { id, view: [...kept], segments, own }, ownRows };
}

/** Writes a fork in both worlds: every kept row in the copy world, the segments and the stored rows in the shared one. */
export async function writeFork(
	database: SqliteDatabase,
	copy: World,
	shared: World,
	child: HistorySession,
	ownRows: readonly { seq: number; entry: SessionEntry }[],
): Promise<void> {
	await writeRows(
		database,
		copy,
		child.id,
		child.view.map((entry, index) => ({ seq: index + 1, entry })),
	);
	await writeSegments(database, shared, child.id, child.segments);
	await writeRows(database, shared, child.id, ownRows);
}

/** Writes `rows` appended to `sessionId` in both worlds. */
export async function writeAppend(
	database: SqliteDatabase,
	worlds: readonly World[],
	sessionId: string,
	rows: readonly { seq: number; entry: SessionEntry }[],
): Promise<void> {
	for (const world of worlds) await writeRows(database, world, sessionId, rows);
}
