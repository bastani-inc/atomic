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

/** Prefix for the environment entries used to pass a joined group to child runtimes. */
export const RUNTIME_GROUP_ENV = "ATOMIC_INTERCOM_RUNTIME_GROUP";

const RESERVED_RUNTIME_GROUPS = new Set(["true", "auto"]);

/** Use one environment entry per session so in-process sessions cannot overwrite each other. */
export function runtimeIntercomGroupEnvKey(sessionId: string): string {
	return `${RUNTIME_GROUP_ENV}_${encodeURIComponent(sessionId)}`;
}

/** Register one extension instance's current runtime group for child inheritance. */
export function setRuntimeIntercomGroup(sessionId: string, group: string): void {
	process.env[runtimeIntercomGroupEnvKey(sessionId)] = group;
}

/** Remove one extension instance's runtime group without clobbering another session. */
export function clearRuntimeIntercomGroup(sessionId: string): void {
	delete process.env[runtimeIntercomGroupEnvKey(sessionId)];
}

function runtimeIntercomGroupFromEnv(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	const value = process.env[runtimeIntercomGroupEnvKey(sessionId)];
	return typeof value === "string" && value.trim().length > 0 ? normalizeGroup(value) : undefined;
}

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
  sessionManager?: { getSessionId(): string } | undefined;
}
/**
 * Resolve a session's home intercom group with precedence (most specific first):
 * orchestrationContext.intercomGroup > admitted subagentPolicy.intercomGroup >
 * runtime join override > env ATOMIC_INTERCOM_GROUP (also PI_INTERCOM_GROUP legacy) >
 * config.json "group" > "default". Always returns a concrete normalized string.
 */
export function resolveHomeGroup(
  config: { group?: string } | undefined,
  ctx?: HomeGroupContext | null,
): string {
  const fromContext = ctx?.orchestrationContext?.intercomGroup;
  if (typeof fromContext === "string" && fromContext.trim().length > 0) {
    return normalizeGroup(fromContext);
  }
  const fromPolicy = ctx?.subagentPolicy?.intercomGroup;
  if (typeof fromPolicy === "string" && fromPolicy.trim().length > 0) {
    return normalizeGroup(fromPolicy);
  }
  const fromRuntime = runtimeIntercomGroupFromEnv(ctx?.sessionManager?.getSessionId());
  if (fromRuntime !== undefined) return fromRuntime;
  const fromEnv = intercomGroupFromEnv();
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return normalizeGroup(fromEnv);
  }
  if (config && typeof config.group === "string" && config.group.trim().length > 0) {
    return normalizeGroup(config.group);
  }
  return DEFAULT_GROUP;
}
