import { hasGroup, normalizeGroup, normalizeGroups } from "../group.js";
import type { GroupSummary, SessionInfo } from "../types.js";
import type { BrokerConnectedSession } from "./send-handler.js";

/** Return the normalized memberships carried by a wire session. */
export function sessionGroups(session: SessionInfo): Set<string> {
	return normalizeGroups(session.groups, session.group);
}

/** Persist normalized memberships while retaining the legacy single-group field. */
export function setSessionGroups(session: SessionInfo, groups: ReadonlySet<string>, legacyGroup?: string): void {
	const normalized = normalizeGroups(groups);
	session.groups = [...normalized];
	const firstGroup = normalized.values().next().value ?? normalizeGroup();
	session.group = legacyGroup !== undefined && normalized.has(normalizeGroup(legacyGroup))
		? normalizeGroup(legacyGroup)
		: firstGroup;
}

/** Sessions can route to each other when any normalized membership intersects. */
export function sessionsShareGroup(a: SessionInfo, b: SessionInfo): boolean {
	const bGroups = sessionGroups(b);
	return [...sessionGroups(a)].some((group) => bGroups.has(group));
}

/** Return each session visible through at least one of the requester's memberships. */
export function sessionsVisibleTo(
	sessions: ReadonlyMap<string, BrokerConnectedSession>,
	requester: SessionInfo,
): SessionInfo[] {
	return [...sessions.values()].map(({ info }) => info).filter((info) => sessionsShareGroup(requester, info));
}

/** Return sessions that belong to one explicit group. */
export function sessionsInGroup(
	sessions: ReadonlyMap<string, BrokerConnectedSession>,
	group: string | undefined,
): SessionInfo[] {
	return [...sessions.values()].map(({ info }) => info).filter((info) => hasGroup(sessionGroups(info), group));
}

/** Summarize every group currently represented by a connected session. */
export function knownGroupSummaries(
	sessions: ReadonlyMap<string, BrokerConnectedSession>,
	requester: SessionInfo,
): GroupSummary[] {
	const counts = new Map<string, number>();
	for (const { info } of sessions.values()) {
		for (const group of sessionGroups(info)) counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	const requesterGroups = sessionGroups(requester);
	return [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([group, sessionCount]) => ({ group, sessionCount, member: requesterGroups.has(group) }));
}
