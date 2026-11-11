import type { ReleasedReplyRefusalCode } from "../types.js";
import type { JsonWireValue } from "./framing.js";
import { rehydrateErrorCause, type SerializedErrorCause, serializeErrorCause } from "./released-child-errors.js";

export type IntercomReleasedReplyErrorCode = ReleasedReplyRefusalCode;

export const RELEASED_REPLY_ERROR_CODES: readonly IntercomReleasedReplyErrorCode[] = [
	"released_reply_answered",
	"released_reply_in_flight",
];

const CODES: ReadonlySet<string> = new Set(RELEASED_REPLY_ERROR_CODES);

export function isReleasedReplyErrorCode(value: string): value is IntercomReleasedReplyErrorCode {
	return CODES.has(value);
}

/** The reply and the released subagent's question it answers; ids and the subagent's name only. */
export interface IntercomReleasedReplyErrorFields {
	readonly messageId: string;
	readonly questionId: string;
	readonly childName: string;
}

const HINTS: Readonly<Record<IntercomReleasedReplyErrorCode, string>> = {
	released_reply_answered:
		"The subagent's owner already took another reply to this question; do not send this one again, and send a new message if the subagent needs more.",
	released_reply_in_flight:
		"Another reply to this question is still being handed to the subagent's owner; wait, then reply again if the subagent still waits for an answer.",
};

const RETRYABLE: Readonly<Record<IntercomReleasedReplyErrorCode, boolean>> = {
	released_reply_answered: false,
	released_reply_in_flight: true,
};

const BASE_NAME = "IntercomReleasedReplyError";
const ANSWERED_NAME = "ReleasedReplyAnsweredError";
const IN_FLIGHT_NAME = "ReleasedReplyInFlightError";

/**
 * #4386: base of the refusals of a reply to a subagent that was released while it waited on its question, decided by
 * the broker that routes the reply to the subagent's owner.
 */
export class IntercomReleasedReplyError extends Error {
	override readonly name: string = BASE_NAME;
	readonly code: IntercomReleasedReplyErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly messageId: string;
	readonly questionId: string;
	readonly childName: string;

	constructor(
		code: IntercomReleasedReplyErrorCode,
		fields: IntercomReleasedReplyErrorFields,
		options?: { readonly cause?: Error },
	) {
		super(
			`Reply to a released subagent refused: question ${JSON.stringify(fields.questionId)} of ${JSON.stringify(fields.childName)} (${code}). ${HINTS[code]}`,
			options,
		);
		this.code = code;
		this.hint = HINTS[code];
		this.retryable = RETRYABLE[code];
		this.messageId = fields.messageId;
		this.questionId = fields.questionId;
		this.childName = fields.childName;
	}
}

/** Another reply to the question was accepted, or was refused after a handoff that may have been saved. */
export class ReleasedReplyAnsweredError extends IntercomReleasedReplyError {
	override readonly name = ANSWERED_NAME;
	constructor(fields: IntercomReleasedReplyErrorFields, options?: { readonly cause?: Error }) {
		super("released_reply_answered", fields, options);
	}
}

/** Another reply to the question is being handed to the owner; this one may be tried again once that settles. */
export class ReleasedReplyInFlightError extends IntercomReleasedReplyError {
	override readonly name = IN_FLIGHT_NAME;
	constructor(fields: IntercomReleasedReplyErrorFields, options?: { readonly cause?: Error }) {
		super("released_reply_in_flight", fields, options);
	}
}

const NAMES: ReadonlySet<string> = new Set([BASE_NAME, ANSWERED_NAME, IN_FLIGHT_NAME]);

function hasStructure(error: Error, names: ReadonlySet<string>): boolean {
	const code = (error as Error & { readonly code?: string | number }).code;
	return names.has(error.name) && typeof code === "string" && isReleasedReplyErrorCode(code);
}

export function isIntercomReleasedReplyError(error: Error): error is IntercomReleasedReplyError {
	return error instanceof IntercomReleasedReplyError || hasStructure(error, NAMES);
}

const ANSWERED_NAMES: ReadonlySet<string> = new Set([ANSWERED_NAME]);
const IN_FLIGHT_NAMES: ReadonlySet<string> = new Set([IN_FLIGHT_NAME]);

export function isReleasedReplyAnsweredError(error: Error): error is ReleasedReplyAnsweredError {
	return error instanceof ReleasedReplyAnsweredError || hasStructure(error, ANSWERED_NAMES);
}

export function isReleasedReplyInFlightError(error: Error): error is ReleasedReplyInFlightError {
	return error instanceof ReleasedReplyInFlightError || hasStructure(error, IN_FLIGHT_NAMES);
}

const MAX_CAUSE_DEPTH = 4;

/** Whether the error, or one of its first causes, is a released-reply refusal that may be retried. */
export function isRetryableIntercomReleasedReplyError(error: Error): boolean {
	let current: Error | undefined = error;
	for (let depth = 0; current !== undefined && depth <= MAX_CAUSE_DEPTH; depth++) {
		if (isIntercomReleasedReplyError(current) && current.retryable === true) return true;
		current = current.cause instanceof Error ? current.cause : undefined;
	}
	return false;
}

export interface SerializedIntercomReleasedReplyError {
	readonly name: string;
	readonly code: IntercomReleasedReplyErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: IntercomReleasedReplyErrorFields;
	readonly cause?: SerializedErrorCause;
}

export function serializeIntercomReleasedReplyError(error: IntercomReleasedReplyError): SerializedIntercomReleasedReplyError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: { messageId: error.messageId, questionId: error.questionId, childName: error.childName },
		...(error.cause instanceof Error ? { cause: serializeErrorCause(error.cause, 1) } : {}),
	};
}

/** The same class on this side of the boundary; an unknown name keeps its name and code on the family base. */
export function rehydrateIntercomReleasedReplyError(
	serialized: SerializedIntercomReleasedReplyError,
): IntercomReleasedReplyError {
	const options = serialized.cause === undefined ? undefined : { cause: rehydrateErrorCause(serialized.cause, 1) };
	if (serialized.name === ANSWERED_NAME) return new ReleasedReplyAnsweredError(serialized.fields, options);
	if (serialized.name === IN_FLIGHT_NAME) return new ReleasedReplyInFlightError(serialized.fields, options);
	const error = new IntercomReleasedReplyError(serialized.code, serialized.fields, options);
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}

type WireObject = { readonly [key: string]: JsonWireValue };

const isWireObject = (value: JsonWireValue | undefined): value is WireObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function readCause(value: JsonWireValue | undefined, depth: number): SerializedErrorCause | undefined | false {
	if (value === undefined) return undefined;
	if (!isWireObject(value) || typeof value.name !== "string" || typeof value.message !== "string") return false;
	const next = depth < MAX_CAUSE_DEPTH ? readCause(value.cause, depth + 1) : undefined;
	if (next === false) return false;
	return { name: value.name, message: value.message, ...(next === undefined ? {} : { cause: next }) };
}

/** Validate a serialized refusal read off the wire; `undefined` when it is not one. */
export function readSerializedIntercomReleasedReplyError(
	value: JsonWireValue | undefined,
): SerializedIntercomReleasedReplyError | undefined {
	if (!isWireObject(value)) return undefined;
	const { name, code, message, hint, retryable, fields } = value;
	if (typeof name !== "string" || typeof code !== "string" || !isReleasedReplyErrorCode(code)) return undefined;
	if (typeof message !== "string" || typeof hint !== "string" || typeof retryable !== "boolean") return undefined;
	if (!isWireObject(fields)) return undefined;
	const { messageId, questionId, childName } = fields;
	if (typeof messageId !== "string" || typeof questionId !== "string" || typeof childName !== "string") return undefined;
	const cause = readCause(value.cause, 1);
	if (cause === false) return undefined;
	return {
		name,
		code,
		message,
		hint,
		retryable,
		fields: { messageId, questionId, childName },
		...(cause === undefined ? {} : { cause }),
	};
}
