import { hasGroup, normalizeGroup, normalizeGroups } from "../group.js";
import type { GroupSummary, SessionInfo } from "../types.js";
import type { BrokerConnectedSession } from "./send-handler.js";
import { isAgentRecipient } from "../recipient-purpose.js";
import { type IntercomReachPolicy, reachesAnyGroup, reachGroups } from "../reach-policy.js";

/** A session as the broker's reach rule sees it: its memberships, and the reach policy it registered with, if any. */
export interface ReachSubject {
	readonly info: SessionInfo;
	readonly reach?: IntercomReachPolicy;
}

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

/**
 * #5352: whether `sender` reaches a session that holds `groups`. A session with a reach policy reaches its home and
 * reachable groups and the subgroups under its home, one way; one without reaches the sessions it shares a group with.
 */
export function reachesGroups(sender: ReachSubject, groups: Iterable<string>): boolean {
	if (sender.reach !== undefined) return reachesAnyGroup(sender.reach, groups);
	const own = sessionGroups(sender.info);
	for (const group of groups) {
		if (own.has(normalizeGroup(group))) return true;
	}
	return false;
}

/** A send's sender as a hold for a subagent with no live session sees it (#3760, #4639). */
export interface HoldSender extends ReachSubject {
	readonly id: string;
	/** #5352: the send answers an ask the sender received; a sender with a reach policy may always answer one. */
	readonly answersAsk?: true;
}

/** Whether a send from `sender` may be held for, or told about, a subagent in `group`. */
export function holdAdmitsSender(sender: HoldSender, group: string): boolean {
	if (sender.answersAsk === true && sender.reach !== undefined) return true;
	return reachesGroups(sender, [group]);
}

/** #5352: whether `sender` reaches `target`; see {@link reachesGroups}. */
export function reachesSession(sender: ReachSubject, target: SessionInfo): boolean {
	return reachesGroups(sender, sessionGroups(target));
}

/** Return each session the requester reaches: through a shared membership, or through its reach policy (#5352). */
export function sessionsVisibleTo(
	sessions: ReadonlyMap<string, Pick<BrokerConnectedSession, "info">>,
	requester: SessionInfo,
	reach?: IntercomReachPolicy,
): SessionInfo[] {
	const subject: ReachSubject = reach === undefined ? { info: requester } : { info: requester, reach };
	return [...sessions.values()].map(({ info }) => info).filter((info) => isAgentRecipient(info) && reachesSession(subject, info));
}

/** Return sessions that belong to one explicit group. */
export function sessionsInGroup(
	sessions: ReadonlyMap<string, Pick<BrokerConnectedSession, "info">>,
	group: string | undefined,
): SessionInfo[] {
	return [...sessions.values()].map(({ info }) => info).filter((info) => isAgentRecipient(info) && hasGroup(sessionGroups(info), group));
}

/**
 * Summarize every group currently represented by a connected session. #5352: a requester with a reach policy sees only
 * its home and reachable groups, each listed even when no session is in it.
 */
export function knownGroupSummaries(
	sessions: ReadonlyMap<string, BrokerConnectedSession>,
	requester: SessionInfo,
	reach?: IntercomReachPolicy,
): GroupSummary[] {
	const counts = new Map<string, number>();
	for (const { info } of sessions.values()) {
		if (!isAgentRecipient(info)) continue;
		for (const group of sessionGroups(info)) counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	const requesterGroups = sessionGroups(requester);
	if (reach !== undefined)
		return reachGroups(reach).map((group) => ({
			group,
			sessionCount: counts.get(group) ?? 0,
			member: requesterGroups.has(group),
		}));
	return [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([group, sessionCount]) => ({ group, sessionCount, member: requesterGroups.has(group) }));
}
