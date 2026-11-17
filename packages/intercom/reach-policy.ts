
import type { JsonWireValue } from "./broker/framing.js";

export interface IntercomReachPolicy {
	readonly home: string;
	readonly reachable: readonly string[];
}

export const MAX_REACHABLE_GROUPS = 1_000;

export const MAX_REACH_GROUP_LENGTH = 1_024;

const RESERVED_GROUP_NAMES = ["true", "auto"];

function reachGroupError(value: JsonWireValue | undefined, field: string): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return `${field} must be a non-empty group name`;
	const group = value.trim();
	if (group.length > MAX_REACH_GROUP_LENGTH)
		return `${field} is longer than ${MAX_REACH_GROUP_LENGTH} characters`;
	if (RESERVED_GROUP_NAMES.includes(group.toLowerCase()))
		return `${field} "${group}" is reserved for subagent auto-groups; choose another name`;
	return undefined;
}

export function reachPolicyError(group: JsonWireValue | undefined, reachable: JsonWireValue | readonly string[] | undefined): string | undefined {
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

export function normalizeReachable(home: string, reachable: readonly string[]): string[] {
	const groups: string[] = [];
	for (const entry of reachable) {
		const group = entry.trim();
		if (group !== home && !groups.includes(group)) groups.push(group);
	}
	return groups;
}

export function createReachPolicy(group: IntercomReachPolicy["home"], reachable?: IntercomReachPolicy["reachable"]): IntercomReachPolicy {
	const error = reachPolicyError(group, reachable);
	if (error !== undefined) throw new TypeError(error);
	const home = group.trim();
	return { home, reachable: normalizeReachable(home, reachable ?? []) };
}

export function isSubgroupOf(owner: string, group: string): boolean {
	return group.length > owner.length + 1 && group.startsWith(owner) && group.charAt(owner.length) === "/";
}

export function inReachSet(policy: IntercomReachPolicy, group: string): boolean {
	return group === policy.home || policy.reachable.includes(group);
}

export function isReachable(policy: IntercomReachPolicy, group: string): boolean {
	return inReachSet(policy, group) || isSubgroupOf(policy.home, group);
}

export function reachesAnyGroup(policy: IntercomReachPolicy, groups: Iterable<string>): boolean {
	for (const group of groups) {
		if (isReachable(policy, group)) return true;
	}
	return false;
}

export function reachGroups(policy: IntercomReachPolicy): string[] {
	const groups = [policy.home];
	for (const group of policy.reachable) {
		if (!groups.includes(group)) groups.push(group);
	}
	return groups;
}

export function canJoin(policy: IntercomReachPolicy, group: string): boolean {
	return inReachSet(policy, group);
}

export function canLeave(policy: IntercomReachPolicy, group: string): boolean {
	return group !== policy.home;
}

export function canPeek(policy: IntercomReachPolicy, group: string): boolean {
	return isReachable(policy, group);
}

export function admitsMemberships(policy: IntercomReachPolicy, groups: readonly string[]): boolean {
	if (!groups.includes(policy.home)) return false;
	for (const group of groups) {
		if (!inReachSet(policy, group)) return false;
	}
	return true;
}

export function narrowMemberships(policy: IntercomReachPolicy, groups: readonly string[]): string[] {
	const kept = [policy.home];
	for (const group of groups) {
		if (inReachSet(policy, group) && !kept.includes(group)) kept.push(group);
	}
	return kept;
}

export function confinedChildGroup(parentHome: string, requested: string | undefined): string {
	if (requested === undefined) return parentHome;
	const group = requested.trim();
	if (group.length === 0 || group === parentHome || isSubgroupOf(parentHome, group)) return group || parentHome;
	return `${parentHome}/${group}`;
}

export function childReachPolicy(childHome: string): IntercomReachPolicy {
	return { home: childHome, reachable: [] };
}

export function outsideReachReason(policy: IntercomReachPolicy): string {
	const reachable = policy.reachable.length === 0 ? "none" : policy.reachable.join(", ");
	return `Target session is outside this session's Intercom reach (home group ${policy.home}; reachable groups: ${reachable})`;
}

export function notFoundInReachReason(policy: IntercomReachPolicy): string {
	const reachable = policy.reachable.length === 0 ? "none" : policy.reachable.join(", ");
	return `This session reaches only sessions in its home group ${policy.home} and its reachable groups (${reachable})`;
}
