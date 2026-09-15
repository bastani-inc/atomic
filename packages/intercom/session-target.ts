import type { SessionInfo } from "./types.js";

export type SessionTargetResolution<T extends Pick<SessionInfo, "id" | "name"> = SessionInfo> =
  | { kind: "resolved"; session: T }
  | { kind: "ambiguous_name"; matches: readonly T[] }
  | { kind: "ambiguous_id_prefix"; matches: readonly T[] }
  | { kind: "not_found" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}$/i;

/** Resolve an Intercom session by exact ID/name or a unique 8-hex UUID prefix. */
export function resolveSessionTarget<T extends Pick<SessionInfo, "id" | "name">>(
  sessions: readonly T[],
  nameOrId: string,
): SessionTargetResolution<T> {
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

  // #2603: names and custom exact IDs retain precedence over UUID-prefix targeting.
  if (UUID_PREFIX_PATTERN.test(target)) {
    const normalized = target.toLowerCase();
    const prefixMatches = sessions.filter(
      (session) => UUID_PATTERN.test(session.id) && session.id.toLowerCase().startsWith(normalized),
    );
    if (prefixMatches.length === 1) return { kind: "resolved", session: prefixMatches[0]! };
    if (prefixMatches.length > 1) return { kind: "ambiguous_id_prefix", matches: prefixMatches };
  }

  return { kind: "not_found" };
}

export function sessionTargetFailureReason(
  target: string,
  resolution: Exclude<SessionTargetResolution<Pick<SessionInfo, "id" | "name">>, { kind: "resolved" }>,
): string {
  if (resolution.kind === "ambiguous_name") {
    return `Multiple sessions named "${target}" are connected. Use the session ID instead.`;
  }
	if (resolution.kind === "ambiguous_id_prefix") {
		return `Session ID prefix "${target}" is ambiguous; matches: ${resolution.matches
			.map((session) => `${session.name ?? "unnamed"} (${session.id})`)
			.join(", ")}. Use the full UUID.`;
	}
  return "Session not found";
}

export interface SessionListingClient {
  listSessions(): Promise<SessionInfo[]>;
  readonly supervisorSessionId?: string | null;
}

/** Resolve a target through the broker's current session list. */
export async function resolveSessionTargetId(
  client: SessionListingClient,
  nameOrId: string,
): Promise<string | null> {
  const sessions: Pick<SessionInfo, "id" | "name">[] = [...await client.listSessions()];
  // #2603: isolated children still know their broker-authorized supervisor ID.
  if (client.supervisorSessionId && !sessions.some((session) => session.id === client.supervisorSessionId)) {
    sessions.push({ id: client.supervisorSessionId });
  }
  const resolution = resolveSessionTarget(sessions, nameOrId);
  if (resolution.kind === "resolved") return resolution.session.id;
  if (resolution.kind === "not_found") return null;
  throw new Error(sessionTargetFailureReason(nameOrId, resolution));
}
