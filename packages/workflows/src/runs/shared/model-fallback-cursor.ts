import { isAuthenticatedCursorRouteModel, type CreateAgentSessionOptions } from "@bastani/atomic";
import type { WorkflowModelCatalogPort, WorkflowModelInfo, WorkflowModelValue } from "../../shared/types.js";

export interface ExplicitCursorReference {
  readonly fullId: string;
  readonly routeId: string;
}

export function parseExplicitCursorReference(rawInput: string): ExplicitCursorReference | undefined {
  if (!rawInput.startsWith("cursor/")) return undefined;
  const routeId = rawInput.slice("cursor/".length);
  return { fullId: rawInput, routeId };
}


export function strictCursorStringReference(rawInput: string): boolean {
  // Only an explicit lowercase `cursor/<bytes>` reference reserves authenticated
  // Cursor discovery; Cursor exposes no static executable catalog, so bare ids
  // are ordinary non-Cursor references.
  return parseExplicitCursorReference(rawInput) !== undefined;
}

export function explicitCursorModelObject(value: WorkflowModelValue | undefined): boolean {
  return value !== undefined && typeof value !== "string" && value.provider === "cursor";
}

interface CursorObjectRoutingCompat {
  readonly cursorRouting?: Readonly<Record<string, { readonly modelId: string; readonly catalogOccurrence: number }>>;
}

/**
 * Return the exact private per-ID occurrence ordinal carried by a Cursor model.
 * Missing, mismatched, and malformed routing identities are rejected by callers;
 * routing shape identifies an occurrence but never proves live provenance.
 */
export function cursorObjectOccurrence(value: NonNullable<CreateAgentSessionOptions["model"]>): number | undefined {
  const compat = value.compat as CursorObjectRoutingCompat | undefined;
  const routing = compat?.cursorRouting?.[value.id];
  if (routing?.modelId !== value.id) return undefined;
  const occurrence = routing.catalogOccurrence;
  return Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : undefined;
}

export function liveInfoCursorOccurrence(info: WorkflowModelInfo): number | undefined {
  return info.model ? cursorObjectOccurrence(info.model) : undefined;
}

export function isAuthenticatedWorkflowCursorInfo(info: WorkflowModelInfo): info is WorkflowModelInfo & { readonly model: NonNullable<CreateAgentSessionOptions["model"]> } {
  return info.provider === "cursor"
    && info.fullId === `cursor/${info.id}`
    && info.model !== undefined
    && info.model.id === info.id
    && isAuthenticatedCursorRouteModel(info.model);
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
