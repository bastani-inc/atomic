/**
 * #5352: a session's Intercom reach policy, set by its host, and the pure rules the broker and the client both apply.
 * Keep this module free of host-package imports: the detached broker loads it with only Node built-ins.
 */

/** A session's home group and the other groups it may reach. */
export interface IntercomReachPolicy {
	readonly home: string;
	readonly reachable: readonly string[];
}

/** The most groups one session may list as reachable. */
export const MAX_REACHABLE_GROUPS = 1_000;

/** The longest group name a reach policy accepts, in UTF-16 code units. */
export const MAX_REACH_GROUP_LENGTH = 1_024;

const RESERVED_GROUP_NAMES = ["true", "auto"];

/** Why a host-supplied group cannot be part of a reach policy, or undefined when it can. */
function reachGroupError(value: unknown, field: string): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return `${field} must be a non-empty group name`;
	const group = value.trim();
	if (group.length > MAX_REACH_GROUP_LENGTH)
		return `${field} is longer than ${MAX_REACH_GROUP_LENGTH} characters`;
	if (RESERVED_GROUP_NAMES.includes(group.toLowerCase()))
		return `${field} "${group}" is reserved for subagent auto-groups; choose another name`;
	return undefined;
}

/** The error a host-supplied policy has, or undefined when it is valid. */
export function reachPolicyError(group: unknown, reachable: unknown): string | undefined {
	const homeError = reachGroupError(group, "Intercom group");
	if (homeError !== undefined) return homeError;
	if (reachable === undefined) return undefined;
	if (!Array.isArray(reachable)) return "Intercom reachable must be an array of group names";
	if (reachable.length > MAX_REACHABLE_GROUPS)
		return `Intercom reachable lists ${reachable.length} groups, over the limit of ${MAX_REACHABLE_GROUPS}`;
	for (const entry of reachable) {
		const error = reachGroupError(entry, "Each reachable group");
		if (error !== undefined) return error;
	}
	return undefined;
}

/** Each reachable group once, trimmed, in order, without the home group. */
export function normalizeReachable(home: string, reachable: readonly string[]): string[] {
	const groups: string[] = [];
	for (const entry of reachable) {
		const group = entry.trim();
		if (group !== home && !groups.includes(group)) groups.push(group);
	}
	return groups;
}

/** A validated, normalized policy; throws with the reason when the host supplied an invalid one. */
export function createReachPolicy(group: unknown, reachable?: unknown): IntercomReachPolicy {
	const error = reachPolicyError(group, reachable);
	if (error !== undefined) throw new TypeError(error);
	const home = (group as string).trim();
	return { home, reachable: normalizeReachable(home, (reachable as readonly string[] | undefined) ?? []) };
}

/** Whether `group` is a subgroup under `owner`: the group workflow stages and subagents of a session sit in. */
export function isSubgroupOf(owner: string, group: string): boolean {
	return group.length > owner.length + 1 && group.startsWith(owner) && group.charAt(owner.length) === "/";
}

/** Whether `group` is the policy's home or one of its reachable groups: the groups it may list, join and peek. */
export function inReachSet(policy: IntercomReachPolicy, group: string): boolean {
	return group === policy.home || policy.reachable.includes(group);
}

/**
 * Whether a session with this policy may reach sessions that belong to `group`: its home, a reachable group, or a
 * subgroup under its home that holds the workflow stages and subagents it started. Reach is one way: it says nothing
 * about who may reach this session.
 */
export function isReachable(policy: IntercomReachPolicy, group: string): boolean {
	return inReachSet(policy, group) || isSubgroupOf(policy.home, group);
}

/** Whether a session with this policy may reach a session holding these memberships. */
export function reachesAnyGroup(policy: IntercomReachPolicy, groups: Iterable<string>): boolean {
	for (const group of groups) {
		if (isReachable(policy, group)) return true;
	}
	return false;
}

/** The groups the `groups` action shows a session with this policy: its home, then each reachable group once. */
export function reachGroups(policy: IntercomReachPolicy): string[] {
	const groups = [policy.home];
	for (const group of policy.reachable) {
		if (!groups.includes(group)) groups.push(group);
	}
	return groups;
}

/** Whether a session with this policy may join `group`. */
export function canJoin(policy: IntercomReachPolicy, group: string): boolean {
	return inReachSet(policy, group);
}

/** Whether a session with this policy may leave `group`: never its home. */
export function canLeave(policy: IntercomReachPolicy, group: string): boolean {
	return group !== policy.home;
}

/** Whether a session with this policy may peek at `group` with a `list` or `status` filter. */
export function canPeek(policy: IntercomReachPolicy, group: string): boolean {
	return isReachable(policy, group);
}

/** Whether a policy admits these memberships: they include its home and stay within its home and reachable groups. */
export function admitsMemberships(policy: IntercomReachPolicy, groups: readonly string[]): boolean {
	if (!groups.includes(policy.home)) return false;
	for (const group of groups) {
		if (!inReachSet(policy, group)) return false;
	}
	return true;
}

/** The memberships kept under a policy: the home group first, then each held group the policy still admits, once. */
export function narrowMemberships(policy: IntercomReachPolicy, groups: readonly string[]): string[] {
	const kept = [policy.home];
	for (const group of groups) {
		if (inReachSet(policy, group) && !kept.includes(group)) kept.push(group);
	}
	return kept;
}

/**
 * The group a subagent of a session with this policy belongs to. With none requested it shares its parent's home; a
 * requested group is placed under the parent's home unless it is the home or already under it, so a child never
 * lands in one of its parent's reachable groups or in another session's group.
 */
export function confinedChildGroup(parentHome: string, requested: string | undefined): string {
	if (requested === undefined) return parentHome;
	const group = requested.trim();
	if (group.length === 0 || group === parentHome || isSubgroupOf(parentHome, group)) return group || parentHome;
	return `${parentHome}/${group}`;
}

/** The policy a workflow stage or subagent of a session with a policy gets: its own group, and nothing reachable. */
export function childReachPolicy(childHome: string): IntercomReachPolicy {
	return { home: childHome, reachable: [] };
}

/** Why a session with this policy may not send to a target outside its reach. */
export function outsideReachReason(policy: IntercomReachPolicy): string {
	const reachable = policy.reachable.length === 0 ? "none" : policy.reachable.join(", ");
	return `Target session is outside this session's Intercom reach (home group ${policy.home}; reachable groups: ${reachable})`;
}

/** Why a session with this policy finds no session by a name: it sees only the sessions in its reach. */
export function notFoundInReachReason(policy: IntercomReachPolicy): string {
	const reachable = policy.reachable.length === 0 ? "none" : policy.reachable.join(", ");
	return `This session reaches only sessions in its home group ${policy.home} and its reachable groups (${reachable})`;
}
