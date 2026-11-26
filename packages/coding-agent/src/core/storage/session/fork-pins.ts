/**
 * What deleting, replacing and re-creating a session does when forks read rows it stores. A fork's segments name the
 * session that stores each row it inherited, so those rows stay for as long as any segment names them:
 *
 * - Deleting a session that forks still read removes it from every read (its sessions row and its search texts go)
 *   but keeps the rows they read, its entries, entry chunks and blobs, under a tombstone. The rows go with the
 *   tombstone once nothing names them any more: when the last fork reading them is deleted, replaced or detached.
 * - Replacing a session that forks still read first gives each of them its own copy of the rows it read (detach),
 *   since the replace deletes those rows.
 * - Creating a session under the ID of a tombstone, by `create` or by any fork, first detaches the forks that still
 *   read the old rows, then removes them, so the new session starts empty.
 *
 * A session's own segments go when it is deleted or replaced, which may leave a deleted source no fork reads; the caller
 * sweeps it once its transaction commits (fork-sweep.ts). A delete and a replace lock the session's row for update
 * before they read anything of its fork history, as the first read of their transaction ({@link forkPinReads}), so
 * they drop its own segments and list the forks that name it only under that lock. A fork locks every session its
 * segments name for key share, tombstones included, so a fork being made either commits first and is listed, or waits
 * and finds the session gone.
 */

import type { SqliteExecutor, SqliteRow, SqliteStatement } from "../database.js";
import {
	detachForkWithin,
	type ForkDetachHost,
	isTombstoned,
	lockedReferrers,
	removeStoredRows,
} from "./fork-detach.js";

/** What a delete or a replace of a session needs to know of its fork history, read in one statement. */
export interface ForkPinListing {
	/** The sessions whose rows the session's own segments name. */
	readonly sources: readonly string[];
	/** The forks whose segments name rows the session stores. */
	readonly readers: readonly string[];
	/** Whether the session has a lineage row, as a fork has. */
	readonly lineage: boolean;
}

/**
 * The statements a delete or a replace of `sessionId` reads its fork history with, as the first reads of its
 * transaction: where writers can run together, the session's row, locked for update so that no fork of it starts
 * meanwhile, then the listing. Sent with the transaction's start, they cost no round trip of their own.
 */
export function forkPinReads(host: ForkDetachHost, sessions: string, sessionId: string): readonly SqliteStatement[] {
	const { forkSegments, forkLineage } = host.pinTables;
	const lock = host.lockClause("update");
	return [
		...(lock === "" ? [] : [{ sql: `SELECT id FROM ${sessions} WHERE id = ?${lock}`, params: [sessionId] }]),
		{
			sql: `SELECT 's' AS kind, source_id AS id FROM ${forkSegments} WHERE session_id = ?
				UNION SELECT 'r', session_id FROM ${forkSegments} WHERE source_id = ? AND session_id <> ?
				UNION SELECT 'l', session_id FROM ${forkLineage} WHERE session_id = ?`,
			params: [sessionId, sessionId, sessionId, sessionId],
		},
	];
}

/** Reads `sessionId`'s fork history through the statements of {@link forkPinReads}, in order. */
export async function readForkPins(tx: SqliteExecutor, reads: readonly SqliteStatement[]): Promise<ForkPinListing> {
	const listing = reads.at(-1)!;
	for (const lock of reads.slice(0, -1)) await tx.get(lock.sql, ...lock.params);
	const rows = await tx.all<SqliteRow & { kind: string; id: string }>(listing.sql, ...listing.params);
	const of = (kind: string) =>
		[...new Set(rows.filter((row) => row.kind === kind).map((row) => String(row.id)))].sort();
	return { sources: of("s"), readers: of("r"), lineage: rows.some((row) => row.kind === "l") };
}

/**
 * In `delete`'s transaction, before the session's rows go, given what {@link readForkPins} read. `keepRows` when forks
 * still read rows the session stores: the caller then removes only its sessions row, and the rows stay under a
 * tombstone. `released` are the sources the session's own segments named, to sweep once the transaction commits. A
 * session no fork history names costs no statement.
 */
export async function deleteForkedSessionWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
	deletedAt: string,
	pins: ForkPinListing,
): Promise<{ readonly keepRows: boolean; readonly released: readonly string[] }> {
	// A session created later under this ID starts without the deleted one's segments and lineage.
	if (pins.sources.length > 0)
		await tx.run(`DELETE FROM ${host.pinTables.forkSegments} WHERE session_id = ?`, sessionId);
	if (pins.lineage) await tx.run(`DELETE FROM ${host.pinTables.forkLineage} WHERE session_id = ?`, sessionId);
	if (pins.readers.length === 0) return { keepRows: false, released: pins.sources };
	await tx.run(
		`INSERT INTO ${host.pinTables.tombstones} (session_id, deleted_at) VALUES (?, ?) ON CONFLICT DO NOTHING`,
		sessionId,
		deletedAt,
	);
	return { keepRows: true, released: pins.sources };
}

/**
 * In `replace`'s transaction, before the session's rows go, given what {@link readForkPins} read: each fork reading
 * them gets its own copy, and the session drops its own segments, as a replaced session holds every row of its view
 * itself. Resolves with the sources those segments named, to sweep once the transaction commits. A session no fork
 * history names costs no statement.
 */
export async function replaceForkedSessionWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
	pins: ForkPinListing,
): Promise<readonly string[]> {
	if (pins.sources.length > 0) await host.writeForkSegments(tx, sessionId, []);
	// Each detach reads the fork's segments again under its lock: one a detach re-pointed meanwhile is read as it is now.
	for (const child of pins.readers) await detachForkWithin(host, tx, sessionId, child, false);
	return pins.sources;
}

/**
 * In the transaction that writes a new session, by `create` or by a fork, before the session is written: when a
 * deleted session with this ID left a tombstone, the forks still reading its rows get their own copy, and the rows go.
 *
 * The forks that read the rows are locked before the tombstone, as a fork locks its sources' rows before their
 * tombstones: a fork of one of them, which holds that fork's row while it waits for the tombstone, never waits for this
 * transaction while this one waits for it. Under the tombstone's lock no fork starts reading the rows, so the forks are
 * listed again there; one that a fork committed meanwhile is locked as it is detached.
 */
export async function createOverTombstoneWithin(
	host: ForkDetachHost,
	tx: SqliteExecutor,
	sessionId: string,
): Promise<void> {
	if (!(await isTombstoned(host, tx, sessionId))) return;
	// Where writers run one at a time, nothing is locked.
	if (host.lockClause("update") !== "")
		await host.lockForkSources(tx, await host.forkChildren(tx, sessionId), "update");
	for (const child of await lockedReferrers(host, tx, sessionId))
		await detachForkWithin(host, tx, sessionId, child, false);
	await removeStoredRows(host, tx, sessionId);
}
