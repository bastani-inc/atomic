import { randomUUID } from "node:crypto";
import type { StageOptions } from "./types.js";

/** The implicit group shared by every ungrouped session. */
export const DEFAULT_INTERCOM_GROUP = "default";

/** Normalize authored or agent-serialized auto-group sentinels without changing real group names. */
export function normalizeAutoGroupSentinel(group: string | true): string | true {
  if (group === true) return true;
  const sentinel = group.trim().toLowerCase();
  return sentinel === "true" || sentinel === "auto" ? true : group;
}

/** Trim; empty/undefined collapses to the shared default group. */
export function normalizeGroup(value?: string | null): string {
  if (typeof value !== "string") return DEFAULT_INTERCOM_GROUP;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_INTERCOM_GROUP;
}

/**
 * Resolve a stage's `group` option to a concrete home-group string, or undefined
 * when the stage did not request a group (so the intercom layer falls back to
 * env/config/default). A named string is trimmed; a bare `true` that survives to
 * this point (a single, non-parallel stage) mints one fresh UUID for that stage.
 * Parallel sets resolve `true` to one shared UUID upstream, so it never reaches
 * here as `true`.
 */
export function resolveStageGroup(stageOptions?: { group?: string | true }): string | undefined {
  if (!stageOptions) return undefined;
  const group = stageOptions.group;
  if (group === undefined) return undefined;
  if (group === true) return randomUUID();
  const trimmed = group.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether a stage session will actually have an intercom tool available. Group
 * assignment is skipped for stages without intercom access so an agent is never
 * placed into an isolated group it cannot use.
 */
export function stageHasIntercomAccess(stageOptions?: StageOptions): boolean {
  if (!stageOptions) return true;
  if (stageOptions.noTools === "all" || stageOptions.noTools === "builtin") return false;
  const tools = stageOptions.tools;
  if (Array.isArray(tools) && !tools.includes("intercom")) return false;
  const excluded = stageOptions.excludedTools;
  if (Array.isArray(excluded) && excluded.includes("intercom")) return false;
  return true;
}
