/** Typed failures of event subscriptions (`ctx.subscribe`, `ctx.events`, `session.subscribe`, event sources). */

export type SubscriptionErrorCode =
	| "subscription-closed"
	| "invalid-option"
	| "invalid-event"
	| "source-failed"
	| "handler-failed"
	| "child-unavailable";

export type SubscriptionErrorName =
	| "SubscriptionError"
	| "SubscriptionClosedError"
	| "SubscriptionConfigError"
	| "SubscriptionEventError"
	| "EventSourceError"
	| "SubscriptionHandlerError"
	| "SubscriptionChildUnavailableError";

export type SubscriptionErrorFieldValue = string | number | boolean | null;
export type SubscriptionErrorFields = Readonly<Record<string, SubscriptionErrorFieldValue>>;

/** Wire form of a subscription error, for crossing worker, coordinator or IPC boundaries. */
export interface SerializedSubscriptionError {
	readonly name: string;
	readonly code: SubscriptionErrorCode;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields: SubscriptionErrorFields;
	readonly cause?: SerializedSubscriptionErrorCause;
}

export interface SerializedSubscriptionErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly cause?: SerializedSubscriptionErrorCause;
}

const MAX_CAUSE_DEPTH = 8;

function failureMessage(what: string, subject: string, code: SubscriptionErrorCode, hint: string): string {
	return `${what}: ${subject} (${code}). ${hint}`;
}

/** Base of every subscription failure. Catch this to handle the whole family. */
export class SubscriptionError extends Error {
	override readonly name: SubscriptionErrorName = "SubscriptionError";
	readonly code: SubscriptionErrorCode;
	readonly hint: string | undefined;
	readonly retryable: boolean;

	constructor(
		code: SubscriptionErrorCode,
		message: string,
		options?: { readonly hint?: string | undefined; readonly retryable?: boolean; readonly cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.code = code;
		this.hint = options?.hint;
		this.retryable = options?.retryable ?? false;
	}

	/** JSON-safe context fields; subclasses add their own. */
	fields(): SubscriptionErrorFields {
		return {};
	}
}

export type SubscriptionClosedOperation = "publish" | "emit" | "report";

/** An event or report was sent to a subscription that is closed, or not open in this process. */
export class SubscriptionClosedError extends SubscriptionError {
	override readonly name = "SubscriptionClosedError" as const;
	declare readonly code: "subscription-closed";
	readonly subscriptionId: string;
	readonly operation: SubscriptionClosedOperation;

	constructor(subscriptionId: string, operation: SubscriptionClosedOperation, options?: { readonly cause?: unknown }) {
		const hint = "Use the id of an open subscription; a closed subscription accepts no events or reports.";
		super(
			"subscription-closed",
			failureMessage("Subscription is closed", subscriptionId, "subscription-closed", hint),
			{
				hint,
				...(options?.cause === undefined ? {} : { cause: options.cause }),
			},
		);
		this.subscriptionId = subscriptionId;
		this.operation = operation;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, operation: this.operation };
	}
}

export type SubscriptionConfigReason =
	| "duplicate-id"
	| "not-event-source"
	| "not-function"
	| "not-positive-integer"
	| "not-stage"
	| "not-string";

/** A subscription option is invalid. Thrown before the subscription opens or anything is recorded. */
export class SubscriptionConfigError extends SubscriptionError {
	override readonly name = "SubscriptionConfigError" as const;
	declare readonly code: "invalid-option";
	readonly source: "sdk";
	readonly field: string;
	readonly reason: SubscriptionConfigReason;

	constructor(field: string, reason: SubscriptionConfigReason) {
		const expected: Record<SubscriptionConfigReason, string> = {
			"duplicate-id": "a value that no other open subscription in this process uses",
			"not-event-source": "an EventSource with a string id and a start(signal, emit) function",
			"not-function": "a function",
			"not-positive-integer": "a positive integer",
			"not-stage": "a stage returned by ctx.stage()",
			"not-string": "a non-empty string",
		};
		const hint = `Pass ${expected[reason]} for ${field}.`;
		super("invalid-option", failureMessage("Invalid subscription option", field, "invalid-option", hint), { hint });
		this.source = "sdk";
		this.field = field;
		this.reason = reason;
	}

	override fields(): SubscriptionErrorFields {
		return { source: this.source, field: this.field, reason: this.reason };
	}
}

export type SubscriptionEventReason = "not-object" | "missing-id";

/** A source or publisher emitted something that is not an event with a string `id`. */
export class SubscriptionEventError extends SubscriptionError {
	override readonly name = "SubscriptionEventError" as const;
	declare readonly code: "invalid-event";
	readonly subscriptionId: string;
	readonly reason: SubscriptionEventReason;

	constructor(subscriptionId: string, reason: SubscriptionEventReason) {
		const hint =
			"Emit objects shaped { id: string, type?: string, payload?: JSON value }; the id drives deduplication.";
		super("invalid-event", failureMessage("Invalid subscription event", subscriptionId, "invalid-event", hint), {
			hint,
		});
		this.subscriptionId = subscriptionId;
		this.reason = reason;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, reason: this.reason };
	}
}

export type EventSourcePhase = "start" | "listen" | "poll" | "read";

/** An event source failed. `detail` is a short, credential-free description of the underlying failure. */
export class EventSourceError extends SubscriptionError {
	override readonly name = "EventSourceError" as const;
	declare readonly code: "source-failed";
	readonly sourceId: string;
	readonly phase: EventSourcePhase;
	readonly detail: string | undefined;

	constructor(
		sourceId: string,
		phase: EventSourcePhase,
		options?: { readonly cause?: unknown; readonly detail?: string; readonly retryable?: boolean },
	) {
		const hint =
			phase === "listen"
				? "Choose a free port or hostname for the webhook source, then subscribe again."
				: "Check the source's configuration and access (for GitHub sources, `gh auth status`), then subscribe again.";
		super(
			"source-failed",
			failureMessage(
				`Event source failed during ${phase}${options?.detail === undefined ? "" : ` (${options.detail})`}`,
				sourceId,
				"source-failed",
				hint,
			),
			{
				hint,
				retryable: options?.retryable ?? false,
				...(options?.cause === undefined ? {} : { cause: options.cause }),
			},
		);
		this.sourceId = sourceId;
		this.phase = phase;
		this.detail = options?.detail;
	}

	override fields(): SubscriptionErrorFields {
		return { sourceId: this.sourceId, phase: this.phase, detail: this.detail ?? null };
	}
}

/** The handler for one event failed; the subscription stops and its `done` promise rejects with this error. */
export class SubscriptionHandlerError extends SubscriptionError {
	override readonly name = "SubscriptionHandlerError" as const;
	declare readonly code: "handler-failed";
	readonly subscriptionId: string;
	readonly eventId: string;

	constructor(subscriptionId: string, eventId: string, cause: unknown) {
		const hint = "Inspect the cause, fix the handler, then subscribe again; events already handled are not repeated.";
		super(
			"handler-failed",
			failureMessage(`Event handler failed for event ${eventId}`, subscriptionId, "handler-failed", hint),
			{ hint, cause },
		);
		this.subscriptionId = subscriptionId;
		this.eventId = eventId;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, eventId: this.eventId };
	}
}

/** A session-level event child needs a child session, but this session cannot create one. */
export class SubscriptionChildUnavailableError extends SubscriptionError {
	override readonly name = "SubscriptionChildUnavailableError" as const;
	declare readonly code: "child-unavailable";
	readonly subscriptionId: string;
	readonly sessionId: string;

	constructor(subscriptionId: string, sessionId: string) {
		const hint = "Create the session with createAgentSession() so it can start child sessions, or report directly.";
		super(
			"child-unavailable",
			failureMessage("Event child session unavailable", subscriptionId, "child-unavailable", hint),
			{ hint },
		);
		this.subscriptionId = subscriptionId;
		this.sessionId = sessionId;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, sessionId: this.sessionId };
	}
}

const CODE_BY_NAME: Readonly<Record<string, SubscriptionErrorCode>> = {
	SubscriptionClosedError: "subscription-closed",
	SubscriptionConfigError: "invalid-option",
	SubscriptionEventError: "invalid-event",
	EventSourceError: "source-failed",
	SubscriptionHandlerError: "handler-failed",
	SubscriptionChildUnavailableError: "child-unavailable",
};

const SUBSCRIPTION_ERROR_CODES: ReadonlySet<string> = new Set<SubscriptionErrorCode>(Object.values(CODE_BY_NAME));

interface StructuralError {
	readonly name?: unknown;
	readonly code?: unknown;
	readonly cause?: unknown;
}

/** Reads `name`, `code` and `cause` from any value; primitives have none. */
function structural(value: unknown): StructuralError {
	return Object(value) as StructuralError;
}

function findInCauseChain<T>(error: unknown, matches: (value: unknown) => value is T): T | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (matches(current)) return current;
		current = structural(current).cause;
	}
	return undefined;
}

function guard<T extends SubscriptionError>(
	ctor: abstract new (...args: never[]) => T,
	name: SubscriptionErrorName,
): (error: unknown) => error is T {
	const matches = (value: unknown): value is T =>
		value instanceof ctor || (structural(value).name === name && structural(value).code === CODE_BY_NAME[name]);
	return (error: unknown): error is T => findInCauseChain(error, matches) !== undefined;
}

function isFamilyMember(value: unknown): value is SubscriptionError {
	if (value instanceof SubscriptionError) return true;
	const { name, code } = structural(value);
	const knownName = name === "SubscriptionError" || Object.hasOwn(CODE_BY_NAME, String(name));
	return knownName && SUBSCRIPTION_ERROR_CODES.has(String(code));
}

/** True when the error, or anything in its cause chain, belongs to the subscription error family. */
export function isSubscriptionError(error: unknown): error is SubscriptionError {
	return findInCauseChain(error, isFamilyMember) !== undefined;
}

export const isSubscriptionClosedError = guard(SubscriptionClosedError, "SubscriptionClosedError");
export const isSubscriptionConfigError = guard(SubscriptionConfigError, "SubscriptionConfigError");
export const isSubscriptionEventError = guard(SubscriptionEventError, "SubscriptionEventError");
export const isEventSourceError = guard(EventSourceError, "EventSourceError");
export const isSubscriptionHandlerError = guard(SubscriptionHandlerError, "SubscriptionHandlerError");
export const isSubscriptionChildUnavailableError = guard(
	SubscriptionChildUnavailableError,
	"SubscriptionChildUnavailableError",
);

/** First subscription error in the cause chain, if any. */
export function findSubscriptionError(error: unknown): SubscriptionError | undefined {
	return findInCauseChain(error, isFamilyMember);
}

/** True when the first subscription error in the cause chain says the operation may be retried. */
export function isRetryableSubscriptionError(error: unknown): boolean {
	return findSubscriptionError(error)?.retryable === true;
}

function serializeCause(cause: unknown, depth: number): SerializedSubscriptionErrorCause | undefined {
	if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return undefined;
	const candidate = structural(cause);
	const name = typeof candidate.name === "string" ? candidate.name : typeof cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	const code = typeof candidate.code === "string" ? candidate.code : undefined;
	const nested = serializeCause(candidate.cause, depth + 1);
	return {
		name,
		message,
		...(code === undefined ? {} : { code }),
		...(nested === undefined ? {} : { cause: nested }),
	};
}

/** Wire form for crossing a process boundary; the cause chain is kept to a bounded depth. */
export function serializeSubscriptionError(error: SubscriptionError): SerializedSubscriptionError {
	const cause = serializeCause(error.cause, 0);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
		retryable: error.retryable,
		fields: error.fields(),
		...(cause === undefined ? {} : { cause }),
	};
}

function rehydrateCause(cause: SerializedSubscriptionErrorCause | undefined): Error | undefined {
	if (cause === undefined) return undefined;
	const error = new Error(cause.message, { cause: rehydrateCause(cause.cause) });
	Object.defineProperty(error, "name", { value: cause.name });
	if (cause.code !== undefined) Object.defineProperty(error, "code", { value: cause.code, enumerable: true });
	return error;
}

function stringField(fields: SubscriptionErrorFields, key: string): string {
	const value = fields[key];
	return typeof value === "string" ? value : "";
}

/** Rebuild a serialized subscription error as its own class; unknown names become the family base. */
export function deserializeSubscriptionError(serialized: SerializedSubscriptionError): SubscriptionError {
	const cause = rehydrateCause(serialized.cause);
	const fields = serialized.fields;
	const rebuilt = ((): SubscriptionError => {
		switch (serialized.name) {
			case "SubscriptionClosedError":
				return new SubscriptionClosedError(
					stringField(fields, "subscriptionId"),
					stringField(fields, "operation") as SubscriptionClosedOperation,
					{ cause },
				);
			case "SubscriptionConfigError":
				return new SubscriptionConfigError(
					stringField(fields, "field"),
					stringField(fields, "reason") as SubscriptionConfigReason,
				);
			case "SubscriptionEventError":
				return new SubscriptionEventError(
					stringField(fields, "subscriptionId"),
					stringField(fields, "reason") as SubscriptionEventReason,
				);
			case "EventSourceError": {
				const detail = fields.detail;
				return new EventSourceError(
					stringField(fields, "sourceId"),
					stringField(fields, "phase") as EventSourcePhase,
					{
						cause,
						retryable: serialized.retryable,
						...(typeof detail === "string" ? { detail } : {}),
					},
				);
			}
			case "SubscriptionHandlerError":
				return new SubscriptionHandlerError(
					stringField(fields, "subscriptionId"),
					stringField(fields, "eventId"),
					cause,
				);
			case "SubscriptionChildUnavailableError":
				return new SubscriptionChildUnavailableError(
					stringField(fields, "subscriptionId"),
					stringField(fields, "sessionId"),
				);
			default: {
				const base = new SubscriptionError(serialized.code, serialized.message, {
					retryable: serialized.retryable,
					hint: serialized.hint,
					cause,
				});
				Object.defineProperty(base, "name", { value: serialized.name });
				return base;
			}
		}
	})();
	if (rebuilt.cause === undefined && cause !== undefined) Object.defineProperty(rebuilt, "cause", { value: cause });
	return rebuilt;
}
