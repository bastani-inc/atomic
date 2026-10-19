import type { SessionEntry } from "@bastani/atomic";

/** Custom session entry recording the Intercom session id a session registered under (#3760). */
export const INTERCOM_SESSION_IDENTITY_ENTRY = "intercom_session_identity";

export interface IntercomSessionIdentity {
	/** The Atomic session that registered; a forked or copied session must not inherit the Intercom id. */
	readonly sessionId: string;
	readonly intercomSessionId: string;
}

/**
 * The Intercom id this session last registered under, read from its own entries so a resumed session or a
 * restored subagent asks the broker for the id its peers already know. Entries copied from another session
 * (a fork) name that session and are ignored.
 */
export function readIntercomSessionIdentity(entries: readonly SessionEntry[], sessionId: string): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== INTERCOM_SESSION_IDENTITY_ENTRY) continue;
		const data = entry.data as Partial<IntercomSessionIdentity> | undefined;
		if (data?.sessionId === sessionId && typeof data.intercomSessionId === "string" && data.intercomSessionId)
			return data.intercomSessionId;
	}
	return undefined;
}
