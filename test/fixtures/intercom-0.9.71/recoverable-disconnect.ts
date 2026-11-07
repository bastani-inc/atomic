/**
 * Classification for a *recoverable* Intercom broker disconnect.
 *
 * The client socket is gone, but the lightweight extension wrapper owns
 * recovery: a failed lazy-initialization attempt is discarded, and the next
 * call re-imports the heavy module and reconnects. Work the user did not ask
 * for — session lifecycle events and background event relays — must therefore
 * not render such a disconnect as a failure while that retry is still ahead.
 * Explicit, user-initiated operations keep rejecting visibly.
 *
 * Classification is by construction, never by message text. Only errors this
 * module or `live-route-refusal.ts` create carry the marker, so an identically
 * worded error raised anywhere else — and every protocol, authentication,
 * configuration, or non-recoverable initialization failure — stays actionable.
 *
 * A broker refusal of a live workflow-stage route ends the socket too. When its
 * code is transient (the workflow owner is re-registering after its own
 * reconnect, or the previous attempt's session is still being torn down), the
 * same bounded retry that recovers a lost socket clears it (#3163). A refusal
 * whose code repeats identically on retry is not recoverable.
 *
 * A broker that accepts the socket but does not answer a registration in time is
 * saturated, not gone. Its timeout is recoverable for the same reason, and a
 * background relay that sees it keeps quiet unless the outage persists.
 *
 * A broker that retires (idle for its window, asked to shut down, or replaced)
 * can end a connection that is still registering. That is a lost race, not a
 * failure of this client: the broker either says so with `broker_retiring`
 * before it closes, or is gone by the time the client looks. The client spawns
 * and connects to the replacement.
 */

import { IntercomLiveRouteRefusedError } from "./live-route-refusal.js";

/** Transport diagnosis. Delivery tools own bounded recovery, not their callers. */
export const RECOVERABLE_DISCONNECT_MESSAGE = "Client disconnected";

/**
 * Bound on the `cause` chain walk. Intercom wraps failures with `cause` on the
 * relay and reply paths (`subagent-relay.ts` and `index-heavy.ts` both do), so
 * a recoverable disconnect can arrive nested; the bound keeps a cyclic or
 * adversarially deep chain from turning classification into a hang.
 */
const MAX_CAUSE_DEPTH = 8;

interface RecoverableDisconnectMarker {
	readonly intercomRecoverableDisconnect?: boolean;
}

/** Raised when an established broker socket is gone and lazy re-initialization can retry. */
export class IntercomClientDisconnectedError extends Error implements RecoverableDisconnectMarker {
	readonly intercomRecoverableDisconnect = true;

	constructor(options?: ErrorOptions) {
		super(RECOVERABLE_DISCONNECT_MESSAGE, options);
		this.name = "IntercomClientDisconnectedError";
	}
}

/** Raised when the broker accepted the socket but did not answer a registration within its bound. */
export class IntercomBrokerTimeoutError extends Error implements RecoverableDisconnectMarker {
	readonly intercomRecoverableDisconnect = true;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "IntercomBrokerTimeoutError";
	}
}

/** The `registration_failed` code a retiring broker answers a registration with before it closes. */
export const BROKER_RETIRING_CODE = "broker_retiring";
export const BROKER_RETIRING_REASON = "Intercom broker is retiring; connect to its replacement";

/**
 * Raised when the broker a client was registering with retired first: it answered `broker_retiring`, or it ended
 * the connection before answering and no longer answers on its socket. A replacement broker can be spawned and the
 * registration tried again.
 */
export class IntercomBrokerRetiringError extends Error implements RecoverableDisconnectMarker {
	readonly intercomRecoverableDisconnect = true;

	constructor(message: string = BROKER_RETIRING_REASON, options?: ErrorOptions) {
		super(message, options);
		this.name = "IntercomBrokerRetiringError";
	}
}

/**
 * True for an `IntercomClientDisconnectedError`, an `IntercomBrokerTimeoutError`, an `IntercomBrokerRetiringError`,
 * or a transient `IntercomLiveRouteRefusedError`, directly or as a bounded `cause` ancestor.
 */
export function isRecoverableIntercomDisconnect(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (!(current instanceof Error)) return false;
		if (current instanceof IntercomClientDisconnectedError) return true;
		if (current instanceof IntercomBrokerTimeoutError) return true;
		if (current instanceof IntercomBrokerRetiringError) return true;
		if (current instanceof IntercomLiveRouteRefusedError) return current.transient;
		current = current.cause;
	}
	return false;
}

/** True for an `IntercomBrokerTimeoutError`, directly or as a bounded `cause` ancestor. */
export function isIntercomBrokerTimeout(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (!(current instanceof Error)) return false;
		if (current instanceof IntercomBrokerTimeoutError) return true;
		current = current.cause;
	}
	return false;
}

/** True for an `IntercomBrokerRetiringError`, directly or as a bounded `cause` ancestor. */
export function isIntercomBrokerRetiring(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (!(current instanceof Error)) return false;
		if (current instanceof IntercomBrokerRetiringError) return true;
		current = current.cause;
	}
	return false;
}
