/**
 * Session-management primitives.
 *
 * Thin wrappers around the tmux runtime utilities and the on-disk
 * `~/.atomic/sessions/<workflowRunId>/` layout. Consumers (atomic CLI,
 * third-party CLIs, embedding TUIs) call these instead of touching tmux
 * commands or the status-writer schema directly.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  attachSession as tmuxAttach,
  isTmuxInstalled,
  killSession,
  listSessions as listAllTmuxSessions,
  type SessionType,
  type TmuxSession,
} from "../runtime/tmux.ts";
import {
  readSnapshot,
  workflowRunIdFromTmuxName,
  type WorkflowStatusSnapshot,
} from "../runtime/status-writer.ts";
import type { AgentType, SavedMessage } from "../types.ts";

/** Scope filter for session listings — chat sessions, workflow sessions, or both. */
export type SessionScope = "chat" | "workflow" | "all";

/** Single session entry returned by `listSessions` / `getSession`. */
export interface SessionInfo {
  /** Tmux session name (e.g. `atomic-wf-claude-ralph-a1b2c3d4`). */
  id: string;
  /** Session type derived from the name prefix. */
  type?: SessionType;
  /** Agent backend that owns this session. */
  agent?: string;
  /** ISO 8601 creation timestamp. */
  created: string;
  /** Whether a tmux client is currently attached. */
  attached: boolean;
}

/** Status snapshot persisted by the orchestrator at `~/.atomic/sessions/<id>/status.json`. */
export type StatusSnapshot = WorkflowStatusSnapshot;

/** Options for filtering `listSessions()`. */
export interface ListSessionsOptions {
  /** Restrict to one or more agent backends. */
  agent?: AgentType | readonly AgentType[];
  /** Restrict by session kind. Defaults to `"all"`. */
  scope?: SessionScope;
}

/** Default base dir for session artefacts on disk. */
function sessionsBaseDir(): string {
  return join(homedir(), ".atomic", "sessions");
}

/** Convert a TmuxSession into the consumer-facing SessionInfo shape. */
function toSessionInfo(s: TmuxSession): SessionInfo {
  return {
    id: s.name,
    type: s.type,
    agent: s.agent,
    created: s.created,
    attached: s.attached,
  };
}

/** Filter sessions by scope. */
function filterByScope(
  sessions: readonly TmuxSession[],
  scope: SessionScope,
): TmuxSession[] {
  if (scope === "all") return [...sessions];
  return sessions.filter((s) => s.type === scope);
}

/** Filter sessions by an allow-list of agent backends. */
function filterByAgents(
  sessions: readonly TmuxSession[],
  agents: readonly AgentType[],
): TmuxSession[] {
  if (agents.length === 0) return [...sessions];
  const allowed = new Set<string>(agents);
  return sessions.filter((s) => s.agent !== undefined && allowed.has(s.agent));
}

/**
 * List atomic-managed tmux sessions on the shared `atomic` socket.
 *
 * Returns an empty array when tmux is not installed or the server has no
 * sessions — never throws on the cold-start path.
 */
export function listSessions(options: ListSessionsOptions = {}): SessionInfo[] {
  if (!isTmuxInstalled()) return [];
  const scope = options.scope ?? "all";
  const agents: readonly AgentType[] = options.agent === undefined
    ? []
    : Array.isArray(options.agent)
      ? (options.agent as readonly AgentType[])
      : [options.agent as AgentType];

  const all = listAllTmuxSessions();
  const scoped = filterByScope(all, scope);
  const filtered = filterByAgents(scoped, agents);
  return filtered.map(toSessionInfo);
}

/** Look up a single session by id. Returns `undefined` when not found. */
export function getSession(id: string): SessionInfo | undefined {
  if (!isTmuxInstalled()) return undefined;
  const match = listAllTmuxSessions().find((s) => s.name === id);
  return match ? toSessionInfo(match) : undefined;
}

/**
 * Stop a running session. Best-effort: if the session is already gone
 * the underlying `tmux kill-session` is a no-op-equivalent.
 */
export async function stopSession(id: string): Promise<void> {
  if (!isTmuxInstalled()) return;
  try {
    killSession(id);
  } catch {
    // tmux returns non-zero when the session has already been torn down —
    // surface that as a successful stop rather than a hard failure.
  }
}

/**
 * Attach to a running session interactively. Only valid when the host
 * process has a TTY — otherwise the underlying tmux invocation will
 * complain that it can't take over the terminal.
 */
export async function attachSession(id: string): Promise<void> {
  if (!isTmuxInstalled()) {
    throw new Error("tmux is not installed");
  }
  tmuxAttach(id);
}

/**
 * Read the on-disk status snapshot for a workflow session. Returns
 * `null` when the orchestrator hasn't written one yet (the workflow
 * is still very early) or when the directory doesn't exist.
 */
export async function getSessionStatus(
  id: string,
): Promise<StatusSnapshot | null> {
  const runId = workflowRunIdFromTmuxName(id);
  if (!runId) return null;
  return await readSnapshot(join(sessionsBaseDir(), runId));
}

/**
 * Read the saved native-message transcript for a single session inside
 * a workflow run. `id` is the tmux session id (`atomic-wf-...`); the
 * `sessionName` is the `name` passed to `ctx.stage({ name })` whose
 * messages were saved via `s.save(...)`.
 *
 * Returns an empty array when no transcript was persisted (e.g. the
 * workflow chose not to call `s.save`).
 */
export async function getSessionTranscript(
  id: string,
  sessionName: string,
): Promise<SavedMessage[]> {
  const runId = workflowRunIdFromTmuxName(id);
  if (!runId) return [];
  const file = Bun.file(
    join(sessionsBaseDir(), runId, sessionName, "messages.json"),
  );
  if (!(await file.exists())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSavedMessage);
}

/** Runtime guard for deserialised SavedMessage objects. */
function isSavedMessage(value: unknown): value is SavedMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.provider === "claude" ||
    v.provider === "copilot" ||
    v.provider === "opencode"
  );
}
