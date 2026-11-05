import type { ReleasedChildRefusal, ReleasedChildRefusalCode } from "../types.js";

export type IntercomReleasedChildErrorCode = ReleasedChildRefusalCode;

export const RELEASED_CHILD_ERROR_CODES: readonly IntercomReleasedChildErrorCode[] = [
	"invalid_frame",
	"invalid_child_name",
	"invalid_alias",
	"too_many_aliases",
	"invalid_group",
	"unknown_released_child",
	"not_owner",
	"group_not_allowed",
];

const CODES: ReadonlySet<string> = new Set(RELEASED_CHILD_ERROR_CODES);

export function isReleasedChildErrorCode(value: string): value is IntercomReleasedChildErrorCode {
	return CODES.has(value);
}

const HINTS: Readonly<Record<IntercomReleasedChildErrorCode, string>> = {
	invalid_frame: "Send between 1 and 500 children per frame, each with a child name and a boolean wake flag.",
	invalid_child_name: "Use the child's exact, non-empty name; the wildcard `*` names no child.",
	invalid_alias: "Reserve extra targets only as session ids, never as names.",
	too_many_aliases: "Reserve at most 4 extra session ids per child.",
	invalid_group: "Give the group as a string, or omit it to use the owner's registration group.",
	unknown_released_child:
		"Reserve the child with reserveReleasedChildren on this connection before acknowledging its wake or dropping it.",
	not_owner:
		"Only the session that owns this child can reserve, drop or acknowledge it: the one that reserved it first, or that authorized it as its supervisor. Reconnect as that session, or launch a new child.",
	group_not_allowed:
		"Reserve a child in a workflow group only from a session that is a member of that group, or omit the group to use the owner's registration group.",
};

const BASE_NAME = "IntercomReleasedChildError";
const RESERVATION_NAME = "ReleasedChildReservationError";
const UNKNOWN_NAME = "UnknownReleasedChildError";

/** Base of the failures of released-child reservation requests. */
export class IntercomReleasedChildError extends Error {
	override readonly name: string = BASE_NAME;
	readonly code: IntercomReleasedChildErrorCode;
	readonly childName?: string;
	readonly hint: string;
	readonly retryable = false;

	constructor(refusal: ReleasedChildRefusal, options?: { readonly cause?: Error }) {
		const subject = refusal.childName === undefined ? "request" : `child ${JSON.stringify(refusal.childName)}`;
		super(`Released-child request refused: ${subject} (${refusal.code}). ${HINTS[refusal.code]}`, options);
		this.code = refusal.code;
		if (refusal.childName !== undefined) this.childName = refusal.childName;
		this.hint = HINTS[refusal.code];
	}
}

/** A `reserveReleasedChildren` frame had an invalid item, or named a child another session owns; nothing was reserved. */
export class ReleasedChildReservationError extends IntercomReleasedChildError {
	override readonly name = RESERVATION_NAME;
}

/** The child is not reserved by this connection. */
export class UnknownReleasedChildError extends IntercomReleasedChildError {
	override readonly name = UNKNOWN_NAME;
}

const NAMES: ReadonlySet<string> = new Set([BASE_NAME, RESERVATION_NAME, UNKNOWN_NAME]);
const RESERVATION_NAMES: ReadonlySet<string> = new Set([RESERVATION_NAME]);
const UNKNOWN_NAMES: ReadonlySet<string> = new Set([UNKNOWN_NAME]);

function hasStructure(error: Error, names: ReadonlySet<string>): boolean {
	const code = (error as Error & { readonly code?: string | number }).code;
	return names.has(error.name) && typeof code === "string" && isReleasedChildErrorCode(code);
}

export function isIntercomReleasedChildError(error: Error): error is IntercomReleasedChildError {
	return error instanceof IntercomReleasedChildError || hasStructure(error, NAMES);
}

export function isReleasedChildReservationError(error: Error): error is ReleasedChildReservationError {
	return error instanceof ReleasedChildReservationError || hasStructure(error, RESERVATION_NAMES);
}

export function isUnknownReleasedChildError(error: Error): error is UnknownReleasedChildError {
	return error instanceof UnknownReleasedChildError || hasStructure(error, UNKNOWN_NAMES);
}

export function releasedChildErrorFor(
	refusal: ReleasedChildRefusal,
	options?: { readonly cause?: Error },
): IntercomReleasedChildError {
	return refusal.code === "unknown_released_child"
		? new UnknownReleasedChildError(refusal, options)
		: new ReleasedChildReservationError(refusal, options);
}

export interface SerializedErrorCause {
	readonly name: string;
	readonly message: string;
	readonly cause?: SerializedErrorCause;
}

export interface SerializedIntercomReleasedChildError {
	readonly name: string;
	readonly code: IntercomReleasedChildErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: false;
	readonly fields: { readonly childName?: string };
	readonly cause?: SerializedErrorCause;
}

const MAX_CAUSE_DEPTH = 4;

function serializeCause(cause: Error, depth: number): SerializedErrorCause {
	const next = cause.cause instanceof Error && depth < MAX_CAUSE_DEPTH ? serializeCause(cause.cause, depth + 1) : undefined;
	return { name: cause.name, message: cause.message, ...(next === undefined ? {} : { cause: next }) };
}

function rehydrateCause(serialized: SerializedErrorCause, depth: number): Error {
	const next =
		serialized.cause !== undefined && depth < MAX_CAUSE_DEPTH ? rehydrateCause(serialized.cause, depth + 1) : undefined;
	const cause = new Error(serialized.message, next === undefined ? undefined : { cause: next });
	cause.name = serialized.name;
	return cause;
}

export function serializeIntercomReleasedChildError(error: IntercomReleasedChildError): SerializedIntercomReleasedChildError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.childName === undefined ? {} : { childName: error.childName },
		...(error.cause instanceof Error ? { cause: serializeCause(error.cause, 1) } : {}),
	};
}

export function rehydrateIntercomReleasedChildError(
	serialized: SerializedIntercomReleasedChildError,
): IntercomReleasedChildError {
	const refusal: ReleasedChildRefusal =
		serialized.fields.childName === undefined
			? { code: serialized.code }
			: { code: serialized.code, childName: serialized.fields.childName };
	const options = serialized.cause === undefined ? undefined : { cause: rehydrateCause(serialized.cause, 1) };
	if (serialized.name === RESERVATION_NAME) return new ReleasedChildReservationError(refusal, options);
	if (serialized.name === UNKNOWN_NAME) return new UnknownReleasedChildError(refusal, options);
	const error = new IntercomReleasedChildError(refusal, options);
	if (serialized.name !== BASE_NAME) Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}
