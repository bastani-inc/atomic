import type { HostedSessionRefusal, HostedSessionRefusalCode } from "../types.js";
import type { JsonWireValue } from "./framing.js";
import { isWireObject } from "./hosted-sessions.js";
import { rehydrateErrorCause, type SerializedErrorCause, serializeErrorCause } from "./released-child-errors.js";
import { readCause } from "./released-reply-errors.js";

export type IntercomHostedSessionErrorCode = HostedSessionRefusalCode;

export const HOSTED_SESSION_ERROR_CODES: readonly IntercomHostedSessionErrorCode[] = [
	"invalid_hosted_frame",
	"invalid_hosted_session",
	"not_hosted_by_connection",
];

const CODES: ReadonlySet<string> = new Set(HOSTED_SESSION_ERROR_CODES);

export function isHostedSessionErrorCode(value: string): value is IntercomHostedSessionErrorCode {
	return CODES.has(value);
}

/** The item a refusal names: the host's key for a session being hosted, or the broker id of a hosted session. */
export interface IntercomHostedSessionErrorFields {
	readonly key?: string;
	readonly sessionId?: string;
}

const HINTS: Readonly<Record<IntercomHostedSessionErrorCode, string>> = {
	invalid_hosted_frame:
		"Send between 1 and 500 sessions per frame, each under a distinct non-empty key, or 1 to 500 session ids to remove.",
	invalid_hosted_session:
		"Give each hosted session a non-empty name and a valid agent registration (cwd, model, pid and timestamps).",
	not_hosted_by_connection:
		"Only the connection that hosts a session may send as it or remove it; host the session again after a reconnect.",
};

const BASE_NAME = "IntercomHostedSessionError";
const REQUEST_NAME = "HostedSessionRequestError";
const NOT_HOSTED_NAME = "NotHostedSessionError";

/** #4642: base of the broker's refusals of hosted-session requests. None is retryable as sent. */
export class IntercomHostedSessionError extends Error {
	override readonly name: string = BASE_NAME;
	readonly code: IntercomHostedSessionErrorCode;
	readonly hint: string;
	readonly retryable = false;
	readonly key?: string;
	readonly sessionId?: string;

	constructor(
		code: IntercomHostedSessionErrorCode,
		fields: IntercomHostedSessionErrorFields = {},
		options?: { readonly cause?: Error },
	) {
		const subject =
			fields.key !== undefined
				? `hosted session ${JSON.stringify(fields.key)}`
				: fields.sessionId !== undefined
					? `session ${JSON.stringify(fields.sessionId)}`
					: "request";
		super(`Hosted-session request refused: ${subject} (${code}). ${HINTS[code]}`, options);
		this.code = code;
		this.hint = HINTS[code];
		if (fields.key !== undefined) this.key = fields.key;
		if (fields.sessionId !== undefined) this.sessionId = fields.sessionId;
	}
}

/** A `host_sessions` or `unhost_sessions` frame, or one of its items, is malformed; nothing in it took effect. */
export class HostedSessionRequestError extends IntercomHostedSessionError {
	override readonly name = REQUEST_NAME;
}

/** The session named to send as, or to remove, is not hosted by this connection. */
export class NotHostedSessionError extends IntercomHostedSessionError {
	override readonly name = NOT_HOSTED_NAME;
	constructor(fields: IntercomHostedSessionErrorFields, options?: { readonly cause?: Error }) {
		super("not_hosted_by_connection", fields, options);
	}
}

const NAMES: ReadonlySet<string> = new Set([BASE_NAME, REQUEST_NAME, NOT_HOSTED_NAME]);
const REQUEST_NAMES: ReadonlySet<string> = new Set([REQUEST_NAME]);
const NOT_HOSTED_NAMES: ReadonlySet<string> = new Set([NOT_HOSTED_NAME]);

function hasStructure(error: Error, names: ReadonlySet<string>): boolean {
	const code = (error as Error & { readonly code?: string | number }).code;
	return names.has(error.name) && typeof code === "string" && isHostedSessionErrorCode(code);
}

export function isIntercomHostedSessionError(error: Error): error is IntercomHostedSessionError {
	return error instanceof IntercomHostedSessionError || hasStructure(error, NAMES);
}

export function isHostedSessionRequestError(error: Error): error is HostedSessionRequestError {
	return error instanceof HostedSessionRequestError || hasStructure(error, REQUEST_NAMES);
}

export function isNotHostedSessionError(error: Error): error is NotHostedSessionError {
	return error instanceof NotHostedSessionError || hasStructure(error, NOT_HOSTED_NAMES);
}

function fieldsOf(refusal: HostedSessionRefusal | IntercomHostedSessionErrorFields): IntercomHostedSessionErrorFields {
	return {
		...(refusal.key === undefined ? {} : { key: refusal.key }),
		...(refusal.sessionId === undefined ? {} : { sessionId: refusal.sessionId }),
	};
}

/** The typed error of a refusal read off the wire. */
export function hostedSessionErrorFor(
	refusal: HostedSessionRefusal,
	options?: { readonly cause?: Error },
): IntercomHostedSessionError {
	return refusal.code === "not_hosted_by_connection"
		? new NotHostedSessionError(fieldsOf(refusal), options)
		: new HostedSessionRequestError(refusal.code, fieldsOf(refusal), options);
}

export interface SerializedIntercomHostedSessionError {
	readonly name: string;
	readonly code: IntercomHostedSessionErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: false;
	readonly fields: IntercomHostedSessionErrorFields;
	readonly cause?: SerializedErrorCause;
}

export function serializeIntercomHostedSessionError(
	error: IntercomHostedSessionError,
): SerializedIntercomHostedSessionError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: false,
		fields: fieldsOf(error),
		...(error.cause instanceof Error ? { cause: serializeErrorCause(error.cause, 1) } : {}),
	};
}

/** The same class on this side of the boundary; an unknown name keeps its name and code on the family base. */
export function rehydrateIntercomHostedSessionError(
	serialized: SerializedIntercomHostedSessionError,
): IntercomHostedSessionError {
	const options = serialized.cause === undefined ? undefined : { cause: rehydrateErrorCause(serialized.cause, 1) };
	if (serialized.name === NOT_HOSTED_NAME) return new NotHostedSessionError(serialized.fields, options);
	if (serialized.name === REQUEST_NAME)
		return new HostedSessionRequestError(serialized.code, serialized.fields, options);
	const error = new IntercomHostedSessionError(serialized.code, serialized.fields, options);
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}

/** Validate a refusal read off the wire; `undefined` when it is not one. */
export function readHostedSessionRefusal(value: JsonWireValue | undefined): HostedSessionRefusal | undefined {
	if (!isWireObject(value)) return undefined;
	const { code, key, sessionId } = value;
	if (typeof code !== "string" || !isHostedSessionErrorCode(code)) return undefined;
	if ((key !== undefined && typeof key !== "string") || (sessionId !== undefined && typeof sessionId !== "string")) {
		return undefined;
	}
	return { code, ...(key === undefined ? {} : { key }), ...(sessionId === undefined ? {} : { sessionId }) };
}

/** Validate a serialized hosted-session error read off the wire; `undefined` when it is not one. */
export function readSerializedIntercomHostedSessionError(
	value: JsonWireValue | undefined,
): SerializedIntercomHostedSessionError | undefined {
	if (!isWireObject(value)) return undefined;
	const { name, code, message, hint, retryable, fields } = value;
	if (typeof name !== "string" || typeof code !== "string" || !isHostedSessionErrorCode(code)) return undefined;
	if (typeof message !== "string" || typeof hint !== "string" || retryable !== false) return undefined;
	const refusal = isWireObject(fields) ? readHostedSessionRefusal({ ...fields, code }) : undefined;
	if (refusal === undefined) return undefined;
	const cause = readCause(value.cause, 1);
	if (cause === false) return undefined;
	return {
		name,
		code,
		message,
		hint,
		retryable: false,
		fields: fieldsOf(refusal),
		...(cause === undefined ? {} : { cause }),
	};
}
