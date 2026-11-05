/** Why a detached tool call operation was refused. Codes are public API: never rename or reuse one. */
export type ToolDetachmentErrorCode =
	| "invalid-policy"
	| "unknown-tool-call"
	| "session-busy"
	| "session-closed"
	| "context-detached"
	| "stage-parked";

/** The largest `afterMs` a detachment policy accepts: timers clamp anything above it to 1 ms. */
export const MAX_TOOL_DETACHMENT_AFTER_MS = 2_147_483_647;

const TOOL_DETACHMENT_ERROR_NAME = "ToolDetachmentError";
const MAX_CAUSE_DEPTH = 8;

const HINTS: Readonly<Record<ToolDetachmentErrorCode, string>> = {
	"invalid-policy": `Pass a policy whose afterMs is a finite number of milliseconds from 0 to ${MAX_TOOL_DETACHMENT_AFTER_MS}, or undefined.`,
	"unknown-tool-call":
		"Hand back only results of the calls takeDetachedToolCalls() or redispatchDetachedToolCalls() returned for this session's transcript.",
	"session-busy": "Wait for the session's current run to settle before resuming its detached turn.",
	"session-closed": "Reopen the session from its store and hand the results to the new session.",
	"context-detached":
		"Read what the tool's work needs from ctx before the call detaches, or pass it in the tool's arguments.",
	"stage-parked":
		"Wait for the workflow stage to reopen its session, then start the task again. A released stage launches no tasks while it waits.",
};

/** JSON-safe facts about a refused detachment operation. */
export interface ToolDetachmentErrorFields {
	readonly sessionId: string;
	/** The policy field that was rejected. */
	readonly field?: "afterMs";
	/** The rejected value, as text. */
	readonly value?: string;
	readonly toolCallId?: string;
}

/** A bounded, credential-free description of a wrapped cause. */
export interface SerializedToolDetachmentErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly cause?: SerializedToolDetachmentErrorCause;
}

/** The serialized form of a {@link ToolDetachmentError}, for crossing a worker or IPC boundary. */
export interface SerializedToolDetachmentError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ToolDetachmentErrorFields;
	readonly cause?: SerializedToolDetachmentErrorCause;
}

/**
 * A detached tool call operation on an `AgentSession` was refused before it changed anything: a detachment
 * policy was invalid, a result was handed back for a call the transcript is not waiting on, the session was
 * still running or already closed, a detached call's work used the session's context after it detached, or a
 * workflow stage released while it waits was asked to launch a task.
 */
export class ToolDetachmentError extends Error {
	override readonly name = TOOL_DETACHMENT_ERROR_NAME;
	readonly code: ToolDetachmentErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ToolDetachmentErrorFields;

	constructor(code: ToolDetachmentErrorCode, fields: ToolDetachmentErrorFields, options?: ErrorOptions) {
		const hint = HINTS[code];
		super(`${toolDetachmentSubject(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = code === "session-busy" || code === "stage-parked";
		this.fields = fields;
	}

	toJSON(): SerializedToolDetachmentError {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: this.fields,
			...(this.cause === undefined ? {} : { cause: serializeCause(this.cause, 0) }),
		};
	}
}

function toolDetachmentSubject(code: ToolDetachmentErrorCode, fields: ToolDetachmentErrorFields): string {
	switch (code) {
		case "invalid-policy":
			return `Invalid tool detachment policy for session ${fields.sessionId}: ${fields.field} is ${fields.value}`;
		case "unknown-tool-call":
			return `Session ${fields.sessionId} is not waiting on tool call ${fields.toolCallId}`;
		case "session-busy":
			return `Session ${fields.sessionId} is still running and cannot resume its detached turn`;
		case "session-closed":
			return `Session ${fields.sessionId} is closed and cannot resume its detached turn`;
		case "context-detached":
			return `Tool call ${fields.toolCallId} detached from session ${fields.sessionId} and can no longer use its context`;
		case "stage-parked":
			return `Workflow stage session ${fields.sessionId} is released and cannot launch a task`;
	}
}

const TOOL_DETACHMENT_ERROR_CODES: ReadonlySet<string> = new Set<ToolDetachmentErrorCode>([
	"invalid-policy",
	"unknown-tool-call",
	"session-busy",
	"session-closed",
	"context-detached",
	"stage-parked",
]);

/** True when `error` is a {@link ToolDetachmentError}, including one from another realm or a structural copy. */
export function isToolDetachmentError(error: unknown): error is ToolDetachmentError {
	if (error instanceof ToolDetachmentError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return (
		candidate.name === TOOL_DETACHMENT_ERROR_NAME &&
		typeof candidate.code === "string" &&
		TOOL_DETACHMENT_ERROR_CODES.has(candidate.code)
	);
}

/** The first {@link ToolDetachmentError} in `error`'s cause chain, at most eight levels deep. */
export function findToolDetachmentError(error: unknown): ToolDetachmentError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isToolDetachmentError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Rebuild a serialized {@link ToolDetachmentError} on this side of a process boundary. An unknown name keeps its
 * `name`, `code` and message on the base class.
 */
export function deserializeToolDetachmentError(serialized: SerializedToolDetachmentError): ToolDetachmentError {
	const error = new ToolDetachmentError(
		serialized.code as ToolDetachmentErrorCode,
		serialized.fields,
		serialized.cause === undefined ? undefined : { cause: deserializeCause(serialized.cause) },
	);
	if (serialized.name !== TOOL_DETACHMENT_ERROR_NAME) Object.defineProperty(error, "name", { value: serialized.name });
	if (!TOOL_DETACHMENT_ERROR_CODES.has(serialized.code)) {
		Object.defineProperties(error, {
			hint: { value: serialized.hint },
			retryable: { value: serialized.retryable },
		});
	}
	if (error.message !== serialized.message) Object.defineProperty(error, "message", { value: serialized.message });
	return error;
}

function serializeCause(cause: unknown, depth: number): SerializedToolDetachmentErrorCause {
	if (!(cause instanceof Error) || depth >= MAX_CAUSE_DEPTH - 1)
		return { name: cause instanceof Error ? cause.name : "Error", message: errorMessage(cause) };
	const code = (cause as { readonly code?: unknown }).code;
	return {
		name: cause.name,
		message: cause.message,
		...(typeof code === "string" ? { code } : {}),
		...(cause.cause === undefined ? {} : { cause: serializeCause(cause.cause, depth + 1) }),
	};
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function deserializeCause(cause: SerializedToolDetachmentErrorCause): Error {
	const error = new Error(
		cause.message,
		cause.cause === undefined ? undefined : { cause: deserializeCause(cause.cause) },
	);
	error.name = cause.name;
	if (cause.code !== undefined) Object.assign(error, { code: cause.code });
	return error;
}
