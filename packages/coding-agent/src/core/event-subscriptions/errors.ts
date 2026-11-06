/** Typed failures of event subscriptions (`ctx.subscribe`, `ctx.events`, `session.subscribe`, event sources). */

import { StorageUnavailableError } from "../storage/errors.js";

export type SubscriptionErrorCode =
	| "subscription-closed"
	| "invalid-option"
	| "invalid-event"
	| "source-failed"
	| "handler-failed"
	| "child-unavailable"
	| "setup-missing"
	| "subscriber-unavailable"
	| "record-failed"
	| "timeout";

export type SubscriptionErrorName =
	| "SubscriptionError"
	| "SubscriptionClosedError"
	| "SubscriptionConfigError"
	| "SubscriptionEventError"
	| "EventSourceError"
	| "SubscriptionHandlerError"
	| "SubscriptionChildUnavailableError"
	| "SubscriptionSetupError"
	| "SubscriptionSubscriberUnavailableError"
	| "SubscriptionRecordError"
	| "SubscriptionTimeoutError";

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

export type SubscriptionClosedOperation = "publish" | "emit" | "report" | "subscribe";

/** An event or report was sent to a subscription that is closed or not open in this process, or `session.subscribe` ran on a closed session. */
export class SubscriptionClosedError extends SubscriptionError {
	override readonly name = "SubscriptionClosedError" as const;
	declare readonly code: "subscription-closed";
	readonly subscriptionId: string;
	readonly operation: SubscriptionClosedOperation;

	constructor(subscriptionId: string, operation: SubscriptionClosedOperation, options?: { readonly cause?: unknown }) {
		const hint =
			operation === "subscribe"
				? "Subscribe while the session is open; a closed session accepts no subscriptions."
				: "Use the id of an open subscription; a closed subscription accepts no events or reports.";
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
	| "duplicate-path"
	| "not-absolute-path"
	| "not-event-source"
	| "not-function"
	| "not-owner-repo"
	| "not-plain-path"
	| "not-positive-integer"
	| "not-stage"
	| "not-string"
	| "out-of-range";

const EXPECTED_BY_REASON: Readonly<Record<SubscriptionConfigReason, string>> = {
	"duplicate-id": "a value that no other open subscription in this process uses",
	"duplicate-path": "a path that no other open webhook source on this host and port uses",
	"not-absolute-path": "a path that starts with /, for example /hooks/ci",
	"not-event-source": "an EventSource with a string id and a start(signal, emit) function",
	"not-function": "a function",
	"not-owner-repo": "a repository as owner/name, for example acme/widgets",
	"not-plain-path": "a path without a query string or fragment, for example /hooks/ci",
	"not-positive-integer": "a positive integer",
	"not-stage": "a stage returned by ctx.stage()",
	"not-string": "a non-empty string",
	"out-of-range": "a value inside the allowed range",
};

/** A subscription option is invalid. Thrown before the subscription opens or anything is recorded. */
export class SubscriptionConfigError extends SubscriptionError {
	override readonly name = "SubscriptionConfigError" as const;
	declare readonly code: "invalid-option";
	readonly source: "sdk";
	readonly field: string;
	readonly reason: SubscriptionConfigReason;
	/** What a valid value looks like, for example `an integer from 0 to 65535`. */
	readonly expected: string;

	constructor(field: string, reason: SubscriptionConfigReason, expected: string = EXPECTED_BY_REASON[reason]) {
		const hint = `Pass ${expected} for ${field}.`;
		super("invalid-option", failureMessage("Invalid subscription option", field, "invalid-option", hint), { hint });
		this.source = "sdk";
		this.field = field;
		this.reason = reason;
		this.expected = expected;
	}

	override fields(): SubscriptionErrorFields {
		return { source: this.source, field: this.field, reason: this.reason, expected: this.expected };
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

export type EventSourcePhase = "start" | "listen" | "poll" | "read" | "request";

/**
 * How to continue after a subscription stopped. Dedupe follows the durable record of one subscription, which a resume
 * or a reopened session finds again; a new subscription in the same run or session starts with no processed events.
 */
export const CONTINUE_AFTER_FAILURE =
	"resume the run or reopen the session, which skips events already recorded as processed; subscribing again in the same run or session handles every event again";

const DEFAULT_SOURCE_HINT: Readonly<Record<EventSourcePhase, string>> = {
	start: `Check the source's configuration and access, then ${CONTINUE_AFTER_FAILURE}.`,
	listen: `Choose a free port or hostname for the webhook source, then ${CONTINUE_AFTER_FAILURE}.`,
	poll: `Check the source's configuration and access, then ${CONTINUE_AFTER_FAILURE}.`,
	read: `Check the source's configuration and access, then ${CONTINUE_AFTER_FAILURE}.`,
	request: "Inspect the cause; the sender can send the delivery again.",
};

/**
 * An event source failed. `detail` is a short, credential-free description of the underlying failure. `hint`
 * overrides the default for the phase when the source knows the fix for its own failure.
 */
export class EventSourceError extends SubscriptionError {
	override readonly name = "EventSourceError" as const;
	declare readonly code: "source-failed";
	readonly sourceId: string;
	readonly phase: EventSourcePhase;
	readonly detail: string | undefined;

	constructor(
		sourceId: string,
		phase: EventSourcePhase,
		options?: {
			readonly cause?: unknown;
			readonly detail?: string;
			readonly retryable?: boolean;
			readonly hint?: string;
		},
	) {
		const hint = options?.hint ?? DEFAULT_SOURCE_HINT[phase];
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
		const hint = `Inspect the cause and fix the handler, then ${CONTINUE_AFTER_FAILURE}.`;
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

export type SubscriptionSetupMissing = "gh-cli" | "gh-auth";

const SETUP_SUBJECT: Readonly<Record<SubscriptionSetupMissing, string>> = {
	"gh-cli": "the GitHub CLI (gh) that githubChecks and githubReviews run",
	"gh-auth": "a GitHub login for gh",
};

const SETUP_HINT: Readonly<Record<SubscriptionSetupMissing, string>> = {
	"gh-cli":
		"Install the GitHub CLI from https://cli.github.com (for example `brew install gh` or `winget install GitHub.cli`), then run `gh auth login`.",
	"gh-auth": "Run `gh auth login`, then subscribe again.",
};

/** A source needs something that is not set up on this machine. Retrying cannot help until the setup is done. */
export class SubscriptionSetupError extends SubscriptionError {
	override readonly name = "SubscriptionSetupError" as const;
	declare readonly code: "setup-missing";
	readonly missing: SubscriptionSetupMissing;

	constructor(missing: SubscriptionSetupMissing, options?: { readonly cause?: unknown }) {
		const hint = SETUP_HINT[missing];
		super(
			"setup-missing",
			failureMessage("Subscription setup is missing", SETUP_SUBJECT[missing], "setup-missing", hint),
			{ hint, ...(options?.cause === undefined ? {} : { cause: options.cause }) },
		);
		this.missing = missing;
	}

	override fields(): SubscriptionErrorFields {
		return { missing: this.missing };
	}
}

export type SubscriberUnavailableReason =
	| "no-adapter"
	| "not-terminal"
	| "no-session"
	| "invalid-session"
	| "closed"
	| "no-message-admission";

const SUBSCRIBER_UNAVAILABLE_HINT: Readonly<Record<SubscriberUnavailableReason, string>> = {
	"no-adapter":
		"The workflow host cannot start sessions here, so the replayed subscriber's session cannot be reopened; run the workflow from Atomic, or subscribe from a stage that runs in this run.",
	"not-terminal":
		"The subscriber stage did not complete, so its session cannot be reopened for reports; subscribe from a stage that completes, or start the run again instead of resuming it.",
	"no-session":
		"The subscriber stage kept no agent session to reopen; subscribe from a stage that runs an agent session in this run.",
	"invalid-session":
		"The subscriber's retained session could not be reopened from the session store; make the store that ran the stage available, or start the run again instead of resuming it.",
	closed: "The run is closing, so reports can no longer be delivered; resume the run to continue.",
	"no-message-admission":
		"The subscriber's stage chat cannot take messages; close whatever holds that chat, or subscribe from a stage that runs in this run.",
};

/** A report could not reach its subscriber stage, because that stage was replayed from a checkpoint after a resume. */
export class SubscriptionSubscriberUnavailableError extends SubscriptionError {
	override readonly name = "SubscriptionSubscriberUnavailableError" as const;
	declare readonly code: "subscriber-unavailable";
	readonly subscriptionId: string;
	readonly subscriber: string;
	/** Why the subscriber's retained session could not take the report. */
	readonly reason: SubscriberUnavailableReason;

	constructor(subscriptionId: string, subscriber: string, reason: SubscriberUnavailableReason) {
		const hint = SUBSCRIBER_UNAVAILABLE_HINT[reason];
		super(
			"subscriber-unavailable",
			failureMessage(
				`Subscriber stage "${subscriber}" cannot take reports (${reason})`,
				subscriptionId,
				"subscriber-unavailable",
				hint,
			),
			{ hint },
		);
		this.subscriptionId = subscriptionId;
		this.subscriber = subscriber;
		this.reason = reason;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, subscriber: this.subscriber, reason: this.reason };
	}
}

export type SubscriptionRecordKind = "subscription" | "processed-event";

const RECORD_HINT: Readonly<Record<SubscriptionRecordKind, string>> = {
	subscription:
		"The subscription was not recorded, so it did not start; make the journal or transcript storage available (see the cause), then subscribe again.",
	"processed-event":
		"The handler finished, but the event was not recorded and is handled again after a resume; make the journal or transcript storage available (see the cause), then resume.",
};

/**
 * Recording a subscription or a processed event failed, so the subscription stops. A processed event whose record
 * failed is handled again after a resume. Retryable exactly when the storage reports itself unavailable.
 */
export class SubscriptionRecordError extends SubscriptionError {
	override readonly name = "SubscriptionRecordError" as const;
	declare readonly code: "record-failed";
	readonly subscriptionId: string;
	readonly record: SubscriptionRecordKind;
	readonly eventId: string | null;

	constructor(
		subscriptionId: string,
		record: SubscriptionRecordKind,
		eventId: string | null,
		options?: { readonly cause?: unknown; readonly retryable?: boolean },
	) {
		const hint = RECORD_HINT[record];
		super(
			"record-failed",
			failureMessage(
				record === "subscription"
					? "Recording the subscription failed"
					: `Recording processed event ${eventId} failed`,
				subscriptionId,
				"record-failed",
				hint,
			),
			{
				hint,
				retryable: options?.retryable ?? options?.cause instanceof StorageUnavailableError,
				...(options?.cause === undefined ? {} : { cause: options.cause }),
			},
		);
		this.subscriptionId = subscriptionId;
		this.record = record;
		this.eventId = eventId;
	}

	override fields(): SubscriptionErrorFields {
		return { subscriptionId: this.subscriptionId, record: this.record, eventId: this.eventId };
	}
}

export type SubscriptionTimeoutPhase = "gh-auth-check";

const TIMEOUT_SUBJECT: Readonly<Record<SubscriptionTimeoutPhase, string>> = {
	"gh-auth-check": "the GitHub login check (gh auth token)",
};

const TIMEOUT_HINT: Readonly<Record<SubscriptionTimeoutPhase, string>> = {
	"gh-auth-check": "Check that `gh auth status` answers promptly on this machine, then subscribe again.",
};

/** A step the subscription waits on took longer than its limit. Trying again may succeed. */
export class SubscriptionTimeoutError extends SubscriptionError {
	override readonly name = "SubscriptionTimeoutError" as const;
	declare readonly code: "timeout";
	readonly phase: SubscriptionTimeoutPhase;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(
		phase: SubscriptionTimeoutPhase,
		timeoutMs: number,
		elapsedMs: number,
		options?: { readonly cause?: unknown },
	) {
		const hint = TIMEOUT_HINT[phase];
		super("timeout", failureMessage(`Timed out after ${timeoutMs} ms`, TIMEOUT_SUBJECT[phase], "timeout", hint), {
			hint,
			retryable: true,
			...(options?.cause === undefined ? {} : { cause: options.cause }),
		});
		this.phase = phase;
		this.timeoutMs = timeoutMs;
		this.elapsedMs = elapsedMs;
	}

	override fields(): SubscriptionErrorFields {
		return { phase: this.phase, timeoutMs: this.timeoutMs, elapsedMs: this.elapsedMs };
	}
}

const CODE_BY_NAME: Readonly<Record<string, SubscriptionErrorCode>> = {
	SubscriptionClosedError: "subscription-closed",
	SubscriptionConfigError: "invalid-option",
	SubscriptionEventError: "invalid-event",
	EventSourceError: "source-failed",
	SubscriptionHandlerError: "handler-failed",
	SubscriptionChildUnavailableError: "child-unavailable",
	SubscriptionSetupError: "setup-missing",
	SubscriptionSubscriberUnavailableError: "subscriber-unavailable",
	SubscriptionRecordError: "record-failed",
	SubscriptionTimeoutError: "timeout",
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
export const isSubscriptionSetupError = guard(SubscriptionSetupError, "SubscriptionSetupError");
export const isSubscriptionSubscriberUnavailableError = guard(
	SubscriptionSubscriberUnavailableError,
	"SubscriptionSubscriberUnavailableError",
);
export const isSubscriptionRecordError = guard(SubscriptionRecordError, "SubscriptionRecordError");
export const isSubscriptionTimeoutError = guard(SubscriptionTimeoutError, "SubscriptionTimeoutError");

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

/** The field's value when it is one of the values this version knows. */
function knownField<T extends string>(
	fields: SubscriptionErrorFields,
	key: string,
	known: readonly T[],
): T | undefined {
	return known.find((value) => value === fields[key]);
}

function keysOf<T extends string>(record: Readonly<Record<T, unknown>>): readonly T[] {
	return Object.keys(record) as T[];
}

const CLOSED_OPERATIONS: readonly SubscriptionClosedOperation[] = ["publish", "emit", "report", "subscribe"];
const EVENT_REASONS: readonly SubscriptionEventReason[] = ["not-object", "missing-id"];

function numberField(fields: SubscriptionErrorFields, key: string): number {
	const value = fields[key];
	return typeof value === "number" ? value : 0;
}

/** The family base carrying a serialized error's own name and code, for names or values this version does not know. */
function familyBase(serialized: SerializedSubscriptionError, cause: Error | undefined): SubscriptionError {
	const base = new SubscriptionError(serialized.code, serialized.message, {
		retryable: serialized.retryable,
		hint: serialized.hint,
		cause,
	});
	Object.defineProperty(base, "name", { value: serialized.name });
	return base;
}

/** Rebuild a serialized subscription error as its own class; unknown names become the family base. */
export function deserializeSubscriptionError(serialized: SerializedSubscriptionError): SubscriptionError {
	const cause = rehydrateCause(serialized.cause);
	const fields = serialized.fields;
	const rebuilt = ((): SubscriptionError => {
		switch (serialized.name) {
			case "SubscriptionClosedError": {
				const operation = knownField(fields, "operation", CLOSED_OPERATIONS);
				if (operation === undefined) return familyBase(serialized, cause);
				return new SubscriptionClosedError(stringField(fields, "subscriptionId"), operation);
			}
			case "SubscriptionConfigError": {
				const reason = knownField(fields, "reason", keysOf(EXPECTED_BY_REASON));
				if (reason === undefined) return familyBase(serialized, cause);
				return new SubscriptionConfigError(
					stringField(fields, "field"),
					reason,
					stringField(fields, "expected") || undefined,
				);
			}
			case "SubscriptionEventError": {
				const reason = knownField(fields, "reason", EVENT_REASONS);
				if (reason === undefined) return familyBase(serialized, cause);
				return new SubscriptionEventError(stringField(fields, "subscriptionId"), reason);
			}
			case "EventSourceError": {
				const phase = knownField(fields, "phase", keysOf(DEFAULT_SOURCE_HINT));
				if (phase === undefined) return familyBase(serialized, cause);
				const detail = fields.detail;
				return new EventSourceError(stringField(fields, "sourceId"), phase, {
					cause,
					retryable: serialized.retryable,
					hint: serialized.hint,
					...(typeof detail === "string" ? { detail } : {}),
				});
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
			case "SubscriptionSetupError": {
				const missing = knownField(fields, "missing", keysOf(SETUP_HINT));
				if (missing === undefined) return familyBase(serialized, cause);
				return new SubscriptionSetupError(missing);
			}
			case "SubscriptionSubscriberUnavailableError": {
				const reason = knownField(fields, "reason", keysOf(SUBSCRIBER_UNAVAILABLE_HINT));
				if (reason === undefined) return familyBase(serialized, cause);
				return new SubscriptionSubscriberUnavailableError(
					stringField(fields, "subscriptionId"),
					stringField(fields, "subscriber"),
					reason,
				);
			}
			case "SubscriptionRecordError": {
				const record = knownField(fields, "record", keysOf(RECORD_HINT));
				if (record === undefined) return familyBase(serialized, cause);
				return new SubscriptionRecordError(
					stringField(fields, "subscriptionId"),
					record,
					typeof fields.eventId === "string" ? fields.eventId : null,
					{ retryable: serialized.retryable },
				);
			}
			case "SubscriptionTimeoutError": {
				const phase = knownField(fields, "phase", keysOf(TIMEOUT_HINT));
				if (phase === undefined) return familyBase(serialized, cause);
				return new SubscriptionTimeoutError(
					phase,
					numberField(fields, "timeoutMs"),
					numberField(fields, "elapsedMs"),
				);
			}
			default:
				return familyBase(serialized, cause);
		}
	})();
	if (cause !== undefined)
		Object.defineProperty(rebuilt, "cause", { value: cause, configurable: true, writable: true });
	return rebuilt;
}
