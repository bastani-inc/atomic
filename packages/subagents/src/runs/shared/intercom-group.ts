import { randomUUID } from "node:crypto";

/** Normalize agent-serialized auto-group sentinels without changing real group names. */
export function normalizeAutoGroupSentinel(group: string | true | undefined): string | true | undefined {
	if (group === undefined || group === true) return group;
	const sentinel = group.trim().toLowerCase();
	return sentinel === "true" || sentinel === "auto" ? true : group;
}

const RUNTIME_GROUP_ENV = "ATOMIC_INTERCOM_RUNTIME_GROUP";

function runtimeIntercomGroup(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	const encodedSessionId = encodeURIComponent(sessionId);
	const group = process.env[`${RUNTIME_GROUP_ENV}_${encodedSessionId}`];
	return typeof group === "string" && group.trim().length > 0 ? group.trim() : undefined;
}

interface OrchestrationCarrier {
	orchestrationContext?: { intercomGroup?: string } | undefined;
	subagentPolicy?: { intercomGroup?: string } | undefined;
	sessionManager?: { getSessionId(): string } | undefined;
}

/** Read the joined group before the admitted child or static stage group. */
export function inheritedIntercomGroup(ctx: OrchestrationCarrier | undefined): string | undefined {
	const runtimeGroup = runtimeIntercomGroup(ctx?.sessionManager?.getSessionId());
	if (runtimeGroup !== undefined) return runtimeGroup;
	const policyGroup = ctx?.subagentPolicy?.intercomGroup;
	if (typeof policyGroup === "string" && policyGroup.trim().length > 0) return policyGroup.trim();
	const group = ctx?.orchestrationContext?.intercomGroup;
	return typeof group === "string" && group.trim().length > 0 ? group.trim() : undefined;
}

/**
 * Resolve the intercom group for a spawned subagent child. Explicit task group
 * takes precedence over the inherited current-session group.
 * `true` resolves to `sharedAutoGroup` (a single UUID minted once per parallel
 * set) so every child in the set shares one isolated group. Returns undefined
 * when nothing applies, so the child inherits env/config/default itself.
 */
export function resolveChildIntercomGroup(
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
