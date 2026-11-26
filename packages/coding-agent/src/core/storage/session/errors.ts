import { SESSION_FORMAT_VERSION, type StorageDescriptor } from "./types.js";

export type SessionJsonValue =
	| null
	| boolean
	| number
	| string
	| SessionJsonValue[]
	| { [key: string]: SessionJsonValue };

export class SessionFormatVersionError extends Error {
	readonly path: string;
	readonly found: SessionJsonValue | undefined;
	readonly supported = SESSION_FORMAT_VERSION;

	constructor(path: string, found: SessionJsonValue | undefined) {
		super(`Unsupported session format at ${path}`);
		this.name = "SessionFormatVersionError";
		this.path = path;
		this.found = found;
	}
}

export class StorageUnavailableError extends Error {
	readonly adapter: string;
	readonly location: string;
	override readonly cause: Error;

	constructor(descriptor: StorageDescriptor, cause: Error) {
		super(`Storage unavailable: ${descriptor.adapter} at ${descriptor.location}`, { cause });
		this.name = "StorageUnavailableError";
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
		this.cause = cause;
	}
}

export class StoreClosedError extends Error {
	readonly adapter: string;
	readonly location: string;

	constructor(descriptor: StorageDescriptor) {
		super(`Store closed: ${descriptor.adapter} at ${descriptor.location}`);
		this.name = "StoreClosedError";
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export class SessionNotFoundError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session not found: ${sessionId}`);
		this.name = "SessionNotFoundError";
		this.sessionId = sessionId;
	}
}

export class SessionIdMismatchError extends Error {
	readonly requested: string;
	readonly found: string;

	constructor(requested: string, found: string) {
		super(`Session ID mismatch: requested ${requested}, found ${found}`);
		this.name = "SessionIdMismatchError";
		this.requested = requested;
		this.found = found;
	}
}

export class SessionExistsError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session already exists: ${sessionId}`);
		this.name = "SessionExistsError";
		this.sessionId = sessionId;
	}
}

export class SessionConflictError extends Error {
	readonly sessionId: string;
	readonly expectedSeq: number;
	readonly actualSeq: number;

	constructor(sessionId: string, expectedSeq: number, actualSeq: number) {
		super(`Session conflict: ${sessionId}, expected ${expectedSeq}, actual ${actualSeq}`);
		this.name = "SessionConflictError";
		this.sessionId = sessionId;
		this.expectedSeq = expectedSeq;
		this.actualSeq = actualSeq;
	}
}

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

export type SessionTextField =
	| "sessionId"
	| "header.id"
	| "header.cwd"
	| "header.parentSessionId"
	| "entry.id"
	| "entry.parentId"
	| "summarizedThroughId";

export class SessionInvalidTextError extends Error {
	readonly field: SessionTextField;
	readonly reason: "nul-character" | "ill-formed-unicode";

	constructor(field: SessionTextField, reason: "nul-character" | "ill-formed-unicode") {
		super(`Invalid session text: ${field} (${reason})`);
		this.name = "SessionInvalidTextError";
		this.field = field;
		this.reason = reason;
	}
}

export type SessionTimestampField =
	| "header.createdAt"
	| "entry.timestamp"
	| "entry.message.timestamp"
	| "entry.systemMessage.timestamp";

export class SessionInvalidTimestampError extends Error {
	readonly field: SessionTimestampField;
	readonly value: string | number;
	readonly reason: "out-of-range" | "unparseable";

	constructor(field: SessionTimestampField, value: string | number, reason: "out-of-range" | "unparseable") {
		super(`Invalid session timestamp: ${field} (${reason})`);
		this.name = "SessionInvalidTimestampError";
		this.field = field;
		this.value = value;
		this.reason = reason;
	}
}
