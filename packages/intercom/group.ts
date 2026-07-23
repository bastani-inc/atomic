import { getEnvValue } from "@bastani/atomic";

/** The implicit group every ungrouped session belongs to. */
export const DEFAULT_GROUP = "default";

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

/** `getEnvValue("ATOMIC_INTERCOM_GROUP")` also resolves the legacy `PI_INTERCOM_GROUP`. */
const INTERCOM_GROUP_ENV = "ATOMIC_INTERCOM_GROUP";

interface HomeGroupContext {
  orchestrationContext?: { intercomGroup?: string } | undefined;
}

/**
 * Resolve a session's home intercom group with precedence (most specific first):
 * per-session orchestrationContext.intercomGroup (in-process workflow stages) >
 * env ATOMIC_INTERCOM_GROUP (also PI_INTERCOM_GROUP legacy) > config.json "group" >
 * "default". Always returns a concrete normalized string.
 */
export function resolveHomeGroup(
  config: { group?: string } | undefined,
  ctx?: HomeGroupContext | null,
): string {
  const fromContext = ctx?.orchestrationContext?.intercomGroup;
  if (typeof fromContext === "string" && fromContext.trim().length > 0) {
    return normalizeGroup(fromContext);
  }
  const fromEnv = getEnvValue(INTERCOM_GROUP_ENV);
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return normalizeGroup(fromEnv);
  }
  if (config && typeof config.group === "string" && config.group.trim().length > 0) {
    return normalizeGroup(config.group);
  }
  return DEFAULT_GROUP;
}
