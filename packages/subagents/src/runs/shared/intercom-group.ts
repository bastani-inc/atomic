import { randomUUID } from "node:crypto";

interface OrchestrationCarrier {
	orchestrationContext?: { intercomGroup?: string } | undefined;
}

/** Read the inherited stage/session intercom group from the extension context (never from process.env). */
export function inheritedIntercomGroup(ctx: OrchestrationCarrier | undefined): string | undefined {
	const group = ctx?.orchestrationContext?.intercomGroup;
	return typeof group === "string" && group.trim().length > 0 ? group.trim() : undefined;
}

/**
 * Resolve the intercom group for a spawned subagent child. Precedence:
 * explicit task/parallel/chain group > inherited current-session (stage) group.
 * `true` resolves to `sharedAutoGroup` (a single UUID minted once per parallel
 * set) so every child in the set shares one isolated group. Returns undefined
 * when nothing applies, so the child inherits env/config/default itself.
 */
export function resolveChildIntercomGroup(
	explicit: string | true | undefined,
	inherited: string | undefined,
	sharedAutoGroup: string | undefined,
): string | undefined {
	if (explicit === true) return sharedAutoGroup ?? randomUUID();
	if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
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
	const needsAuto = setGroup === true || items.some((item) => item.group === true);
	return needsAuto ? randomUUID() : undefined;
}
