/**
 * Where a forked session's inherited entries live, when a fork shares its parent's stored history instead of copying it
 * (#6560). Seqs are 1-based and dense in every session's view. A segment says that the view's seqs `baseSeq + 1` through
 * `baseSeq + (toSeq - fromSeq + 1)` are the rows `fromSeq` through `toSeq`, inclusive, that session `sourceId` stores
 * under its own id. Every seq of a view that no segment covers is a row the session stores itself, under that same seq.
 *
 * Segments are composed when a fork is made, so a source always stores the rows a segment names itself: reading a
 * session never walks a chain of ancestors, whatever the depth of its forks.
 */
export interface ForkSegment {
	readonly sourceId: string;
	readonly fromSeq: number;
	readonly toSeq: number;
	readonly baseSeq: number;
}

/** A run of a session's view in one place: view seqs `firstSeq` on are `sessionId`'s stored seqs `fromSeq` to `toSeq`. */
export interface ForkPiece {
	readonly sessionId: string;
	readonly fromSeq: number;
	readonly toSeq: number;
	readonly firstSeq: number;
}

export function segmentLength(segment: ForkSegment): number {
	return segment.toSeq - segment.fromSeq + 1;
}

/** The view seq after the segment's last one. */
function segmentEnd(segment: ForkSegment): number {
	return segment.baseSeq + segmentLength(segment);
}

/**
 * Throws unless `segments` are well formed for the view of session `sessionId`, of `length` seqs: each non-empty, within
 * the view, of another session, with its source rows from seq 1 on, in view order and disjoint, and each source's rows
 * in increasing order, so no stored row is read at two seqs of the view.
 */
export function assertForkSegments(sessionId: string, segments: readonly ForkSegment[], length: number): void {
	let end = 0;
	const sourceEnds = new Map<string, number>();
	for (const segment of segments) {
		const { sourceId, fromSeq, toSeq, baseSeq } = segment;
		if (
			sourceId === sessionId ||
			!Number.isSafeInteger(fromSeq) ||
			!Number.isSafeInteger(toSeq) ||
			!Number.isSafeInteger(baseSeq) ||
			fromSeq < 1 ||
			toSeq < fromSeq ||
			baseSeq < end ||
			segmentEnd(segment) > length ||
			fromSeq <= (sourceEnds.get(sourceId) ?? 0)
		)
			throw new RangeError(`Invalid fork segment ${JSON.stringify(segment)} in a view of ${length} entries`);
		end = segmentEnd(segment);
		sourceEnds.set(sourceId, toSeq);
	}
}

/** The index of the segment that holds view seq `seq`, or -1 when `seq` is a row of the session's own. */
function segmentIndexOf(segments: readonly ForkSegment[], seq: number): number {
	let low = 0;
	let high = segments.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const segment = segments[middle]!;
		if (seq <= segment.baseSeq) high = middle - 1;
		else if (seq > segmentEnd(segment)) low = middle + 1;
		else return middle;
	}
	return -1;
}

/** Where view seq `seq` of session `sessionId` is stored. */
export function locateForkSeq(
	sessionId: string,
	segments: readonly ForkSegment[],
	seq: number,
): { readonly sessionId: string; readonly seq: number } {
	const index = segmentIndexOf(segments, seq);
	if (index < 0) return { sessionId, seq };
	const segment = segments[index]!;
	return { sessionId: segment.sourceId, seq: segment.fromSeq + (seq - segment.baseSeq) - 1 };
}

/**
 * The view seqs `fromSeq` through `toSeq` of session `sessionId` as runs stored in one place each, in view order: what a
 * read of that range reads, one statement a piece.
 */
export function forkPieces(
	sessionId: string,
	segments: readonly ForkSegment[],
	fromSeq: number,
	toSeq: number,
): ForkPiece[] {
	const pieces: ForkPiece[] = [];
	let seq = fromSeq;
	let index = segments.findIndex((segment) => segmentEnd(segment) >= seq);
	if (index < 0) index = segments.length;
	while (seq <= toSeq) {
		const segment = segments[index];
		if (segment === undefined || seq <= segment.baseSeq) {
			// The session's own rows up to the next segment.
			const last = Math.min(toSeq, segment === undefined ? toSeq : segment.baseSeq);
			pieces.push({ sessionId, fromSeq: seq, toSeq: last, firstSeq: seq });
			seq = last + 1;
			continue;
		}
		const last = Math.min(toSeq, segmentEnd(segment));
		if (last < seq) throw new RangeError(`Fork segments out of order at view seq ${seq}`);
		const offset = segment.fromSeq - segment.baseSeq - 1;
		pieces.push({ sessionId: segment.sourceId, fromSeq: seq + offset, toSeq: last + offset, firstSeq: seq });
		seq = last + 1;
		index++;
	}
	return pieces;
}

/**
 * The segments a fork of session `parentId`, whose view has `parentLength` seqs and inherits `parent`, keeps when it
 * takes the parent's view seqs `fromSeq` through `toSeq` as its own view seqs from `baseSeq + 1` on: the parent's own rows
 * as segments of the parent, and its inherited rows as segments of their sources, so no source of the result inherits
 * the rows it names. Throws when the range is not in the parent's view.
 */
export function forkRunSegments(
	parentId: string,
	parent: readonly ForkSegment[],
	parentLength: number,
	run: { readonly fromSeq: number; readonly toSeq: number; readonly baseSeq: number },
): ForkSegment[] {
	if (run.fromSeq < 1 || run.toSeq < run.fromSeq || run.toSeq > parentLength)
		throw new RangeError(`Fork run ${JSON.stringify(run)} is outside a parent view of ${parentLength} entries`);
	return forkPieces(parentId, parent, run.fromSeq, run.toSeq).map((piece) => ({
		sourceId: piece.sessionId,
		fromSeq: piece.fromSeq,
		toSeq: piece.toSeq,
		baseSeq: run.baseSeq + (piece.firstSeq - run.fromSeq),
	}));
}

/**
 * `segments` with each segment that continues the one before it in both its source and its view joined to it: the same
 * view in fewer segments.
 */
export function joinForkSegments(segments: readonly ForkSegment[]): ForkSegment[] {
	const joined: ForkSegment[] = [];
	for (const segment of segments) {
		const last = joined.at(-1);
		if (
			last !== undefined &&
			last.sourceId === segment.sourceId &&
			last.toSeq + 1 === segment.fromSeq &&
			segmentEnd(last) === segment.baseSeq
		)
			joined[joined.length - 1] = { ...last, toSeq: segment.toSeq };
		else joined.push(segment);
	}
	return joined;
}

/** The segments of a fork that keeps the first `cut` seqs of a parent's view, as a prefix of its own view. */
export function prefixForkSegments(
	parentId: string,
	parent: readonly ForkSegment[],
	parentLength: number,
	cut: number,
): ForkSegment[] {
	if (!Number.isSafeInteger(cut) || cut < 0 || cut > parentLength)
		throw new RangeError(`Fork cut ${cut} is outside a parent view of ${parentLength} entries`);
	return cut === 0 ? [] : forkRunSegments(parentId, parent, parentLength, { fromSeq: 1, toSeq: cut, baseSeq: 0 });
}
