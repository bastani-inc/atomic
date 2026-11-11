import { IntercomBrokerTimeoutError } from "./recoverable-disconnect.js";

export type IntercomHostedSessionTimeoutCode = "hosted_session_timeout";

/** The step that was waiting: the broker's answer to a request to host or remove sessions on a connection. */
export type IntercomHostedSessionTimeoutPhase = "hosted-session-request";

/** The request that went unanswered. */
export type IntercomHostedSessionRequestType = "host_sessions" | "unhost_sessions";

const HOSTED_SESSION_TIMEOUT_HINT =
	"Hosting is tried again on the next connection; run `atomic intercom restart` if the broker keeps timing out.";

export interface IntercomHostedSessionTimeoutFields {
	readonly requestType: IntercomHostedSessionRequestType;
	/** Sessions the request carried; never the sessions themselves. */
	readonly sessionCount: number;
	readonly timeoutMs: number;
	/**
	 * Whole milliseconds from writing the request to the bound expiring, on the monotonic clock; past `timeoutMs` when
	 * the event loop was late.
	 */
	readonly elapsedMs: number;
}

/**
 * The broker was asked to host or remove sessions on a connection and did not answer within its bound. It is an
 * {@link IntercomBrokerTimeoutError}, so every recoverable-disconnect check still recognizes it; `cause` is the failed
 * broker health check when the connection was given up as well.
 */
export class IntercomHostedSessionTimeoutError extends IntercomBrokerTimeoutError {
	override readonly name = "IntercomHostedSessionTimeoutError" as const;
	readonly code: IntercomHostedSessionTimeoutCode = "hosted_session_timeout";
	readonly phase: IntercomHostedSessionTimeoutPhase = "hosted-session-request";
	readonly retryable = true as const;
	readonly hint = HOSTED_SESSION_TIMEOUT_HINT;
	readonly requestType: IntercomHostedSessionRequestType;
	readonly sessionCount: number;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(fields: IntercomHostedSessionTimeoutFields, options?: ErrorOptions) {
		super(
			`Hosted-session request timed out: ${fields.requestType} for ${fields.sessionCount} sessions, unanswered after ${fields.elapsedMs} ms of ${fields.timeoutMs} ms (hosted_session_timeout). ${HOSTED_SESSION_TIMEOUT_HINT}`,
			options,
		);
		this.requestType = fields.requestType;
		this.sessionCount = fields.sessionCount;
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
	}
}

/** True for an {@link IntercomHostedSessionTimeoutError}, or an error of another realm shaped like one, by `name` and `code`. */
export function isIntercomHostedSessionTimeoutError(value: unknown): value is IntercomHostedSessionTimeoutError {
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "IntercomHostedSessionTimeoutError" && code === "hosted_session_timeout";
}
