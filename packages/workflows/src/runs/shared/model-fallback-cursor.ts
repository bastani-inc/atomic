import { isLegacyBareCursorModelId } from "@bastani/atomic";
import type { WorkflowModelCatalogPort, WorkflowModelValue } from "../../shared/types.js";

export interface ExplicitCursorReference {
  readonly fullId: string;
  readonly routeId: string;
}

export function parseExplicitCursorReference(rawInput: string): ExplicitCursorReference | undefined {
  const slashIndex = rawInput.indexOf("/");
  if (slashIndex <= 0 || rawInput.slice(0, slashIndex).trim().toLowerCase() !== "cursor") return undefined;
  const routeId = rawInput.slice(slashIndex + 1);
  return { fullId: `cursor/${routeId}`, routeId };
}

export function strictCursorStringReference(rawInput: string): boolean {
  return parseExplicitCursorReference(rawInput) !== undefined || isLegacyBareCursorModelId(rawInput);
}

export function explicitCursorModelObject(value: WorkflowModelValue | undefined): boolean {
  return value !== undefined && typeof value !== "string" && String(value.provider).toLowerCase() === "cursor";
}

export function hasStrictCursorReference(input: {
  readonly primaryModel?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
}): boolean {
  return explicitCursorModelObject(input.primaryModel)
    || (typeof input.primaryModel === "string" && strictCursorStringReference(input.primaryModel))
    || (input.fallbackModels?.some(strictCursorStringReference) ?? false);
}

const AUTHENTICATED_CURSOR_DISCOVERY_UNAVAILABLE =
  "workflows: authenticated Cursor model discovery is unavailable";

export async function requireAuthenticatedCursorDiscovery(
  catalog: WorkflowModelCatalogPort | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (catalog?.discoverModels === undefined) {
    throw new Error(AUTHENTICATED_CURSOR_DISCOVERY_UNAVAILABLE);
  }
  await catalog.discoverModels(signal);
}
