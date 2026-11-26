// A module of its own, not errors.ts: a process of an earlier release that an in-place update caught keeps the copy of
// errors.js it loaded, which lacks this class, and this build's modules loaded on demand import it from here (#6560).

/**
 * A fork could not be given its own copy of rows it shares (#6560): the session that stores them lacks one of them, or
 * one of the chunks of a large entry, so a copy would be corrupt. Nothing was written; the fork keeps reading the rows
 * where they are.
 */
export class ForkSourceIncompleteError extends Error {
	/** The fork the copy was for. */
	readonly sessionId: string;
	/** The session storing the rows, and the first of its seqs whose entry is missing or lacks a chunk. */
	readonly sourceId: string;
	readonly sourceSeq: number;

	constructor(sessionId: string, sourceId: string, sourceSeq: number) {
		super(
			`Cannot copy the history session ${sessionId} shares: entry ${sourceSeq} of session ${sourceId} is missing or lacks a chunk`,
		);
		this.name = "ForkSourceIncompleteError";
		this.sessionId = sessionId;
		this.sourceId = sourceId;
		this.sourceSeq = sourceSeq;
	}
}
