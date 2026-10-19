/** Broker session ids are lowercase canonical UUIDs; only that form may be requested back. */
const CANONICAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Lets a restarted or reconnected session register under the Intercom id peers already know (#3760).
 *
 * A requested id is granted only when no live session holds it, so a registration never displaces a
 * live session. While this broker remembers who last held an id, only a registration with that same
 * return address (the host's session identity) gets it back. A broker that restarted remembers
 * nothing; its sessions and their routing state are gone too, so a free id carries no authority.
 */
export class SessionIdReclaim {
	private readonly retired = new Map<string, string | undefined>();

	constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

	/** Remember who held a departed session id. */
	retire(sessionId: string, returnAddress: string | undefined): void {
		this.retired.delete(sessionId);
		this.retired.set(sessionId, returnAddress);
		while (this.retired.size > this.maxEntries) {
			const oldest = this.retired.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.retired.delete(oldest);
		}
	}

	/** The requested id when it can be granted, otherwise undefined (the caller assigns a fresh id). */
	grant(
		preferredSessionId: string | undefined,
		returnAddress: string | undefined,
		isLive: (sessionId: string) => boolean,
	): string | undefined {
		if (preferredSessionId === undefined || returnAddress === undefined) return undefined;
		if (!CANONICAL_SESSION_ID.test(preferredSessionId) || isLive(preferredSessionId)) return undefined;
		if (this.retired.has(preferredSessionId) && this.retired.get(preferredSessionId) !== returnAddress) return undefined;
		this.retired.delete(preferredSessionId);
		return preferredSessionId;
	}
}
