/**
 * What deleting, replacing and re-creating a session does when forks read rows it stores. A fork's segments name the
 * session that stores each row it inherited, so those rows stay for as long as any segment names them:
 *
 * - Deleting a session that forks still read removes it from every read (its sessions row and its search texts go)
 *   but keeps the rows they read, its entries, entry chunks and blobs, under a tombstone. The rows go with the
 *   tombstone once nothing names them any more: when the last fork reading them is deleted, replaced or detached.
 * - Replacing a session that forks still read first gives each of them its own copy of the rows it read (detach),
 *   since the replace deletes those rows.
 * - Creating a session under the ID of a tombstone first detaches the forks that still read the old rows, then removes
 *   them, so the new session starts empty.
 *
 * A session's own segments go when it is deleted or replaced, which may leave a tombstoned source unnamed; it is swept
 * in the same transaction. Each of these locks the session for update before it lists the forks that name it, and a
 * fork locks every session its segments name for key share, tombstones included, so a fork being made either commits
 * first and is listed, or waits and finds the session gone.
 */

import type { SqliteExecutor } from "../database.js";
import {
	detachForkWithin,
	type ForkDetachHost,
	isTombstoned,
	lockedReferrers,
	removeStoredRows,
} from "./fork-detach.js";

/**
 * Drops `sessionId`'s own segments. Resolves with the sources they named: a deleted one that no fork reads any more
 * is for the caller to sweep once its transaction commits (fork-sweep.ts).
 */
async function dropOwnSegments(host: ForkDetachHost, tx: SqliteExecutor, sessionId: string): Promise<string[]> {
	const sources = [...new Set((await host.forkSegments(tx, sessionId)).map((segment) => segment.sourceId))].sort();
	if (sources.length > 0) await host.writeForkSegments(tx, sessionId, []);
	return sources;
}

/**
 * In `delete`'s transaction, before the session's rows go. `keepRows` when forks still read rows the session stores:
 * the caller then removes only its sessions row, and the rows stay under a tombstone. `released` are the sources the
 * session's own segments named, to sweep once the transaction commits.
 */
export async function deleteForkedSessionWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
	deletedAt: string,
): Promise<{ readonly keepRows: boolean; readonly released: readonly string[] }> {
	const released = await dropOwnSegments(host, tx, sessionId);
	// A session created later under this ID starts without the deleted one's lineage.
	await tx.run(`DELETE FROM ${host.pinTables.forkSegments} WHERE session_id = ?`, sessionId);
	await tx.run(`DELETE FROM ${host.pinTables.forkLineage} WHERE session_id = ?`, sessionId);
	if ((await lockedReferrers(host, tx, sessionId)).length === 0) return { keepRows: false, released };
	await tx.run(
		`INSERT INTO ${host.pinTables.tombstones} (session_id, deleted_at) VALUES (?, ?) ON CONFLICT DO NOTHING`,
		sessionId,
		deletedAt,
	);
	return { keepRows: true, released };
}

/**
 * In `replace`'s transaction, before the session's rows go: each fork reading them gets its own copy, and the session
 * drops its own segments, as a replaced session holds every row of its view itself. Resolves with the sources those
 * segments named, to sweep once the transaction commits.
 */
export async function replaceForkedSessionWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
): Promise<readonly string[]> {
	const released = await dropOwnSegments(host, tx, sessionId);
	for (const child of await lockedReferrers(host, tx, sessionId))
		await detachForkWithin(host, tx, sessionId, child, false);
	return released;
}

/**
 * In `create`'s transaction, before the session is written: when a deleted session with this ID left a tombstone,
 * the forks still reading its rows get their own copy, and the rows go.
 */
export async function createOverTombstoneWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
): Promise<void> {
	if (!(await isTombstoned(host, tx, sessionId))) return;
	for (const child of await lockedReferrers(host, tx, sessionId))
		await detachForkWithin(host, tx, sessionId, child, false);
	await removeStoredRows(host, tx, sessionId);
}
