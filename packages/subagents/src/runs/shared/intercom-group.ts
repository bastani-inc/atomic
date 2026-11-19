import { randomUUID } from "node:crypto";
import { readRuntimeIntercomGroup } from "@bastani/atomic";

/** Normalize agent-serialized auto-group sentinels without changing real group names. */
export function normalizeAutoGroupSentinel(group: string | true | undefined): string | true | undefined {
	if (group === undefined || group === true) return group;
	const sentinel = group.trim().toLowerCase();
	return sentinel === "true" || sentinel === "auto" ? true : group;
}

/** Runtime joins are intentionally inherited before static child policy. */
function runtimeIntercomGroup(sessionId: string | undefined): string | undefined {
	return readRuntimeIntercomGroup(sessionId);
}

interface ChildGroupPolicy {
	readonly home: string;
	childGroup(requested: string | undefined): string;
}

interface ChildGroupContext {
	subagentPolicy?: { intercomGroup?: string } | undefined;
	sessionManager?: { getSessionId(): string } | undefined;
	intercomPolicy?: ChildGroupPolicy | undefined;
}

/**
 * Read the live joined group before the admitted child group. The runtime env
 * entry is a deliberate exception to the no-process-env rule for admission capabilities: it
 * carries only the current group so children launched after `join` follow their parent.
 */
export function inheritedIntercomGroup(ctx: ChildGroupContext | undefined): string | undefined {
	const policy = ctx?.intercomPolicy;
	if (policy !== undefined) return policy.home;
	const runtimeGroup = runtimeIntercomGroup(ctx?.sessionManager?.getSessionId());
	if (runtimeGroup !== undefined) return runtimeGroup;
	const policyGroup = ctx?.subagentPolicy?.intercomGroup;
	return typeof policyGroup === "string" && policyGroup.trim().length > 0 ? policyGroup.trim() : undefined;
}

export function resolveChildIntercomGroup(
	explicit: string | true | undefined,
	inherited: string | undefined,
	sharedAutoGroup: string | undefined,
	policy?: ChildGroupPolicy,
): string | undefined {
	const resolved = requestedChildIntercomGroup(explicit, inherited, sharedAutoGroup);
	return policy === undefined ? resolved : policy.childGroup(resolved);
}

function requestedChildIntercomGroup(
	explicit: string | true | undefined,
	inherited: string | undefined,
	sharedAutoGroup: string | undefined,
): string | undefined {
	const normalized = normalizeAutoGroupSentinel(explicit);
	if (normalized === true) return sharedAutoGroup ?? randomUUID();
	if (typeof normalized === "string" && normalized.trim().length > 0) return normalized.trim();
	return inherited;
}

/**
 * Mint one shared auto-group UUID for a set when the set-level group or any item
 * requested `true`; otherwise undefined. Ensures all `true` items in one parallel
 * set land in the SAME group.
 */
export function sharedAutoGroupForSet(
	setGroup: string | true | undefined,
	items: ReadonlyArray<{ group?: string | true }>,
): string | undefined {
	const needsAuto =
		normalizeAutoGroupSentinel(setGroup) === true ||
		items.some((item) => normalizeAutoGroupSentinel(item.group) === true);
	return needsAuto ? randomUUID() : undefined;
}
