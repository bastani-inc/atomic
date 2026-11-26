/**
 * The SQL session store's side of detaching and pinning shared fork history (#6560): its fork segments, read and
 * written through fork-lineage.ts, in transactions of the store.
 */

import type { SqliteExecutor, SqliteRow } from "../database.js";
import type { StorageDialect } from "../dialect.js";
import type { ForkDetachHost } from "./fork-detach.js";
import {
	type ForkMaterializeTables,
	forkChildren,
	lockForkSources,
	materializeForkSegments,
	readForkSegments,
	writeForkSegments,
} from "./fork-lineage.js";
import type { SessionForkTables } from "./fork-schema.js";

/** What a store gives its fork host: its connection's dialect, its tables and how it runs a write transaction. */
export interface ForkHostStore {
	readonly dialect: StorageDialect;
	readonly tables: Omit<ForkMaterializeTables, "forkSegments" | "forkLineage">;
	readonly forkTables: SessionForkTables;
	readonly blobs: { readonly legacyBlobData: boolean; readonly chunkBytes: number };
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
}

/** The fork host of a store whose sessions schema has shared-history forks. */
export function forkDetachHost(store: ForkHostStore): ForkDetachHost {
	const { dialect, tables, forkTables } = store;
	const lineage = {
		sessions: tables.sessions,
		forkSegments: forkTables.forkSegments,
		forkLineage: forkTables.forkLineage,
	};
	const materialize: ForkMaterializeTables = { ...tables, ...lineage };
	/** A session's last seq: the length of its view. A deleted session's tombstone has no row, and no view to keep. */
	const length = async (tx: SqliteExecutor, sessionId: string): Promise<number> => {
		const row = await tx.get<SqliteRow & { last_seq: number }>(
			`SELECT last_seq FROM ${tables.sessions} WHERE id = ?`,
			sessionId,
		);
		return row === undefined ? 0 : Number(row.last_seq);
	};
	return {
		forkDetachTable: forkTables.forkDetach,
		pinTables: {
			entries: tables.entries,
			entryChunks: tables.entryChunks,
			searchTexts: tables.searchTexts,
			blobs: tables.blobs,
			blobChunks: tables.blobChunks,
			tombstones: forkTables.forkTombstones,
			forkSegments: forkTables.forkSegments,
			forkLineage: forkTables.forkLineage,
		},
		forkTransaction: (body) => store.transaction(body),
		lockClause: (mode) => dialect.lockClause(mode),
		forkSegments: (tx, sessionId) => readForkSegments(tx, lineage, sessionId),
		forkChildren: (tx, sourceId) => forkChildren(tx, lineage, sourceId),
		async materializeForkSegments(tx, childId, pieces) {
			await materializeForkSegments(
				tx,
				dialect,
				materialize,
				store.blobs,
				childId,
				await length(tx, childId),
				pieces,
			);
		},
		async writeForkSegments(tx, sessionId, segments) {
			if (segments.length > 0 || (await readForkSegments(tx, lineage, sessionId)).length > 0)
				await writeForkSegments(tx, lineage, sessionId, segments, await length(tx, sessionId));
		},
		async lockForkSources(tx, ids, mode) {
			await lockForkSources(tx, dialect, lineage, ids, mode);
			// A deleted session forks still read has only its tombstone left to lock.
			const sorted = [...new Set(ids)].sort();
			if (dialect.name !== "sqlite" && sorted.length > 0)
				await tx.all(
					`SELECT session_id FROM ${forkTables.forkTombstones} WHERE session_id IN (${sorted.map(() => "?").join(", ")}) ORDER BY session_id${dialect.lockClause(mode)}`,
					...sorted,
				);
		},
		async forkRewriteEpoch(tx, sessionId) {
			const row = await tx.get<SqliteRow & { epoch: string | null }>(
				`SELECT COALESCE(${dialect.jsonText("summary_state", "epoch")}, ${dialect.jsonText("summary_state", "resume", "epoch")}) AS epoch FROM ${tables.sessions} WHERE id = ?`,
				sessionId,
			);
			return row?.epoch ?? undefined;
		},
	};
}
