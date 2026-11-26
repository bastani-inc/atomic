/**
 * Segment arithmetic for detaching lazy forks (detach_ancestor): which rows a detach page copies, and when a sibling's
 * segments can be re-pointed at a detached child. See fork-segments.ts for what a segment is.
 */

import { type ForkSegment, joinForkSegments, segmentLength } from "./fork-segments.js";

/**
 * The first `rows` rows of `segment`, which a detach page copies into the child, and what remains of the segment
 * after them; `rest` is undefined when the page takes the whole segment. Copying `page` and replacing `segment` with
 * `rest` in one transaction leaves the child's view unchanged: no seq is covered both by a segment and by a row of its own.
 */
export function splitSegment(
	segment: ForkSegment,
	rows: number,
): { readonly page: ForkSegment; readonly rest: ForkSegment | undefined } {
	if (rows >= segmentLength(segment)) return { page: segment, rest: undefined };
	const toSeq = segment.fromSeq + rows - 1;
	return {
		page: { ...segment, toSeq },
		rest: { sourceId: segment.sourceId, fromSeq: toSeq + 1, toSeq: segment.toSeq, baseSeq: segment.baseSeq + rows },
	};
}

/**
 * `sibling`'s segments re-pointed from `parentId` at the detached child `childId`, or undefined when the sibling must
 * keep reading the parent. `childOnParent` are the child's segments on the parent as they were before the detach. A
 * sibling is re-pointed only when each of its segments on the parent lies within one of those that maps the parent's
 * seq `j` to the child's own seq `j`, the prefix the child forked: the sibling then reads the same seqs of the child
 * that it read of the parent, and those rows of the child are copies of exactly those rows of the parent, so its view
 * does not change. A sibling that reads parent rows past the child's cut-off would read the child's own later rows
 * there instead, and one that reads rows a branch fork skipped would read other rows; both are left on the parent, to
 * be detached on their own.
 */
export function reparentedSegments(
	sibling: readonly ForkSegment[],
	parentId: string,
	childId: string,
	childOnParent: readonly ForkSegment[],
): ForkSegment[] | undefined {
	const prefix = childOnParent.filter((cover) => cover.baseSeq + 1 === cover.fromSeq);
	const onParent = sibling.filter((segment) => segment.sourceId === parentId);
	if (onParent.length === 0) return undefined;
	const held = (segment: ForkSegment) =>
		prefix.some((cover) => cover.fromSeq <= segment.fromSeq && segment.toSeq <= cover.toSeq);
	if (!onParent.every(held)) return undefined;
	return joinForkSegments(
		sibling.map((segment) => (segment.sourceId === parentId ? { ...segment, sourceId: childId } : segment)),
	);
}
