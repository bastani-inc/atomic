export type ReleasedChildErrorCode =
	| "child-record-missing"
	| "child-unrestorable"
	| "record-append-failed"
	| "hold-failed";

/** Ids and reasons only, so an error can be logged, serialized and shown without exposing prompts or results. */
export interface ReleasedChildErrorFields {
	readonly childId?: string;
	readonly childName?: string;
	readonly ownerSessionId?: string;
	readonly reason?: string;
	readonly state?: string;
	readonly terminalStatus?: string;
}

export const RELEASED_CHILD_ERROR_NAME = "ReleasedChildError";

const RELEASED_CHILD_ERROR_CODES: ReadonlySet<string> = new Set<ReleasedChildErrorCode>([
	"child-record-missing",
	"child-unrestorable",
	"record-append-failed",
	"hold-failed",
]);

const RETRYABLE_CODES: ReadonlySet<ReleasedChildErrorCode> = new Set(["record-append-failed", "hold-failed"]);

function describeChild(fields: ReleasedChildErrorFields): string {
	return fields.childId ?? fields.childName ?? "the subagent";
}

function hintFor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields): string {
	switch (code) {
		case "child-record-missing":
			return "Wake the subagent from the session that launched it: only a session's own children are recorded there.";
		case "child-unrestorable":
			return `Fix what the reason names, then resume it with { action: "resume", id: "${describeChild(fields)}", message? }, or launch a new subagent.`;
		case "record-append-failed":
			return "Check the session store the owning session writes to; until it is saved, a restart would not know this state of the child.";
		case "hold-failed":
			return "Check that Intercom is connected; until the reservation exists, sends to this subagent are answered as not found.";
	}
}

function subjectFor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields): string {
	switch (code) {
		case "child-record-missing":
			return `Session ${fields.ownerSessionId} has no record of subagent ${fields.childId}`;
		case "child-unrestorable":
			return `Subagent ${fields.childId} cannot be restored: ${fields.reason}`;
		case "record-append-failed":
			return `The ${fields.state} record of subagent ${fields.childId} could not be saved`;
		case "hold-failed":
			return `Sends to released subagent ${fields.childName} cannot be held`;
	}
}

export interface SerializedReleasedChildError {
	readonly name: string;
	readonly code: ReleasedChildErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ReleasedChildErrorFields;
}

/**
 * Waking, recording or keeping addressable a released subagent failed. `code` says why, `fields` carries the ids
 * involved, `hint` says what to do next, and `retryable` is true only when trying again later can succeed.
 */
export class ReleasedChildError extends Error {
	override readonly name: string = RELEASED_CHILD_ERROR_NAME;
	readonly code: ReleasedChildErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ReleasedChildErrorFields;

	constructor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields, options?: ErrorOptions) {
		const hint = hintFor(code, fields);
		super(`${subjectFor(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = RETRYABLE_CODES.has(code);
		this.fields = fields;
	}

	toJSON(): SerializedReleasedChildError {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: this.fields,
		};
	}
}

/** True for a {@link ReleasedChildError}, including a structural copy that crossed a realm or process boundary. */
export function isReleasedChildError(error: Error | object | null | undefined): error is ReleasedChildError {
	if (error instanceof ReleasedChildError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: string; readonly code?: string };
	return (
		candidate.name === RELEASED_CHILD_ERROR_NAME &&
		typeof candidate.code === "string" &&
		RELEASED_CHILD_ERROR_CODES.has(candidate.code)
	);
}
