/**
 * Group primitives shared by the detached broker and the host extension.
 * Keep this module free of host-package imports: the broker loads it in a
 * detached process with only Node built-ins and Intercom-local modules.
 */

/**
 * Mirrors `getEnvValue("ATOMIC_INTERCOM_GROUP")` locally so the detached broker subprocess
 * needs no host package. `getEnvValue` returns the first value that is `!== undefined` across
 * `[ATOMIC_INTERCOM_GROUP, PI_INTERCOM_GROUP]`, so a defined-but-empty ATOMIC value
 * deliberately shadows the legacy name and yields `""`; `resolveHomeGroup` then falls through
 * on the empty string. `??` reproduces that exactly — do not "improve" it to `||`.
 */
function intercomGroupFromEnv(): string | undefined {
	return process.env.ATOMIC_INTERCOM_GROUP ?? process.env.PI_INTERCOM_GROUP;
}

/** The implicit group every ungrouped session belongs to. */
export const DEFAULT_GROUP = "default";

const RESERVED_RUNTIME_GROUPS = new Set(["true", "auto"]);

/** Runtime representation of a session's normalized group memberships. */
export type GroupMemberships = ReadonlySet<string>;

type GroupMembershipInput = readonly (string | null | undefined)[] | ReadonlySet<string | null | undefined>;

/**
 * Normalize an intercom group id. Undefined, empty, or whitespace-only values
 * collapse to the shared {@link DEFAULT_GROUP} so ungrouped sessions all compare
 * equal and can still talk to each other (backward compatible).
 */
export function normalizeGroup(value?: string | null): string {
	if (typeof value !== "string") return DEFAULT_GROUP;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_GROUP;
}

/**
 * Normalize serialized group memberships into a non-empty set. Duplicate names
 * collapse, and an absent or empty collection retains legacy default membership.
 * A legacy `group` value is merged so single-group clients remain authoritative.
 */
export function normalizeGroups(
	values?: GroupMembershipInput | null,
	legacyGroup?: string | null,
): Set<string> {
	const groups = new Set<string>();
	for (const value of values ?? []) groups.add(normalizeGroup(value));
	if (legacyGroup !== undefined) groups.add(normalizeGroup(legacyGroup));
	if (groups.size === 0) groups.add(DEFAULT_GROUP);
	return groups;
}

/**
 * Validate a group requested by the runtime join action. `default` is a real,
 * explicit group name; `true` and `auto` remain reserved for subagent auto-grouping.
 */
export function validateRuntimeGroup(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("A non-empty intercom group name is required");
	}
	const group = normalizeGroup(value);
	if (RESERVED_RUNTIME_GROUPS.has(group.toLowerCase())) {
		throw new Error(`Intercom group name "${group}" is reserved; choose another name`);
	}
	return group;
}

/** Add one validated runtime group to a normalized membership set. */
export function addGroup(groups: GroupMemberships, value: unknown): Set<string> {
	const next = normalizeGroups(groups);
	next.add(validateRuntimeGroup(value));
	return next;
}

/** Remove one normalized group while retaining the fallback (or default) membership when none remain. */
export function removeGroup(
	groups: GroupMemberships,
	value?: string | null,
	fallback?: string | null,
): Set<string> {
	const next = normalizeGroups(groups);
	next.delete(normalizeGroup(value));
	return next.size > 0 ? next : normalizeGroups(undefined, fallback);
}

/** Test a normalized group membership. */
export function hasGroup(groups: GroupMemberships, value?: string | null): boolean {
	return normalizeGroups(groups).has(normalizeGroup(value));
}

interface HomeGroupContext {
	subagentPolicy?: { intercomGroup?: string } | undefined;
	intercomPolicy?: { home: string } | undefined;
	/** Accepted from the live extension context but intentionally ignored for home resolution. */
	sessionManager?: { getSessionId(): string } | undefined;
}

export function explicitHomeGroup(
	config: { group?: string } | undefined,
	ctx?: HomeGroupContext | null,
): string | undefined {
	const fromPolicy = ctx?.subagentPolicy?.intercomGroup;
	if (typeof fromPolicy === "string" && fromPolicy.trim().length > 0) {
		return normalizeGroup(fromPolicy);
	}
	const fromHost = ctx?.intercomPolicy?.home;
	if (typeof fromHost === "string" && fromHost.trim().length > 0) {
		return normalizeGroup(fromHost);
	}
	const fromEnv = intercomGroupFromEnv();
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return normalizeGroup(fromEnv);
	}
	if (config && typeof config.group === "string" && config.group.trim().length > 0) {
		return normalizeGroup(config.group);
	}
	return undefined;
}

/**
 * Resolve a session's static home intercom group: its {@link explicitHomeGroup}, else the `fallback` group
 * (the project group while multi-node routing is on), else "default". Always returns a concrete normalized string.
 * `fallback` runs only when no explicit group applies.
 *
 * Runtime join entries are deliberately not read here. They are child-inheritance state, not
 * home state, so a reconnect cannot turn the joined group into the destination of `leave`.
 */
export function resolveHomeGroup(
	config: { group?: string } | undefined,
	ctx?: HomeGroupContext | null,
	fallback?: () => string | undefined,
): string {
	return explicitHomeGroup(config, ctx) ?? normalizeGroup(fallback?.());
}

/**
 * How long a recipient may answer a sender outside its groups after that sender's latest message reached it. See
 * `broker/return-paths.ts`.
 */
export const RETURN_PATH_WINDOW_MS = 30 * 60_000;
/** Messages a recipient may send back after the latest message that reached it: an answer, a correction and a final result. */
export const RETURN_PATH_MESSAGE_LIMIT = 3;

/** How the intercom tool tells the model about return paths, after "cross-group sends are rejected by the broker". */
export const RETURN_PATH_TOOL_NOTE = `except an answer to a sender outside your groups whose message reached you (up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${Math.round(RETURN_PATH_WINDOW_MS / 60_000)} minutes of its latest one)`;

/** Why a send to a sender whose return path has closed is refused. */
export function returnPathClosedReason(sender: string): string {
	const minutes = Math.round(RETURN_PATH_WINDOW_MS / 60_000);
	return `${sender} is outside your intercom groups and its return path has closed: a session outside your groups can be answered with up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${minutes} minutes of its latest message to you. It reopens when ${sender} writes to you again.`;
}
