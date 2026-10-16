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
