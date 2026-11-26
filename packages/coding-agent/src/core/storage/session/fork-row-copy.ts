import type { SqliteRow, SqliteStatement } from "../database.js";
import { SessionBlobError } from "../errors.js";
import { SessionConflictError } from "./errors.js";

/** The tables a fork copies stored rows between, in one database. */
export interface ForkCopyTables {
	readonly entries: string;
	readonly entryChunks: string;
	readonly blobs: string;
	readonly blobChunks: string;
}

/** A run of a fork: child seqs `childFrom` on are the source's seqs `sourceFrom` on, `count` of them. */
interface ForkRowRun {
	readonly sourceFrom: number;
	readonly childFrom: number;
	count: number;
}

/** How many entry IDs a run builder holds for lookups before it sends its runs, bounding what a fork holds. */
const HELD_RUN_ROWS = 4096;

/** How many hashes one blob statement names, so a statement stays small whatever the session holds. */
const BLOB_HASHES_PER_STATEMENT = 256;

/**
 * The chunk rows `INSERT … SELECT` copies of the entries of session `?` at seqs `?` to `?`: only each entry's chunks 0 to
 * `chunks - 1`, as the copy one chunk at a time did, never a row an older version left past them or at an entry stored
 * whole. `incompleteEntryRead` then finds an entry missing any of those.
 */
function entryChunkRows(tables: ForkCopyTables, seqs: string): string {
	return `FROM ${tables.entryChunks} c JOIN ${tables.entries} e ON e.session_id = c.session_id AND e.seq = c.seq WHERE c.session_id = ? AND c.seq ${seqs} AND c.idx >= 0 AND c.idx < e.chunks ORDER BY c.seq, c.idx`;
}

/** Copies to child seq `?` the chunks 0 to `chunks - 1` of the entry at seq `?` of session `?`, as a fork does. */
export function entryChunksCopy(tables: ForkCopyTables): string {
	return `INSERT INTO ${tables.entryChunks} (session_id, seq, idx, data) SELECT ?, ?, c.idx, c.data ${entryChunkRows(tables, "= ?")}`;
}

/**
 * The source's stored rows a fork copies, gathered into runs of consecutive seqs and copied a run at a time, each run in
 * one `INSERT … SELECT` for its entries and one for their chunks (#6560), not one statement per row and chunk. Rows are
 * copied in seq order, so the snapshot index's triggers meet a parent before its children, as they do for an append.
 */
export class ForkRowRuns {
	private readonly tables: ForkCopyTables;
	private readonly child: string;
	private readonly source: string;
	private runs: ForkRowRun[] = [];
	/** The latest child seq of each entry ID among the rows not sent yet, for the fork's lookups. */
	private held = new Map<string, number>();
	private heldRows = 0;

	constructor(tables: ForkCopyTables, child: string, source: string) {
		this.tables = tables;
		this.child = child;
		this.source = source;
	}

	/** Adds the source row at `sourceSeq` as the child's row at `childSeq`, whose entry ID is `entryId`. */
	add(sourceSeq: number, childSeq: number, entryId: string): void {
		const last = this.runs.at(-1);
		if (last !== undefined && last.sourceFrom + last.count === sourceSeq && last.childFrom + last.count === childSeq)
			last.count++;
		else this.runs.push({ sourceFrom: sourceSeq, childFrom: childSeq, count: 1 });
		this.held.set(entryId, childSeq);
		this.heldRows++;
	}

	/** The latest child seq of `entryId` among the rows added and not taken yet. */
	heldSeq(entryId: string): number | undefined {
		return this.held.get(entryId);
	}

	/** Whether the runs hold as many rows as a fork may hold before it sends them. */
	get full(): boolean {
		return this.heldRows >= HELD_RUN_ROWS;
	}

	/**
	 * The statements that copy the runs added since the last call, in seq order, each with the rows it must copy: a run's
	 * entries statement copies one row for each of its seqs, or the source changed under the fork.
	 */
	drain(): CountedStatement[] {
		const { entries, entryChunks } = this.tables;
		const statements: CountedStatement[] = [];
		for (const { sourceFrom, childFrom, count } of this.runs) {
			const params = [this.child, childFrom - sourceFrom, this.source, sourceFrom, sourceFrom + count - 1];
			statements.push(
				{
					sql: `INSERT INTO ${entries} (session_id, seq, entry_id, entry_json, chunks) SELECT ?, seq + ?, entry_id, entry_json, chunks FROM ${entries} WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
					params,
					changes: count,
					mismatch: () => new SessionConflictError(this.source, sourceFrom, sourceFrom + count - 1),
				},
				{
					sql: `INSERT INTO ${entryChunks} (session_id, seq, idx, data) SELECT ?, c.seq + ?, c.idx, c.data ${entryChunkRows(this.tables, "BETWEEN ? AND ?")}`,
					params,
				},
			);
		}
		this.runs = [];
		this.held = new Map();
		this.heldRows = 0;
		return statements;
	}
}

/** A statement with the number of rows it must change, when that is known, and the failure when it does not. */
export interface CountedStatement extends SqliteStatement {
	readonly changes?: number;
	readonly mismatch?: () => Error;
}

/**
 * The read that finds a stored entry of `child` missing any of its chunks, which the fork checks before it commits: an
 * entry copied from the source names its chunk count, and the chunks were copied in the same statements. It counts the
 * entry's chunk rows from 0 to `chunks - 1`, keyed by their index, so a count of `chunks` is each of them.
 */
export function incompleteEntryRead(tables: ForkCopyTables, child: string): SqliteStatement {
	return {
		sql: `SELECT e.seq FROM ${tables.entries} e WHERE e.session_id = ? AND e.chunks > 0 AND e.chunks <> (SELECT count(*) FROM ${tables.entryChunks} c WHERE c.session_id = e.session_id AND c.seq = e.seq AND c.idx >= 0 AND c.idx < e.chunks) LIMIT 1`,
		params: [child],
	};
}

/** The blob copy of a fork: its statements, and the read that tells which blobs it copied whole. */
export interface ForkBlobCopy {
	readonly statements: readonly SqliteStatement[];
	readonly checks: readonly SqliteStatement[];
	/**
	 * The hashes the source does not hold, from the answers to `checks` in order, which `copySessionBlobs` reports as it
	 * reports a missing blob. Throws `blob-incomplete` for a blob the source holds and the fork could not copy whole.
	 */
	remaining(answers: readonly (readonly SqliteRow[])[]): string[];
}

/**
 * Copies the blobs `hashes` of session `source` to `child`, with their chunks, a few statements for all of them (#6560):
 * as `copyForkBlob` copied each one, a blob the child already holds is kept, one in the legacy one-row layout is copied
 * only with all its bytes, and each chunk only at its full length.
 */
export function forkBlobCopy(
	tables: ForkCopyTables,
	options: { readonly legacyBlobData: boolean; readonly chunkBytes: number },
	source: string,
	child: string,
	hashes: readonly string[],
): ForkBlobCopy {
	const { blobs, blobChunks } = tables;
	const columns = options.legacyBlobData ? ", data" : "";
	const sourceColumns = options.legacyBlobData ? ", p.data" : "";
	const whole = options.legacyBlobData ? " AND (p.chunks <> -1 OR length(p.data) = p.bytes)" : "";
	const statements: SqliteStatement[] = [];
	const checks: SqliteStatement[] = [];
	const groups: string[][] = [];
	for (let start = 0; start < hashes.length; start += BLOB_HASHES_PER_STATEMENT)
		groups.push(hashes.slice(start, start + BLOB_HASHES_PER_STATEMENT));
	for (const group of groups) {
		const named = group.map(() => "?").join(", ");
		statements.push(
			{
				sql: `INSERT INTO ${blobs} (session_id, hash, bytes, chunks${columns}) SELECT ?, p.hash, p.bytes, p.chunks${sourceColumns} FROM ${blobs} p WHERE p.session_id = ? AND p.hash IN (${named})${whole} AND NOT EXISTS (SELECT 1 FROM ${blobs} c WHERE c.session_id = ? AND c.hash = p.hash) ORDER BY p.hash`,
				params: [child, source, ...group, child],
			},
			{
				sql: `INSERT INTO ${blobChunks} (session_id, hash, idx, data) SELECT ?, k.hash, k.idx, k.data FROM ${blobChunks} k JOIN ${blobs} p ON p.session_id = k.session_id AND p.hash = k.hash WHERE k.session_id = ? AND k.hash IN (${named}) AND k.idx < p.chunks AND length(k.data) = CASE WHEN k.idx = p.chunks - 1 THEN p.bytes - k.idx * ? ELSE ? END AND NOT EXISTS (SELECT 1 FROM ${blobChunks} x WHERE x.session_id = ? AND x.hash = k.hash AND x.idx = k.idx) ORDER BY k.hash, k.idx`,
				params: [child, source, ...group, options.chunkBytes, options.chunkBytes, child],
			},
		);
		checks.push({
			sql: `SELECT p.hash, p.bytes, p.chunks, (SELECT count(*) FROM ${blobs} c WHERE c.session_id = ? AND c.hash = p.hash) AS copied, (SELECT count(*) FROM ${blobChunks} k WHERE k.session_id = ? AND k.hash = p.hash) AS parts FROM ${blobs} p WHERE p.session_id = ? AND p.hash IN (${named})`,
			params: [child, child, source, ...group],
		});
	}
	return {
		statements,
		checks,
		remaining(answers) {
			const held = new Set<string>();
			for (const row of answers.flat()) {
				const hash = String(row.hash);
				const bytes = Number(row.bytes);
				const chunks = Number(row.chunks);
				const complete =
					Number(row.copied) === 1 &&
					(chunks < 0 || (chunks === Math.ceil(bytes / options.chunkBytes) && Number(row.parts) === chunks));
				if (!complete) throw new SessionBlobError("blob-incomplete", { sessionId: source, hash, bytes });
				held.add(hash);
			}
			return hashes.filter((hash) => !held.has(hash));
		},
	};
}
