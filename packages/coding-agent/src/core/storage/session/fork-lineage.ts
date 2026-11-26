import type { SqliteExecutor, SqliteRow, SqliteStatement } from "../database.js";
import type { StorageDialect } from "../dialect.js";
import { ForkSourceIncompleteError } from "./fork-errors.js";
import { type ForkCopyTables, forkBlobCopy } from "./fork-row-copy.js";
import { assertForkSegments, type ForkSegment, forkRunSegments, segmentLength } from "./fork-segments.js";

/**
 * The rows that say where a fork that shares its parent's history finds the entries it inherits (#6560): its segments,
 * in `fork_segments`, and its lineage row, in `fork_lineage`, whose `generation` changes with every change to its
 * segments and never repeats. Every writer of segments goes through `forkSegmentWrites`; reads go through the views of
 * `fork-view.ts`, which join the segments in the statement that reads the rows.
 */
export interface ForkLineageTables {
	readonly sessions: string;
	readonly forkSegments: string;
	readonly forkLineage: string;
}

/** Segment rows one statement inserts at most: six parameters each, well under every backend's parameter limit. */
const SEGMENT_ROWS_PER_INSERT = 500;

/** Session `sessionId`'s segments, in view order, read through `tx`. None for a session that inherits nothing. */
export async function readForkSegments(
	tx: SqliteExecutor,
	tables: ForkLineageTables,
	sessionId: string,
): Promise<ForkSegment[]> {
	const rows = await tx.all<SqliteRow & { source_id: string; from_seq: number; to_seq: number; base_seq: number }>(
		`SELECT source_id, from_seq, to_seq, base_seq FROM ${tables.forkSegments} WHERE session_id = ? ORDER BY idx`,
		sessionId,
	);
	return rows.map((row) => ({
		sourceId: String(row.source_id),
		fromSeq: Number(row.from_seq),
		toSeq: Number(row.to_seq),
		baseSeq: Number(row.base_seq),
	}));
}

/**
 * The statements that make `segments` session `sessionId`'s segments, in place of any it had, and give its lineage row a
 * new generation: with `lineage`, the parent and cut-off a new fork records; without, the row keeps them. Throws unless
 * `segments` are well formed for a view of `length` seqs. The session's own rows must not sit at a seq they cover:
 * a view is the rows its segments name and the session's own rows, both read.
 */
export function forkSegmentWrites(
	tables: ForkLineageTables,
	sessionId: string,
	segments: readonly ForkSegment[],
	length: number,
	lineage?: { readonly parentId: string; readonly cutSeq: number },
): SqliteStatement[] {
	assertForkSegments(sessionId, segments, length);
	return [
		{ sql: `DELETE FROM ${tables.forkSegments} WHERE session_id = ?`, params: [sessionId] },
		...forkSegmentInserts(tables, sessionId, 0, segments),
		forkLineageWrite(tables, sessionId, lineage),
	];
}

/** The statements that insert `segments` as session `sessionId`'s segments from index `firstIndex` on. */
export function forkSegmentInserts(
	tables: ForkLineageTables,
	sessionId: string,
	firstIndex: number,
	segments: readonly ForkSegment[],
): SqliteStatement[] {
	const statements: SqliteStatement[] = [];
	for (let start = 0; start < segments.length; start += SEGMENT_ROWS_PER_INSERT) {
		const batch = segments.slice(start, start + SEGMENT_ROWS_PER_INSERT);
		statements.push({
			sql: `INSERT INTO ${tables.forkSegments} (session_id, idx, source_id, from_seq, to_seq, base_seq) VALUES ${batch
				.map(() => "(?, ?, ?, ?, ?, ?)")
				.join(", ")}`,
			params: batch.flatMap((segment, index) => [
				sessionId,
				firstIndex + start + index,
				segment.sourceId,
				segment.fromSeq,
				segment.toSeq,
				segment.baseSeq,
			]),
		});
	}
	return statements;
}

/**
 * The statement that gives session `sessionId`'s lineage row a new generation, as every change to its segments must:
 * with `lineage`, the parent and cut-off a new fork records; without, the row keeps them.
 */
export function forkLineageWrite(
	tables: ForkLineageTables,
	sessionId: string,
	lineage?: { readonly parentId: string; readonly cutSeq: number },
): SqliteStatement {
	return {
		sql: `INSERT INTO ${tables.forkLineage} (session_id, parent_id, cut_seq, generation) VALUES (?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET generation = excluded.generation${
				lineage === undefined ? "" : ", parent_id = excluded.parent_id, cut_seq = excluded.cut_seq"
			}`,
		params: [sessionId, lineage?.parentId ?? null, lineage?.cutSeq ?? null, crypto.randomUUID()],
	};
}

/** Runs {@link forkSegmentWrites} through `tx`. */
export async function writeForkSegments(
	tx: SqliteExecutor,
	tables: ForkLineageTables,
	sessionId: string,
	segments: readonly ForkSegment[],
	length: number,
	lineage?: { readonly parentId: string; readonly cutSeq: number },
): Promise<void> {
	for (const { sql, params } of forkSegmentWrites(tables, sessionId, segments, length, lineage))
		await tx.run(sql, ...params);
}

/** The sessions with a segment that names `sourceId`, by id: the forks that read rows `sourceId` stores. */
export async function forkChildren(tx: SqliteExecutor, tables: ForkLineageTables, sourceId: string): Promise<string[]> {
	const rows = await tx.all<SqliteRow & { session_id: string }>(
		`SELECT DISTINCT session_id FROM ${tables.forkSegments} WHERE source_id = ? ORDER BY session_id`,
		sourceId,
	);
	return rows.map((row) => String(row.session_id));
}

/**
 * Locks the sessions rows of `ids`, in id order so that two transactions never wait for each other: `key-share` keeps
 * them from being deleted or locked `update` while the transaction lasts, as a fork that names them in its segments
 * needs; `update` excludes those. Nothing on SQLite, whose write transactions already run one at a time.
 */
export async function lockForkSources(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	tables: ForkLineageTables,
	ids: Iterable<string>,
	mode: "key-share" | "update",
): Promise<void> {
	const sorted = [...new Set(ids)].sort();
	if (dialect.name === "sqlite" || sorted.length === 0) return;
	await tx.all(
		`SELECT id FROM ${tables.sessions} WHERE id IN (${sorted.map(() => "?").join(", ")}) ORDER BY id${dialect.lockClause(mode)}`,
		...sorted,
	);
}

/**
 * The segments of a fork that shares its parent's history, gathered as the fork's rows stream past (#6560): each row the
 * parent stores unchanged extends a run of the parent's view, and `drain` composes the runs gathered since the last
 * one with the parent's own segments, so that each segment names the session that stores its rows, and returns the
 * statements that insert them. Drain before the fork writes a row of its own, so that its segments come first in seq
 * order. `heldSeq` answers for the rows of runs not yet drained.
 */
export class ForkSegmentRuns {
	readonly segments: ForkSegment[] = [];
	private readonly runs: { fromSeq: number; toSeq: number; baseSeq: number }[] = [];
	private readonly held = new Map<string, number>();
	private readonly tables: ForkLineageTables;
	private readonly child: string;
	private readonly parent: { readonly id: string; readonly segments: readonly ForkSegment[]; readonly length: number };

	constructor(
		tables: ForkLineageTables,
		child: string,
		parent: { readonly id: string; readonly segments: readonly ForkSegment[]; readonly length: number },
	) {
		this.tables = tables;
		this.child = child;
		this.parent = parent;
	}

	/** The parent's row at view seq `parentSeq` is the child's row at `childSeq`, entry `id`. */
	add(parentSeq: number, childSeq: number, id: string): void {
		const run = this.runs.at(-1);
		if (run && parentSeq === run.toSeq + 1 && childSeq === run.baseSeq + (run.toSeq - run.fromSeq) + 2) run.toSeq++;
		else this.runs.push({ fromSeq: parentSeq, toSeq: parentSeq, baseSeq: childSeq - 1 });
		this.held.set(id, childSeq);
	}

	/** The child seq of entry `id` among the rows not yet drained, the latest when several hold it. */
	heldSeq(id: string): number | undefined {
		return this.held.get(id);
	}

	/** Whether enough rows wait that they should be drained before more are added. */
	get full(): boolean {
		return this.held.size >= 8192;
	}

	/** The statements that insert the segments of the runs gathered since the last drain. */
	drain(): SqliteStatement[] {
		if (this.runs.length === 0) return [];
		const composed = this.runs.flatMap((run) =>
			forkRunSegments(this.parent.id, this.parent.segments, this.parent.length, run),
		);
		const first = this.segments.length;
		this.segments.push(...composed);
		this.runs.length = 0;
		this.held.clear();
		return forkSegmentInserts(this.tables, this.child, first, composed);
	}
}

/** The tables a materialization copies rows between, besides the fork tables. */
export interface ForkMaterializeTables extends ForkLineageTables, ForkCopyTables {
	readonly searchTexts: string;
}

/**
 * `segments` without the view seqs `pieces` cover: each piece must lie within one segment, naming the same rows of the
 * same source. Throws otherwise.
 */
export function withoutForkPieces(segments: readonly ForkSegment[], pieces: readonly ForkSegment[]): ForkSegment[] {
	const end = (segment: ForkSegment) => segment.baseSeq + segmentLength(segment);
	const remaining: ForkSegment[] = [];
	for (const segment of segments) {
		const inside = pieces
			.filter(
				(piece) =>
					piece.baseSeq >= segment.baseSeq && end(piece) <= end(segment) && piece.sourceId === segment.sourceId,
			)
			.sort((a, b) => a.baseSeq - b.baseSeq);
		let view = segment.baseSeq;
		for (const piece of inside) {
			if (piece.fromSeq - piece.baseSeq !== segment.fromSeq - segment.baseSeq || piece.baseSeq < view)
				throw new RangeError(`Fork piece ${JSON.stringify(piece)} does not lie within ${JSON.stringify(segment)}`);
			if (piece.baseSeq > view)
				remaining.push({
					...segment,
					fromSeq: segment.fromSeq + (view - segment.baseSeq),
					toSeq: piece.fromSeq - 1,
					baseSeq: view,
				});
			view = end(piece);
		}
		if (view < end(segment))
			remaining.push({ ...segment, fromSeq: segment.fromSeq + (view - segment.baseSeq), baseSeq: view });
	}
	const covered = pieces.reduce((sum, piece) => sum + segmentLength(piece), 0);
	const before = segments.reduce((sum, segment) => sum + segmentLength(segment), 0);
	const after = remaining.reduce((sum, segment) => sum + segmentLength(segment), 0);
	if (before - after !== covered) throw new RangeError("Fork pieces overlap or lie outside the fork's segments");
	return remaining;
}

/** The first seq of `piece` whose entry its source lacks, or holds without one of its chunks: why its copy was refused. */
async function firstIncomplete(tx: SqliteExecutor, tables: ForkMaterializeTables, piece: ForkSegment): Promise<number> {
	const rows = await tx.all<SqliteRow & { seq: number; chunks: number; held: number }>(
		`SELECT e.seq, e.chunks, (SELECT count(*) FROM ${tables.entryChunks} c WHERE c.session_id = e.session_id AND c.seq = e.seq AND c.idx >= 0 AND c.idx < e.chunks) AS held FROM ${tables.entries} e WHERE e.session_id = ? AND e.seq BETWEEN ? AND ? ORDER BY e.seq`,
		piece.sourceId,
		piece.fromSeq,
		piece.toSeq,
	);
	let expected = piece.fromSeq;
	for (const row of rows) {
		if (Number(row.seq) !== expected || (Number(row.chunks) > 0 && Number(row.held) !== Number(row.chunks)))
			return expected;
		expected++;
	}
	return expected;
}

/**
 * Copies into session `childId`, a fork that shares history, the rows `pieces` of its segments name, with their chunks,
 * search texts and the blobs their tool outputs name, then writes its segments without them, with a new generation, so
 * its view stays as it was at every commit (#6560). Last, `relink` links the child's rows in the snapshot index again
 * from the first row copied on, in seq order, as the index's rebuild links them: the copies are stored after the rows
 * the child appended, which are linked behind them again. Each piece lies within one of the child's segments: a sub-range of
 * it, or all of it. The caller holds the child's row locked `update`, and the sources' rows locked, so neither its
 * segments nor the rows they name change meanwhile; `length` is the child's last seq.
 */
export async function materializeForkSegments(
	tx: SqliteExecutor,
	dialect: StorageDialect,
	tables: ForkMaterializeTables,
	blobs: { readonly legacyBlobData: boolean; readonly chunkBytes: number },
	relink: (tx: SqliteExecutor, sessionId: string, fromSeq: number) => Promise<void>,
	childId: string,
	length: number,
	pieces: readonly ForkSegment[],
): Promise<void> {
	const remaining = withoutForkPieces(await readForkSegments(tx, tables, childId), pieces);
	const text = (...path: string[]) => dialect.jsonText("entry_json", ...path);
	// In seq order, so the snapshot index's triggers meet a parent before its children, as an append does.
	for (const piece of [...pieces].sort((a, b) => a.baseSeq - b.baseSeq)) {
		const shift = piece.baseSeq - piece.fromSeq + 1;
		const range = [piece.sourceId, piece.fromSeq, piece.toSeq];
		// Only an entry the source holds whole is copied: one stored in chunks needs each of its chunks 0 to `chunks - 1`,
		// counted by their key in the same statement. An entry missing, or lacking a chunk, is not copied, and the count of
		// the rows copied tells: the copy is refused before anything of it commits, and the fork keeps reading the source.
		const copied = await tx.run(
			`INSERT INTO ${tables.entries} (session_id, seq, entry_id, entry_json, chunks) SELECT ?, e.seq + ?, e.entry_id, e.entry_json, e.chunks FROM ${tables.entries} e WHERE e.session_id = ? AND e.seq BETWEEN ? AND ? AND (e.chunks = 0 OR e.chunks = (SELECT count(*) FROM ${tables.entryChunks} c WHERE c.session_id = e.session_id AND c.seq = e.seq AND c.idx >= 0 AND c.idx < e.chunks)) ORDER BY e.seq`,
			childId,
			shift,
			...range,
		);
		if (Number(copied.changes) !== segmentLength(piece))
			throw new ForkSourceIncompleteError(childId, piece.sourceId, await firstIncomplete(tx, tables, piece));
		// Each entry's own chunks only, never a row an older version left past them or at an entry stored whole.
		await tx.run(
			`INSERT INTO ${tables.entryChunks} (session_id, seq, idx, data) SELECT ?, c.seq + ?, c.idx, c.data FROM ${tables.entryChunks} c JOIN ${tables.entries} e ON e.session_id = c.session_id AND e.seq = c.seq WHERE c.session_id = ? AND c.seq BETWEEN ? AND ? AND c.idx >= 0 AND c.idx < e.chunks ORDER BY c.seq, c.idx`,
			childId,
			shift,
			...range,
		);
		await tx.run(
			`INSERT INTO ${tables.searchTexts} (session_id, seq, text_json) SELECT ?, seq + ?, text_json FROM ${tables.searchTexts} WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
			childId,
			shift,
			...range,
		);
		const named = await tx.all<SqliteRow & { hash: string }>(
			`SELECT DISTINCT ${text("data", "hash")} AS hash FROM ${tables.entries} WHERE session_id = ? AND seq BETWEEN ? AND ?
				AND chunks = 0 AND ${text("type")} = 'custom' AND ${text("customType")} = 'atomic.tool-output' AND ${text("data", "hash")} IS NOT NULL`,
			...range,
		);
		const copy = forkBlobCopy(
			tables,
			blobs,
			piece.sourceId,
			childId,
			named.map((row) => String(row.hash)),
		);
		for (const { sql, params } of copy.statements) await tx.run(sql, ...params);
		const answers = [];
		for (const { sql, params } of copy.checks) answers.push(await tx.all(sql, ...params));
		// A blob the source no longer holds stays missing, as it was for the source; one copied part way fails.
		copy.remaining(answers);
	}
	await writeForkSegments(tx, tables, childId, remaining, length);
	if (pieces.length > 0) await relink(tx, childId, Math.min(...pieces.map((piece) => piece.baseSeq + 1)));
}
