import type { SessionEntry } from "@bastani/atomic";

/** Custom session entry recording the Intercom groups a session holds after a `join` or `leave` (#4079). */
export const INTERCOM_SESSION_MEMBERSHIPS_ENTRY = "intercom_session_memberships";

export interface IntercomSessionMemberships {
	/** The Atomic session that joined; a forked or copied session must not inherit its memberships. */
	readonly sessionId: string;
	/** The home group the memberships were held under; a session restored under another home keeps only its home. */
	readonly homeGroup: string;
	/** The memberships after the last `join` or `leave`, or `null` once `leave` returned the session to its home group. */
	readonly groups: readonly string[] | null;
}

function isMemberships(record: Partial<IntercomSessionMemberships> | undefined): record is IntercomSessionMemberships {
	return (
		record !== undefined &&
		record !== null &&
		typeof record.sessionId === "string" &&
		typeof record.homeGroup === "string" &&
		(record.groups === null ||
			(Array.isArray(record.groups) && record.groups.every((group) => typeof group === "string")))
	);
}

/**
 * The groups this session held when it last joined or left one, read from its own entries so a restored session
 * rejoins exactly those groups. Only the session's own latest record counts: entries copied from another session
 * (a fork) are ignored, a `leave` recorded later wins over an earlier `join`, and a record made under a different
 * home group is not restored.
 */
export function readIntercomSessionMemberships(
	entries: readonly SessionEntry[],
	sessionId: string,
	homeGroup: string,
): readonly string[] | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== INTERCOM_SESSION_MEMBERSHIPS_ENTRY) continue;
		const data = entry.data as Partial<IntercomSessionMemberships> | undefined;
		if (!isMemberships(data) || data.sessionId !== sessionId) continue;
		if (data.homeGroup !== homeGroup || data.groups === null) return undefined;
		return data.groups;
	}
	return undefined;
}
