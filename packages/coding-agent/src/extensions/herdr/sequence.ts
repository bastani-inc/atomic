/**
 * The shared report sequence.
 *
 * Herdr rejects a report whose sequence is not strictly greater than the last
 * one it accepted for this source, and it rejects it *silently* while still
 * acknowledging the request. State, session, and release reports therefore all
 * draw from this one counter.
 *
 * The high-water mark is module scope so a successor reporter — after `/new`,
 * `/resume`, a fork, or `/reload` — continues above its predecessor instead of
 * restarting at a value Herdr would drop.
 *
 * Caveat: this survives instance replacement, not process replacement. A fresh
 * Atomic process in the same pane re-seeds from `Date.now() * 1000`, which is
 * above any sequence a predecessor process could have reached, because wall
 * clock only moves forward. A backwards clock change between two processes is
 * the one case where the successor's first reports can be dropped.
 */

let highWaterMark = 0;

/** Next sequence value. Strictly increasing for the life of the process. */
export function nextReportSeq(): number {
	const seeded = Math.max(highWaterMark, Date.now() * 1000);
	highWaterMark = seeded + 1;
	return highWaterMark;
}

/** The last issued sequence value; 0 before the first call. */
export function currentReportSeq(): number {
	return highWaterMark;
}
