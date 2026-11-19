export type ReleasedChildErrorCode =
	| "child-record-missing"
	| "child-record-unreadable"
	| "child-unrestorable"
	| "record-append-failed"
	| "hold-failed"
	| "completion-not-held"
	| "wake-failed";

/** Ids and reasons only, so an error can be logged, serialized and shown without exposing prompts or results. */
export interface ReleasedChildErrorFields {
	readonly childId?: string;
	readonly childName?: string;
	/** Every subagent one failure covers when it covers several, by Intercom name (#5551). */
	readonly childNames?: readonly string[];
	readonly ownerSessionId?: string;
	readonly reason?: string;
	readonly state?: string;
	readonly terminalStatus?: string;
	/** The session whose history holds a child's latest record. */
	readonly sessionId?: string;
	/** The session entry holding a child's latest record. */
	readonly entryId?: string;
}

export const RELEASED_CHILD_ERROR_NAME = "ReleasedChildError";

const RELEASED_CHILD_ERROR_CODES: ReadonlySet<string> = new Set<ReleasedChildErrorCode>([
	"child-record-missing",
	"child-record-unreadable",
	"child-unrestorable",
	"record-append-failed",
	"hold-failed",
	"completion-not-held",
	"wake-failed",
]);

const RETRYABLE_CODES: ReadonlySet<ReleasedChildErrorCode> = new Set([
	"record-append-failed",
	"hold-failed",
	"wake-failed",
]);

function describeChild(fields: ReleasedChildErrorFields): string {
	return fields.childId ?? fields.childName ?? "the subagent";
}

function hintFor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields): string {
	switch (code) {
		case "child-record-missing":
			return "Wake the subagent from the session that launched it: only a session's own children are recorded there.";
		case "child-record-unreadable":
			return "Open the session that launched the subagent, then try again from it: a subagent's record is read from that session's history.";
		case "child-unrestorable":
			return `Fix what the reason names, then resume it with { action: "resume", id: "${describeChild(fields)}", message? }, or launch a new subagent.`;
		case "record-append-failed":
			return "Check the session store the owning session writes to; until it is saved, a restart would not know this state of the child.";
		case "hold-failed":
			return `Check that Intercom is connected; until the reservation exists, sends to ${several(fields) ? "these subagents" : "this subagent"} are answered as not found.`;
		case "completion-not-held":
			// #5551: the parent's task owner keeps a refused notice for the child's next run, never for the launching session.
			return "Nothing to do: the task's completion notice waits for the subagent's next run; the session that launched the subagent never receives it.";
		case "wake-failed":
			return `Its results are kept: resume it with { action: "resume", id: "${describeChild(fields)}", message? } to try again.`;
	}
}

function several(fields: ReleasedChildErrorFields): boolean {
	return (fields.childNames?.length ?? 0) > 1;
}

const LISTED_NAMES = 3;

/** "a, b and c", or the first few and how many more. */
function listed(names: readonly string[]): string {
	const shown = names.slice(0, names.length > LISTED_NAMES + 1 ? LISTED_NAMES : names.length);
	const more = names.length - shown.length;
	if (more > 0) return `${shown.join(", ")} and ${more} more`;
	return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** "subagent <id>" by its child id, else its Intercom name; "the subagent" when the failure names neither (#5551). */
function subagentNamed(fields: ReleasedChildErrorFields): string {
	const id = fields.childId ?? fields.childName;
	return id === undefined ? "the subagent" : `subagent ${id}`;
}

function subjectFor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields): string {
	const named = subagentNamed(fields);
	const leading = `${named.charAt(0).toUpperCase()}${named.slice(1)}`;
	switch (code) {
		case "child-record-missing":
			return `Session ${fields.ownerSessionId} has no record of ${named}`;
		case "child-record-unreadable":
			return `The latest record of ${named} is in entry ${fields.entryId ?? "(none)"} of session ${fields.sessionId ?? fields.ownerSessionId}, which is not open in this process`;
		case "child-unrestorable":
			return `${leading} cannot be restored: ${fields.reason}`;
		case "record-append-failed":
			return `The ${fields.state === undefined ? "" : `${fields.state} `}record of ${named} could not be saved`;
		case "hold-failed": {
			if (several(fields)) return `Sends to released subagents ${listed(fields.childNames ?? [])} cannot be held`;
			const target = fields.childName ?? fields.childId;
			return `Sends to ${target === undefined ? "a released subagent" : `released subagent ${target}`} cannot be held`;
		}
		case "completion-not-held":
			return `${leading} runs again or has ended, so it does not hold the completion of a task it launched`;
		case "wake-failed":
			return `Waking ${named} failed: ${fields.reason}`;
	}
}

export interface SerializedReleasedChildError {
	readonly name: string;
	readonly code: ReleasedChildErrorCode;
	readonly subject: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ReleasedChildErrorFields;
}

/**
 * Waking, recording or keeping addressable a released subagent failed. `subject` says what failed, `code` says why,
 * `fields` carries the ids involved, `hint` says what to do next, and `retryable` is true only when trying again
 * later can succeed. The message is the subject followed by the code and the hint.
 */
export class ReleasedChildError extends Error {
	override readonly name: string = RELEASED_CHILD_ERROR_NAME;
	readonly code: ReleasedChildErrorCode;
	readonly subject: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ReleasedChildErrorFields;

	constructor(code: ReleasedChildErrorCode, fields: ReleasedChildErrorFields, options?: ErrorOptions) {
		const hint = hintFor(code, fields);
		const subject = subjectFor(code, fields);
		super(`${subject} (${code}). ${hint}`, options);
		this.code = code;
		this.subject = subject;
		this.hint = hint;
		this.retryable = RETRYABLE_CODES.has(code);
		this.fields = fields;
	}

	toJSON(): SerializedReleasedChildError {
		return {
			name: this.name,
			code: this.code,
			subject: this.subject,
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

/**
 * What failed, without the code and the hint the message ends with: the error's own subject, or for a structural copy
 * that carries none, as one serialized before it had one, the subject its code and fields name (#5551).
 */
export function releasedChildErrorSubject(error: ReleasedChildError): string {
	const subject = (error as { readonly subject?: unknown }).subject;
	return typeof subject === "string" ? subject : subjectFor(error.code, error.fields ?? {});
}
