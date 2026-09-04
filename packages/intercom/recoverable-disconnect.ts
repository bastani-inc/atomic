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
 * module creates carry the marker, so an identically worded error raised
 * anywhere else — and every protocol, authentication, configuration, or
 * non-recoverable initialization failure — stays actionable.
 */

/** Model-visible recovery direction for a stale broker socket. */
export const RECOVERABLE_DISCONNECT_MESSAGE =
	"Client disconnected. Retry the same Intercom call up to three times to reconnect.";

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

/** True only for an `IntercomClientDisconnectedError`, directly or as a bounded `cause` ancestor. */
export function isRecoverableIntercomDisconnect(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (!(current instanceof Error)) return false;
		if (current instanceof IntercomClientDisconnectedError) return true;
		current = current.cause;
	}
	return false;
}
