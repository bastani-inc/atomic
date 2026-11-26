/**
 * Removing the rows of deleted sessions once no fork reads them (#6560). A session deleted while forks still read its
 * rows leaves a tombstone; when the last of them stops reading the rows (it is deleted, replaced or detached), a sweep
 * removes them, a batch per transaction, and the tombstone with the last batch. Each batch locks the tombstone and
 * checks again that no fork reads the rows, so a stopped sweep leaves only a tombstone the next sweep finishes, and it
 * touches no other session's rows.
 *
 * No fork can start reading a swept session's rows: a fork names a source only by composing the segments of the
 * session it forks, and once no segment names the source, none ever will again.
 */

import type { SqliteExecutor, SqliteRow } from "../database.js";
import { type ForkDetachHost, isTombstoned, lockedReferrers } from "./fork-detach.js";

/** Entries a sweep removes in one transaction, with their chunks and search texts. */
export const FORK_SWEEP_BATCH_ENTRIES = 2_000;
/** Blobs a sweep removes in one transaction, with their chunks. */
const FORK_SWEEP_BATCH_BLOBS = 64;
/** Tombstones no fork reads any more that a sweep also finishes: ones an earlier sweep left when it stopped. */
const LEFTOVER_TOMBSTONES = 16;

/** One batch of the sweep of `sessionId`: whether the tombstone is gone, still read, or has rows left. */
async function sweepBatch(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
	entries: number,
): Promise<"done" | "kept" | "more" | "absent"> {
	if (!(await isTombstoned(host, tx, sessionId))) return "absent";
	if ((await lockedReferrers(host, tx, sessionId)).length > 0) return "kept";
	const tables = host.pinTables;
	const bound = await tx.get<SqliteRow & { seq: number }>(
		`SELECT seq FROM ${tables.entries} WHERE session_id = ? ORDER BY seq LIMIT 1 OFFSET ?`,
		sessionId,
		entries - 1,
	);
	for (const table of [tables.entryChunks, tables.searchTexts, tables.entries])
		await (bound === undefined
			? tx.run(`DELETE FROM ${table} WHERE session_id = ?`, sessionId)
			: tx.run(`DELETE FROM ${table} WHERE session_id = ? AND seq <= ?`, sessionId, Number(bound.seq)));
	if (bound !== undefined) return "more";
	const hashes = (
		await tx.all<SqliteRow & { hash: string }>(
			`SELECT hash FROM ${tables.blobs} WHERE session_id = ? UNION SELECT hash FROM ${tables.blobChunks} WHERE session_id = ? ORDER BY hash LIMIT ?`,
			sessionId,
			sessionId,
			FORK_SWEEP_BATCH_BLOBS,
		)
	).map((row) => String(row.hash));
	if (hashes.length > 0) {
		const list = hashes.map(() => "?").join(", ");
		for (const table of [tables.blobChunks, tables.blobs])
			await tx.run(`DELETE FROM ${table} WHERE session_id = ? AND hash IN (${list})`, sessionId, ...hashes);
		if (hashes.length === FORK_SWEEP_BATCH_BLOBS) return "more";
	}
	await tx.run(`DELETE FROM ${tables.tombstones} WHERE session_id = ?`, sessionId);
	return "done";
}

/**
 * Removes the rows of the tombstones `sessionIds` that no fork reads any more, and of up to a few others an earlier
 * sweep left, a batch per transaction. A tombstone a fork still reads is kept. Resolves with the sessions removed.
 */
export async function sweepForkTombstones(
	host: ForkDetachHost,
	sessionIds: Iterable<string> = [],
	options: { readonly batchEntries?: number } = {},
): Promise<string[]> {
	const entries = Math.max(1, Math.floor(options.batchEntries ?? FORK_SWEEP_BATCH_ENTRIES));
	const tables = host.pinTables;
	const leftover = await host.forkTransaction((tx) =>
		tx.all<SqliteRow & { session_id: string }>(
			`SELECT session_id FROM ${tables.tombstones} t WHERE NOT EXISTS (SELECT 1 FROM ${tables.forkSegments} s WHERE s.source_id = t.session_id) ORDER BY session_id LIMIT ?`,
			LEFTOVER_TOMBSTONES,
		),
	);
	const swept: string[] = [];
	for (const sessionId of new Set([...sessionIds, ...leftover.map((row) => String(row.session_id))])) {
		let outcome: Awaited<ReturnType<typeof sweepBatch>>;
		do outcome = await host.forkTransaction((tx) => sweepBatch(host, tx, sessionId, entries));
		while (outcome === "more");
		if (outcome === "done") swept.push(sessionId);
	}
	return swept;
}
