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

interface HomeGroupContext {
	orchestrationContext?: { intercomGroup?: string } | undefined;
	subagentPolicy?: { intercomGroup?: string } | undefined;
	/** Accepted from the live extension context but intentionally ignored for home resolution. */
	sessionManager?: { getSessionId(): string } | undefined;
}

/**
 * Resolve a session's static home intercom group with precedence (most specific first):
 * admitted subagentPolicy.intercomGroup > orchestrationContext.intercomGroup >
 * env ATOMIC_INTERCOM_GROUP (also PI_INTERCOM_GROUP legacy) > config.json "group" > "default".
 * Always returns a concrete normalized string.
 *
 * Runtime join entries are deliberately not read here. They are child-inheritance state, not
 * home state, so a reconnect cannot turn the joined group into the destination of `leave`.
 */
export function resolveHomeGroup(
	config: { group?: string } | undefined,
	ctx?: HomeGroupContext | null,
): string {
	const fromPolicy = ctx?.subagentPolicy?.intercomGroup;
	if (typeof fromPolicy === "string" && fromPolicy.trim().length > 0) {
		return normalizeGroup(fromPolicy);
	}
	const fromContext = ctx?.orchestrationContext?.intercomGroup;
	if (typeof fromContext === "string" && fromContext.trim().length > 0) {
		return normalizeGroup(fromContext);
	}
	const fromEnv = intercomGroupFromEnv();
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return normalizeGroup(fromEnv);
	}
	if (config && typeof config.group === "string" && config.group.trim().length > 0) {
		return normalizeGroup(config.group);
	}
	return DEFAULT_GROUP;
}
