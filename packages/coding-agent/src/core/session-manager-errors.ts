export class SessionEntryError extends Error {
	readonly entryId: string;
	readonly reason: "missing" | "inactive" | "not-editable" | "not-forkable" | "invalid-replacement";

	constructor(entryId: string, reason: SessionEntryError["reason"]) {
		super(
			reason === "missing"
				? `Entry ${entryId} not found`
				: reason === "inactive"
					? `Entry ${entryId} is not on the active branch`
					: reason === "not-editable"
						? `Entry ${entryId} does not contribute editable model content`
						: reason === "not-forkable"
							? `Entry ${entryId} is not a user message for forking`
							: "Context edit replacement must be null or contain string/array content",
		);
		this.name = "SessionEntryError";
		this.entryId = entryId;
		this.reason = reason;
	}
}

export class SessionHistoryNotLoadedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(
			`Session ${sessionId} holds only its current context window; read older entries with sessionManager.readHistory(), or call loadFullHistory() on the session manager first to keep the whole history in memory`,
		);
		this.name = "SessionHistoryNotLoadedError";
		this.sessionId = sessionId;
	}
}

export class SessionIdError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
		this.name = "SessionIdError";
		this.sessionId = sessionId;
	}
}

/**
 * The session this manager has open was deleted from its store, for example from another process (#4971). The append
 * that found it gone fails with this error, once; the manager then keeps later entries in memory only and saves
 * nothing more for the session.
 */
export class SessionDeletedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, options?: { readonly cause?: unknown }) {
		super(
			`Session ${sessionId} was deleted from its store, possibly by another process; it is no longer saved. Start or resume a session to keep saving.`,
			options,
		);
		this.name = "SessionDeletedError";
		this.sessionId = sessionId;
	}
}

/** Deleting a session another live process has open is refused (#4971). */
export class SessionOpenElsewhereError extends Error {
	readonly sessionId: string;
	readonly pid: number;
	readonly host: string;

	constructor(sessionId: string, holder: { readonly pid: number; readonly host: string }) {
		super(
			`Cannot delete session ${sessionId}: it is open in a running Atomic session (pid ${holder.pid} on ${holder.host}). Close it there first.`,
		);
		this.name = "SessionOpenElsewhereError";
		this.sessionId = sessionId;
		this.pid = holder.pid;
		this.host = holder.host;
	}
}

/** The exit code of `atomic --session`, `--resume` or `--continue` refused with a {@link SessionAlreadyOpenError} (#5135). */
export const SESSION_ALREADY_OPEN_EXIT_CODE = 75;

/**
 * Resuming a session another live process on this machine holds is refused before anything is written or restored
 * (#5135). `pid` and `host` name the holder.
 */
export class SessionAlreadyOpenError extends Error {
	readonly sessionId: string;
	readonly pid: number;
	readonly host: string;
	readonly exitCode = SESSION_ALREADY_OPEN_EXIT_CODE;

	constructor(sessionId: string, holder: { readonly pid: number; readonly host: string }) {
		super(
			`Session ${sessionId} is already open in process ${holder.pid} on ${holder.host}. Nothing was changed. Close it there or wait for that process to exit, then resume again.`,
		);
		this.name = "SessionAlreadyOpenError";
		this.sessionId = sessionId;
		this.pid = holder.pid;
		this.host = holder.host;
	}
}
