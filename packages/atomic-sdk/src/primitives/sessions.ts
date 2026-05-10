/**
 * Session-management primitives.
 *
 * Thin RPC clients over the atomic daemon JSON-RPC. Consumers (atomic CLI,
 * third-party CLIs, embedding TUIs) call these instead of touching tmux
 * commands or the status-writer schema directly.
 */

import { connectToDaemon } from "../runtime/daemon.ts";
import type { RunInfo } from "../runtime/ui-protocol/schemas.ts";
import type { WorkflowStatusSnapshot } from "../runtime/status-writer.ts";
import type { AgentType, SavedMessage } from "../types.ts";

// ─── Public types ────────────────────────────────────────────────────────────

/** Scope filter for session listings — chat sessions, workflow sessions, or both. */
export type SessionScope = "chat" | "workflow" | "all";

/** Status snapshot persisted by the orchestrator. */
export type StatusSnapshot = WorkflowStatusSnapshot;

/** Single session entry returned by `listSessions` / `getSession`. */
export interface SessionInfo {
  /** Run id (replaces tmux session name). */
  id: string;
  /** Always "workflow" for daemon-managed runs. */
  type?: "workflow" | "chat";
  /** Agent backend. */
  agent?: string;
  /** ISO 8601 start timestamp. */
  created: string;
  /** Whether a client is attached. False by default (daemon doesn't track this yet). */
  attached: boolean;
  /** Run status (new field). */
  status?: string;
  /** Workflow name (new field). */
  workflowName?: string;
}

/** Options for filtering `listSessions()`. */
export interface ListSessionsOptions {
  /** Restrict to one or more agent backends. */
  agent?: AgentType | readonly AgentType[];
  /** Restrict by session kind. Defaults to `"all"`. */
  scope?: SessionScope;
}

/**
 * Injectable dependencies for the session primitives.
 *
 * Defaults wire through to the real daemon JSON-RPC implementations.
 * Tests pass in mocks; embedding consumers can override the backend
 * without monkey-patching the underlying modules.
 */
export interface SessionPrimitiveDeps {
  /** run/list */
  listRuns(scope?: "active" | "completed" | "all"): Promise<RunInfo[]>;
  /** run/get */
  getRun(runId: string): Promise<RunInfo | null>;
  /** run/stop */
  stopRun(runId: string): Promise<void>;
  /** run/status */
  getRunStatus(runId: string): Promise<StatusSnapshot | null>;
  /** run/transcript */
  getRunTranscript(runId: string, sessionName: string): Promise<SavedMessage[]>;
  /** run/getAttachInfo */
  getAttachInfo(runId: string): Promise<{ subscriptionId: string; foregroundStage: string | null }>;
  /** run/setForeground */
  setForeground(runId: string, stageName?: string): Promise<void>;
}

/** Default deps — wires through to the real daemon JSON-RPC implementations. */
const defaultDeps: SessionPrimitiveDeps = {
  listRuns: async (scope) => {
    const conn = await connectToDaemon();
    try {
      return await conn.sendRequest("run/list", { scope }) as RunInfo[];
    } finally {
      conn.dispose();
    }
  },
  getRun: async (runId) => {
    const conn = await connectToDaemon();
    try {
      return await conn.sendRequest("run/get", { runId }) as RunInfo | null;
    } finally {
      conn.dispose();
    }
  },
  stopRun: async (runId) => {
    const conn = await connectToDaemon();
    try {
      await conn.sendRequest("run/stop", { runId });
    } finally {
      conn.dispose();
    }
  },
  getRunStatus: async (runId) => {
    const conn = await connectToDaemon();
    try {
      return await conn.sendRequest("run/status", { runId }) as StatusSnapshot | null;
    } finally {
      conn.dispose();
    }
  },
  getRunTranscript: async (runId, sessionName) => {
    const conn = await connectToDaemon();
    try {
      return await conn.sendRequest("run/transcript", { runId, sessionName }) as SavedMessage[];
    } finally {
      conn.dispose();
    }
  },
  getAttachInfo: async (runId) => {
    const conn = await connectToDaemon();
    try {
      return await conn.sendRequest("run/getAttachInfo", { runId }) as { subscriptionId: string; foregroundStage: string | null };
    } finally {
      conn.dispose();
    }
  },
  setForeground: async (runId, stageName) => {
    const conn = await connectToDaemon();
    try {
      await conn.sendRequest("run/setForeground", { runId, stageName });
    } finally {
      conn.dispose();
    }
  },
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Convert a RunInfo into the consumer-facing SessionInfo shape. */
function runInfoToSessionInfo(r: RunInfo): SessionInfo {
  return {
    id: r.runId,
    type: "workflow",
    agent: r.agent,
    created: r.startedAt,
    attached: false,
    status: r.status,
    workflowName: r.workflowName,
  };
}

/** Normalise the optional `agent` option into a flat list. Empty list = no filter. */
function toAgentList(
  agent: AgentType | readonly AgentType[] | undefined,
): readonly AgentType[] {
  if (agent === undefined) return [];
  if (Array.isArray(agent)) return agent as readonly AgentType[];
  return [agent as AgentType];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List atomic-managed runs from the daemon.
 *
 * Returns an empty array when the daemon has no runs — never throws on
 * the cold-start path.
 */
export async function listSessions(
  options: ListSessionsOptions = {},
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<SessionInfo[]> {
  // SessionScope ("chat" | "workflow" | "all") is a session-type filter.
  // run/list uses "active" | "completed" | "all". Always fetch "all" and
  // let the session-type filter below narrow the results.
  const runs = await deps.listRuns("all");
  let sessions = runs.map(runInfoToSessionInfo);

  if (options.scope === "chat") sessions = sessions.filter((s) => s.type === "chat");
  if (options.scope === "workflow") sessions = sessions.filter((s) => s.type === "workflow");

  const agents = toAgentList(options.agent);
  if (agents.length > 0) {
    const allowed = new Set<string>(agents);
    sessions = sessions.filter((s) => s.agent !== undefined && allowed.has(s.agent));
  }

  return sessions;
}

/** Look up a single run by id. Returns `undefined` when not found. */
export async function getSession(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<SessionInfo | undefined> {
  const run = await deps.getRun(id);
  return run ? runInfoToSessionInfo(run) : undefined;
}

/**
 * Stop a running session. Best-effort: if the session is already gone
 * the underlying RPC call is a no-op-equivalent.
 */
export async function stopSession(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.stopRun(id);
  } catch {
    // best-effort
  }
}

/**
 * Get attach info for a run. Returns the subscription id and the
 * current foreground stage (or null when none is set).
 */
export async function attachSession(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<{ subscriptionId: string; foregroundStage: string | null }> {
  return await deps.getAttachInfo(id);
}

/**
 * Detach clients from a session. No RPC equivalent in daemon v1;
 * detach is managed by panel clients. Best-effort no-op.
 */
export async function detachSession(
  _id: string,
  _deps: SessionPrimitiveDeps = defaultDeps,
): Promise<void> {
  // No RPC equivalent in daemon v1; detach is managed by panel clients.
}

/**
 * Move to the next stage/window. Calls `setForeground` with no stageName —
 * the daemon selects the next stage.
 */
export async function nextWindow(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<void> {
  await deps.setForeground(id, undefined);
}

/**
 * Move to the previous stage/window. Calls `setForeground` with no stageName —
 * the daemon selects the default stage.
 */
export async function previousWindow(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<void> {
  await deps.setForeground(id, undefined);
}

/**
 * Jump to the orchestrator / default stage of the target run.
 * Calls `setForeground` with no stageName — daemon resets to foreground/default.
 */
export async function gotoOrchestrator(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<void> {
  await deps.setForeground(id, undefined);
}

/**
 * Read the status snapshot for a workflow run. Returns `null` when the
 * orchestrator hasn't written one yet or the run is not found.
 */
export async function getSessionStatus(
  id: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<StatusSnapshot | null> {
  return await deps.getRunStatus(id);
}

/**
 * Read the saved native-message transcript for a single stage inside
 * a workflow run. `id` is the run id; `sessionName` is the stage name.
 *
 * Returns an empty array when no transcript was persisted.
 */
export async function getSessionTranscript(
  id: string,
  sessionName: string,
  deps: SessionPrimitiveDeps = defaultDeps,
): Promise<SavedMessage[]> {
  return await deps.getRunTranscript(id, sessionName);
}
