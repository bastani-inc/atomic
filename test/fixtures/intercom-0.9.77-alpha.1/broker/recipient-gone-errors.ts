import type { JsonWireValue } from "./framing.js";
import { rehydrateErrorCause, type SerializedErrorCause, serializeErrorCause } from "./released-child-errors.js";

/** How a subagent's last run ended, as the session that launched it reports it (#4639). */
export type SubagentEndedOutcome = "completed" | "failed" | "stopped" | "cancelled";

export const SUBAGENT_ENDED_OUTCOMES: readonly SubagentEndedOutcome[] = ["completed", "failed", "stopped", "cancelled"];

/** The subagent ended and its launching session said why. */
export type SubagentRecipientEndedCode =
	| "recipient_completed"
	| "recipient_failed"
	| "recipient_stopped"
	| "recipient_cancelled";

/** The subagent's connection ended and neither it came back nor its launching session said why. */
export type SubagentRecipientDisconnectedCode = "recipient_disconnected";

/** The subagent is released and the session that would wake it is suspended or disconnected. */
export type SubagentRecipientOwnerSuspendedCode = "recipient_owner_suspended";

/** Why a send or ask to a subagent with no live session was refused (#4639). Codes are public API. */
export type IntercomRecipientGoneErrorCode =
	| SubagentRecipientEndedCode
	| SubagentRecipientDisconnectedCode
	| SubagentRecipientOwnerSuspendedCode;

export const INTERCOM_RECIPIENT_GONE_ERROR_CODES: readonly IntercomRecipientGoneErrorCode[] = [
	"recipient_completed",
	"recipient_failed",
	"recipient_stopped",
	"recipient_cancelled",
	"recipient_disconnected",
	"recipient_owner_suspended",
];

const CODES: ReadonlySet<unknown> = new Set(INTERCOM_RECIPIENT_GONE_ERROR_CODES);

export function isIntercomRecipientGoneErrorCode(value: unknown): value is IntercomRecipientGoneErrorCode {
	return CODES.has(value);
}

const ENDED_CODE: Readonly<Record<SubagentEndedOutcome, SubagentRecipientEndedCode>> = {
	completed: "recipient_completed",
	failed: "recipient_failed",
	stopped: "recipient_stopped",
	cancelled: "recipient_cancelled",
};

/** The refusal code of a subagent that ended with `outcome`. */
export function subagentEndedCode(outcome: SubagentEndedOutcome): SubagentRecipientEndedCode {
	return ENDED_CODE[outcome];
}

/** The send's target as it was addressed, and the subagent it named; ids and names only. */
export interface IntercomRecipientGoneErrorFields {
	readonly target: string;
	readonly childName: string;
	/** The `<runId>:<index>` id its launching session resumes it by, when that session reported it. */
	readonly childId?: string;
}

const WHAT: Readonly<Record<IntercomRecipientGoneErrorCode, string>> = {
	recipient_completed: "completed and has no live session",
	recipient_failed: "failed and has no live session",
	recipient_stopped: "was stopped (paused or quit) and has no live session",
	recipient_cancelled: "was cancelled for good and has no live session",
	recipient_disconnected: "disconnected and has not reconnected",
	recipient_owner_suspended: "is released and the session that launched it is suspended or disconnected, so nothing can wake it now",
};

function hintFor(code: IntercomRecipientGoneErrorCode, childId: string | undefined): string {
	if (code === "recipient_cancelled")
		return "It cannot be resumed; launch a fresh subagent if its work is still needed.";
	if (code === "recipient_disconnected")
		return 'Its launching session has not said why; check subagent({ action: "status" }) there, or try again shortly.';
	if (code === "recipient_owner_suspended")
		return "Try again once its launching session is back; to reach that session now, send to its workflow stage target (workflow:<rootRunId>/<stage>), which queues the message until the stage reopens.";
	return `Its launching session can continue it with subagent({ action: "resume", id: ${JSON.stringify(childId ?? "<child-id>")}, message: "<your message>" }).`;
}

const BASE_NAME = "IntercomRecipientGoneError";
const ENDED_NAME = "SubagentRecipientEndedError";
const DISCONNECTED_NAME = "SubagentRecipientDisconnectedError";
const OWNER_SUSPENDED_NAME = "SubagentRecipientOwnerSuspendedError";

/**
 * #4639: base of the refusals of a send or ask to a subagent that has no live session, decided by the broker
 * instead of a bare `Session not found`: it names why the subagent is gone and what to do next.
 */
export class IntercomRecipientGoneError extends Error {
	override readonly name: string = BASE_NAME;
	readonly code: IntercomRecipientGoneErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly target: string;
	readonly childName: string;
	readonly childId?: string;

	constructor(
		code: IntercomRecipientGoneErrorCode,
		fields: IntercomRecipientGoneErrorFields,
		options?: { readonly cause?: Error },
	) {
		const hint = hintFor(code, fields.childId);
		super(`Subagent ${JSON.stringify(fields.childName)} ${WHAT[code]} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = code === "recipient_disconnected" || code === "recipient_owner_suspended";
		this.target = fields.target;
		this.childName = fields.childName;
		this.childId = fields.childId;
	}

	get fields(): IntercomRecipientGoneErrorFields {
		return {
			target: this.target,
			childName: this.childName,
			...(this.childId === undefined ? {} : { childId: this.childId }),
		};
	}
}

/** The subagent's launching session reported it ended: completed, failed, stopped or cancelled. Not retryable. */
export class SubagentRecipientEndedError extends IntercomRecipientGoneError {
	override readonly name = ENDED_NAME;
	declare readonly code: SubagentRecipientEndedCode;
	constructor(
		code: SubagentRecipientEndedCode,
		fields: IntercomRecipientGoneErrorFields,
		options?: { readonly cause?: Error },
	) {
		super(code, fields, options);
	}
}

/** The subagent disconnected and did not come back while the send waited, and nobody said why. Retryable. */
export class SubagentRecipientDisconnectedError extends IntercomRecipientGoneError {
	override readonly name = DISCONNECTED_NAME;
	declare readonly code: SubagentRecipientDisconnectedCode;
	constructor(fields: IntercomRecipientGoneErrorFields, options?: { readonly cause?: Error }) {
		super("recipient_disconnected", fields, options);
	}
}

/**
 * The subagent is released and the session that launched it, which wakes it, is suspended or disconnected: a workflow
 * stage that waits with its session released, for instance. Its sends were held and the hold ended first. Retryable.
 */
export class SubagentRecipientOwnerSuspendedError extends IntercomRecipientGoneError {
	override readonly name = OWNER_SUSPENDED_NAME;
	declare readonly code: SubagentRecipientOwnerSuspendedCode;
	constructor(fields: IntercomRecipientGoneErrorFields, options?: { readonly cause?: Error }) {
		super("recipient_owner_suspended", fields, options);
	}
}

const NAMES: ReadonlySet<string> = new Set([BASE_NAME, ENDED_NAME, DISCONNECTED_NAME, OWNER_SUSPENDED_NAME]);
const ENDED_NAMES: ReadonlySet<string> = new Set([ENDED_NAME]);
const DISCONNECTED_NAMES: ReadonlySet<string> = new Set([DISCONNECTED_NAME]);
const OWNER_SUSPENDED_NAMES: ReadonlySet<string> = new Set([OWNER_SUSPENDED_NAME]);

function hasStructure(error: Error, names: ReadonlySet<string>): boolean {
	return names.has(error.name) && isIntercomRecipientGoneErrorCode((error as Error & { readonly code?: unknown }).code);
}

export function isIntercomRecipientGoneError(error: Error): error is IntercomRecipientGoneError {
	return error instanceof IntercomRecipientGoneError || hasStructure(error, NAMES);
}

export function isSubagentRecipientEndedError(error: Error): error is SubagentRecipientEndedError {
	return error instanceof SubagentRecipientEndedError || hasStructure(error, ENDED_NAMES);
}

export function isSubagentRecipientDisconnectedError(error: Error): error is SubagentRecipientDisconnectedError {
	return error instanceof SubagentRecipientDisconnectedError || hasStructure(error, DISCONNECTED_NAMES);
}

export function isSubagentRecipientOwnerSuspendedError(error: Error): error is SubagentRecipientOwnerSuspendedError {
	return error instanceof SubagentRecipientOwnerSuspendedError || hasStructure(error, OWNER_SUSPENDED_NAMES);
}

const MAX_CAUSE_DEPTH = 4;

/** Whether the error, or one of its first causes, is a gone-recipient refusal that may be retried. */
export function isRetryableIntercomRecipientGoneError(error: Error): boolean {
	let current: Error | undefined = error;
	for (let depth = 0; current !== undefined && depth <= MAX_CAUSE_DEPTH; depth++) {
		if (isIntercomRecipientGoneError(current) && current.retryable) return true;
		current = current.cause instanceof Error ? current.cause : undefined;
	}
	return false;
}

/** The refusal for a send addressed as `target` to a subagent that ended with `outcome`. */
export function subagentRecipientEnded(
	outcome: SubagentEndedOutcome,
	fields: IntercomRecipientGoneErrorFields,
): SubagentRecipientEndedError {
	return new SubagentRecipientEndedError(subagentEndedCode(outcome), fields);
}

export interface SerializedIntercomRecipientGoneError {
	readonly name: string;
	readonly code: IntercomRecipientGoneErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: IntercomRecipientGoneErrorFields;
	readonly cause?: SerializedErrorCause;
}

export function serializeIntercomRecipientGoneError(
	error: IntercomRecipientGoneError,
): SerializedIntercomRecipientGoneError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(error.cause instanceof Error ? { cause: serializeErrorCause(error.cause, 1) } : {}),
	};
}

/** The same class on this side of the boundary; an unknown name keeps its name and code on the family base. */
export function rehydrateIntercomRecipientGoneError(
	serialized: SerializedIntercomRecipientGoneError,
): IntercomRecipientGoneError {
	const options = serialized.cause === undefined ? undefined : { cause: rehydrateErrorCause(serialized.cause, 1) };
	const { code, fields } = serialized;
	if (serialized.name === ENDED_NAME && code !== "recipient_disconnected" && code !== "recipient_owner_suspended")
		return new SubagentRecipientEndedError(code, fields, options);
	if (serialized.name === DISCONNECTED_NAME && code === "recipient_disconnected")
		return new SubagentRecipientDisconnectedError(fields, options);
	if (serialized.name === OWNER_SUSPENDED_NAME && code === "recipient_owner_suspended")
		return new SubagentRecipientOwnerSuspendedError(fields, options);
	const error = new IntercomRecipientGoneError(code, fields, options);
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}

type WireObject = { readonly [key: string]: JsonWireValue };

const isWireObject = (value: JsonWireValue | undefined): value is WireObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readCause(value: JsonWireValue | undefined, depth: number): SerializedErrorCause | undefined | false {
	if (value === undefined) return undefined;
	if (!isWireObject(value) || typeof value.name !== "string" || typeof value.message !== "string") return false;
	const next = depth < MAX_CAUSE_DEPTH ? readCause(value.cause, depth + 1) : undefined;
	if (next === false) return false;
	return { name: value.name, message: value.message, ...(next === undefined ? {} : { cause: next }) };
}

/** Validate a serialized refusal read off the wire; `undefined` when it is not one. */
export function readSerializedIntercomRecipientGoneError(
	value: JsonWireValue | undefined,
): SerializedIntercomRecipientGoneError | undefined {
	if (!isWireObject(value)) return undefined;
	const { name, code, message, hint, retryable, fields } = value;
	if (typeof name !== "string" || !isIntercomRecipientGoneErrorCode(code)) return undefined;
	if (typeof message !== "string" || typeof hint !== "string" || typeof retryable !== "boolean") return undefined;
	if (!isWireObject(fields)) return undefined;
	const { target, childName, childId } = fields;
	if (typeof target !== "string" || typeof childName !== "string") return undefined;
	if (childId !== undefined && typeof childId !== "string") return undefined;
	const cause = readCause(value.cause, 1);
	if (cause === false) return undefined;
	return {
		name,
		code,
		message,
		hint,
		retryable,
		fields: { target, childName, ...(childId === undefined ? {} : { childId }) },
		...(cause === undefined ? {} : { cause }),
	};
}
