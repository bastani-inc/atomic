/**
 * Detaching lazy forks from a session (Neon's detach_ancestor). A fork in a SQL store reads the rows it inherited
 * through segments that point at the sessions owning them, which keep those rows while any segment points at them. To
 * really delete or rewrite such a session, every fork still pointing at it first gets its own copy of those rows:
 *
 * 1. Block: the segments pin the parent's rows, and a progress row records the detach and the child's original map.
 * 2. Copy: a page of the parent's rows moves into the child at the global seqs the segment gave them, and in the same
 *    transaction the segment shrinks past them, so every seq is covered by a segment or by a row of the child's own,
 *    never both, and the child reads the same at every commit.
 * 3. Publish: each page commits; the segments are the progress, so a crash resumes with the segments that remain.
 * 4-6. The last page also removes the child's last segment on the parent, re-points at the child's copy each other
 *    fork of the parent that reads only rows the child's prefix holds (its cut-off at or below the child's), and
 *    removes the progress row, in one transaction.
 *
 * A detach locks the sessions whose segments it changes for update, in ID order, and never the parent. The store's
 * delete and replace lock a session for update before they list the references to it, and a fork locks every session
 * its segments name for key share, so neither misses a reference another transaction is adding. Re-pointing a fork at
 * the child adds a reference to the child, which the detach already holds for update. Locking the parent instead
 * would deadlock against the parent's replace, which holds the parent's row while it waits for its forks' rows.
 */

import type { SqliteExecutor } from "../database.js";
import { reparentedSegments, splitSegment } from "./fork-detach-map.js";
import { ForkSourceIncompleteError } from "./fork-errors.js";
import { type ForkSegment, segmentLength } from "./fork-segments.js";

/**
 * Where a refused copy of shared rows is noted, for debugging: the application sets it once, to its debug log. A refusal
 * also fails the write that needed the copy, so nothing is lost; the note says which fork and which source entry.
 */
let noteRefusedCopy: (fields: Readonly<Record<string, string | number>>) => void = () => {};

export function setForkCopyRefusalNote(note: (fields: Readonly<Record<string, string | number>>) => void): void {
	noteRefusedCopy = note;
}

/** Notes `error` once when it is a refused copy of shared rows; resolves nothing and never throws. */
export function noteForkCopyRefusal(error: unknown, operation: string): void {
	if (!(error instanceof ForkSourceIncompleteError)) return;
	try {
		noteRefusedCopy({
			operation,
			sessionId: error.sessionId,
			sourceId: error.sourceId,
			sourceSeq: error.sourceSeq,
		});
	} catch {
		/* A note is for debugging only. */
	}
}

/** Rows a detach copies in one transaction, which bounds how long it holds the write lock. */
export const FORK_DETACH_PAGE_ROWS = 2_000;

/** The tables a session's stored rows are in, and the tombstones of deleted sessions forks still read. */
export interface ForkPinTables {
	readonly entries: string;
	readonly entryChunks: string;
	readonly searchTexts: string;
	readonly blobs: string;
	readonly blobChunks: string;
	readonly tombstones: string;
	readonly forkSegments: string;
	readonly forkLineage: string;
}

/** What a SQL session store gives detach: its fork segments, and transactions to change them in. */
export interface ForkDetachHost {
	readonly pinTables: ForkPinTables;
	/** `<prefix>session_fork_detach`, created with the other fork tables: detaches in progress. */
	readonly forkDetachTable: string;
	/** Runs `body` in one write transaction of the store. */
	forkTransaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
	/** The session's segments, ordered by `baseSeq`. */
	forkSegments(tx: SqliteExecutor, sessionId: string): Promise<readonly ForkSegment[]>;
	/** The sessions with a segment pointing at `sourceId`, ordered by ID. */
	forkChildren(tx: SqliteExecutor, sourceId: string): Promise<readonly string[]>;
	/**
	 * Copies the rows `pieces` map, in seq order with their chunks, search texts and blobs, into the child at the seqs of
	 * its view they cover, then removes them from the child's segments. Each piece lies within one of the child's
	 * segments, so the child's view is the same before and after.
	 */
	materializeForkSegments(tx: SqliteExecutor, childId: string, pieces: readonly ForkSegment[]): Promise<void>;
	/** Replaces the session's segments with `segments`, and moves its fork generation on. */
	writeForkSegments(tx: SqliteExecutor, sessionId: string, segments: readonly ForkSegment[]): Promise<void>;
	/**
	 * Locks the sessions `ids` in ID order: `key-share` to add a reference to them (which leaves their appends free),
	 * `update` to drop one they hold or to delete them.
	 */
	lockForkSources(tx: SqliteExecutor, ids: readonly string[], mode: "key-share" | "update"): Promise<void>;
	/** The clause that locks the rows a read selects, for update or for key share; none where writers run one at a time. */
	lockClause(mode: "key-share" | "update"): string;
	/** The session's rewrite epoch, which a replace or a truncation changes and an append does not. */
	forkRewriteEpoch(tx: SqliteExecutor, sessionId: string): Promise<string | undefined>;
}

export interface ForkDetachOptions {
	/** Re-point the parent's other forks at the child's copy of the rows it holds. Default true. */
	readonly reparent?: boolean;
	/** Rows copied a transaction. Default {@link FORK_DETACH_PAGE_ROWS}. */
	readonly pageRows?: number;
}

export interface ForkDetachReport {
	/** Forks that copied the parent's rows they read. */
	readonly detached: readonly string[];
	/** Forks re-pointed at a detached fork's copy instead. */
	readonly reparented: readonly string[];
}

/**
 * Locks `ids` for update, to change their segments, in ID order, the order every transaction that locks sessions
 * takes them in. A detach never locks the parent: the parent's replace holds the parent's row while it waits for its
 * forks' rows, and only that replace can change the parent's rows a fork reads, after it has detached the fork itself.
 */
async function lockForUpdate(host: ForkDetachHost, tx: SqliteExecutor, ids: readonly string[]): Promise<void> {
	await host.lockForkSources(tx, [...new Set(ids)].sort(), "update");
}

interface DetachProgress {
	readonly reparent: boolean;
	/** The child's segments on the parent when the detach started: where its copy of each parent row is. */
	readonly original: readonly ForkSegment[];
	/**
	 * The parent's and the child's rewrite epochs when the detach started. `original` describes the child's rows only
	 * while neither was rewritten: a rewritten parent's seq is another row, a rewritten child's row is another row.
	 */
	readonly epochs: readonly [string | undefined, string | undefined];
}

type ProgressRow = {
	parent_id: string;
	child_id: string;
	reparent: number;
	original_segments: string;
	parent_epoch: string | null;
	child_epoch: string | null;
};

/** The forks whose segments name `sessionId`, after locking it for update. */
export async function lockedReferrers(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
): Promise<readonly string[]> {
	await host.lockForkSources(tx, [sessionId], "update");
	return (await host.forkChildren(tx, sessionId)).filter((id) => id !== sessionId);
}

/** Removes the rows a session stores and its tombstone: nothing names them, and the session is gone or replaced. */
export async function removeStoredRows(host: ForkDetachHost, tx: SqliteExecutor, sessionId: string): Promise<void> {
	const { pinTables: tables } = host;
	for (const table of [tables.blobChunks, tables.blobs, tables.entryChunks, tables.searchTexts, tables.entries])
		await tx.run(`DELETE FROM ${table} WHERE session_id = ?`, sessionId);
	await tx.run(`DELETE FROM ${tables.tombstones} WHERE session_id = ?`, sessionId);
}

export async function isTombstoned(host: ForkDetachHost, tx: SqliteExecutor, sessionId: string): Promise<boolean> {
	return (
		(await tx.get(`SELECT session_id FROM ${host.pinTables.tombstones} WHERE session_id = ?`, sessionId)) !==
		undefined
	);
}

function parseProgress(row: ProgressRow): DetachProgress {
	return {
		reparent: row.reparent !== 0,
		original: JSON.parse(row.original_segments) as ForkSegment[],
		epochs: [row.parent_epoch ?? undefined, row.child_epoch ?? undefined],
	};
}

/** The rewrite epochs of the parent and the child, read under their locks. */
async function rewriteEpochs(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	parentId: string,
	childId: string,
): Promise<readonly [string | undefined, string | undefined]> {
	return [await host.forkRewriteEpoch(tx, parentId), await host.forkRewriteEpoch(tx, childId)];
}

/** Every session whose rows `sessionId` reads, directly or through the sessions it reads. */
async function readSources(host: ForkDetachHost, tx: SqliteExecutor, sessionId: string): Promise<Set<string>> {
	const found = new Set<string>();
	const pending = [sessionId];
	for (let next = pending.pop(); next !== undefined; next = pending.pop())
		for (const { sourceId } of await host.forkSegments(tx, next))
			if (!found.has(sourceId)) {
				found.add(sourceId);
				pending.push(sourceId);
			}
	return found;
}

/**
 * Within `tx`, copies every row of `parentId` the child reads into the child and removes its segments on the parent,
 * as a caller about to rewrite the parent in the same transaction needs. With `reparent`, the parent's other forks are
 * re-pointed at the child's copy when it holds every row they read of the parent at the same seqs. `started` is how a detach a page at a time found
 * the child when it started; its map of the child's rows holds only while neither session was rewritten since, so
 * a rewrite of either skips the re-pointing, and the other forks keep reading the parent. Resolves with the forks
 * re-pointed.
 */
export async function detachForkWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	parentId: string,
	childId: string,
	reparent: boolean,
	started?: Pick<DetachProgress, "original" | "epochs">,
): Promise<string[]> {
	const siblings = reparent ? (await host.forkChildren(tx, parentId)).filter((id) => id !== childId) : [];
	await lockForUpdate(host, tx, [childId, ...siblings]);
	const segments = await host.forkSegments(tx, childId);
	const onParent = segments.filter((segment) => segment.sourceId === parentId);
	if (onParent.length > 0) await host.materializeForkSegments(tx, childId, onParent);
	if (siblings.length === 0) return [];
	let map: readonly ForkSegment[] = onParent;
	if (started !== undefined) {
		const [parentEpoch, childEpoch] = await rewriteEpochs(host, tx, parentId, childId);
		map = parentEpoch === started.epochs[0] && childEpoch === started.epochs[1] ? started.original : [];
	}
	const reparented: string[] = [];
	if (map.length === 0) return reparented;
	// A fork the child still reads rows of, directly or through the sessions it reads, keeps reading the parent: pointed
	// at the child, the two would each keep the other's rows, and neither could ever be swept.
	const readByChild = await readSources(host, tx, childId);
	for (const sibling of siblings) {
		if (readByChild.has(sibling)) continue;
		const before = await host.forkSegments(tx, sibling);
		const after = reparentedSegments(before, parentId, childId, map);
		if (after !== undefined) {
			await host.writeForkSegments(tx, sibling, after);
			reparented.push(sibling);
		}
	}
	return reparented;
}

/**
 * Detaches `childId` from `parentId` a page at a time, each page its own transaction; see the module comment. A detach
 * a crash stopped resumes where it stopped when it runs again, with the options it started with.
 */
export async function detachFork(
	host: ForkDetachHost,
	parentId: string,
	childId: string,
	options: ForkDetachOptions = {},
): Promise<ForkDetachReport> {
	const table = host.forkDetachTable;
	const pageRows = Math.max(1, Math.floor(options.pageRows ?? FORK_DETACH_PAGE_ROWS));
	const progress = await host.forkTransaction(async (tx): Promise<DetachProgress | undefined> => {
		const row = await tx.get<ProgressRow>(
			`SELECT parent_id, child_id, reparent, original_segments, parent_epoch, child_epoch FROM ${table} WHERE parent_id = ? AND child_id = ?`,
			parentId,
			childId,
		);
		if (row !== undefined) return parseProgress(row);
		await lockForUpdate(host, tx, [childId]);
		const original = (await host.forkSegments(tx, childId)).filter((segment) => segment.sourceId === parentId);
		if (original.length === 0) return undefined;
		const started: DetachProgress = {
			reparent: options.reparent ?? true,
			original,
			epochs: await rewriteEpochs(host, tx, parentId, childId),
		};
		await tx.run(
			`INSERT INTO ${table} (parent_id, child_id, reparent, original_segments, parent_epoch, child_epoch) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			parentId,
			childId,
			started.reparent ? 1 : 0,
			JSON.stringify(original),
			started.epochs[0] ?? null,
			started.epochs[1] ?? null,
		);
		return started;
	});
	if (progress === undefined) return { detached: [], reparented: [] };
	for (;;) {
		const done = await host
			.forkTransaction(async (tx): Promise<readonly string[] | undefined> => {
				await lockForUpdate(host, tx, [childId]);
				const segments = await host.forkSegments(tx, childId);
				const onParent = segments.filter((segment) => segment.sourceId === parentId);
				const remaining = onParent.reduce((rows, segment) => rows + segmentLength(segment), 0);
				if (remaining > pageRows) {
					await host.materializeForkSegments(tx, childId, [splitSegment(onParent[0]!, pageRows).page]);
					return undefined;
				}
				const reparented = await detachForkWithin(host, tx, parentId, childId, progress.reparent, progress);
				await tx.run(`DELETE FROM ${table} WHERE parent_id = ? AND child_id = ?`, parentId, childId);
				return reparented;
			})
			.catch(async (error: unknown) => {
				// A copy a missing source chunk refused cannot finish later either: the detach is given up, and the fork keeps
				// reading the rows it has not copied. Its pages so far stay, each a part of its view it now holds itself.
				if (error instanceof ForkSourceIncompleteError)
					await host.forkTransaction((tx) =>
						tx.run(`DELETE FROM ${table} WHERE parent_id = ? AND child_id = ?`, parentId, childId),
					);
				throw error;
			});
		if (done !== undefined) return { detached: [childId], reparented: [...done] };
	}
}

/**
 * Detaches every fork still pointing at `parentId`, so the parent's rows can go: first the fork that holds most of the
 * parent's rows, re-pointing the others at its copy when it holds all they read, then any fork that still reads
 * rows only the parent has. Detaches a crash stopped are finished first.
 */
export async function detachForkChildren(
	host: ForkDetachHost,
	parentId: string,
	options: ForkDetachOptions = {},
): Promise<ForkDetachReport> {
	const detached: string[] = [];
	const reparented = new Set<string>();
	const record = (report: ForkDetachReport) => {
		detached.push(...report.detached);
		for (const id of report.reparented) reparented.add(id);
	};
	const pending = await host.forkTransaction((tx) =>
		tx.all<ProgressRow>(
			`SELECT child_id FROM ${host.forkDetachTable} WHERE parent_id = ? ORDER BY child_id`,
			parentId,
		),
	);
	for (const { child_id } of pending) record(await detachFork(host, parentId, child_id, options));
	for (;;) {
		const next = await host.forkTransaction(async (tx) => {
			let best: { id: string; rows: number } | undefined;
			for (const id of await host.forkChildren(tx, parentId)) {
				const rows = (await host.forkSegments(tx, id))
					.filter((segment) => segment.sourceId === parentId)
					.reduce((sum, segment) => sum + segmentLength(segment), 0);
				if (best === undefined || rows > best.rows) best = { id, rows };
			}
			return best?.id;
		});
		if (next === undefined) break;
		record(await detachFork(host, parentId, next, options));
	}
	return { detached, reparented: [...reparented].filter((id) => !detached.includes(id)) };
}

/** Finishes every detach a crash stopped, as each started. */
export async function resumeForkDetaches(host: ForkDetachHost): Promise<ForkDetachReport> {
	const rows = await host.forkTransaction((tx) =>
		tx.all<ProgressRow>(`SELECT parent_id, child_id FROM ${host.forkDetachTable} ORDER BY parent_id, child_id`),
	);
	const detached: string[] = [];
	const reparented: string[] = [];
	for (const { parent_id, child_id } of rows) {
		const report = await detachFork(host, parent_id, child_id);
		detached.push(...report.detached);
		reparented.push(...report.reparented);
	}
	return { detached, reparented };
}
