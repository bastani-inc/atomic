import type { SessionInfo } from "./types.js";

export type SessionTargetResolution =
  | { kind: "resolved"; session: SessionInfo }
  | { kind: "ambiguous_name"; matches: readonly SessionInfo[] }
  | { kind: "ambiguous_prefix"; matches: readonly SessionInfo[] }
  | { kind: "not_found" };

/** Resolve an Intercom session by exact ID, exact case-insensitive name, or unique ID prefix. */
export function resolveSessionTarget(
  sessions: readonly SessionInfo[],
  nameOrId: string,
): SessionTargetResolution {
  const target = nameOrId.trim();
  const exactId = sessions.find((session) => session.id === target);
  if (exactId !== undefined) return { kind: "resolved", session: exactId };

  const lowerTarget = target.toLowerCase();
  const exactNames = sessions.filter(
    (session) => session.name?.toLowerCase() === lowerTarget,
  );
  if (exactNames.length === 1) {
    return { kind: "resolved", session: exactNames[0]! };
  }
  if (exactNames.length > 1) {
    return { kind: "ambiguous_name", matches: exactNames };
  }

  const prefixedIds = sessions.filter((session) => session.id.startsWith(target));
  if (prefixedIds.length === 1) {
    return { kind: "resolved", session: prefixedIds[0]! };
  }
  if (prefixedIds.length > 1) {
    return { kind: "ambiguous_prefix", matches: prefixedIds };
  }
  return { kind: "not_found" };
}

export function sessionTargetFailureReason(
  target: string,
  resolution: Exclude<SessionTargetResolution, { kind: "resolved" }>,
): string {
  if (resolution.kind === "ambiguous_name") {
    return `Multiple sessions named "${target}" are connected. Use the session ID instead.`;
  }
  if (resolution.kind === "ambiguous_prefix") {
    const labels = resolution.matches
      .map((session) => `${session.name ?? "Unnamed session"} (${session.id})`)
      .join(", ");
    return `Ambiguous session ID prefix "${target}" matches: ${labels}. Use a longer ID or an exact session name.`;
  }
  return "Session not found";
}

export interface SessionListingClient {
  listSessions(): Promise<SessionInfo[]>;
}

/** Resolve a target through the broker's current session list. */
export async function resolveSessionTargetId(
  client: SessionListingClient,
  nameOrId: string,
): Promise<string | null> {
  const resolution = resolveSessionTarget(await client.listSessions(), nameOrId);
  if (resolution.kind === "resolved") return resolution.session.id;
  if (resolution.kind === "not_found") return null;
  throw new Error(sessionTargetFailureReason(nameOrId, resolution));
}
